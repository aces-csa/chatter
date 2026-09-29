package com.chatter.user.api;

import java.util.UUID;

/** @param avatar small profile photo as a data URL, or null (unset, or hidden by privacy) */
public record UserDto(UUID id, String phoneE164, String displayName, String about, UUID avatarMediaId,
                      String avatar) {
}
