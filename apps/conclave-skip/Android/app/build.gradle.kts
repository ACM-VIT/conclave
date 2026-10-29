import java.util.Properties

val skipEnvValues: Map<String, String> = rootDir.parentFile
    .resolve("Skip.env")
    .takeIf { it.isFile }
    ?.readLines()
    ?.mapNotNull { rawLine ->
        val line = rawLine.trim()
        if (line.isEmpty() || line.startsWith("//")) {
            return@mapNotNull null
        }
        val separator = line.indexOf("=")
        if (separator <= 0) {
            return@mapNotNull null
        }
        val key = line.substring(0, separator).trim()
        val value = line.substring(separator + 1)
            .trim()
            .removeSurrounding("\"")
            .removeSurrounding("'")
        key to value
    }
    ?.toMap()
    ?: emptyMap()

fun configuredValue(vararg keys: String): String {
    var provider = providers.gradleProperty(keys.first())
        .orElse(providers.environmentVariable(keys.first()))
    for (key in keys.drop(1)) {
        provider = provider
            .orElse(providers.gradleProperty(key))
            .orElse(providers.environmentVariable(key))
    }
    val configured = provider.getOrElse("").trim()
    if (configured.isNotEmpty()) {
        return configured
    }
    for (key in keys) {
        val skipEnvValue = skipEnvValues[key]?.trim()
        if (!skipEnvValue.isNullOrEmpty()) {
            return skipEnvValue
        }
    }
    return ""
}

val googleSignInWebClientId = configuredValue(
    "GOOGLE_SIGN_IN_WEB_CLIENT_ID",
    "GOOGLE_WEB_CLIENT_ID",
    "GOOGLE_CLIENT_ID",
    "EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID"
)

val conclaveAuthBaseUrl = configuredValue(
    "CONCLAVE_AUTH_BASE_URL",
    "AUTH_BASE_URL",
    "BETTER_AUTH_BASE_URL",
    "BETTER_AUTH_URL",
    "APP_BASE_URL",
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_SITE_URL"
)

val productionConclaveBaseUrl = "https://conclave.acmvit.in"
val productionSfuJoinUrl = "$productionConclaveBaseUrl/api/sfu/join"
val debugViewerProfile = configuredValue("CONCLAVE_DEBUG_VIEWER_PROFILE").lowercase() in setOf("yes", "true", "1")
val sfuJoinUrl = configuredValue("SFU_JOIN_URL").ifBlank { productionSfuJoinUrl }
val releaseArtifactRequested = gradle.startParameter.taskNames.any { taskName ->
    val lower = taskName.substringAfterLast(":").lowercase()
    lower in setOf("assemble", "bundle", "build") ||
        ("release" in lower && (
            "assemble" in lower ||
                "bundle" in lower ||
                "package" in lower ||
                "install" in lower ||
                "publish" in lower ||
                "upload" in lower
        ))
}
val allowDebugReleaseSigning = configuredValue("ALLOW_DEBUG_RELEASE_SIGNING")
    .equals("true", ignoreCase = true)

plugins {
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.android.application)
    id("skip-build-plugin")
}

skip {
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.fromTarget(libs.versions.jvm.get())
    }
}

android {
    namespace = group as String

    compileSdk = 37
    compileOptions {
        sourceCompatibility = JavaVersion.toVersion(libs.versions.jvm.get())
        targetCompatibility = JavaVersion.toVersion(libs.versions.jvm.get())
    }
    packaging {
        jniLibs {
            keepDebugSymbols.add("**/*.so")
            pickFirsts.add("**/*.so")
            useLegacyPackaging = true
        }
    }

    defaultConfig {
        minSdk = libs.versions.android.sdk.min.get().toInt()
        targetSdk = libs.versions.android.sdk.compile.get().toInt()
        manifestPlaceholders["GOOGLE_SIGN_IN_WEB_CLIENT_ID"] = googleSignInWebClientId
        manifestPlaceholders["CONCLAVE_AUTH_BASE_URL"] = conclaveAuthBaseUrl
        manifestPlaceholders["SFU_JOIN_URL"] = sfuJoinUrl
        manifestPlaceholders["CONCLAVE_DEBUG_VIEWER_PROFILE"] = "false"
        manifestPlaceholders["USES_CLEARTEXT_TRAFFIC"] = "true"

    }

    buildFeatures {
        buildConfig = true
    }

    androidResources {
        generateLocaleConfig = true
    }

    lint {
        disable.add("Instantiatable")
        disable.add("MissingPermission")
    }

    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }

    signingConfigs {
        val keystorePropertiesFile = file("keystore.properties")
        create("release") {
            if (keystorePropertiesFile.isFile) {
                val keystoreProperties = Properties()
                keystoreProperties.load(keystorePropertiesFile.inputStream())
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
            } else {
                if (releaseArtifactRequested && !allowDebugReleaseSigning) {
                    throw GradleException(
                        "Missing Android/app/keystore.properties for release signing. " +
                            "Set ALLOW_DEBUG_RELEASE_SIGNING=true only for local throwaway release artifacts."
                    )
                }
                keyAlias = signingConfigs.getByName("debug").keyAlias
                keyPassword = signingConfigs.getByName("debug").keyPassword
                storeFile = signingConfigs.getByName("debug").storeFile
                storePassword = signingConfigs.getByName("debug").storePassword
            }
        }
    }

    buildTypes {
        debug {
            isPseudoLocalesEnabled = true
            manifestPlaceholders["CONCLAVE_DEBUG_VIEWER_PROFILE"] = debugViewerProfile.toString()
        }
        release {
            signingConfig = signingConfigs.findByName("release")

            isMinifyEnabled = false
            isShrinkResources = false
            isDebuggable = false
            manifestPlaceholders["CONCLAVE_DEBUG_VIEWER_PROFILE"] = "false"
            manifestPlaceholders["CONCLAVE_AUTH_BASE_URL"] = productionConclaveBaseUrl
            manifestPlaceholders["SFU_JOIN_URL"] = productionSfuJoinUrl
            manifestPlaceholders["USES_CLEARTEXT_TRAFFIC"] = "false"
        }
    }
}

dependencies {
    implementation(platform("com.squareup.okhttp3:okhttp-bom:5.5.0"))
    implementation("com.squareup.okhttp3:okhttp")

    implementation("com.google.android.material:material:1.14.0")
}
