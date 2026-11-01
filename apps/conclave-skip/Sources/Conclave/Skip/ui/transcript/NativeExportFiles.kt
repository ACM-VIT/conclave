package conclave.module

import android.content.Context
import java.io.File
import java.util.UUID

internal object NativeExportFiles {
    private const val MAX_AGE_MILLIS = 24 * 60 * 60 * 1000L
    private const val SHARE_GRACE_MILLIS = 60 * 60 * 1000L
    private const val RETAINED_COUNT = 16

    @Synchronized
    fun write(context: Context, category: String, displayName: String, bytes: ByteArray): File {
        require(File(displayName).name == displayName)
        val root = File(context.cacheDir, "exports/$category").apply { mkdirs() }
        val directory = File(root, UUID.randomUUID().toString()).apply { check(mkdir()) }
        try {
            val pending = File(directory, ".pending")
            pending.writeBytes(bytes)
            val target = File(directory, displayName)
            check(pending.renameTo(target))
            prune(root, System.currentTimeMillis())
            return target
        } catch (failure: Throwable) {
            directory.deleteRecursively()
            throw failure
        }
    }

    @Synchronized
    fun discard(file: File) {
        file.parentFile?.deleteRecursively()
    }

    private fun prune(root: File, now: Long) {
        val entries = root.listFiles()?.filter { it.isDirectory }?.sortedByDescending { timestamp(it) } ?: emptyList()
        for ((index, entry) in entries.withIndex()) {
            val age = now - timestamp(entry)
            if (age > MAX_AGE_MILLIS || (index >= RETAINED_COUNT && age > SHARE_GRACE_MILLIS)) {
                entry.deleteRecursively()
            }
        }
        val prefix = if (root.name == "whiteboard") "whiteboard-" else "conclave-"
        val suffix = if (root.name == "whiteboard") ".png" else "-transcript.md"
        root.parentFile?.listFiles()?.filter {
            it.isFile && it.name.startsWith(prefix) && it.name.endsWith(suffix) && now - it.lastModified() > MAX_AGE_MILLIS
        }?.forEach { it.delete() }
    }

    private fun timestamp(directory: File): Long = directory.listFiles()?.maxOfOrNull { it.lastModified() } ?: directory.lastModified()
}
