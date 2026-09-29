package com.chatter.user.persistence;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface UserRepository extends JpaRepository<UserEntity, UUID> {

    Optional<UserEntity> findByPhoneE164(String phoneE164);

    List<UserEntity> findByPhoneHashIn(List<byte[]> hashes);
}
