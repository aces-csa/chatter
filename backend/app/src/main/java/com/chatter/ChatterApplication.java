package com.chatter;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class ChatterApplication {

    public static void main(String[] args) {
        SpringApplication.run(ChatterApplication.class, args);
    }
}
