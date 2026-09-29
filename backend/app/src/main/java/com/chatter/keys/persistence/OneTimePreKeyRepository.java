package com.chatter.keys.persistence;

import jakarta.persistence.LockModeType;
import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface OneTimePreKeyRepository extends JpaRepository<OneTimePreKeyEntity, DeviceKeyId> {

    /**
     * Claims unconsumed prekeys under a row lock. Without the lock, two simultaneous bundle
     * fetches could hand the same one-time key to two senders, which silently breaks forward
     * secrecy for those sessions -- a failure with no visible symptom, so it has to be prevented
     * rather than detected.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select k from OneTimePreKeyEntity k "
            + "where k.id.deviceId = :deviceId and k.consumedAt is null order by k.id.keyId")
    List<OneTimePreKeyEntity> claimAvailable(@Param("deviceId") UUID deviceId, Limit limit);

    @Query("select count(k) from OneTimePreKeyEntity k "
            + "where k.id.deviceId = :deviceId and k.consumedAt is null")
    long countAvailable(@Param("deviceId") UUID deviceId);

    @Query("select max(k.id.keyId) from OneTimePreKeyEntity k where k.id.deviceId = :deviceId")
    Optional<Integer> maxKeyId(@Param("deviceId") UUID deviceId);
}
