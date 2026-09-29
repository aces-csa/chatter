package com.chatter.platform.security;

import java.security.KeyFactory;
import java.security.interfaces.RSAPrivateCrtKey;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.RSAPublicKeySpec;

final class RsaKeys {

    private RsaKeys() {
    }

    /**
     * A PKCS#8 RSA private key carries the CRT parameters, so the public key can be derived
     * rather than configured separately. One fewer file to keep in sync.
     */
    static RSAPublicKey publicFromPrivate(RSAPrivateKey privateKey) throws Exception {
        if (!(privateKey instanceof RSAPrivateCrtKey crt)) {
            throw new IllegalArgumentException(
                    "Private key does not carry CRT parameters; supply the public key separately");
        }
        RSAPublicKeySpec spec = new RSAPublicKeySpec(crt.getModulus(), crt.getPublicExponent());
        return (RSAPublicKey) KeyFactory.getInstance("RSA").generatePublic(spec);
    }
}
