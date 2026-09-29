package com.chatter.chat.api;

import java.util.UUID;

/** What the chat module must do when an account disappears (FR-1.6). */
public interface ConversationLifecycle {

    /**
     * Takes a user out of every conversation and drops everything still waiting for them.
     * Must run inside the caller's transaction, alongside the deletion of the user itself.
     */
    void removeUserEverywhere(UUID userId);
}
