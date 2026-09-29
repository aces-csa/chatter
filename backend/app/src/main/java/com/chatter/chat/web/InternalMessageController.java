package com.chatter.chat.web;

import com.chatter.chat.api.ChatDtos;
import com.chatter.chat.domain.MessageIngestService;
import com.chatter.chat.domain.MessageSyncService;
import com.chatter.common.wire.Frames;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * The surface the ws-gateway calls. Guarded by a shared secret, never exposed publicly.
 *
 * <p>Identity comes from the request body rather than a token because the gateway has already
 * authenticated the socket; re-validating the user's JWT on every frame would double the cost of
 * the hot path for no extra safety inside the cluster boundary.
 */
@RestController
@RequestMapping("/internal/v1")
public class InternalMessageController {

    private final MessageIngestService ingest;
    private final MessageSyncService sync;

    public InternalMessageController(MessageIngestService ingest, MessageSyncService sync) {
        this.ingest = ingest;
        this.sync = sync;
    }

    @PostMapping("/messages")
    public ChatDtos.IngestResult send(@Valid @RequestBody ChatDtos.IngestRequest request) {
        return ingest.ingest(request);
    }

    @PostMapping("/receipts/delivered")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delivered(@Valid @RequestBody ChatDtos.ReceiptRequest request) {
        sync.markDelivered(request);
    }

    @PostMapping("/receipts/read")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void read(@Valid @RequestBody ChatDtos.ReceiptRequest request) {
        sync.markRead(request);
    }

    @PostMapping("/sync")
    public Frames.SyncPage sync(@Valid @RequestBody ChatDtos.SyncRequest request) {
        return sync.sync(request);
    }
}
