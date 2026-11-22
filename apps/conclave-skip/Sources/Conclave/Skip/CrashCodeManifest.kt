package conclave.module

import java.nio.ByteBuffer
import java.security.MessageDigest
import skip.foundation.ProcessInfo

/**
 * The classes compiled into this app with their source files, as the Android build writes them into the APK
 * (`generate<Variant>CrashCodeManifest` in `Android/app/build.gradle.kts`): the first 8 bytes of SHA-256 of each
 * `class<TAB>source file`, sorted big-endian longs. A crash report keeps one of our Java or Kotlin frames only when its
 * pair's hash is listed. Read once, lazily, into a sorted array searched in place.
 */
internal object CrashCodeManifest {
    const val ASSET = "crash-code-frames.bin"

    @Volatile private var table: LongArray? = null

    fun contains(entry: String): Boolean {
        val loaded = table ?: load().also { table = it }
        return contains(loaded, entry)
    }

    internal fun contains(table: LongArray, entry: String): Boolean = java.util.Arrays.binarySearch(table, hash(entry)) >= 0

    /** The build hashes `class<TAB>source file` exactly this way. */
    internal fun hash(entry: String): Long {
        val digest = MessageDigest.getInstance("SHA-256").digest(entry.toByteArray(Charsets.UTF_8))
        return ByteBuffer.wrap(digest, 0, 8).long
    }

    internal fun table(bytes: ByteArray): LongArray {
        val buffer = ByteBuffer.wrap(bytes)
        val values = LongArray(bytes.size / 8) { buffer.long }
        java.util.Arrays.sort(values)
        return values
    }

    private fun load(): LongArray = try {
        table(ProcessInfo.processInfo.androidContext.assets.open(ASSET).use { it.readBytes() })
    } catch (_: Throwable) {
        LongArray(0)
    }
}
