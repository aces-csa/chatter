package com.chatter.platform.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;

@Configuration
public class RedisConfig {

    /**
     * Everything we put in Redis is either a counter, a small string or JSON we serialise
     * ourselves. A String template keeps the keyspace inspectable with redis-cli, which is worth
     * more during development than typed serialisers.
     */
    @Bean
    StringRedisTemplate stringRedisTemplate(RedisConnectionFactory factory) {
        return new StringRedisTemplate(factory);
    }
}
