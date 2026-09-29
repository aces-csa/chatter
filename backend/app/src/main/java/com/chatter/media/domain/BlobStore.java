package com.chatter.media.domain;

import java.time.Duration;
import java.util.List;

/**
 * Object storage, reduced to what media needs: multipart uploads the browser performs itself
 * through presigned URLs, and presigned downloads. The app never proxies a byte of media --
 * streaming 100 MB through a servlet thread is an excellent way to produce a heap dump (DD-9).
 */
public interface BlobStore {

    record CompletedPart(int partNumber, String etag) {
    }

    /** @return the multipart upload id */
    String startUpload(String key);

    String presignPart(String key, String uploadId, int partNumber, Duration ttl);

    /** Parts the store already holds, so an interrupted upload resumes rather than restarts. */
    List<CompletedPart> uploadedParts(String key, String uploadId);

    void completeUpload(String key, String uploadId, List<CompletedPart> parts);

    void abortUpload(String key, String uploadId);

    /** @return the object's size in bytes, or -1 if it does not exist */
    long sizeOf(String key);

    String presignDownload(String key, Duration ttl);

    void delete(String key);
}
