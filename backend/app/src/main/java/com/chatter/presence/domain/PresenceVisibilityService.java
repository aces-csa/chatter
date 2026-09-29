package com.chatter.presence.domain;

import com.chatter.presence.api.PresenceDtos;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Decides whose presence a given viewer is allowed to see.
 *
 * <p>Enforced server-side on purpose. A client-side filter would mean the data still crossed the
 * wire, so "nobody" would be a suggestion rather than a setting.
 */
@Service
public class PresenceVisibilityService {

    private static final String EVERYONE = "everyone";
    private static final String CONTACTS = "contacts";

    private final JdbcTemplate jdbc;

    public PresenceVisibilityService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Transactional(readOnly = true)
    public PresenceDtos.VisibilityResponse resolve(UUID viewerId, List<UUID> userIds) {
        List<UUID> distinct = userIds.stream().distinct().toList();
        if (distinct.isEmpty()) {
            return new PresenceDtos.VisibilityResponse(List.of(), List.of());
        }

        Set<UUID> blocked = blockedEitherWay(viewerId, distinct);
        Map<UUID, String> lastSeenPolicy = lastSeenPolicies(distinct);
        Set<UUID> haveViewerAsContact = whoHasViewerAsContact(viewerId, distinct);

        List<UUID> onlineVisible = new ArrayList<>();
        List<UUID> lastSeenVisible = new ArrayList<>();

        for (UUID userId : distinct) {
            if (userId.equals(viewerId)) {
                // Your own devices always see each other; that is what multi-device sync looks like.
                onlineVisible.add(userId);
                lastSeenVisible.add(userId);
                continue;
            }
            if (blocked.contains(userId)) {
                continue;
            }

            String policy = lastSeenPolicy.getOrDefault(userId, EVERYONE);
            boolean visible = switch (policy) {
                case EVERYONE -> true;
                case CONTACTS -> haveViewerAsContact.contains(userId);
                default -> false;   // "nobody"
            };

            if (visible) {
                onlineVisible.add(userId);
                lastSeenVisible.add(userId);
            }
        }

        return new PresenceDtos.VisibilityResponse(onlineVisible, lastSeenVisible);
    }

    /** A block hides presence in both directions, not only from the blocked party. */
    private Set<UUID> blockedEitherWay(UUID viewerId, List<UUID> userIds) {
        String in = placeholders(userIds.size());
        List<Object> args = new ArrayList<>();
        args.add(viewerId);
        args.addAll(userIds);
        args.add(viewerId);
        args.addAll(userIds);

        return new HashSet<>(jdbc.queryForList(
                "SELECT blocked_id FROM blocks WHERE blocker_id = ? AND blocked_id IN (" + in + ") "
                        + "UNION "
                        + "SELECT blocker_id FROM blocks WHERE blocked_id = ? AND blocker_id IN (" + in + ")",
                UUID.class, args.toArray()));
    }

    private Map<UUID, String> lastSeenPolicies(List<UUID> userIds) {
        return jdbc.query(
                "SELECT user_id, last_seen FROM user_privacy WHERE user_id IN ("
                        + placeholders(userIds.size()) + ")",
                rs -> {
                    Map<UUID, String> out = new HashMap<>();
                    while (rs.next()) {
                        out.put(rs.getObject("user_id", UUID.class), rs.getString("last_seen"));
                    }
                    return out;
                },
                userIds.toArray());
    }

    /** "Contacts" means the target has the viewer in their contact list, not the reverse. */
    private Set<UUID> whoHasViewerAsContact(UUID viewerId, List<UUID> userIds) {
        List<Object> args = new ArrayList<>();
        args.add(viewerId);
        args.addAll(userIds);

        return jdbc.queryForList(
                        "SELECT owner_id FROM contacts WHERE contact_id = ? AND owner_id IN ("
                                + placeholders(userIds.size()) + ")",
                        UUID.class, args.toArray())
                .stream().collect(Collectors.toSet());
    }

    private static String placeholders(int count) {
        return String.join(",", java.util.Collections.nCopies(count, "?"));
    }
}
