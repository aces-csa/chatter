package com.chatter.auth.api;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Device lookup for the modules that need it: keys (to attach prekeys), chat (to fan a message
 * out to every recipient device) and the gateway routing table.
 */
public interface DeviceDirectory {

    Optional<DeviceDto> findById(UUID deviceId);

    List<DeviceDto> findByUser(UUID userId);

    /** Every device of every listed user. The fan-out target set for one message. */
    List<DeviceDto> findByUsers(List<UUID> userIds);

    void registerIdentity(UUID deviceId, byte[] identityKey, int registrationId);

    void touch(UUID deviceId);
}
