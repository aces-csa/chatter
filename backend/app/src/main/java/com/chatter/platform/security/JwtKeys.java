package com.chatter.platform.security;

import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Base64;
import java.util.Map;

/**
 * Holds the RS256 signing key. The public half is served at /.well-known/jwks.json so the
 * ws-gateway validates tokens locally and never has to call back into auth on the hot path.
 *
 * <p>In dev, with no key configured, a key is generated once and kept in
 * {@code ~/.chatter/dev-jwt-key.pem}, so restarting the app does not invalidate every session.
 * It used to be regenerated on each start under a fixed key id; the gateway, having cached the
 * old public key under that same id, then rejected every new token until it too was restarted.
 *
 * <p>The key id is the key's RFC 7638 thumbprint. A genuinely new key therefore always has a new
 * id, and a verifier holding a cached JWKS sees an unknown id and refetches instead of failing.
 */
@Component
public class JwtKeys {

    private static final Logger log = LoggerFactory.getLogger(JwtKeys.class);

    private final RSAKey rsaKey;

    public JwtKeys(@Value("${chatter.security.jwt.private-key-path:}") String privateKeyPath) {
        this.rsaKey = privateKeyPath == null || privateKeyPath.isBlank()
                ? loadFrom(devKeyPath())
                : loadFrom(Path.of(privateKeyPath));
    }

    /** Creates the dev key on first use; every later start reads the same one. */
    private static Path devKeyPath() {
        Path path = Path.of(System.getProperty("user.home"), ".chatter", "dev-jwt-key.pem");
        if (Files.exists(path)) {
            return path;
        }
        log.warn("No chatter.security.jwt.private-key-path configured -- creating a dev signing key "
                + "at {}. Configure a managed key in production.", path);
        try {
            KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
            gen.initialize(2048);
            KeyPair pair = gen.generateKeyPair();
            String pem = "-----BEGIN PRIVATE KEY-----\n"
                    + Base64.getMimeEncoder(64, "\n".getBytes()).encodeToString(pair.getPrivate().getEncoded())
                    + "\n-----END PRIVATE KEY-----\n";
            Files.createDirectories(path.getParent());
            Files.writeString(path, pem);
            return path;
        } catch (Exception e) {
            throw new IllegalStateException("Cannot create dev signing key at " + path, e);
        }
    }

    private static RSAKey loadFrom(Path pemPath) {
        try {
            String pem = Files.readString(pemPath)
                    .replaceAll("-----BEGIN (.*)-----", "")
                    .replaceAll("-----END (.*)-----", "")
                    .replaceAll("\\s", "");
            byte[] der = Base64.getDecoder().decode(pem);
            KeyFactory kf = KeyFactory.getInstance("RSA");
            RSAPrivateKey privateKey = (RSAPrivateKey) kf.generatePrivate(new PKCS8EncodedKeySpec(der));
            RSAPublicKey publicKey = RsaKeys.publicFromPrivate(privateKey);
            RSAKey withoutId = new RSAKey.Builder(publicKey).privateKey(privateKey).build();
            return new RSAKey.Builder(withoutId).keyID(withoutId.computeThumbprint().toString()).build();
        } catch (Exception e) {
            throw new IllegalStateException("Cannot load RSA private key from " + pemPath, e);
        }
    }

    public RSAKey rsaKey() {
        return rsaKey;
    }

    public RSAPublicKey publicKey() {
        try {
            return rsaKey.toRSAPublicKey();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** JWKS document, public halves only. */
    public Map<String, Object> jwks() {
        return new JWKSet(rsaKey.toPublicJWK()).toJSONObject();
    }
}
