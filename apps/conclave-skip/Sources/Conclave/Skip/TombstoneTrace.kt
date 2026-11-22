package conclave.module

/**
 * Reads a native-crash tombstone (AOSP `debuggerd/proto/tombstone.proto`, what ApplicationExitInfo returns for
 * `REASON_CRASH_NATIVE` from Android 12) and keeps only the signal name and the crashing thread's backtrace. Each
 * frame's module comes from its mapping's full path and survives only when that ends in a known module, else `[path]`.
 * Abort messages, other threads, memory, logs and open files stay on the device.
 */
internal object TombstoneTrace {
    private const val TOMBSTONE_TID = 6
    private const val TOMBSTONE_SIGNAL = 10
    private const val TOMBSTONE_THREADS = 16
    private const val SIGNAL_NAME = 2
    private const val MAP_VALUE = 2
    private const val THREAD_ID = 1
    private const val THREAD_BACKTRACE = 4
    private const val FRAME_REL_PC = 1
    private const val FRAME_FUNCTION = 4
    private const val FRAME_FILE = 6
    private const val APP_PACKAGE = "com.acmvit.conclave"

    private class Reader(private val bytes: ByteArray, private var position: Int = 0, private val end: Int = bytes.size) {
        val hasMore: Boolean get() = position < end

        fun varint(): Long {
            var result = 0L
            var shift = 0
            while (position < end && shift < 64) {
                val byte = bytes[position++].toInt()
                result = result or ((byte and 0x7F).toLong() shl shift)
                if (byte and 0x80 == 0) return result
                shift += 7
            }
            throw IllegalArgumentException("Truncated varint")
        }

        fun lengthDelimited(): Reader {
            val length = varint().toInt()
            if (length < 0 || position + length > end) throw IllegalArgumentException("Truncated field")
            val nested = Reader(bytes, position, position + length)
            position += length
            return nested
        }

        fun string(): String {
            val nested = lengthDelimited()
            return String(bytes, nested.position, nested.end - nested.position, Charsets.UTF_8)
        }

        fun skip(wireType: Int) {
            when (wireType) {
                0 -> varint()
                1 -> position += 8
                2 -> lengthDelimited()
                5 -> position += 4
                else -> throw IllegalArgumentException("Unsupported wire type $wireType")
            }
        }

        inline fun fields(handle: (field: Int, wireType: Int) -> Boolean) {
            while (hasMore) {
                val key = varint()
                val field = (key ushr 3).toInt()
                val wireType = (key and 0x7).toInt()
                if (!handle(field, wireType)) skip(wireType)
            }
        }
    }

    private class ThreadTrace(val id: Long, val frames: List<CrashReportFrame>)

    /** The crash as a captured exception, innermost frame first, or null when the bytes are not a tombstone. */
    fun exception(bytes: ByteArray): CrashReportException? = try {
        var crashedThreadId = -1L
        var signalName = ""
        val threads = mutableListOf<ThreadTrace>()
        val reader = Reader(bytes)
        reader.fields { field, wireType ->
            when {
                field == TOMBSTONE_TID && wireType == 0 -> { crashedThreadId = reader.varint(); true }
                field == TOMBSTONE_SIGNAL && wireType == 2 -> { signalName = signalName(reader.lengthDelimited()); true }
                field == TOMBSTONE_THREADS && wireType == 2 -> { thread(reader.lengthDelimited())?.let { threads.add(it) }; true }
                else -> false
            }
        }
        val crashed = threads.firstOrNull { it.id == crashedThreadId }
        if (crashed == null && signalName.isEmpty()) {
            null
        } else {
            CrashReportException(
                type = signalName.ifEmpty { "NativeCrash" },
                frames = skip.lib.Array(crashed?.frames ?: emptyList()),
            )
        }
    } catch (_: Throwable) {
        null
    }

    private fun signalName(reader: Reader): String {
        var name = ""
        reader.fields { field, wireType ->
            if (field == SIGNAL_NAME && wireType == 2) { name = reader.string(); true } else false
        }
        return name
    }

    private fun thread(entry: Reader): ThreadTrace? {
        var thread: ThreadTrace? = null
        entry.fields { field, wireType ->
            if (field == MAP_VALUE && wireType == 2) { thread = threadValue(entry.lengthDelimited()); true } else false
        }
        return thread
    }

    private fun threadValue(reader: Reader): ThreadTrace {
        var id = -1L
        val frames = mutableListOf<CrashReportFrame>()
        reader.fields { field, wireType ->
            when {
                field == THREAD_ID && wireType == 0 -> { id = reader.varint(); true }
                field == THREAD_BACKTRACE && wireType == 2 -> {
                    if (frames.size < CrashReportEventBuilder.maxFrames) frames.add(frame(reader.lengthDelimited()))
                    else reader.lengthDelimited()
                    true
                }
                else -> false
            }
        }
        return ThreadTrace(id, frames)
    }

    private fun frame(reader: Reader): CrashReportFrame {
        var relPc = 0L
        var function = ""
        var file = ""
        reader.fields { field, wireType ->
            when {
                field == FRAME_REL_PC && wireType == 0 -> { relPc = reader.varint(); true }
                field == FRAME_FUNCTION && wireType == 2 -> { function = reader.string(); true }
                field == FRAME_FILE && wireType == 2 -> { file = reader.string(); true }
                else -> false
            }
        }
        val module = CrashReportPrivacy.moduleNameFromPath(file)
        return CrashReportFrame(
            function = function.ifEmpty { "$module+0x${java.lang.Long.toHexString(relPc)}" },
            module = module,
            filename = module,
            line = 0,
            inApp = file.contains(APP_PACKAGE),
            address = CrashReportPrivacy.address(java.lang.Long.toHexString(relPc)),
        )
    }
}
