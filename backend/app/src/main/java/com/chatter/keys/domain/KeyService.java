package com.chatter.keys.domain;

import com.chatter.auth.api.DeviceDirectory;
import com.chatter.auth.api.DeviceDto;
import com.chatter.common.error.AppException;
import com.chatter.common.error.ErrorCode;
import com.chatter.keys.api.KeyDtos;
import com.chatter.keys.persistence.OneTimePreKeyRepository;
import com.chatter.keys.persistence.SignedPreKeyEntity;
import com.chatter.keys.persistence.SignedPreKeyRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Limit;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

@Service
public class KeyService {

    private static final Logger log = LoggerFactory.getLogger(KeyService.class);
    private static final Base64.Decoder DECODER = Base64.getDecoder();
    private static final Base64.Encoder ENCODER = Base64.getEncoder();

    private final DeviceDirectory devices;
    private final SignedPreKeyRepository signedPreKeys;
    private final OneTimePreKeyRepository oneTimePreKeys;
    private final JdbcTemplate jdbc;

    public KeyService(DeviceDirectory devices, SignedPreKeyRepository signedPreKeys,
                      OneTimePreKeyRepository oneTimePreKeys, JdbcTemplate jdbc) {
        this.devices = devices;
        this.signedPreKeys = signedPreKeys;
        this.oneTimePreKeys = oneTimePreKeys;
        this.jdbc = jdbc;
    }

    @Transactional
    public void register(UUID deviceId, KeyDtos.RegisterKeysRequest request) {
        devices.registerIdentity(deviceId, DECODER.decode(request.identityKey()),
                request.registrationId());

        signedPreKeys.save(new SignedPreKeyEntity(
                deviceId,
                request.signedPreKey().keyId(),
                DECODER.decode(request.signedPreKey().publicKey()),
                DECODER.decode(request.signedPreKey().signature())));

        storeOneTimeKeys(deviceId, request.oneTimePreKeys());
    }

    @Transactional
    public void topUp(UUID deviceId, List<KeyDtos.PreKeyDto> keys) {
        storeOneTimeKeys(deviceId, keys);
    }

    /**
     * Upsert-ignore rather than insert. A client can legitimately re-offer a key id the server
     * already holds -- an interrupted registration, a retried top-up, a restored session -- and
     * that is not an error worth failing the whole batch over. Rejecting it would leave the
     * client retrying the same colliding ids forever, which is a permanent outage for one device.
     *
     * <p>The existing row is kept deliberately: overwriting a public key that a sender may
     * already have fetched would break the session they are building with it.
     */
    private void storeOneTimeKeys(UUID deviceId, List<KeyDtos.PreKeyDto> keys) {
        if (keys.isEmpty()) {
            return;
        }
        jdbc.batchUpdate("""
                        INSERT INTO one_time_prekeys (device_id, key_id, public_key)
                        VALUES (?, ?, ?)
                        ON CONFLICT (device_id, key_id) DO NOTHING
                        """,
                keys, keys.size(),
                (ps, key) -> {
                    ps.setObject(1, deviceId);
                    ps.setInt(2, key.keyId());
                    ps.setBytes(3, DECODER.decode(key.publicKey()));
                });
    }

    /**
     * Reports both the unconsumed count and the highest id the server holds. The client needs
     * the latter to pick non-colliding ids for a top-up: its own store is not authoritative,
     * because local key material can be lost or partially written while the server's is not.
     */
    @Transactional(readOnly = true)
    public KeyDtos.PreKeyCount count(UUID deviceId) {
        return new KeyDtos.PreKeyCount(
                (int) oneTimePreKeys.countAvailable(deviceId),
                oneTimePreKeys.maxKeyId(deviceId).orElse(0));
    }

    /**
     * Returns a bundle for every key-registered device of the target user, consuming one one-time
     * prekey per device. Devices that have not finished key registration are omitted rather than
     * returned half-formed -- a sender must never build a session against an incomplete identity.
     */
    @Transactional
    public KeyDtos.UserBundles bundlesFor(UUID userId, UUID onlyDeviceId) {
        List<DeviceDto> targets = devices.findByUser(userId).stream()
                .filter(DeviceDto::hasKeys)
                .filter(d -> onlyDeviceId == null || d.id().equals(onlyDeviceId))
                .toList();

        if (targets.isEmpty()) {
            throw new AppException(ErrorCode.KEYS_NOT_REGISTERED,
                    "This user has no device ready to receive encrypted messages yet");
        }

        List<KeyDtos.DeviceBundle> bundles = new ArrayList<>(targets.size());
        for (DeviceDto device : targets) {
            bundles.add(bundleFor(device));
        }
        return new KeyDtos.UserBundles(userId, bundles);
    }

    private KeyDtos.DeviceBundle bundleFor(DeviceDto device) {
        SignedPreKeyEntity signed = signedPreKeys.findLatest(device.id(), Limit.of(1)).stream()
                .findFirst()
                .orElseThrow(() -> new AppException(ErrorCode.KEYS_NOT_REGISTERED,
                        "Device " + device.id() + " has no signed prekey"));

        KeyDtos.PreKeyDto oneTime = oneTimePreKeys.claimAvailable(device.id(), Limit.of(1)).stream()
                .findFirst()
                .map(k -> {
                    k.consume();
                    return new KeyDtos.PreKeyDto(k.getId().getKeyId(), ENCODER.encodeToString(k.getPublicKey()));
                })
                .orElseGet(() -> {
                    log.warn("Device {} is out of one-time prekeys; falling back to the signed "
                            + "prekey (no forward secrecy on the initial message)", device.id());
                    return null;
                });

        return new KeyDtos.DeviceBundle(
                device.id(),
                device.registrationId(),
                device.identityKey(),
                new KeyDtos.SignedPreKeyDto(
                        signed.getId().getKeyId(),
                        ENCODER.encodeToString(signed.getPublicKey()),
                        ENCODER.encodeToString(signed.getSignature())),
                oneTime);
    }
}
