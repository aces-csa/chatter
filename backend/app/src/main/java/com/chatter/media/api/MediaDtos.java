package com.chatter.media.api;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Deliberately no mime type, file name or dimensions anywhere here: those live inside the
 * encrypted message. The server learns a size and nothing else about the content.
 */
public final class MediaDtos {

    private MediaDtos() {
    }

    /** @param sizeBytes size of the encrypted blob, not the original file */
    public record StartUploadRequest(@Positive long sizeBytes) {
    }

    public record PartUrl(int partNumber, String url) {
    }

    public record UploadedPart(@Positive int partNumber, @NotBlank String etag) {
    }

    /**
     * Everything the browser needs to upload, or to resume: fresh URLs for every part, and the
     * parts the store already has so they can be skipped.
     */
    public record UploadTicket(UUID mediaId, long sizeBytes, int partSize, List<PartUrl> parts,
                               List<UploadedPart> alreadyUploaded, Instant urlsExpireAt) {
    }

    public record CompleteUploadRequest(@NotEmpty List<@Valid UploadedPart> parts) {
    }

    public record ShareRequest(@NotNull UUID conversationId) {
    }

    public record DownloadUrl(String url, Instant expiresAt) {
    }
}
