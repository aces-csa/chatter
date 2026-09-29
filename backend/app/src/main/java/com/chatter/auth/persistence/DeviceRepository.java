package com.chatter.auth.persistence;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface DeviceRepository extends JpaRepository<DeviceEntity, UUID> {

    List<DeviceEntity> findByUserId(UUID userId);

    List<DeviceEntity> findByUserIdIn(List<UUID> userIds);
}
