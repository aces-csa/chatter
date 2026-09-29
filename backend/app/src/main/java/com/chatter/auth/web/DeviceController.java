package com.chatter.auth.web;

import com.chatter.auth.api.DeviceDirectory;
import com.chatter.auth.api.DeviceDto;
import com.chatter.platform.security.CurrentUser;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

/**
 * Devices are auth's data, so this lives in auth even though the URL is nested under /users.
 * Putting it in the user module would make user depend on auth while auth already depends on
 * user, which is a dependency cycle the architecture test rejects -- and rightly, because it
 * would mean neither module could be extracted without the other.
 */
@RestController
@RequestMapping("/api/v1/users/{userId}/devices")
public class DeviceController {

    private final DeviceDirectory devices;

    public DeviceController(DeviceDirectory devices) {
        this.devices = devices;
    }

    /**
     * The device list a sender needs in order to address a message to every one of a recipient's
     * devices. Deliberately separate from the prekey-bundle endpoint: fetching a bundle consumes
     * a one-time prekey, so it must never be called merely to discover which devices exist.
     */
    @GetMapping
    public List<DeviceDto> devicesOf(@PathVariable UUID userId) {
        CurrentUser.require();
        return devices.findByUser(userId).stream().filter(DeviceDto::hasKeys).toList();
    }
}
