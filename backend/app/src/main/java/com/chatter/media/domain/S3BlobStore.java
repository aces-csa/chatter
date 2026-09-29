package com.chatter.media.domain;

import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.exception.SdkException;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CompletedMultipartUpload;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;
import software.amazon.awssdk.services.s3.model.S3Exception;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;

import java.net.URI;
import java.time.Duration;
import java.util.List;

/**
 * S3 in production, MinIO locally. Path-style addressing because MinIO does not do virtual-host
 * buckets out of the box.
 */
@Component
public class S3BlobStore implements BlobStore {

    private static final Logger log = LoggerFactory.getLogger(S3BlobStore.class);

    private final S3Client s3;
    private final S3Presigner presigner;
    private final String bucket;

    public S3BlobStore(@Value("${chatter.media.endpoint}") String endpoint,
                       @Value("${chatter.media.region}") String region,
                       @Value("${chatter.media.bucket}") String bucket,
                       @Value("${chatter.media.access-key}") String accessKey,
                       @Value("${chatter.media.secret-key}") String secretKey) {
        var credentials = StaticCredentialsProvider.create(
                AwsBasicCredentials.create(accessKey, secretKey));
        var pathStyle = S3Configuration.builder().pathStyleAccessEnabled(true).build();
        this.bucket = bucket;
        this.s3 = S3Client.builder()
                .endpointOverride(URI.create(endpoint))
                .region(Region.of(region))
                .credentialsProvider(credentials)
                .serviceConfiguration(pathStyle)
                .build();
        this.presigner = S3Presigner.builder()
                .endpointOverride(URI.create(endpoint))
                .region(Region.of(region))
                .credentialsProvider(credentials)
                .serviceConfiguration(pathStyle)
                .build();
        ensureBucket();
    }

    /**
     * Creates the bucket on first boot. Failure is logged, not fatal: messaging must still start
     * when object storage is down, with only media unavailable.
     */
    private void ensureBucket() {
        try {
            s3.headBucket(b -> b.bucket(bucket));
        } catch (S3Exception missing) {
            try {
                s3.createBucket(b -> b.bucket(bucket));
                log.info("Created media bucket {}", bucket);
            } catch (SdkException e) {
                log.warn("Media bucket {} unavailable; media uploads will fail until it exists", bucket, e);
            }
        } catch (SdkException e) {
            log.warn("Object storage unreachable; media uploads will fail until it is", e);
        }
    }

    @Override
    public String startUpload(String key) {
        return s3.createMultipartUpload(b -> b.bucket(bucket).key(key)
                .contentType("application/octet-stream")).uploadId();
    }

    @Override
    public String presignPart(String key, String uploadId, int partNumber, Duration ttl) {
        return presigner.presignUploadPart(p -> p
                        .signatureDuration(ttl)
                        .uploadPartRequest(r -> r.bucket(bucket).key(key)
                                .uploadId(uploadId).partNumber(partNumber)))
                .url().toString();
    }

    @Override
    public List<BlobStore.CompletedPart> uploadedParts(String key, String uploadId) {
        return s3.listPartsPaginator(b -> b.bucket(bucket).key(key).uploadId(uploadId))
                .parts().stream()
                .map(p -> new BlobStore.CompletedPart(p.partNumber(), p.eTag()))
                .toList();
    }

    @Override
    public void completeUpload(String key, String uploadId, List<BlobStore.CompletedPart> parts) {
        // Fully qualified: BlobStore.CompletedPart shadows the SDK type inside this class.
        List<software.amazon.awssdk.services.s3.model.CompletedPart> completed = parts.stream()
                .map(p -> software.amazon.awssdk.services.s3.model.CompletedPart.builder()
                        .partNumber(p.partNumber()).eTag(p.etag()).build())
                .toList();
        s3.completeMultipartUpload(b -> b.bucket(bucket).key(key).uploadId(uploadId)
                .multipartUpload(CompletedMultipartUpload.builder().parts(completed).build()));
    }

    @Override
    public void abortUpload(String key, String uploadId) {
        try {
            s3.abortMultipartUpload(b -> b.bucket(bucket).key(key).uploadId(uploadId));
        } catch (S3Exception e) {
            log.debug("Abort of {} failed; the store's lifecycle rules will reap it", key, e);
        }
    }

    @Override
    public long sizeOf(String key) {
        try {
            return s3.headObject(b -> b.bucket(bucket).key(key)).contentLength();
        } catch (NoSuchKeyException e) {
            return -1;
        } catch (S3Exception e) {
            if (e.statusCode() == 404) {
                return -1;
            }
            throw e;
        }
    }

    @Override
    public String presignDownload(String key, Duration ttl) {
        return presigner.presignGetObject(p -> p
                        .signatureDuration(ttl)
                        .getObjectRequest(r -> r.bucket(bucket).key(key)))
                .url().toString();
    }

    @Override
    public void delete(String key) {
        s3.deleteObject(b -> b.bucket(bucket).key(key));
    }

    @PreDestroy
    void close() {
        presigner.close();
        s3.close();
    }
}
