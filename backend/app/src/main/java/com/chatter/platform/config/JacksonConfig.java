package com.chatter.platform.config;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class JacksonConfig {

    /**
     * Note the explicit WRITE_DATES_AS_TIMESTAMPS disable. Calling {@code .modules(...)} replaces
     * Boot's auto-configured module list, which also drops its default of ISO-8601 dates -- so
     * Instants started serialising as decimal epoch numbers. Clients then did Date.parse() on a
     * number, got NaN, and rows silently vanished from an IndexedDB index. Cheap line, expensive
     * bug.
     */
    @Bean
    Jackson2ObjectMapperBuilderCustomizer chatterJacksonCustomizer() {
        return builder -> builder
                .modules(new JavaTimeModule())
                .featuresToDisable(
                        DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES,
                        SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    }

    /** A plain mapper for places that serialise outside the MVC stack (outbox, Redis pub/sub). */
    @Bean
    ObjectMapper objectMapper() {
        return new ObjectMapper()
                .registerModule(new JavaTimeModule())
                .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    }
}
