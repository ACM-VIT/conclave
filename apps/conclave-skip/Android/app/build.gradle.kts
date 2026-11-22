import java.io.DataInputStream
import java.io.DataOutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.Properties
import java.util.zip.ZipFile

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
val postHogProjectKey = configuredValue("POSTHOG_PROJECT_KEY")
val postHogHost = configuredValue("POSTHOG_HOST")
val crashReportsInDebug = configuredValue("CONCLAVE_CRASH_REPORTS_IN_DEBUG").lowercase() in setOf("yes", "true", "1")
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

    compileSdk = libs.versions.android.sdk.compile.get().toInt()
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
        targetSdk = 36
        manifestPlaceholders["GOOGLE_SIGN_IN_WEB_CLIENT_ID"] = googleSignInWebClientId
        manifestPlaceholders["CONCLAVE_AUTH_BASE_URL"] = conclaveAuthBaseUrl
        manifestPlaceholders["SFU_JOIN_URL"] = sfuJoinUrl
        manifestPlaceholders["CONCLAVE_DEBUG_VIEWER_PROFILE"] = "false"
        manifestPlaceholders["USES_CLEARTEXT_TRAFFIC"] = "true"
        manifestPlaceholders["POSTHOG_PROJECT_KEY"] = postHogProjectKey
        manifestPlaceholders["POSTHOG_HOST"] = postHogHost
        manifestPlaceholders["CONCLAVE_CRASH_REPORTS_IN_DEBUG"] = "false"

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
            manifestPlaceholders["CONCLAVE_CRASH_REPORTS_IN_DEBUG"] = crashReportsInDebug.toString()
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

/**
 * Writes `crash-code-frames.bin` into the APK's assets: for every class the app compiles under `conclave/` and
 * `skip/`, the first 8 bytes of SHA-256 of `class<TAB>source file` (the file its class file names), as sorted
 * big-endian longs. Crash reports keep one of our Java or Kotlin frames only when its pair's hash is listed, so a
 * parsed frame can never carry an arbitrary name. CrashCodeManifest.kt hashes the same way.
 */
abstract class CrashCodeManifestTask : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val classJars: ListProperty<RegularFile>

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val classDirectories: ListProperty<Directory>

    @get:OutputDirectory
    abstract val outputDirectory: DirectoryProperty

    @TaskAction
    fun write() {
        val hashes = sortedSetOf<Long>()
        fun add(path: String, bytes: () -> ByteArray) {
            if (!path.endsWith(".class") || OWN_PREFIXES.none { path.startsWith(it) }) return
            val source = sourceFile(bytes()) ?: return
            val entry = path.removeSuffix(".class").replace('/', '.') + "\t" + source
            val digest = MessageDigest.getInstance("SHA-256").digest(entry.toByteArray(Charsets.UTF_8))
            hashes.add(ByteBuffer.wrap(digest, 0, 8).long)
        }
        for (jar in classJars.get()) {
            ZipFile(jar.asFile).use { zip ->
                for (entry in zip.entries()) {
                    if (!entry.isDirectory) add(entry.name) { zip.getInputStream(entry).use { it.readBytes() } }
                }
            }
        }
        for (directory in classDirectories.get()) {
            val root = directory.asFile
            root.walkTopDown().filter { it.isFile }.forEach { file ->
                add(file.relativeTo(root).invariantSeparatorsPath) { file.readBytes() }
            }
        }
        val output = outputDirectory.get().asFile
        output.mkdirs()
        DataOutputStream(output.resolve("crash-code-frames.bin").outputStream().buffered()).use { out ->
            for (hash in hashes) out.writeLong(hash)
        }
    }

    /** The class file's `SourceFile` attribute, or null when it has none or is not a class file. */
    private fun sourceFile(bytes: ByteArray): String? {
        val input = DataInputStream(bytes.inputStream())
        if (input.readInt() != 0xCAFEBABE.toInt()) return null
        input.skipBytes(4)
        val constantCount = input.readUnsignedShort()
        val utf8 = arrayOfNulls<String>(constantCount)
        var index = 1
        while (index < constantCount) {
            when (input.readUnsignedByte()) {
                1 -> utf8[index] = input.readUTF()
                3, 4, 9, 10, 11, 12, 17, 18 -> input.skipBytes(4)
                5, 6 -> { input.skipBytes(8); index += 1 }
                7, 8, 16, 19, 20 -> input.skipBytes(2)
                15 -> input.skipBytes(3)
                else -> return null
            }
            index += 1
        }
        input.skipBytes(6)
        input.skipBytes(2 * input.readUnsignedShort())
        repeat(2) {
            repeat(input.readUnsignedShort()) {
                input.skipBytes(6)
                repeat(input.readUnsignedShort()) {
                    input.skipBytes(2)
                    input.skipBytes(input.readInt())
                }
            }
        }
        repeat(input.readUnsignedShort()) {
            val name = utf8.getOrNull(input.readUnsignedShort())
            val length = input.readInt()
            if (name == "SourceFile" && length == 2) return utf8.getOrNull(input.readUnsignedShort())
            input.skipBytes(length)
        }
        return null
    }

    companion object {
        val OWN_PREFIXES = listOf("conclave/", "skip/")
    }
}

androidComponents {
    onVariants { variant ->
        val name = variant.name.replaceFirstChar { it.uppercase() }
        val manifest = tasks.register<CrashCodeManifestTask>("generate${name}CrashCodeManifest")
        variant.artifacts.forScope(com.android.build.api.variant.ScopedArtifacts.Scope.ALL)
            .use(manifest)
            .toGet(
                com.android.build.api.artifact.ScopedArtifact.CLASSES,
                CrashCodeManifestTask::classJars,
                CrashCodeManifestTask::classDirectories,
            )
        variant.sources.assets?.addGeneratedSourceDirectory(manifest, CrashCodeManifestTask::outputDirectory)
    }
}

dependencies {
    implementation(platform("com.squareup.okhttp3:okhttp-bom:5.5.1"))
    implementation("com.squareup.okhttp3:okhttp")

    implementation("com.google.android.material:material:1.14.0")
}
