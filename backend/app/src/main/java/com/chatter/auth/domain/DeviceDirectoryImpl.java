package com.chatter.auth.domain;

import com.chatter.auth.api.DeviceDirectory;
import com.chatter.auth.api.DeviceDto;
import com.chatter.auth.persistence.DeviceEntity;
import com.chatter.auth.persistence.DeviceRepository;
import com.chatter.common.error.AppException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Base64;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Service
public class DeviceDirectoryImpl implements DeviceDirectory {

    private final DeviceRepository repository;

    public DeviceDirectoryImpl(DeviceRepository repository) {
        this.repository = repository;
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<DeviceDto> findById(UUID deviceId) {
        return repository.findById(deviceId).map(DeviceDirectoryImpl::toDto);
    }

    @Override
    @Transactional(readOnly = true)
    public List<DeviceDto> findByUser(UUID userId) {
        return repository.findByUserId(userId).stream().map(DeviceDirectoryImpl::toDto).toList();
    }

    @Override
    @Transactional(readOnly = true)
    public List<DeviceDto> findByUsers(List<UUID> userIds) {
        if (userIds.isEmpty()) {
            return List.of();
        }
        return repository.findByUserIdIn(userIds).stream().map(DeviceDirectoryImpl::toDto).toList();
    }

    @Override
    @Transactional
    public void registerIdentity(UUID deviceId, byte[] identityKey, int registrationId) {
        DeviceEntity device = repository.findById(deviceId)
                .orElseThrow(() -> AppException.notFound("Device"));
        device.registerIdentity(identityKey, registrationId);
    }

    @Override
    @Transactional
    public void touch(UUID deviceId) {
        repository.findById(deviceId).ifPresent(DeviceEntity::touch);
    }

    static DeviceDto toDto(DeviceEntity e) {
        return new DeviceDto(
                e.getId(), e.getUserId(), e.getName(), e.hasKeys(),
                e.getIdentityKey() == null
                        ? null
                        : Base64.getEncoder().encodeToString(e.getIdentityKey()),
                e.getRegistrationId(), e.getLastActiveAt(), e.getCreatedAt());
    }
}
