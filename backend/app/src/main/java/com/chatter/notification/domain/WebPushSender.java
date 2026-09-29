package com.chatter.notification.domain;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Web Push delivery, done with the JDK alone: RFC 8291 message encryption (aes128gcm, RFC 8188)
 * and RFC 8292 VAPID authentication. No third-party push library -- the protocol is small, and
 * the ones available pin old BouncyCastle versions we would rather not carry.
 */
@Component
public class WebPushSender {

    private static final Base64.Encoder B64URL = Base64.getUrlEncoder().withoutPadding();
    private static final Base64.Decoder B64URL_DECODER = Base64.getUrlDecoder();
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int RECORD_SIZE = 4096;
    private static final Duration JWT_LIFETIME = Duration.ofHours(12);

    private final VapidKeys vapid;
    private final String subject;
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();
    /** One signed JWT per push service origin, reused until it nears expiry. */
    private final Map<String, CachedJwt> jwts = new ConcurrentHashMap<>();

    private record CachedJwt(String token, Instant refreshAfter) {
    }

    public record Subscription(String endpoint, String p256dh, String auth) {
    }

    public WebPushSender(VapidKeys vapid,
                         @Value("${chatter.push.subject:mailto:admin@chatter.local}") String subject) {
        this.vapid = vapid;
        this.subject = subject;
    }

    /**
     * @param topic collapse key: a newer push with the same topic replaces an undelivered older
     *              one at the push service, so a busy chat is one notification, not fifty
     * @return the push service's HTTP status; 404 and 410 mean the subscription is gone
     */
    public CompletableFuture<Integer> send(Subscription subscription, byte[] payload, String topic,
                                           Duration ttl) {
        byte[] body;
        String authorization;
        try {
            body = encrypt(subscription, payload);
            authorization = vapidHeader(subscription.endpoint());
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            return CompletableFuture.failedFuture(e);
        }
        HttpRequest request = HttpRequest.newBuilder(URI.create(subscription.endpoint()))
                .timeout(Duration.ofSeconds(10))
                .header("Content-Encoding", "aes128gcm")
                .header("Content-Type", "application/octet-stream")
                .header("TTL", Long.toString(ttl.toSeconds()))
                .header("Urgency", "high")
                .header("Topic", topic)
                .header("Authorization", authorization)
                .POST(HttpRequest.BodyPublishers.ofByteArray(body))
                .build();
        return http.sendAsync(request, HttpResponse.BodyHandlers.discarding())
                .thenApply(HttpResponse::statusCode);
    }

    /** RFC 8291 section 3 + RFC 8188: one record, header carrying salt and our ephemeral key. */
    private byte[] encrypt(Subscription subscription, byte[] plaintext) throws GeneralSecurityException {
        byte[] uaPublic = B64URL_DECODER.decode(subscription.p256dh());
        byte[] authSecret = B64URL_DECODER.decode(subscription.auth());
        ECPublicKey uaKey = VapidKeys.decodePoint(uaPublic);

        // A fresh key pair per message: the ECDH secret is never reused.
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair ephemeral = generator.generateKeyPair();
        byte[] asPublic = VapidKeys.rawPoint((ECPublicKey) ephemeral.getPublic());

        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(ephemeral.getPrivate());
        agreement.doPhase(uaKey, true);
        byte[] ecdhSecret = agreement.generateSecret();

        byte[] keyInfo = concat("WebPush: info".getBytes(StandardCharsets.US_ASCII), new byte[]{0},
                uaPublic, asPublic);
        byte[] ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);

        byte[] salt = new byte[16];
        RANDOM.nextBytes(salt);
        byte[] cek = hkdf(salt, ikm, concat("Content-Encoding: aes128gcm".getBytes(StandardCharsets.US_ASCII), new byte[]{0}), 16);
        byte[] nonce = hkdf(salt, ikm, concat("Content-Encoding: nonce".getBytes(StandardCharsets.US_ASCII), new byte[]{0}), 12);

        // 0x02 marks the last (and only) record; no extra padding.
        byte[] padded = concat(plaintext, new byte[]{2});
        if (padded.length + 16 > RECORD_SIZE) {
            throw new IllegalArgumentException("Push payload too large");
        }
        Cipher aes = Cipher.getInstance("AES/GCM/NoPadding");
        aes.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(cek, "AES"), new GCMParameterSpec(128, nonce));
        byte[] ciphertext = aes.doFinal(padded);

        ByteBuffer header = ByteBuffer.allocate(16 + 4 + 1 + asPublic.length);
        header.put(salt).putInt(RECORD_SIZE).put((byte) asPublic.length).put(asPublic);
        return concat(header.array(), ciphertext);
    }

    /** RFC 8292: "vapid t=<jwt>, k=<public key>", signed for the push service's origin. */
    private String vapidHeader(String endpoint) throws GeneralSecurityException {
        URI uri = URI.create(endpoint);
        if (!"https".equals(uri.getScheme())) {
            throw new IllegalArgumentException("Push endpoints must be https");
        }
        String audience = uri.getScheme() + "://" + uri.getHost() + (uri.getPort() == -1 ? "" : ":" + uri.getPort());
        Instant now = Instant.now();
        CachedJwt cached = jwts.get(audience);
        if (cached == null || now.isAfter(cached.refreshAfter())) {
            long exp = now.plus(JWT_LIFETIME).getEpochSecond();
            String header = B64URL.encodeToString("{\"typ\":\"JWT\",\"alg\":\"ES256\"}".getBytes(StandardCharsets.UTF_8));
            String claims = B64URL.encodeToString(("{\"aud\":\"" + audience + "\",\"exp\":" + exp
                    + ",\"sub\":\"" + subject + "\"}").getBytes(StandardCharsets.UTF_8));
            // P1363 gives the raw R||S form JWS wants, rather than DER.
            Signature signer = Signature.getInstance("SHA256withECDSAinP1363Format");
            signer.initSign(vapid.privateKey());
            signer.update((header + "." + claims).getBytes(StandardCharsets.US_ASCII));
            String token = header + "." + claims + "." + B64URL.encodeToString(signer.sign());
            cached = new CachedJwt(token, now.plus(JWT_LIFETIME.dividedBy(2)));
            jwts.put(audience, cached);
        }
        return "vapid t=" + cached.token() + ", k=" + vapid.publicKeyBase64Url();
    }

    /** HKDF-SHA256 (RFC 5869) for outputs of at most one hash block, which is all Web Push needs. */
    private static byte[] hkdf(byte[] salt, byte[] ikm, byte[] info, int length) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(salt, "HmacSHA256"));
        byte[] prk = mac.doFinal(ikm);
        mac.init(new SecretKeySpec(prk, "HmacSHA256"));
        mac.update(info);
        mac.update((byte) 1);
        return Arrays.copyOf(mac.doFinal(), length);
    }

    private static byte[] concat(byte[]... parts) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] part : parts) {
            out.writeBytes(part);
        }
        return out.toByteArray();
    }
}
