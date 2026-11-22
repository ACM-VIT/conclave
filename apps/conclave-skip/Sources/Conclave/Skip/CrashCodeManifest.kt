package conclave.module

import skip.foundation.ProcessInfo

/**
 * The classes compiled into this app with their source files, one `class<TAB>source file` per line, as the Android
 * build writes them into the APK (`generate<Variant>CrashCodeManifest` in `Android/app/build.gradle.kts`). A crash
 * report keeps one of our Java or Kotlin frames only when its class and file are listed here. Read once, lazily.
 */
internal object CrashCodeManifest {
    const val ASSET = "crash-code-frames.tsv"

    @Volatile private var entries: Set<String>? = null

    fun contains(entry: String): Boolean {
        val loaded = entries ?: load().also { entries = it }
        return loaded.contains(entry)
    }

    private fun load(): Set<String> = try {
        ProcessInfo.processInfo.androidContext.assets.open(ASSET).bufferedReader().useLines { lines ->
            lines.filter { it.isNotEmpty() }.toHashSet()
        }
    } catch (_: Throwable) {
        emptySet()
    }
}
