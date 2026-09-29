package com.chatter.gateway;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class WsGatewayApplication {

    public static void main(String[] args) {
        SpringApplication.run(WsGatewayApplication.class, args);
    }
}
