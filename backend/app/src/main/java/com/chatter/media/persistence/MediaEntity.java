package com.chatter.media.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "media")
public class MediaEntity {

    public static final String PENDING = "PENDING";
    public static final String UPLOADED = "UPLOADED";

    @Id
    private UUID id;

    @Column(name = "owner_id", nullable = false)
    private UUID ownerId;

    @Column(name = "object_key", nullable = false)
    private String objectKey;

    @Column(name = "upload_id")
    private String uploadId;

    @Column(name = "size_bytes", nullable = false)
    private long sizeBytes;

    @Column(name = "part_size", nullable = false)
    private int partSize;

    @Column(nullable = false)
    private String state;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "completed_at")
    private Instant completedAt;

    protected MediaEntity() {
    }

    public MediaEntity(UUID id, UUID ownerId, String objectKey, String uploadId, long sizeBytes,
                       int partSize) {
        this.id = id;
        this.ownerId = ownerId;
        this.objectKey = objectKey;
        this.uploadId = uploadId;
        this.sizeBytes = sizeBytes;
        this.partSize = partSize;
        this.state = PENDING;
    }

    public UUID getId() {
        return id;
    }

    public UUID getOwnerId() {
        return ownerId;
    }

    public String getObjectKey() {
        return objectKey;
    }

    public String getUploadId() {
        return uploadId;
    }

    public long getSizeBytes() {
        return sizeBytes;
    }

    public int getPartSize() {
        return partSize;
    }

    public int partCount() {
        return (int) ((sizeBytes + partSize - 1) / partSize);
    }

    public boolean isPending() {
        return PENDING.equals(state);
    }

    public boolean isUploaded() {
        return UPLOADED.equals(state);
    }

    public void markUploaded() {
        this.state = UPLOADED;
        this.uploadId = null;
        this.completedAt = Instant.now();
    }
}
