package conclave.module

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ColorSpace
import android.os.Build
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.FilterOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

private const val ICON_RASTER_FILE_BYTES = 1024 * 1024
private const val ICON_RASTER_RUN_BYTES = 64L * 1024 * 1024
private const val ICON_RASTER_ENCODE_MS = 5_000L
private const val ICON_RASTER_IDENTITY_MS = 120_000L

// Every format here uses Locale.ROOT: %d writes the default locale's digits (Arabic-Indic under ar-EG,
// Bengali under bn-BD), which the ASCII file-name check rejects.
internal fun iconSHA256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(bytes).joinToString("") { "%02x".format(Locale.ROOT, it.toInt() and 255) }

/** Pixel protocol: top-left row-major straight sRGB RGBA8, RGB zero where alpha is zero. */
internal fun iconPixels(bitmap: Bitmap): ByteArray {
    require(bitmap.width in 1..ICON_RASTER_MAX_PIXELS && bitmap.height in 1..ICON_RASTER_MAX_PIXELS)
    // getPixels returns straight (unpremultiplied) sRGB ARGB, unlike premultiplied storage bytes.
    val pixels = IntArray(bitmap.width * bitmap.height)
    bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
    val rgba = ByteArray(pixels.size * 4)
    for (i in pixels.indices) {
        val p = pixels[i]; val alpha = p ushr 24
        rgba[4 * i] = if (alpha == 0) 0 else (p ushr 16).toByte()
        rgba[4 * i + 1] = if (alpha == 0) 0 else (p ushr 8).toByte()
        rgba[4 * i + 2] = if (alpha == 0) 0 else p.toByte()
        rgba[4 * i + 3] = alpha.toByte()
    }
    return rgba
}

/** [left, top, right, bottom] with right/bottom exclusive, or null when no pixel reaches the threshold. */
internal fun iconAlphaBounds(rgba: ByteArray, width: Int, threshold: Int): IntArray? {
    require(rgba.size == width * width * 4 && threshold in 1..255)
    var left = width; var top = width; var right = -1; var bottom = -1
    for (y in 0 until width) for (x in 0 until width) {
        if ((rgba[4 * (y * width + x) + 3].toInt() and 255) >= threshold) {
            if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y
        }
    }
    return if (right < 0) null else intArrayOf(left, top, right + 1, bottom + 1)
}

internal class IconCapture(val bitmap: Bitmap, val rgba: ByteArray, val frame: Int) {
    val hash = iconSHA256(rgba)
    val visible = rgba.indices.any { it % 4 == 3 && rgba[it] != 0.toByte() }
}

/** Package, build and APK identity for the index; streams the APK once on IO within a deadline. [live] stops it early. */
internal fun iconPackageIdentity(context: Context, live: () -> Boolean = { true }): JSONObject {
    val app = context.applicationContext
    val started = SystemClock.elapsedRealtime()
    @Suppress("DEPRECATION")
    val info = app.packageManager.getPackageInfo(app.packageName, 0)
    val md = MessageDigest.getInstance("SHA-256")
    File(app.applicationInfo.sourceDir).inputStream().use { stream ->
        val buffer = ByteArray(65536)
        while (true) {
            check(SystemClock.elapsedRealtime() - started < ICON_RASTER_IDENTITY_MS) { "deadline while hashing APK" }
            check(live()) { "cancelled while hashing APK" }
            val n = stream.read(buffer)
            if (n < 0) break
            md.update(buffer, 0, n)
        }
    }
    return JSONObject().put("package", app.packageName).put("versionName", info.versionName)
        .put("versionCode", info.longVersionCode).put("apkSHA256", md.digest().joinToString("") { "%02x".format(Locale.ROOT, it.toInt() and 255) })
        .put("splitAPKs", JSONArray(app.applicationInfo.splitSourceDirs?.toList() ?: emptyList<String>()))
        .put("api", Build.VERSION.SDK_INT).put("build", Build.FINGERPRINT).put("abis", JSONArray(Build.SUPPORTED_ABIS.toList()))
}

/**
 * IO-owned private journal below the canonical cache root. Every revision is an immutable index file;
 * failures keep captures, partial files and reasons. COMPLETE.json is written last, or never.
 * The first incomplete index needs no package identity, so it precedes APK hashing and every capture.
 */
internal class IconRasterJournal(
    private val cacheRoot: File, val plan: IconRasterPlan, val expected: Int,
    val id: String = UUID.randomUUID().toString(),
) {
    private lateinit var directory: File
    private val records = JSONArray()
    private val caseFailures = JSONArray()
    private val failures = JSONArray()
    private var revision = 0
    private var bytesWritten = 0L
    private var completedCases = 0
    @Volatile private var opened = false
    /** Newest immutable index revision that was completely written and synced. */
    @Volatile private var lastIndex: String? = null
    private val terminalLock = Any()
    private val cancellation = AtomicReference<String?>(null)
    @Volatile private var complete = false
    private val started = SystemClock.elapsedRealtime()
    private var packageIdentity: JSONObject? = null
    val path: String get() = "cache/wp1-icon-raster/$id"
    val runDirectory: File get() = directory

    /** Publishes the request before waiting for the terminal lock, so any request that precedes the
     *  locked commit decision is observed by it. Returns false once the run has committed. */
    fun cancel(reason: String): Boolean {
        if (complete) return false
        cancellation.compareAndSet(null, reason)
        return synchronized(terminalLock) { !complete }
    }
    fun cancellationReason(): String? = cancellation.get()
    fun isComplete(): Boolean = complete

    /** Status tail for a run that did not complete. Names only files this journal finished writing. */
    fun retained(): String {
        val last = lastIndex
        return when {
            !opened -> "nothing was written"
            last == null -> "no complete index was written; $path"
            else -> "$path/$last"
        }
    }

    fun open() {
        check(!opened)
        require(Regex("[a-zA-Z0-9-]{1,64}").matches(id))
        // Canonicalize first: /data/user/0 is itself a symlink to /data/data on Android.
        val base = File(cacheRoot.canonicalFile, "wp1-icon-raster")
        check(base.isDirectory || base.mkdir()) { "cannot create raster root" }
        check(base.canonicalFile == base) { "symlink in private raster root" }
        val run = File(base, id)
        check(run.mkdir()) { "run directory must be exclusive" }
        check(run.canonicalFile == run) { "symlink in run directory" }
        directory = run
        opened = true
        checkpoint("incomplete", "created; package identity pending; no capture accepted")
    }

    /** Indexes carry a null identity until this succeeds, and completion is refused without one. */
    fun identify(identity: JSONObject) {
        check(opened && packageIdentity == null)
        packageIdentity = identity
        checkpoint("incomplete", "package identity recorded; no capture accepted")
    }

    private fun owned(name: String): File {
        require(Regex("[a-zA-Z0-9._-]{1,120}").matches(name))
        val file = File(directory, name)
        check(file.canonicalFile == file && file.parentFile == directory)
        return file
    }
    private fun reserve(bytes: Int) {
        check(bytes <= ICON_RASTER_FILE_BYTES && bytesWritten + bytes <= ICON_RASTER_RUN_BYTES) { "bounded export budget" }
        bytesWritten += bytes
    }
    private fun exclusive(name: String, bytes: ByteArray) {
        reserve(bytes.size)
        val file = owned(name)
        check(file.createNewFile()) { "output already exists: $name" }
        FileOutputStream(file).use { it.write(bytes); it.fd.sync() }
    }
    private fun checkpoint(state: String, reason: String): File {
        check(opened)
        val index = JSONObject().put("schema", 2).put("run", id).put("state", state).put("reason", reason)
            .put("plan", plan.name).put("expectedCases", expected).put("completedCases", completedCases)
            .put("vectorSourceSHA256", NativeIconCatalog.vectorSourceSHA256).put("manifestSHA256", NativeIconCatalog.manifestSHA256)
            .put("generatorSHA256", NativeIconCatalog.generatorSHA256).put("packageIdentity", packageIdentity ?: JSONObject.NULL)
            .put("pixelProtocol", "top-left row-major straight sRGB RGBA8; RGB zero where alpha is zero")
            .put("canvas", "software ARGB_8888 sRGB; premultiplied storage; density NONE; transparent; black SrcIn tint")
            .put("pngRoundTrip", "decoded unpremultiplied ARGB_8888 sRGB; normalized RGBA SHA-256 must equal the capture")
            .put("alphaBounds", "[left, top, right, bottom], right and bottom exclusive; alpha>0 and alpha>=128")
            .put("records", records).put("caseFailures", caseFailures).put("failures", failures)
            .put("elapsedMs", SystemClock.elapsedRealtime() - started)
            .put("nativeInterruptionLimit", "Synchronous compression cannot be interrupted; image size, write deadline and ownership draining bound it.")
        val name = "index-%04d.json".format(Locale.ROOT, revision++)
        // The immutable revision is published before the convenience pointer is replaced.
        val bytes = index.toString(2).toByteArray(Charsets.UTF_8)
        exclusive(name, bytes)
        lastIndex = name
        reserve(bytes.size)
        val pending = owned("index-pointer-$revision.tmp")
        check(pending.createNewFile())
        FileOutputStream(pending).use { it.write(bytes); it.fd.sync() }
        Files.move(pending.toPath(), owned("index.json").toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        return owned(name)
    }

    fun beginCase(request: IconRasterRequest) { checkpoint("incomplete", "capturing ${request.key}") }

    /** Receives sole ownership of the captures; even a cancelled run awaits this bounded transaction. */
    fun export(request: IconRasterRequest, captures: List<IconCapture>, readinessFailure: String?) {
        var exportError: Throwable? = null
        try {
            if (readinessFailure != null) caseFailures.put(JSONObject().put("case", request.key).put("readinessFailure", readinessFailure))
            for (capture in captures) {
                val stem = "case-%04d-frame-%d".format(Locale.ROOT, request.ordinal, capture.frame)
                val width = capture.bitmap.width
                val record = JSONObject().put("case", request.key).put("artwork", request.artwork.id)
                    .put("property", request.artwork.property).put("inputSHA256", request.artwork.inputSHA256)
                    .put("repetition", request.repetition).put("dp", request.dp).put("density", request.density)
                    .put("direction", request.direction.toString()).put("width", width).put("height", capture.bitmap.height)
                    .put("frame", capture.frame).put("painterRebound", capture.frame == 1)
                    .put("autoMirror", request.artwork.mirrors).put("defaultSizeDp", 24).put("viewport", 960)
                    .put("rgbaSHA256", capture.hash).put("alphaSHA256", iconSHA256(capture.rgba.filterIndexed { i, _ -> i % 4 == 3 }.toByteArray()))
                    .put("alphaBoundsAny", iconAlphaBounds(capture.rgba, width, 1)?.let { JSONArray(it.toList()) } ?: JSONObject.NULL)
                    .put("alphaBoundsHalf", iconAlphaBounds(capture.rgba, width, 128)?.let { JSONArray(it.toList()) } ?: JSONObject.NULL)
                    .put("visible", capture.visible).put("premultiplied", capture.bitmap.isPremultiplied)
                    .put("hasAlpha", capture.bitmap.hasAlpha()).put("bitmapDensity", capture.bitmap.density)
                    .put("colorSpace", capture.bitmap.colorSpace?.name).put("readinessFailure", readinessFailure ?: JSONObject.NULL)
                records.put("$stem.json")
                try {
                    val partial = owned("$stem.png.part")
                    check(partial.createNewFile())
                    val deadline = SystemClock.elapsedRealtime() + ICON_RASTER_ENCODE_MS
                    FileOutputStream(partial).use { file ->
                        val bounded = object : FilterOutputStream(file) {
                            var count = 0
                            private fun guard(n: Int) {
                                count += n
                                check(count <= ICON_RASTER_FILE_BYTES && bytesWritten + count <= ICON_RASTER_RUN_BYTES &&
                                    SystemClock.elapsedRealtime() <= deadline) { "bounded PNG writer deadline/size" }
                            }
                            override fun write(b: Int) { guard(1); out.write(b) }
                            override fun write(b: ByteArray, off: Int, len: Int) { guard(len); out.write(b, off, len) }
                        }
                        check(plan != IconRasterPlan.ExportFailure) { "injected encoding failure" }
                        check(capture.bitmap.compress(Bitmap.CompressFormat.PNG, 100, bounded)) { "PNG encoder returned false" }
                        bounded.flush()
                        file.fd.sync()
                    }
                    val png = partial.readBytes()
                    reserve(png.size)
                    val decoded = BitmapFactory.decodeByteArray(png, 0, png.size, BitmapFactory.Options().apply {
                        inScaled = false; inPremultiplied = false
                        inPreferredConfig = Bitmap.Config.ARGB_8888
                        inPreferredColorSpace = ColorSpace.get(ColorSpace.Named.SRGB)
                    }) ?: error("PNG round-trip decoder failed")
                    try {
                        check(decoded.width == width && decoded.height == capture.bitmap.height) { "PNG dimensions changed" }
                        check(decoded.config == Bitmap.Config.ARGB_8888) { "PNG decoded to ${decoded.config}" }
                        check(iconSHA256(iconPixels(decoded)) == capture.hash) { "PNG normalized pixel mismatch" }
                    } finally { decoded.recycle() }
                    val destination = owned("$stem.png")
                    check(!destination.exists() && partial.renameTo(destination)) { "PNG publication failed" }
                    record.put("png", destination.name).put("pngSHA256", iconSHA256(png)).put("pngBytes", png.size)
                        .put("pngChunks", pngChunks(png)).put("roundTrip", true)
                } catch (failure: Throwable) {
                    record.put("exportFailure", failure.toString())
                    try {
                        exclusive("$stem.rgba", capture.rgba)
                        record.put("rawDiagnostic", "$stem.rgba").put("rawSHA256", capture.hash)
                    } catch (fallback: Throwable) { record.put("capturePreservationFailed", fallback.toString()) }
                    exportError = exportError ?: failure
                } finally { exclusive("$stem.json", record.toString(2).toByteArray(Charsets.UTF_8)) }
            }
            exportError?.let {
                caseFailures.put(JSONObject().put("case", request.key).put("exportFailure", it.toString()))
                throw it
            }
            if (readinessFailure == null) completedCases++
            checkpoint("incomplete", readinessFailure ?: "case ${request.key} retained")
        } finally {
            captures.forEach { if (!it.bitmap.isRecycled) it.bitmap.recycle() }
        }
    }

    fun failure(reason: String) {
        failures.put(reason)
        if (opened) checkpoint("incomplete", reason)
    }

    /** [stillLive] reports the owning job; cancellation by either route before the commit point wins. */
    fun finish(stillLive: () -> Boolean): Boolean {
        check(packageIdentity != null) { "package identity missing" }
        check(completedCases == expected && failures.length() == 0 && caseFailures.length() == 0) { "incomplete case set" }
        val index = checkpoint("captures-ready", "all files round-tripped; terminal eligibility check pending")
        val marker = JSONObject().put("run", id).put("plan", plan.name).put("index", index.name)
            .put("indexSHA256", iconSHA256(index.readBytes())).put("cases", completedCases)
            .put("vectorSourceSHA256", NativeIconCatalog.vectorSourceSHA256).toString(2).toByteArray(Charsets.UTF_8)
        reserve(marker.size)
        val pending = owned("COMPLETE.json.tmp")
        try {
            check(pending.createNewFile()) { "completion marker already pending" }
            FileOutputStream(pending).use { it.write(marker); it.fd.sync() }
            synchronized(terminalLock) {
                val reason = cancellation.get() ?: if (stillLive()) null else "cancelled before terminal commit"
                if (reason != null) {
                    failure(reason)
                    return false
                }
                // The atomic rename of a complete, synced marker is the commit point. Nothing is written after it.
                Files.move(pending.toPath(), owned("COMPLETE.json").toPath(), StandardCopyOption.ATOMIC_MOVE)
                complete = true
            }
            return true
        } finally {
            if (!complete && pending.exists() && !pending.delete()) failures.put("temporary completion marker could not be removed")
        }
    }
}

internal fun pngChunks(bytes: ByteArray): JSONArray {
    require(bytes.size >= 8 && bytes.copyOfRange(0, 8).contentEquals(byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10)))
    val chunks = JSONArray()
    var p = 8
    while (p + 12 <= bytes.size) {
        val n = ((bytes[p].toInt() and 255).toLong() shl 24) or ((bytes[p + 1].toInt() and 255).toLong() shl 16) or
            ((bytes[p + 2].toInt() and 255).toLong() shl 8) or (bytes[p + 3].toInt() and 255).toLong()
        require(n <= ICON_RASTER_FILE_BYTES && p + 12L + n <= bytes.size)
        val name = String(bytes, p + 4, 4, Charsets.US_ASCII)
        val row = JSONObject().put("type", name).put("bytes", n)
        if (name in listOf("sRGB", "gAMA", "iCCP", "IHDR")) row.put("dataSHA256", iconSHA256(bytes.copyOfRange(p + 8, p + 8 + n.toInt())))
        chunks.put(row)
        p += 12 + n.toInt()
        require(chunks.length() <= 100)
        if (name == "IEND") break
    }
    require(p == bytes.size)
    return chunks
}
