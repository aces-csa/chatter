package com.chatter;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.lang.ArchRule;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static com.tngtech.archunit.library.dependencies.SlicesRuleDefinition.slices;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

/**
 * The modular monolith is only modular if something enforces it. These rules are what stop the
 * boundaries from rotting into a big ball of mud, and they are the reason a module can later be
 * extracted into its own service by swapping an in-process call for a remote one.
 */
class ArchitectureTest {

    private static final JavaClasses CLASSES = new ClassFileImporter()
            .withImportOption(ImportOption.Predefined.DO_NOT_INCLUDE_TESTS)
            .importPackages("com.chatter");

    @Test
    @DisplayName("modules talk to each other only through their api packages")
    void modulesOnlyDependOnApiPackages() {
        for (String module : new String[]{"auth", "user", "chat", "keys", "presence", "delivery", "account", "media", "notification", "sealed"}) {
            ArchRule rule = noClasses()
                    .that().resideOutsideOfPackage("com.chatter." + module + "..")
                    .and().resideInAPackage("com.chatter..")
                    .should().dependOnClassesThat()
                    .resideInAnyPackage(
                            "com.chatter." + module + ".domain..",
                            "com.chatter." + module + ".persistence..",
                            "com.chatter." + module + ".web..")
                    .because("another module may only reach com.chatter." + module + ".api");

            rule.check(CLASSES);
        }
    }

    @Test
    @DisplayName("no cycles between modules")
    void noModuleCycles() {
        slices()
                .matching("com.chatter.(*)..")
                .should().beFreeOfCycles()
                .check(CLASSES);
    }

    @Test
    @DisplayName("platform is the bottom layer and depends on no feature module")
    void platformDependsOnNothingAbove() {
        noClasses()
                .that().resideInAPackage("com.chatter.platform..")
                .should().dependOnClassesThat()
                .resideInAnyPackage("com.chatter.auth..", "com.chatter.user..",
                        "com.chatter.chat..", "com.chatter.keys..",
                        "com.chatter.presence..", "com.chatter.delivery..")
                .because("platform is shared infrastructure; anything that needs a feature "
                        + "module belongs in a module of its own")
                .check(CLASSES);
    }

    @Test
    @DisplayName("persistence entities stay inside their module")
    void entitiesAreNotShared() {
        noClasses()
                .that().resideInAPackage("..web..")
                .should().dependOnClassesThat().resideInAPackage("..persistence..")
                .because("controllers speak DTOs; entities are an implementation detail")
                .check(CLASSES);
    }
}
