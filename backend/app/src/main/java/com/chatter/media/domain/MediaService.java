package com.chatter.media.domain;

import com.chatter.chat.api.ConversationMembership;
import com.chatter.common.Ids;
import com.chatter.common.error.AppException;
import com.chatter.common.error.ErrorCode;
import com.chatter.media.api.MediaDtos;
import com.chatter.media.persistence.MediaEntity;
import com.chatter.media.persistence.MediaRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

/**
 * Upload tickets, completion, sharing and download URLs (LLD DD-9, FR-5).
 *
 * <p>Access model: the uploader can always fetch their blob; anyone else must be an active member
 * of a conversation it was shared into. The blob is ciphertext either way -- the key travels only
 * inside the end-to-end encrypted message -- so this check limits who can pull bytes and learn
 * sizes, not who can read content.
 */
@Service
public class MediaService {

    private static final Logger log = LoggerFactory.getLogger(MediaService.class);

    /** 100 MB of content (FR-5.2/5.3) plus room for the IV and MAC the client adds. */
    public static final long MAX_BYTES = 100L * 1024 * 1024 + 1024;
    /** S3's minimum part size for every part but the last. */
    private static final int PART_SIZE = 5 * 1024 * 1024;
    private static final Duration UPLOAD_URL_TTL = Duration.ofHours(1);
    private static final Duration DOWNLOAD_URL_TTL = Duration.ofMinutes(5);
    private static final Duration ABANDON_AFTER = Duration.ofHours(24);

    private final MediaRepository media;
    private final BlobStore store;
    private final ConversationMembership membership;
    private final JdbcTemplate jdbc;

    public MediaService(MediaRepository media, BlobStore store, ConversationMembership membership,
                        JdbcTemplate jdbc) {
        this.media = media;
        this.store = store;
        this.membership = membership;
        this.jdbc = jdbc;
    }

    @Transactional
    public MediaDtos.UploadTicket startUpload(UUID ownerId, long sizeBytes) {
        if (sizeBytes <= 0 || sizeBytes > MAX_BYTES) {
            throw new AppException(ErrorCode.VALIDATION_FAILED, "Files can be at most 100 MB");
        }
        UUID id = Ids.next();
        String key = "m/" + id;
        String uploadId = store.startUpload(key);
        MediaEntity entity = media.save(new MediaEntity(id, ownerId, key, uploadId, sizeBytes, PART_SIZE));
        return ticket(entity, List.of());
    }

    /** Fresh URLs plus what is already stored: an upload survives a reload or a dropped network. */
    @Transactional(readOnly = true)
    public MediaDtos.UploadTicket resumeUpload(UUID ownerId, UUID mediaId) {
        MediaEntity entity = owned(ownerId, mediaId);
        if (!entity.isPending()) {
            throw new AppException(ErrorCode.VALIDATION_FAILED, "Upload already finished");
        }
        List<MediaDtos.UploadedPart> done = store.uploadedParts(entity.getObjectKey(), entity.getUploadId())
                .stream()
                .map(p -> new MediaDtos.UploadedPart(p.partNumber(), p.etag()))
                .toList();
        return ticket(entity, done);
    }

    @Transactional
    public void completeUpload(UUID ownerId, UUID mediaId, List<MediaDtos.UploadedPart> parts) {
        MediaEntity entity = owned(ownerId, mediaId);
        if (entity.isUploaded()) {
            return; // a retried complete after a lost response
        }
        Set<Integer> numbers = parts.stream().map(MediaDtos.UploadedPart::partNumber).collect(Collectors.toSet());
        if (numbers.size() != entity.partCount() || !numbers.equals(
                IntStream.rangeClosed(1, entity.partCount()).boxed().collect(Collectors.toSet()))) {
            throw new AppException(ErrorCode.VALIDATION_FAILED, "Upload is missing parts");
        }
        store.completeUpload(entity.getObjectKey(), entity.getUploadId(), parts.stream()
                .sorted(Comparator.comparingInt(MediaDtos.UploadedPart::partNumber))
                .map(p -> new BlobStore.CompletedPart(p.partNumber(), p.etag()))
                .toList());

        // The ticket was issued for a declared size; hold the client to it, or the 100 MB limit
        // would only apply to what people claim rather than what they store.
        long actual = store.sizeOf(entity.getObjectKey());
        if (actual != entity.getSizeBytes()) {
            store.delete(entity.getObjectKey());
            media.delete(entity);
            throw new AppException(ErrorCode.VALIDATION_FAILED, "Uploaded size does not match the ticket");
        }
        entity.markUploaded();
    }

    /** Cancel: frees the partial upload, or an uploaded blob that was never shared. */
    @Transactional
    public void discard(UUID ownerId, UUID mediaId) {
        MediaEntity entity = owned(ownerId, mediaId);
        if (entity.isPending()) {
            store.abortUpload(entity.getObjectKey(), entity.getUploadId());
        } else if (linkedConversations(mediaId).isEmpty()) {
            store.delete(entity.getObjectKey());
        } else {
            throw new AppException(ErrorCode.VALIDATION_FAILED, "Already shared; it cannot be withdrawn");
        }
        media.delete(entity);
    }

    /**
     * Makes a blob fetchable by a conversation's members. Called by the sender before the message
     * goes out, and again by anyone forwarding it: they may share what they can already read into
     * any conversation they belong to.
     */
    @Transactional
    public void share(UUID userId, UUID mediaId, UUID conversationId) {
        MediaEntity entity = uploaded(mediaId);
        requireAccess(userId, entity);
        membership.assertMember(userId, conversationId);
        jdbc.update("""
                        INSERT INTO media_links (media_id, conversation_id, shared_by)
                        VALUES (?, ?, ?)
                        ON CONFLICT DO NOTHING
                        """,
                mediaId, conversationId, userId);
    }

    @Transactional(readOnly = true)
    public MediaDtos.DownloadUrl downloadUrl(UUID userId, UUID mediaId) {
        MediaEntity entity = uploaded(mediaId);
        requireAccess(userId, entity);
        return new MediaDtos.DownloadUrl(
                store.presignDownload(entity.getObjectKey(), DOWNLOAD_URL_TTL),
                Instant.now().plus(DOWNLOAD_URL_TTL));
    }

    /** Reaps uploads nobody finished, so a closed tab cannot leave parts accruing storage forever. */
    @Scheduled(fixedDelay = 3_600_000, initialDelay = 300_000)
    @Transactional
    public void reapAbandoned() {
        for (MediaEntity stale : media.findAbandoned(Instant.now().minus(ABANDON_AFTER))) {
            store.abortUpload(stale.getObjectKey(), stale.getUploadId());
            media.delete(stale);
            log.info("Reaped abandoned upload {}", stale.getId());
        }
    }

    private MediaDtos.UploadTicket ticket(MediaEntity entity, List<MediaDtos.UploadedPart> done) {
        Set<Integer> skip = done.stream().map(MediaDtos.UploadedPart::partNumber).collect(Collectors.toSet());
        List<MediaDtos.PartUrl> urls = new ArrayList<>();
        for (int part = 1; part <= entity.partCount(); part++) {
            if (!skip.contains(part)) {
                urls.add(new MediaDtos.PartUrl(part, store.presignPart(
                        entity.getObjectKey(), entity.getUploadId(), part, UPLOAD_URL_TTL)));
            }
        }
        return new MediaDtos.UploadTicket(entity.getId(), entity.getSizeBytes(), entity.getPartSize(),
                urls, done, Instant.now().plus(UPLOAD_URL_TTL));
    }

    private void requireAccess(UUID userId, MediaEntity entity) {
        if (entity.getOwnerId().equals(userId)) {
            return;
        }
        boolean shared = linkedConversations(entity.getId()).stream()
                .anyMatch(conversationId -> membership.isMember(userId, conversationId));
        if (!shared) {
            // Same answer as a missing blob: do not confirm that an id exists to someone who
            // could not fetch it anyway.
            throw AppException.notFound("Media");
        }
    }

    private List<UUID> linkedConversations(UUID mediaId) {
        return jdbc.queryForList("SELECT conversation_id FROM media_links WHERE media_id = ?",
                UUID.class, mediaId);
    }

    private MediaEntity owned(UUID ownerId, UUID mediaId) {
        MediaEntity entity = media.findById(mediaId).orElseThrow(() -> AppException.notFound("Media"));
        if (!entity.getOwnerId().equals(ownerId)) {
            throw AppException.notFound("Media");
        }
        return entity;
    }

    private MediaEntity uploaded(UUID mediaId) {
        MediaEntity entity = media.findById(mediaId).orElseThrow(() -> AppException.notFound("Media"));
        if (!entity.isUploaded()) {
            throw AppException.notFound("Media");
        }
        return entity;
    }
}
