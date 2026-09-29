package com.chatter.notification.domain;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.math.BigInteger;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;

/**
 * The server's VAPID identity (RFC 8292): a P-256 key pair generated once and kept in the
 * database, because every browser subscription is bound to the public half. Rotating it would
 * silently orphan every subscription, so it is created on first boot and never replaced.
 */
@Component
public class VapidKeys {

    private final ECPublicKey publicKey;
    private final ECPrivateKey privateKey;
    private final byte[] rawPublic;

    public VapidKeys(JdbcTemplate jdbc) throws GeneralSecurityException {
        List<byte[][]> rows = load(jdbc);
        if (rows.isEmpty()) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
            generator.initialize(new ECGenParameterSpec("secp256r1"));
            KeyPair pair = generator.generateKeyPair();
            // ON CONFLICT: two instances booting together must agree on one key, not each keep
            // their own. Whoever loses the race reads the winner's row below.
            jdbc.update("INSERT INTO vapid_keys (id, public_key, private_key) VALUES (1, ?, ?) "
                            + "ON CONFLICT (id) DO NOTHING",
                    rawPoint((ECPublicKey) pair.getPublic()), pair.getPrivate().getEncoded());
            rows = load(jdbc);
        }
        this.rawPublic = rows.getFirst()[0];
        this.privateKey = (ECPrivateKey) KeyFactory.getInstance("EC")
                .generatePrivate(new PKCS8EncodedKeySpec(rows.getFirst()[1]));
        this.publicKey = decodePoint(rawPublic);
    }

    private static List<byte[][]> load(JdbcTemplate jdbc) {
        return jdbc.query("SELECT public_key, private_key FROM vapid_keys WHERE id = 1",
                (rs, n) -> new byte[][]{rs.getBytes(1), rs.getBytes(2)});
    }

    /** What the browser passes to pushManager.subscribe as applicationServerKey. */
    public String publicKeyBase64Url() {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(rawPublic);
    }

    public ECPrivateKey privateKey() {
        return privateKey;
    }

    public ECPublicKey publicKey() {
        return publicKey;
    }

    static ECParameterSpec p256() throws GeneralSecurityException {
        AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
        parameters.init(new ECGenParameterSpec("secp256r1"));
        return parameters.getParameterSpec(ECParameterSpec.class);
    }

    /** Uncompressed SEC1 point: 0x04 || X || Y, 65 bytes -- the form Web Push uses everywhere. */
    static byte[] rawPoint(ECPublicKey key) {
        byte[] out = new byte[65];
        out[0] = 0x04;
        copyFixed(key.getW().getAffineX(), out, 1);
        copyFixed(key.getW().getAffineY(), out, 33);
        return out;
    }

    static ECPublicKey decodePoint(byte[] raw) throws GeneralSecurityException {
        if (raw.length != 65 || raw[0] != 0x04) {
            throw new GeneralSecurityException("Expected an uncompressed P-256 point");
        }
        ECPoint point = new ECPoint(new BigInteger(1, Arrays.copyOfRange(raw, 1, 33)),
                new BigInteger(1, Arrays.copyOfRange(raw, 33, 65)));
        return (ECPublicKey) KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(point, p256()));
    }

    /** BigInteger bytes are minimal and signed; coordinates must be exactly 32 bytes. */
    private static void copyFixed(BigInteger value, byte[] out, int offset) {
        byte[] bytes = value.toByteArray();
        int start = Math.max(0, bytes.length - 32);
        int length = bytes.length - start;
        System.arraycopy(bytes, start, out, offset + 32 - length, length);
    }
}
