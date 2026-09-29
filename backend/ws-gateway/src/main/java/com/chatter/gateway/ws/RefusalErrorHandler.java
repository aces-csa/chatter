package com.chatter.gateway.ws;

import org.springframework.messaging.Message;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.MessageBuilder;
import org.springframework.web.socket.messaging.StompSubProtocolErrorHandler;

import java.util.regex.Pattern;

/**
 * Puts the gateway's refusal code in the STOMP ERROR frame the client actually sees.
 *
 * <p>Spring wraps anything a channel interceptor throws in "Failed to send message to
 * ExecutorSubscribableChannel[clientInboundChannel]" and sends only that, so without this the
 * client could never tell an expired token (refresh and retry) from a revoked device (sign out)
 * and would retry a rejected token forever. Anything that is not one of our codes gets a generic
 * message: exception text from deeper down is not the client's business.
 */
public class RefusalErrorHandler extends StompSubProtocolErrorHandler {

    private static final Pattern CODE = Pattern.compile("^(AUTH_EXPIRED|DEVICE_REVOKED|GATEWAY_DRAINING)\\b.*");

    @Override
    public Message<byte[]> handleClientMessageProcessingError(Message<byte[]> clientMessage, Throwable ex) {
        String message = "Frame rejected";
        for (Throwable t = ex; t != null; t = t.getCause() == t ? null : t.getCause()) {
            if (t.getMessage() != null && CODE.matcher(t.getMessage()).matches()) {
                message = t.getMessage();
                break;
            }
        }
        StompHeaderAccessor accessor = StompHeaderAccessor.create(StompCommand.ERROR);
        accessor.setMessage(message);
        accessor.setLeaveMutable(true);
        return MessageBuilder.createMessage(new byte[0], accessor.getMessageHeaders());
    }
}
