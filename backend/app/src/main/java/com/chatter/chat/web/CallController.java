package com.chatter.chat.web;

import com.chatter.chat.domain.CallService;
import com.chatter.common.wire.Frames;
import com.chatter.platform.security.CurrentUser;
import jakarta.validation.constraints.NotNull;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Calls: the gateway's internal surface (join / leave / signal / disconnect), plus the ICE
 * server list clients need to set up peer connections.
 */
@RestController
public class CallController {

    private final CallService calls;
    private final List<String> iceServers;

    public CallController(CallService calls,
                          @Value("${chatter.calls.ice-servers:stun:stun.l.google.com:19302}") List<String> iceServers) {
        this.calls = calls;
        this.iceServers = iceServers;
    }

    /**
     * STUN only by default. Peers behind symmetric NAT (common on mobile networks and corporate
     * Wi-Fi) also need a TURN relay; add one here, e.g. a coturn instance with time-limited
     * credentials, and it reaches every client without a frontend change.
     */
    @GetMapping("/api/v1/calls/ice-servers")
    public List<Map<String, Object>> iceServers() {
        CurrentUser.require();
        return iceServers.stream().map(url -> Map.<String, Object>of("urls", url.trim())).toList();
    }

    public record Who(@NotNull UUID userId, @NotNull UUID deviceId) {
    }

    public record JoinRequest(@NotNull UUID userId, @NotNull UUID deviceId, @NotNull UUID conversationId,
                              boolean video) {
    }

    public record LeaveRequest(@NotNull UUID userId, @NotNull UUID deviceId, @NotNull UUID conversationId) {
    }

    public record SignalRequest(@NotNull UUID userId, @NotNull UUID deviceId, @NotNull Frames.CallSignal signal) {
    }

    @PostMapping("/internal/v1/calls/join")
    public List<Frames.CallParticipant> join(@RequestBody JoinRequest request) {
        return calls.join(request.userId(), request.deviceId(), request.conversationId(), request.video());
    }

    @PostMapping("/internal/v1/calls/leave")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void leave(@RequestBody LeaveRequest request) {
        calls.leave(request.userId(), request.deviceId(), request.conversationId());
    }

    @PostMapping("/internal/v1/calls/signal")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void signal(@RequestBody SignalRequest request) {
        calls.signal(request.userId(), request.deviceId(), request.signal());
    }

    @PostMapping("/internal/v1/calls/disconnected")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void disconnected(@RequestBody Who who) {
        calls.disconnected(who.userId(), who.deviceId());
    }
}
