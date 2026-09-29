package com.chatter.user.domain;

import com.chatter.common.error.AppException;
import com.chatter.common.error.ErrorCode;
import com.chatter.user.api.PrivacyDirectory;
import com.chatter.user.api.UserDto;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Profile editing (FR-1.4), privacy settings and blocking (FR-2.2-2.4), quiet hours (FR-8.4).
 *
 * <p>Plain JDBC: these are small keyed reads and upserts, several of them batched over many users
 * on hot paths (fan-out, push), where a query per user would be the cost.
 */
@Service
public class ProfileService implements PrivacyDirectory {

    public static final Set<String> AUDIENCES = Set.of("everyone", "contacts", "nobody");
    private static final int MAX_AVATAR_CHARS = 140_000;

    private final JdbcTemplate jdbc;

    public ProfileService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record Privacy(String lastSeen, String profilePhoto, String about, boolean readReceipts,
                          Integer quietStart, Integer quietEnd, String timeZone) {
    }

    @Transactional
    public void updateProfile(UUID userId, String displayName, String about, String avatar, boolean clearAvatar) {
        if (displayName != null) {
            if (displayName.isBlank() || displayName.length() > 64) {
                throw new AppException(ErrorCode.VALIDATION_FAILED, "Name must be 1-64 characters");
            }
            jdbc.update("UPDATE users SET display_name = ?, updated_at = now() WHERE id = ?", displayName.trim(), userId);
        }
        if (about != null) {
            if (about.length() > 160) {
                throw new AppException(ErrorCode.VALIDATION_FAILED, "About can be at most 160 characters");
            }
            jdbc.update("UPDATE users SET about = ?, updated_at = now() WHERE id = ?", about, userId);
        }
        if (clearAvatar) {
            jdbc.update("UPDATE users SET avatar_data = NULL, updated_at = now() WHERE id = ?", userId);
        } else if (avatar != null) {
            // A data URL of a small JPEG/PNG/WebP made by the client; anything else is refused
            // so this column can never carry script or markup.
            if (!avatar.matches("^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$") || avatar.length() > MAX_AVATAR_CHARS) {
                throw new AppException(ErrorCode.VALIDATION_FAILED, "Profile photo must be a small JPEG, PNG or WebP");
            }
            jdbc.update("UPDATE users SET avatar_data = ?, updated_at = now() WHERE id = ?", avatar, userId);
        }
    }

    public Privacy privacy(UUID userId) {
        List<Privacy> rows = jdbc.query("""
                        SELECT last_seen, profile_photo, about_visibility, read_receipts, quiet_start, quiet_end, time_zone
                        FROM user_privacy WHERE user_id = ?
                        """,
                (rs, n) -> new Privacy(rs.getString(1), rs.getString(2), rs.getString(3), rs.getBoolean(4),
                        (Integer) rs.getObject(5), (Integer) rs.getObject(6), rs.getString(7)),
                userId);
        return rows.isEmpty() ? new Privacy("everyone", "everyone", "everyone", true, null, null, null) : rows.getFirst();
    }

    @Transactional
    public Privacy updatePrivacy(UUID userId, Privacy p) {
        for (String audience : List.of(p.lastSeen(), p.profilePhoto(), p.about())) {
            if (!AUDIENCES.contains(audience)) {
                throw new AppException(ErrorCode.VALIDATION_FAILED, "Audience must be everyone, contacts or nobody");
            }
        }
        boolean quietSet = p.quietStart() != null || p.quietEnd() != null;
        if (quietSet) {
            if (p.quietStart() == null || p.quietEnd() == null || outOfDay(p.quietStart()) || outOfDay(p.quietEnd())) {
                throw new AppException(ErrorCode.VALIDATION_FAILED, "Quiet hours need a start and end within the day");
            }
            try {
                ZoneId.of(p.timeZone());
            } catch (Exception e) {
                throw new AppException(ErrorCode.VALIDATION_FAILED, "Unknown time zone");
            }
        }
        jdbc.update("""
                        INSERT INTO user_privacy (user_id, last_seen, profile_photo, about_visibility, read_receipts,
                                                  quiet_start, quiet_end, time_zone)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT (user_id) DO UPDATE SET
                            last_seen = EXCLUDED.last_seen, profile_photo = EXCLUDED.profile_photo,
                            about_visibility = EXCLUDED.about_visibility, read_receipts = EXCLUDED.read_receipts,
                            quiet_start = EXCLUDED.quiet_start, quiet_end = EXCLUDED.quiet_end,
                            time_zone = EXCLUDED.time_zone
                        """,
                userId, p.lastSeen(), p.profilePhoto(), p.about(), p.readReceipts(),
                quietSet ? p.quietStart() : null, quietSet ? p.quietEnd() : null, quietSet ? p.timeZone() : null);
        return privacy(userId);
    }

    /**
     * A profile as {@code viewer} may see it: photo and about follow the owner's audience
     * settings, and either side having blocked the other hides both.
     */
    public UserDto visibleTo(UUID viewer, UserDto user) {
        if (viewer.equals(user.id())) {
            return user;
        }
        Privacy p = privacy(user.id());
        boolean blocked = isBlocked(user.id(), viewer) || isBlocked(viewer, user.id());
        boolean contact = Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM contacts WHERE owner_id = ? AND contact_id = ?)",
                Boolean.class, user.id(), viewer));
        boolean showAbout = !blocked && allowed(p.about(), contact);
        boolean showPhoto = !blocked && allowed(p.profilePhoto(), contact);
        return new UserDto(user.id(), user.phoneE164(), user.displayName(),
                showAbout ? user.about() : null, user.avatarMediaId(), showPhoto ? user.avatar() : null);
    }

    private static boolean allowed(String audience, boolean contact) {
        return "everyone".equals(audience) || ("contacts".equals(audience) && contact);
    }

    /** Contact sync records who you found, which is what "my contacts" privacy refers to. */
    public void rememberContacts(UUID owner, Collection<UUID> contacts) {
        for (UUID contact : contacts) {
            jdbc.update("INSERT INTO contacts (owner_id, contact_id) VALUES (?, ?) ON CONFLICT DO NOTHING", owner, contact);
        }
    }

    public void block(UUID blocker, UUID blocked) {
        if (blocker.equals(blocked)) {
            throw new AppException(ErrorCode.VALIDATION_FAILED, "You cannot block yourself");
        }
        jdbc.update("INSERT INTO blocks (blocker_id, blocked_id) VALUES (?, ?) ON CONFLICT DO NOTHING", blocker, blocked);
    }

    public void unblock(UUID blocker, UUID blocked) {
        jdbc.update("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?", blocker, blocked);
    }

    public List<UUID> blockedBy(UUID blocker) {
        return jdbc.queryForList("SELECT blocked_id FROM blocks WHERE blocker_id = ?", UUID.class, blocker);
    }

    @Override
    public boolean isBlocked(UUID blocker, UUID blocked) {
        return Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?)",
                Boolean.class, blocker, blocked));
    }

    @Override
    public Set<UUID> whoBlocked(UUID sender, Collection<UUID> users) {
        if (users.isEmpty()) {
            return Set.of();
        }
        return new HashSet<>(jdbc.queryForList(
                "SELECT blocker_id FROM blocks WHERE blocked_id = ? AND blocker_id = ANY(?)",
                UUID.class, sender, users.toArray(UUID[]::new)));
    }

    @Override
    public Set<UUID> receiptsDisabled(Collection<UUID> users) {
        if (users.isEmpty()) {
            return Set.of();
        }
        return new HashSet<>(jdbc.queryForList(
                "SELECT user_id FROM user_privacy WHERE read_receipts = false AND user_id = ANY(?)",
                UUID.class, (Object) users.toArray(UUID[]::new)));
    }

    @Override
    public Set<UUID> inQuietHours(Collection<UUID> users, Instant now) {
        if (users.isEmpty()) {
            return Set.of();
        }
        Map<UUID, int[]> windows = new java.util.HashMap<>();
        Map<UUID, String> zones = new java.util.HashMap<>();
        jdbc.query("""
                        SELECT user_id, quiet_start, quiet_end, time_zone FROM user_privacy
                        WHERE quiet_start IS NOT NULL AND user_id = ANY(?)
                        """,
                rs -> {
                    UUID id = rs.getObject(1, UUID.class);
                    windows.put(id, new int[]{rs.getInt(2), rs.getInt(3)});
                    zones.put(id, rs.getString(4));
                },
                (Object) users.toArray(UUID[]::new));
        return windows.entrySet().stream().filter(e -> {
            LocalTime local = now.atZone(ZoneId.of(zones.get(e.getKey()))).toLocalTime();
            int minute = local.getHour() * 60 + local.getMinute();
            int start = e.getValue()[0];
            int end = e.getValue()[1];
            // A window like 22:00-07:00 wraps midnight.
            return start <= end ? minute >= start && minute < end : minute >= start || minute < end;
        }).map(Map.Entry::getKey).collect(Collectors.toSet());
    }

    private static boolean outOfDay(int minute) {
        return minute < 0 || minute >= 24 * 60;
    }
}
