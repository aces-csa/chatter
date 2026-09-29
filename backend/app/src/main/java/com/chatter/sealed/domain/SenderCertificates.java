package com.chatter.sealed.domain;

import com.chatter.sealed.api.SealedDtos;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.interfaces.ECPrivateKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Issues sender certificates: a server signature over "this user, this device, this identity key,
 * valid until then". The sender puts one inside every sealed envelope. The recipient -- never the
 * server -- checks it, and it is the only thing that tells them who a sealed message is from.
 *
 * <p>ECDSA P-256 in IEEE P1363 form (raw r||s), because that is what WebCrypto verifies natively
 * in every browser; Ed25519 support there is too recent to rely on. The key is separate from the
 * JWT key on purpose: a key used for one job only can be rotated or pinned without touching logins.
 *
 * <p>In dev the key is generated once and kept in {@code ~/.chatter/dev-sender-cert-key.pem}, the
 * same arrangement as the JWT key, so restarts do not invalidate certificates clients hold.
 */
@Component
public class SenderCertificates {

    private static final Logger log = LoggerFactory.getLogger(SenderCertificates.class);
    private static final String ALGORITHM = "SHA256withECDSAinP1363Format";
    /** Short enough that a revoked device's certificate soon stops working; clients renew early. */
    static final Duration LIFETIME = Duration.ofHours(24);

    private final PrivateKey privateKey;
    private final PublicKey publicKey;
    private final ObjectMapper mapper;

    public SenderCertificates(@Value("${chatter.sealed.certificate-key-path:}") String keyPath, ObjectMapper mapper) {
        this.mapper = mapper;
        Path path = keyPath == null || keyPath.isBlank() ? devKeyPath() : Path.of(keyPath);
        try {
            KeyFactory factory = KeyFactory.getInstance("EC");
            this.privateKey = factory.generatePrivate(new PKCS8EncodedKeySpec(readPem(path)));
            this.publicKey = factory.generatePublic(new X509EncodedKeySpec(readPem(publicPath(path))));
        } catch (Exception e) {
            throw new IllegalStateException("Cannot load the sender certificate key from " + path, e);
        }
        if (!(privateKey instanceof ECPrivateKey)) {
            throw new IllegalStateException("The sender certificate key must be an EC P-256 key");
        }
    }

    /** SubjectPublicKeyInfo, base64: what a client imports with {@code crypto.subtle.importKey('spki', ...)}. */
    public String trustRoot() {
        return Base64.getEncoder().encodeToString(publicKey.getEncoded());
    }

    public SealedDtos.SenderCertificate issue(UUID userId, UUID deviceId, String identityKey) {
        Instant expires = Instant.now().plus(LIFETIME);
        // Signed bytes travel as-is and the client parses what it verified, so there is no
        // canonical-JSON problem: nobody re-serialises before checking.
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("userId", userId);
        body.put("deviceId", deviceId);
        body.put("identityKey", identityKey);
        body.put("expires", expires.toEpochMilli());
        try {
            byte[] certificate = mapper.writeValueAsBytes(body);
            Signature signer = Signature.getInstance(ALGORITHM);
            signer.initSign(privateKey);
            signer.update(certificate);
            return new SealedDtos.SenderCertificate(
                    Base64.getEncoder().encodeToString(certificate),
                    Base64.getEncoder().encodeToString(signer.sign()),
                    expires.toEpochMilli());
        } catch (Exception e) {
            throw new IllegalStateException("Cannot sign a sender certificate", e);
        }
    }

    private static Path devKeyPath() {
        Path path = Path.of(System.getProperty("user.home"), ".chatter", "dev-sender-cert-key.pem");
        if (Files.exists(path) && Files.exists(publicPath(path))) {
            return path;
        }
        log.warn("No chatter.sealed.certificate-key-path configured -- creating a dev sender certificate "
                + "key at {}. Configure a managed key in production.", path);
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
            generator.initialize(new ECGenParameterSpec("secp256r1"));
            KeyPair pair = generator.generateKeyPair();
            Files.createDirectories(path.getParent());
            Files.writeString(path, pem("PRIVATE KEY", pair.getPrivate().getEncoded()));
            Files.writeString(publicPath(path), pem("PUBLIC KEY", pair.getPublic().getEncoded()));
            return path;
        } catch (Exception e) {
            throw new IllegalStateException("Cannot create the dev sender certificate key at " + path, e);
        }
    }

    /** EC private keys in PKCS#8 need not carry the public point, so it is kept alongside. */
    private static Path publicPath(Path privatePath) {
        return privatePath.resolveSibling(privatePath.getFileName().toString().replace(".pem", ".pub.pem"));
    }

    private static String pem(String type, byte[] der) {
        return "-----BEGIN " + type + "-----\n"
                + Base64.getMimeEncoder(64, "\n".getBytes()).encodeToString(der)
                + "\n-----END " + type + "-----\n";
    }

    private static byte[] readPem(Path path) throws Exception {
        String body = Files.readString(path)
                .replaceAll("-----BEGIN (.*)-----", "")
                .replaceAll("-----END (.*)-----", "")
                .replaceAll("\\s", "");
        return Base64.getDecoder().decode(body);
    }
}
