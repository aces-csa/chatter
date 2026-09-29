package com.chatter.user.api;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * The only way other modules reach user data. Keeping this an interface is what lets the user
 * module become a separate service later without touching a single call site.
 */
public interface UserDirectory {

    Optional<UserDto> findById(UUID userId);

    List<UserDto> findByIds(List<UUID> userIds);

    /** Creates the user on first sight of a verified phone number, or returns the existing one. */
    UserDto findOrCreateByPhone(String phoneE164, String displayName);

    List<UserDto> findByPhoneHashes(List<byte[]> hashes);

    /**
     * Removes the account. Devices, keys, sessions, contacts, blocks and privacy settings go
     * with it by cascade. Callers must first detach the user from anything that does not cascade.
     */
    void delete(UUID userId);
}
