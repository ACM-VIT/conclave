package conclave.module

/**
 * Stores an uncaught exception as a crash record before the process dies, for the next launch to
 * upload, then hands it to the previous handler. Native signal crashes and ANRs arrive through
 * ApplicationExitInfo instead.
 */
internal object AndroidCrashCapture {
    private const val MAX_CAUSES = 3

    @Volatile private var installed = false

    fun install(store: DiagnosticsFileStore) {
        if (installed) return
        installed = true
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                store.writePayload(payload(throwable, breadcrumbCodes(), currentPhase(), System.currentTimeMillis().toDouble()))
            } catch (_: Throwable) {
            }
            previous?.uncaughtException(thread, throwable)
        }
    }

    internal fun payload(
        throwable: Throwable,
        breadcrumbs: List<String>,
        phase: String,
        createdAtMillis: Double,
        appVersion: String = NativePerformanceDiagnostics.appVersion(),
    ): DiagnosticsStoredPayload {
        val exceptions = mutableListOf<CrashReportException>()
        var current: Throwable? = throwable
        while (current != null && exceptions.size < MAX_CAUSES) {
            exceptions.add(CrashReportException(type = current.javaClass.name, frames = skip.lib.Array(frames(current))))
            val cause = current.cause
            current = if (cause === current) null else cause
        }
        return CrashCaptureRecord.payload(
            exceptions = skip.lib.Array(exceptions),
            breadcrumbs = skip.lib.Array(breadcrumbs),
            phase = phase,
            createdAtMillis = createdAtMillis,
            appVersion = appVersion,
        )
    }

    private fun frames(throwable: Throwable): List<CrashReportFrame> =
        throwable.stackTrace.take(CrashReportEventBuilder.maxFrames).map { element ->
            CrashReportFrame(
                function = element.methodName ?: "",
                module = element.className ?: "",
                filename = element.fileName ?: "",
                line = if (element.lineNumber > 0) element.lineNumber else 0,
                inApp = (element.className ?: "").startsWith("conclave."),
            )
        }

    private fun breadcrumbCodes(): List<String> = try {
        CallDiagnostics.shared.events.map { it.code }.toList()
    } catch (_: Throwable) {
        emptyList()
    }

    private fun currentPhase(): String = try {
        CallDiagnostics.shared.currentPhase
    } catch (_: Throwable) {
        ""
    }

    fun debugForceCrash() {
        if (!AndroidRuntimeConfig.isDebuggable()) return
        throw IllegalStateException("Conclave test crash")
    }
}
