package com.chatter.sealed.web;

import com.chatter.auth.api.DeviceDirectory;
import com.chatter.auth.api.DeviceDto;
import com.chatter.common.error.AppException;
import com.chatter.common.error.ErrorCode;
import com.chatter.platform.security.CurrentUser;
import com.chatter.sealed.api.SealedDtos;
import com.chatter.sealed.domain.SealedMessageService;
import com.chatter.sealed.domain.SenderCertificates;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

/**
 * Sealed sender endpoints. Only {@code POST /deliver/{userId}} and the trust root are public;
 * everything else is a device acting on its own behalf.
 */
@RestController
@RequestMapping("/api/v1/sealed")
public class SealedController {

    /** Signal's header name, kept so the protocol reads the same as the original. */
    static final String ACCESS_KEY_HEADER = "Unidentified-Access-Key";

    private final SealedMessageService sealed;
    private final SenderCertificates certificates;
    private final DeviceDirectory devices;

    public SealedController(SealedMessageService sealed, SenderCertificates certificates, DeviceDirectory devices) {
        this.sealed = sealed;
        this.certificates = certificates;
        this.devices = devices;
    }

    /** Public. Deliberately reads nothing about the caller: there is no caller to read. */
    @PostMapping("/deliver/{recipientUserId}")
    public SealedDtos.SealedSendResult deliver(@PathVariable UUID recipientUserId,
                                               @RequestHeader(value = ACCESS_KEY_HEADER, required = false) String accessKey,
                                               @Valid @RequestBody SealedDtos.SealedSendRequest request) {
        return sealed.deliverUnidentified(recipientUserId, accessKey, request.targets());
    }

    @PostMapping("/self")
    public SealedDtos.SealedSendResult deliverToOwnDevices(@Valid @RequestBody SealedDtos.SealedSendRequest request) {
        CurrentUser me = CurrentUser.require();
        return sealed.deliverToOwnDevices(me.userId(), me.deviceId(), request.targets());
    }

    @GetMapping("/messages")
    public List<SealedDtos.PendingSealed> pending() {
        return sealed.pending(CurrentUser.require().deviceId());
    }

    @PostMapping("/messages/ack")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void acknowledge(@Valid @RequestBody SealedDtos.AckRequest request) {
        sealed.acknowledge(CurrentUser.require().deviceId(), request.ids());
    }

    @GetMapping("/access-key")
    public SealedDtos.AccessKey accessKey() {
        return sealed.accessKey(CurrentUser.require().userId())
                .map(SealedDtos.AccessKey::new)
                .orElseThrow(() -> AppException.notFound("Access key"));
    }

    @PutMapping("/access-key")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void setAccessKey(@Valid @RequestBody SealedDtos.AccessKey request) {
        sealed.setAccessKey(CurrentUser.require().userId(), request.accessKey());
    }

    /** Binds this device's registered identity key; a device without keys cannot send sealed. */
    @GetMapping("/certificate")
    public SealedDtos.SenderCertificate certificate() {
        CurrentUser me = CurrentUser.require();
        DeviceDto device = devices.findById(me.deviceId())
                .filter(d -> d.identityKey() != null)
                .orElseThrow(() -> new AppException(ErrorCode.KEYS_NOT_REGISTERED, "Register keys first"));
        return certificates.issue(me.userId(), me.deviceId(), device.identityKey());
    }

    @GetMapping("/trust-root")
    public SealedDtos.TrustRoot trustRoot() {
        return new SealedDtos.TrustRoot(certificates.trustRoot());
    }
}
