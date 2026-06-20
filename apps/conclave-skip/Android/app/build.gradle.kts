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

val sfuJoinUrl = configuredValue("SFU_JOIN_URL")

plugins {
    alias(libs.plugins.kotlin.android)
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
    compileSdk = libs.versions.android.sdk.compile.get().toInt()
    compileOptions {
        sourceCompatibility = JavaVersion.toVersion(libs.versions.jvm.get())
        targetCompatibility = JavaVersion.toVersion(libs.versions.jvm.get())
    }
    packaging {
        jniLibs {
            keepDebugSymbols.add("**/*.so")
            pickFirsts.add("**/*.so")
            // this option will compress JNI .so files
            useLegacyPackaging = true
        }
    }

    defaultConfig {
        minSdk = libs.versions.android.sdk.min.get().toInt()
        targetSdk = libs.versions.android.sdk.compile.get().toInt()
        manifestPlaceholders["GOOGLE_SIGN_IN_WEB_CLIENT_ID"] = googleSignInWebClientId
        manifestPlaceholders["CONCLAVE_AUTH_BASE_URL"] = conclaveAuthBaseUrl
        manifestPlaceholders["SFU_JOIN_URL"] = sfuJoinUrl
        manifestPlaceholders["USES_CLEARTEXT_TRAFFIC"] = "true"
        // skip.tools.skip-build-plugin will automatically use Skip.env properties for:
        // applicationId = ANDROID_APPLICATION_ID ?? PRODUCT_BUNDLE_IDENTIFIER
        // versionCode = CURRENT_PROJECT_VERSION
        // versionName = MARKETING_VERSION
    }

    buildFeatures {
        buildConfig = true
    }

    lint {
        disable.add("Instantiatable")
        disable.add("MissingPermission")
    }

    dependenciesInfo {
        // Disables dependency metadata when building APKs.
        includeInApk = false
        // Disables dependency metadata when building Android App Bundles.
        includeInBundle = false
    }

    // default signing configuration tries to load from keystore.properties
    // see: https://skip.tools/docs/deployment/#export-signing
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
                // when there is no keystore.properties file, fall back to signing with debug config
                keyAlias = signingConfigs.getByName("debug").keyAlias
                keyPassword = signingConfigs.getByName("debug").keyPassword
                storeFile = signingConfigs.getByName("debug").storeFile
                storePassword = signingConfigs.getByName("debug").storePassword
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            isDebuggable = false // can be set to true for debugging release build, but needs to be false when uploading to store
            manifestPlaceholders["USES_CLEARTEXT_TRAFFIC"] = "false"
            proguardFiles(getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro")
        }
    }
}

dependencies {
    // The Activity theme (res/values/themes.xml) is `Theme.Material3.Dark.*`,
    // whose color attributes (colorOnPrimary, colorSurface, …) ship in the
    // Material Components XML library. Compose Material3 does NOT provide the
    // XML theme attrs, so this AAR must be a direct dependency or the merged
    // resources fail with "style attribute 'attr/colorOnPrimary' not found".
    implementation("com.google.android.material:material:1.12.0")
}
