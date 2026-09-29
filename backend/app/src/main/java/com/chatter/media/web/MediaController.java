package com.chatter.media.web;

import com.chatter.media.api.MediaDtos;
import com.chatter.media.domain.MediaService;
import com.chatter.platform.ratelimit.Limits;
import com.chatter.platform.ratelimit.RateLimiter;
import com.chatter.platform.security.CurrentUser;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/** LLD 5.4 media endpoints. Metadata and URLs only; no media bytes pass through here. */
@RestController
@RequestMapping("/api/v1/media")
public class MediaController {

    private final MediaService media;

    private final RateLimiter limiter;

    public MediaController(MediaService media, RateLimiter limiter) {
        this.media = media;
        this.limiter = limiter;
    }

    @PostMapping("/uploads")
    public MediaDtos.UploadTicket start(@Valid @RequestBody MediaDtos.StartUploadRequest request) {
        limiter.check(Limits.MEDIA_UPLOADS, me().toString());
        return media.startUpload(me(), request.sizeBytes());
    }

    @GetMapping("/{id}/upload")
    public MediaDtos.UploadTicket resume(@PathVariable UUID id) {
        return media.resumeUpload(me(), id);
    }

    @PostMapping("/{id}/complete")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void complete(@PathVariable UUID id,
                         @Valid @RequestBody MediaDtos.CompleteUploadRequest request) {
        media.completeUpload(me(), id, request.parts());
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void discard(@PathVariable UUID id) {
        media.discard(me(), id);
    }

    @PostMapping("/{id}/share")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void share(@PathVariable UUID id, @Valid @RequestBody MediaDtos.ShareRequest request) {
        media.share(me(), id, request.conversationId());
    }

    @GetMapping("/{id}/url")
    public MediaDtos.DownloadUrl url(@PathVariable UUID id) {
        return media.downloadUrl(me(), id);
    }

    private static UUID me() {
        return CurrentUser.require().userId();
    }
}
