
pluginManagement {

    val pluginPath = File.createTempFile("skip-plugin-path", ".tmp")

    val packagePath = settings.rootDir.parentFile.absolutePath
    val indexBuildPath = settings.rootDir.parentFile.resolve(".build/index-build").absolutePath

    val pinnedSkipBinDir = settings.rootDir.parentFile
        .resolve(".build/artifacts/skip/skip/skip.artifactbundle/macos")
        .absolutePath
    val isXcodeDriven = !System.getenv("BUILT_PRODUCTS_DIR").isNullOrBlank()
    val inheritedPath = "${System.getenv("PATH")}:/opt/homebrew/bin"
    val skipPluginResult = providers.exec {
        commandLine(
            "/bin/sh",
            "-c",
            "skip plugin --prebuild --package-path '${packagePath}' --plugin-ref '${pluginPath.absolutePath}' && /usr/bin/env -u SDKROOT -u SDK_NAME -u PLATFORM_NAME -u TARGET_DEVICE_PLATFORM_NAME swift build --package-path '${packagePath}' --scratch-path '${indexBuildPath}'"
        )
        environment("PATH", if (isXcodeDriven) inheritedPath else "${pinnedSkipBinDir}:${inheritedPath}")
    }
    val skipPluginOutput = skipPluginResult.standardOutput.asText.get()
    print(skipPluginOutput)
    val skipPluginError = skipPluginResult.standardError.asText.get()
    print(skipPluginError)

    val packageRoot = settings.rootDir.parentFile
    val skipstoneSettings = packageRoot
        .resolve(".build/plugins/outputs/conclave-skip/Conclave/destination/skipstone/settings.gradle.kts")
    val indexBuildSkipstoneSettings = packageRoot
        .resolve(".build/index-build/plugins/outputs/conclave-skip/Conclave/destination/skipstone/settings.gradle.kts")

    fun xcodeSkipstoneSettings(): List<File> {
        val builtProductsBuildDir = System.getenv("BUILT_PRODUCTS_DIR")
            ?.takeIf { it.isNotBlank() }
            ?.let(::File)
            ?.parentFile
            ?.parentFile
        val buildDir = System.getenv("BUILD_DIR")
            ?.takeIf { it.isNotBlank() }
            ?.let(::File)
            ?.parentFile
        val objRoot = System.getenv("OBJROOT")
            ?.takeIf { it.isNotBlank() }
            ?.let(::File)
        val intermediatesDir = listOfNotNull(
            builtProductsBuildDir?.resolve("Intermediates.noindex"),
            buildDir?.resolve("Intermediates.noindex"),
            objRoot
        ).firstOrNull { it.isDirectory } ?: return emptyList()

        val skipstoneDir = intermediatesDir
            .resolve("BuildToolPluginIntermediates/conclave-skip.output/Conclave/skipstone")
        val variantDirs = skipstoneDir.listFiles()
            ?.filter { it.isDirectory && it.name.startsWith("xcode-") }
            .orEmpty()
        return (variantDirs + skipstoneDir).map { it.resolve("settings.gradle.kts") }
    }

    fun addJitPackRepository(settingsText: String): String {
        if (!settingsText.contains("https://jitpack.io")) {
            return settingsText.replace(
                Regex("""(?m)^    repositories \{\n        mavenCentral\(\)\n        google\(\)\n    \}"""),
                """
    repositories {
        mavenCentral()
        google()
        maven(url = "https://jitpack.io") {
            content {
                includeGroup("com.github.LottieFiles")
            }
        }
    }
""".trimIndent()
            )
        }

        return settingsText
    }

    fun writeIfChanged(settingsFile: File, settingsText: String) {
        if (settingsText != settingsFile.readText()) {
            settingsFile.setWritable(true)
            settingsFile.writeText(settingsText)
        }
    }

    fun patchRepositoryOnly(settingsFile: File) {
        if (settingsFile.isFile) {
            writeIfChanged(settingsFile, addJitPackRepository(settingsFile.readText()))
        }
    }

    if (skipstoneSettings.isFile) {
        var settingsText = addJitPackRepository(skipstoneSettings.readText())

        val dependencyProjects = mapOf(
            "SkipUI" to "skip-ui",
            "SkipModel" to "skip-model",
            "SkipFoundation" to "skip-foundation",
            "SkipLib" to "skip-lib",
            "SkipUnit" to "skip-unit",
            "SkipKit" to "skip-kit"
        )
        dependencyProjects.forEach { (moduleName, outputName) ->
            val indexProject = settings.rootDir.parentFile
                .resolve(".build/index-build/plugins/outputs/${outputName}/${moduleName}/destination/skipstone/${moduleName}")
            val hasKotlinSources = indexProject
                .resolve("src/main/kotlin")
                .walkTopDown()
                .any { it.isFile && it.extension == "kt" }
            if (indexProject.isDirectory && hasKotlinSources) {
                val projectDirPattern = Regex("""project\(":${moduleName}"\)\.projectDir = file\("[^"]*"\)""")
                settingsText = settingsText.replace(
                    projectDirPattern,
                    """project(":${moduleName}").projectDir = file("${indexProject.invariantSeparatorsPath}")"""
                )
            }
        }

        writeIfChanged(skipstoneSettings, settingsText)
    }
    patchRepositoryOnly(indexBuildSkipstoneSettings)
    xcodeSkipstoneSettings().forEach(::patchRepositoryOnly)

    val rootLocalProperties = settings.rootDir.resolve("local.properties")
    val skipstoneLocalProperties = settings.rootDir.parentFile
        .resolve(".build/plugins/outputs/conclave-skip/Conclave/destination/skipstone/local.properties")
    if (rootLocalProperties.isFile && skipstoneSettings.isFile) {
        val localPropertiesText = rootLocalProperties.readText()
        if (!skipstoneLocalProperties.isFile || skipstoneLocalProperties.readText() != localPropertiesText) {
            skipstoneLocalProperties.writeText(localPropertiesText)
        }
    }

    includeBuild(pluginPath.readText()) {
        name = "skip-plugins"
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
        google()
        maven(url = "https://jitpack.io") {
            content {
                includeGroup("com.github.LottieFiles")
            }
        }
    }
}

plugins {
    id("skip-plugin") apply true
}
