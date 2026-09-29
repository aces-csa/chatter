package com.chatter.platform.ratelimit;

import com.chatter.platform.ratelimit.RateLimiter.Limit;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import java.time.Duration;

/**
 * Every limit in one place, so they can be reviewed together (LLD section 7). Numbers follow the
 * LLD except the per-IP OTP limit, raised from 3 to 20 an hour: carrier-grade NAT puts whole
 * neighbourhoods behind one address, and the per-phone limit is what actually stops SMS pumping.
 */
public final class Limits {

    private Limits() {
    }

    // Unauthenticated endpoints: keyed by IP, because there is no one else to key them by.
    public static final Limit OTP_PER_PHONE = new Limit("otp-phone", 5, Duration.ofHours(1));
    public static final Limit OTP_PER_IP = new Limit("otp-ip", 20, Duration.ofHours(1));
    /** OTP guessing across many tokens: each token allows 5 attempts, this caps the tokens. */
    public static final Limit VERIFY_PER_IP = new Limit("verify-ip", 30, Duration.ofHours(1));
    public static final Limit REFRESH_PER_IP = new Limit("refresh-ip", 120, Duration.ofMinutes(1));
    public static final Limit LINK_START_PER_IP = new Limit("link-start-ip", 10, Duration.ofHours(1));
    /** Polling every 2 s is 30 a minute; room for a few tabs. */
    public static final Limit LINK_CLAIM_PER_IP = new Limit("link-claim-ip", 120, Duration.ofMinutes(1));

    // Authenticated endpoints: keyed by user or device.
    public static final Limit LINK_APPROVE = new Limit("link-approve", 10, Duration.ofHours(1));
    /** Contact sync is how phone numbers get enumerated; the HLD says rate-limit it hard. */
    public static final Limit CONTACT_SYNC = new Limit("contact-sync", 30, Duration.ofHours(1));
    /** Each bundle fetch consumes a one-time prekey; unlimited fetches would drain a victim's. */
    public static final Limit PREKEY_BUNDLES = new Limit("prekey-bundle", 300, Duration.ofHours(1));
    public static final Limit MEDIA_UPLOADS = new Limit("media-upload", 100, Duration.ofHours(1));
    public static final Limit GROUP_CREATE = new Limit("group-create", 20, Duration.ofDays(1));
    public static final Limit INVITE_LOOKUP = new Limit("invite", 30, Duration.ofHours(1));
    public static final Limit PUSH_SUBSCRIBE = new Limit("push-subscribe", 20, Duration.ofHours(1));
    /**
     * 30 messages a second per device, with a burst of 100 so an offline outbox flushing on
     * reconnect is not immediately throttled into repeated retries.
     */
    public static final Limit SEND_PER_DEVICE = new Limit("send", 100, Duration.ofMillis(3_333));

    /**
     * The caller's address. Behind a proxy, set server.forward-headers-strategy so this reflects
     * X-Forwarded-For -- and only then, or clients could forge their own address.
     */
    public static String clientIp() {
        if (RequestContextHolder.getRequestAttributes() instanceof ServletRequestAttributes attributes) {
            return attributes.getRequest().getRemoteAddr();
        }
        return "unknown";
    }
}
