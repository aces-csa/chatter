package com.chatter.keys.persistence;

import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.UUID;

public interface SignedPreKeyRepository extends JpaRepository<SignedPreKeyEntity, DeviceKeyId> {

    @Query("select s from SignedPreKeyEntity s where s.id.deviceId = :deviceId "
            + "order by s.createdAt desc")
    List<SignedPreKeyEntity> findLatest(@Param("deviceId") UUID deviceId, Limit limit);
}
