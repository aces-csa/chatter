package com.chatter.user.domain;

import com.chatter.common.Ids;
import com.chatter.user.api.UserDirectory;
import com.chatter.user.api.UserDto;
import com.chatter.user.persistence.UserEntity;
import com.chatter.user.persistence.UserRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Service
public class UserDirectoryImpl implements UserDirectory {

    private final UserRepository repository;
    private final PhoneHasher phoneHasher;

    public UserDirectoryImpl(UserRepository repository, PhoneHasher phoneHasher) {
        this.repository = repository;
        this.phoneHasher = phoneHasher;
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<UserDto> findById(UUID userId) {
        return repository.findById(userId).map(UserDirectoryImpl::toDto);
    }

    @Override
    @Transactional
    public void delete(UUID userId) {
        repository.deleteById(userId);
        repository.flush();
    }

    @Override
    @Transactional(readOnly = true)
    public List<UserDto> findByIds(List<UUID> userIds) {
        return repository.findAllById(userIds).stream().map(UserDirectoryImpl::toDto).toList();
    }

    @Override
    @Transactional
    public UserDto findOrCreateByPhone(String phoneE164, String displayName) {
        return repository.findByPhoneE164(phoneE164)
                .map(UserDirectoryImpl::toDto)
                .orElseGet(() -> {
                    UserEntity created = new UserEntity(
                            Ids.next(), phoneE164, phoneHasher.hash(phoneE164),
                            displayName == null || displayName.isBlank() ? phoneE164 : displayName);
                    return toDto(repository.save(created));
                });
    }

    @Override
    @Transactional(readOnly = true)
    public List<UserDto> findByPhoneHashes(List<byte[]> hashes) {
        if (hashes.isEmpty()) {
            return List.of();
        }
        return repository.findByPhoneHashIn(hashes).stream().map(UserDirectoryImpl::toDto).toList();
    }

    private static UserDto toDto(UserEntity e) {
        return new UserDto(e.getId(), e.getPhoneE164(), e.getDisplayName(), e.getAbout(),
                e.getAvatarMediaId(), e.getAvatarData());
    }
}
