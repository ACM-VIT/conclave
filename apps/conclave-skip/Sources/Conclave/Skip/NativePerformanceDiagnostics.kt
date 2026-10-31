package conclave.module

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.os.StrictMode
import android.os.SystemClock
import android.os.Trace
import android.util.Log
import android.view.Choreographer
import androidx.annotation.RequiresApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ProcessLifecycleOwner
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject
import skip.foundation.ProcessInfo
import skip.ui.UIApplication

object NativePerformanceDiagnostics {
    private const val TAG = "ConclavePerf"
    private const val DIAG_TAG = "ConclaveDiag"

    private const val FORCE_FAILURE_TAG = "ConclaveDiagFail"
    private const val SLOW_FRAME_NS = 50_000_000L
    private const val VERY_SLOW_FRAME_NS = 100_000_000L
    private const val RENDER_LOG_INTERVAL_NS = 500_000_000L
    private const val STATE_LOG_INTERVAL_NS = 120_000_000L
    private const val TRACE_PREFIX = "conclave."
    private const val PREFS_NAME = "conclave.diagnostics"
    private const val PREF_LAST_EXIT_TIMESTAMP = "lastExitTimestamp"

    private const val FILE_PROVIDER_SUFFIX = ".fileprovider"

    private const val PROCESS_STATE_SUMMARY_BYTES = 128
    private const val MAX_TRACE_LINES = 2_000
    private const val MAX_TRACE_LINE_LENGTH = 240
    private const val SAFE_THREAD_NAME_CHARACTERS =
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _.:#-"

    @Volatile private var installed = false
    @Volatile private var frameMonitorStarted = false
    @Volatile private var lottieNativePrewarmStarted = false
    @Volatile private var diagnosticsListenersInstalled = false
    private val mainHandler = Handler(Looper.getMainLooper())
    private val renderCounts = ConcurrentHashMap<String, Int>()
    private val lastRenderLogAt = ConcurrentHashMap<String, Long>()
    private val lastStateLogAt = ConcurrentHashMap<String, Long>()
    private val slowFrames = AtomicInteger(0)
    private val verySlowFrames = AtomicInteger(0)

    private val backgroundObserver = LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_STOP) {
            CallDiagnostics.shared.applicationDidEnterBackground()
        }
    }

    fun install() {
        if (installed) return
        installed = true
        Log.i(TAG, "install debuggable=${AndroidRuntimeConfig.isDebuggable()} verbose=${verboseLogsEnabled()}")
        if (verboseLogsEnabled()) {
            startSlowFrameMonitor()
        }
        warmMeetingIcons()
        prewarmDotLottieNativeLibraries()
    }

    fun enabled(): Boolean = verboseLogsEnabled()

    fun event(name: String, details: String = "") {
        if (!verboseLogsEnabled()) return
        val suffix = if (details.isBlank()) "" else " $details"
        Log.i(TAG, "event $name$suffix thread=${Thread.currentThread().name}")
    }

    fun state(name: String, oldValue: String, newValue: String) {
        if (oldValue == newValue || !verboseLogsEnabled()) return
        val now = System.nanoTime()
        val last = lastStateLogAt[name] ?: 0L
        if (now - last < STATE_LOG_INTERVAL_NS) return
        lastStateLogAt[name] = now
        Log.d(TAG, "state $name $oldValue->$newValue thread=${Thread.currentThread().name}")
    }

    fun render(name: String, details: String = "") {
        if (!verboseLogsEnabled()) return
        val now = System.nanoTime()
        renderCounts[name] = (renderCounts[name] ?: 0) + 1
        val last = lastRenderLogAt[name] ?: 0L
        if (now - last < RENDER_LOG_INTERVAL_NS) return
        val count = renderCounts.remove(name) ?: 0
        lastRenderLogAt[name] = now
        val suffix = if (details.isBlank()) "" else " $details"
        Log.d(TAG, "render $name count=$count$suffix thread=${Thread.currentThread().name}")
    }

    fun lottie(message: String) {
        if (!verboseLogsEnabled()) return
        Log.i(TAG, "lottie $message")
    }

    fun lottieError(message: String, throwable: Throwable? = null) {
        Log.e(TAG, "lottie $message", throwable)
    }

    fun timing(name: String, startedAtNs: Long, details: String = "") {
        if (!verboseLogsEnabled()) return
        val durationMs = (System.nanoTime() - startedAtNs) / 1_000_000.0
        val suffix = if (details.isBlank()) "" else " $details"
        Log.d(TAG, "timing $name ms=$durationMs$suffix thread=${Thread.currentThread().name}")
    }

    fun timingAlways(name: String, startedAtNs: Long, details: String = "") {
        if (!verboseLogsEnabled()) return
        val durationMs = (System.nanoTime() - startedAtNs) / 1_000_000.0
        val suffix = if (details.isBlank()) "" else " $details"
        Log.i(TAG, "timing $name ms=$durationMs$suffix thread=${Thread.currentThread().name}")
    }

    fun measurement(name: String, durationMs: Double, details: String = "") {
        if (!verboseLogsEnabled()) return
        val suffix = if (details.isBlank()) "" else " $details"
        Log.i(TAG, "timing $name ms=$durationMs$suffix thread=${Thread.currentThread().name}")
    }

    fun memory(name: String) {
        if (!verboseLogsEnabled()) return
        val runtime = Runtime.getRuntime()
        val usedMb = (runtime.totalMemory() - runtime.freeMemory()) / (1024.0 * 1024.0)
        val totalMb = runtime.totalMemory() / (1024.0 * 1024.0)
        val maxMb = runtime.maxMemory() / (1024.0 * 1024.0)
        val nativeMb = Debug.getNativeHeapAllocatedSize() / (1024.0 * 1024.0)
        Log.i(
            TAG,
            "memory $name javaUsedMb=$usedMb javaTotalMb=$totalMb javaMaxMb=$maxMb nativeMb=$nativeMb thread=${Thread.currentThread().name}"
        )
    }

    fun monotonicMillis(): Double = SystemClock.elapsedRealtime().toDouble()

    fun isDebuggable(): Boolean = AndroidRuntimeConfig.isDebuggable()

    fun traceBegin(name: String, cookie: Int) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                Trace.beginAsyncSection(traceSectionName(name), cookie)
            } else {
                Trace.beginSection(traceSectionName(name) + ".begin")
                Trace.endSection()
            }
        } catch (_: Throwable) {

        }
    }

    fun traceEnd(name: String, cookie: Int) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                Trace.endAsyncSection(traceSectionName(name), cookie)
            } else {
                Trace.beginSection(traceSectionName(name) + ".end")
                Trace.endSection()
            }
        } catch (_: Throwable) {
        }
    }

    fun traceInstant(name: String) {
        try {
            Trace.beginSection(traceSectionName(name))
            Trace.endSection()
        } catch (_: Throwable) {
        }
    }

    internal fun traceSectionName(name: String): String {
        val full = TRACE_PREFIX + name
        return if (full.length > 120) full.substring(0, 120) else full
    }

    fun logCode(category: String, code: String, phase: String) {
        if (!verboseLogsEnabled()) return
        Log.i(DIAG_TAG, "$category $code phase=$phase")
    }

    fun stampProcessState(callSession: Int, phase: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        try {
            val manager = ProcessInfo.processInfo.androidContext.getSystemService(ActivityManager::class.java) ?: return
            manager.setProcessStateSummary(processStateSummary(callSession, phase))
        } catch (_: Throwable) {
        }
    }

    internal fun processStateSummary(callSession: Int, phase: String): ByteArray {
        val bytes = "s=$callSession;p=$phase".toByteArray(Charsets.UTF_8)
        return if (bytes.size > PROCESS_STATE_SUMMARY_BYTES) bytes.copyOf(PROCESS_STATE_SUMMARY_BYTES) else bytes
    }

    internal fun parseProcessStateSummary(bytes: ByteArray?): Pair<Int, String> {
        if (bytes == null || bytes.isEmpty()) return Pair(0, "")
        var session = 0
        var phase = ""
        for (part in String(bytes, Charsets.UTF_8).split(";")) {
            val separator = part.indexOf('=')
            if (separator <= 0) continue
            val key = part.substring(0, separator)
            val value = part.substring(separator + 1)
            when (key) {
                "s" -> session = value.toIntOrNull() ?: 0
                "p" -> phase = value
            }
        }
        return Pair(session, phase)
    }

    internal fun exitReasonName(reason: Int): String = when (reason) {
        0 -> "unknown"
        1 -> "exitSelf"
        2 -> "signaled"
        3 -> "lowMemory"
        4 -> "crash"
        5 -> "crashNative"
        6 -> "anr"
        7 -> "initializationFailure"
        8 -> "permissionChange"
        9 -> "excessiveResourceUsage"
        10 -> "userRequested"
        11 -> "userStopped"
        12 -> "dependencyDied"
        13 -> "other"
        14 -> "freezer"
        15 -> "packageStateChange"
        16 -> "packageUpdated"
        else -> "reason$reason"
    }

    fun appVersion(): String = try {
        val context = ProcessInfo.processInfo.androidContext
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        val name = info.versionName ?: ""
        "$name (${info.longVersionCode})"
    } catch (_: Throwable) {
        ""
    }

    fun osVersion(): String = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"

    fun deviceClass(): String = try {
        val width = ProcessInfo.processInfo.androidContext.resources.configuration.smallestScreenWidthDp
        if (width >= 600) "tablet" else "phone"
    } catch (_: Throwable) {
        "phone"
    }

    fun slowFrameCount(): Int = slowFrames.get()

    fun verySlowFrameCount(): Int = verySlowFrames.get()

    fun frameMonitorActive(): Boolean = frameMonitorStarted

    fun setCommunicationDeviceCount(): Int = AudioRouteOwnerBridge.setCommunicationDeviceCount

    fun volumeStream(): Int = AudioRouteOwnerBridge.volumeStream(AudioRouteOwnerBridge.isCallAudioLive)

    internal fun installDiagnosticsListeners(store: DiagnosticsFileStore) {
        if (diagnosticsListenersInstalled) return
        diagnosticsListenersInstalled = true
        val register = {
            ProcessLifecycleOwner.get().lifecycle.addObserver(backgroundObserver)
            if (AndroidRuntimeConfig.isDebuggable()) {
                enableDebugStrictMode()
            }
        }
        if (Looper.myLooper() == Looper.getMainLooper()) {
            register()
        } else {
            mainHandler.post(register)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val context = ProcessInfo.processInfo.androidContext.applicationContext
            Thread {
                collectExitReasons(context, store)
            }.apply {
                name = "ConclaveDiagnostics"
                isDaemon = true
                start()
            }
        }
    }

    private fun enableDebugStrictMode() {
        StrictMode.setThreadPolicy(StrictMode.ThreadPolicy.Builder().detectAll().penaltyLog().build())
        StrictMode.setVmPolicy(StrictMode.VmPolicy.Builder().detectAll().penaltyLog().build())
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun collectExitReasons(context: Context, store: DiagnosticsFileStore) {
        try {
            val manager = context.getSystemService(ActivityManager::class.java) ?: return
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val last = prefs.getLong(PREF_LAST_EXIT_TIMESTAMP, 0L)
            var newest = last
            for (info in manager.getHistoricalProcessExitReasons(context.packageName, 0, 5)) {
                if (info.timestamp <= last) continue
                if (info.timestamp > newest) newest = info.timestamp
                val summary = parseProcessStateSummary(info.processStateSummary)
                val trace = if (info.reason == ApplicationExitInfo.REASON_ANR) readAnrTrace(info) else ""
                store.writePayload(
                    DiagnosticsPayloadFactory.exitRecord(
                        reason = exitReasonName(info.reason),
                        timestampMillis = info.timestamp.toDouble(),
                        importance = info.importance,
                        status = info.status,
                        pssKb = info.pss.toDouble(),
                        rssKb = info.rss.toDouble(),
                        summarySession = summary.first,
                        summaryPhase = summary.second,
                        traceJSON = trace,
                    )
                )
            }
            if (newest > last) {
                prefs.edit().putLong(PREF_LAST_EXIT_TIMESTAMP, newest).apply()
            }
        } catch (error: Throwable) {
            if (verboseLogsEnabled()) Log.w(DIAG_TAG, "exit reasons unavailable: ${error.javaClass.simpleName}")
        }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun readAnrTrace(info: ApplicationExitInfo): String {
        return try {
            val stream = info.traceInputStream ?: return ""
            val buffer = ByteArray(DiagnosticsLimits.anrTraceBytes)
            var total = 0
            stream.use { input ->
                while (total < buffer.size) {
                    val read = input.read(buffer, total, buffer.size - total)
                    if (read <= 0) break
                    total += read
                }
            }
            traceJSON(String(buffer, 0, total, Charsets.UTF_8))
        } catch (_: Throwable) {
            ""
        }
    }

    internal fun traceJSON(text: String): String {
        val lines = sanitizedTraceLines(text)
        if (lines.isEmpty()) return ""
        return JSONObject().put("traceLines", JSONArray(lines)).toString()
    }

    internal fun sanitizedTraceLines(text: String): List<String> {
        val result = mutableListOf<String>()
        var threadIndex = 0
        for (raw in text.lineSequence()) {
            val line = raw.trim()
            val kept: String? = when {
                line.startsWith("at ") || line.startsWith("native: ") -> line
                line.startsWith("- waiting") || line.startsWith("- locked") || line.startsWith("- sleeping") ||
                    line.startsWith("- parking") -> line
                line.startsWith("| state=") -> line
                line.startsWith("\"") -> {
                    threadIndex += 1
                    val close = line.indexOf('"', 1)
                    val name = if (close > 0) line.substring(1, close) else ""
                    val rest = if (close > 0) line.substring(close + 1) else ""
                    val safeName = if (isSafeThreadName(name)) name else "thread-$threadIndex"
                    "\"$safeName\"$rest"
                }
                else -> null
            }
            if (kept != null) {
                result.add(if (kept.length > MAX_TRACE_LINE_LENGTH) kept.substring(0, MAX_TRACE_LINE_LENGTH) else kept)
                if (result.size >= MAX_TRACE_LINES) break
            }
        }
        return result
    }

    internal fun isSafeThreadName(name: String): Boolean =
        name.isNotEmpty() && name.length <= 40 && name.all { SAFE_THREAD_NAME_CHARACTERS.indexOf(it) >= 0 }

    fun debugBlockMainThread(millis: Int) {
        if (!AndroidRuntimeConfig.isDebuggable() || millis <= 0) return
        try {
            Thread.sleep(millis.toLong())
        } catch (_: InterruptedException) {
        }
    }

    fun debugForcesRedactionFailure(): Boolean =
        AndroidRuntimeConfig.isDebuggable() && Log.isLoggable(FORCE_FAILURE_TAG, Log.DEBUG)

    fun shareDiagnosticsFile(context: Context, path: String, title: String): Boolean {
        return try {
            val file = File(path)
            if (!file.exists()) return false
            val uri = FileProvider.getUriForFile(context, context.packageName + FILE_PROVIDER_SUFFIX, file)
            val chooser = Intent.createChooser(buildDiagnosticsSendIntent(uri, title), title)
            val activity = UIApplication.shared.androidActivity
            if (activity != null) {
                PipManager.suppressNextAutoEnter("diagnostics_share")
                activity.startActivity(chooser)
            } else {
                context.startActivity(chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            true
        } catch (_: Throwable) {
            PipManager.restoreAutoEnterAfterExternalActivity()
            false
        }
    }

    fun buildDiagnosticsSendIntent(uri: Uri, title: String): Intent = Intent(Intent.ACTION_SEND).apply {
        type = "application/json"
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_SUBJECT, title)
        putExtra(Intent.EXTRA_TITLE, title)
        clipData = ClipData.newRawUri(title, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

    private fun startSlowFrameMonitor() {
        if (frameMonitorStarted) return
        frameMonitorStarted = true
        val start = {
            val callback = object : Choreographer.FrameCallback {
                private var lastFrameTimeNs = 0L

                override fun doFrame(frameTimeNanos: Long) {
                    val last = lastFrameTimeNs
                    if (last != 0L) {
                        val delta = frameTimeNanos - last
                        if (delta >= SLOW_FRAME_NS) {
                            val verySlow = delta >= VERY_SLOW_FRAME_NS
                            if (verySlow) verySlowFrames.incrementAndGet() else slowFrames.incrementAndGet()
                            val level = if (verySlow) "very_slow_frame" else "slow_frame"
                            Log.w(TAG, "$level frameMs=${delta / 1_000_000.0}")
                        }
                    }
                    lastFrameTimeNs = frameTimeNanos
                    Choreographer.getInstance().postFrameCallback(this)
                }
            }
            Choreographer.getInstance().postFrameCallback(callback)
        }
        if (Looper.myLooper() == Looper.getMainLooper()) {
            start()
        } else {
            mainHandler.post(start)
        }
    }

    private fun prewarmDotLottieNativeLibraries() {
        if (lottieNativePrewarmStarted) return
        lottieNativePrewarmStarted = true
        Thread {
            val startedAt = System.nanoTime()
            try {
                System.loadLibrary("dlplayer")
                System.loadLibrary("dotlottie_player")
                timingAlways("lottie_native_prewarm", startedAt)
            } catch (error: Throwable) {
                Log.w(TAG, "lottie native prewarm failed: ${error.message}", error)
            }
        }.apply {
            name = "ConclaveLottiePrewarm"
            isDaemon = true
            start()
        }
    }

    private fun verboseLogsEnabled(): Boolean =
        AndroidRuntimeConfig.isDebuggable() || Log.isLoggable(TAG, Log.DEBUG)
}

@Composable
internal fun DiagnosticsExportItem(presenter: DiagnosticsExportPresenter, identifier: String) {
    val exporting = presenter.phase == DiagnosticsExportPhase.exporting
    ListItem(
        headlineContent = { ConclaveText(conclaveString("sys_diag_export"), line = "$identifier.title") },
        supportingContent = { ConclaveText(conclaveString("sys_diag_footer"), line = "$identifier.footer") },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.heightIn(min = 56.dp).testTag(identifier)
            .clickable(enabled = !exporting, role = Role.Button) { presenter.export() },
    )
}

@Composable
internal fun DiagnosticsExportEffects(presenter: DiagnosticsExportPresenter, snackbar: SnackbarHostState) {
    val context = LocalContext.current
    val ready = presenter.readyRevision
    val failed = presenter.failureRevision
    val title = conclaveString("sys_diag_share_title")
    val failure = conclaveString("sys_diag_failed")
    val retry = conclaveString("ds_retry")
    LaunchedEffect(ready) {
        val path = presenter.takePendingShare()
        if (path.isNotEmpty()) {
            if (NativePerformanceDiagnostics.shareDiagnosticsFile(context, path, title)) {
                presenter.shareFinished()
            } else {
                presenter.shareFailed()
            }
        }
    }
    LaunchedEffect(failed) {
        if (presenter.takePendingFailure()) {
            val result = snackbar.showSnackbar(message = failure, actionLabel = retry, duration = SnackbarDuration.Long)
            if (result == SnackbarResult.ActionPerformed) presenter.export()
        }
    }
}

@Composable
fun DiagnosticsFixtureReadouts(modifier: Modifier = Modifier) {
    var tick by remember { mutableIntStateOf(0) }
    val diagnostics = CallDiagnostics.shared
    val marker = tick
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(if (marker >= 0) diagnostics.readoutValue(DiagnosticsReadout.listenersKey) else "",
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onBackground,
            modifier = Modifier.testTag(DiagnosticsReadout.listenersKey))
        Text(if (marker >= 0) diagnostics.readoutValue(DiagnosticsReadout.bufferKey) else "",
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onBackground,
            modifier = Modifier.testTag(DiagnosticsReadout.bufferKey))
        TextButton(onClick = {
            diagnostics.debugRecordClassifiedError()
            tick += 1
        }, modifier = Modifier.testTag("sys.diagTestError")) { Text(conclaveString("sys_diag_fixture_error")) }
        TextButton(onClick = {
            diagnostics.debugSimulateHang(milliseconds = 6_000)
            tick += 1
        }, modifier = Modifier.testTag("sys.diagTestHang")) { Text(conclaveString("sys_diag_fixture_hang")) }
    }
}
