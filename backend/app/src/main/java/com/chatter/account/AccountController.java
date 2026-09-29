package com.chatter.account;

import com.chatter.chat.api.ConversationLifecycle;
import com.chatter.platform.security.CurrentUser;
import com.chatter.user.api.UserDirectory;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/**
 * FR-1.6, delete account. Its own module because it spans chat and user, and either of those
 * depending on the other would create the cycle the architecture rules forbid.
 *
 * <p>The user row goes last and takes devices, keys, refresh tokens, contacts, blocks and
 * privacy settings with it through ON DELETE CASCADE. One transaction: an account is either
 * fully gone or fully intact, never half-removed.
 */
@RestController
@RequestMapping("/api/v1/me")
public class AccountController {

    private static final Logger log = LoggerFactory.getLogger(AccountController.class);

    private final ConversationLifecycle conversations;
    private final UserDirectory users;

    private final com.chatter.auth.api.DeviceDirectory devices;
    private final com.chatter.platform.security.RevokedDevices revoked;
    private final org.springframework.context.ApplicationEventPublisher events;

    public AccountController(ConversationLifecycle conversations, UserDirectory users,
                             com.chatter.auth.api.DeviceDirectory devices,
                             com.chatter.platform.security.RevokedDevices revoked,
                             org.springframework.context.ApplicationEventPublisher events) {
        this.conversations = conversations;
        this.users = users;
        this.devices = devices;
        this.revoked = revoked;
        this.events = events;
    }

    @DeleteMapping
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Transactional
    public void deleteAccount() {
        UUID userId = CurrentUser.require().userId();
        // Every device's access token stops working now, and every open socket is told --
        // including the other devices of the person deleting, who would otherwise keep chatting
        // on an account that no longer exists for up to 15 minutes.
        for (var device : devices.findByUser(userId)) {
            revoked.mark(device.id());
            events.publishEvent(new com.chatter.auth.api.DeviceRevokedEvent(userId, device.id()));
        }
        conversations.removeUserEverywhere(userId);
        users.delete(userId);
        // Audit trail for an irreversible action (NFR-8), without the phone number.
        log.info("Account {} deleted at the owner's request", userId);
    }
}
