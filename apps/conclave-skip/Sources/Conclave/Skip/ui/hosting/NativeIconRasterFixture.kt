package conclave.module

import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Canvas as AndroidCanvas
import android.graphics.ColorSpace
import android.os.Looper
import android.os.SystemClock
import androidx.compose.runtime.*
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Canvas as ComposeCanvas
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.CanvasDrawScope
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.VectorPath
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.*
import java.util.concurrent.atomic.AtomicBoolean

internal const val ICON_RASTER_MAX_CASES = 1127
internal const val ICON_RASTER_MAX_PIXELS = 144
private const val ICON_RASTER_READINESS_MS = 3_000L
private const val ICON_RASTER_RUN_MS = 600_000L

internal enum class IconRasterPlan { Geometry, Artwork, ReadinessFailure, ExportFailure }
internal data class IconRasterRequest(
    val ordinal: Int, val artwork: NativeIconArtwork, val dp: Int,
    val density: Int, val direction: LayoutDirection, val repetition: String,
) {
    val pixels: Int get() = dp * density
    val key: String get() = "$ordinal.${artwork.id}.$dp.$density.$direction.$repetition"
    val painterKey: String get() = "${artwork.id}.$density"
}

/** Finite matrix: 920 primary LTR, 32 directional RTL cycles (three frames each) and 111 nonmirroring 72px RTL controls. */
internal fun iconRasterCases(plan: IconRasterPlan): List<IconRasterRequest> = buildList {
    fun addCase(a: NativeIconArtwork, dp: Int = 24, density: Int = 3,
                direction: LayoutDirection = LayoutDirection.Ltr, repetition: String = "primary") {
        add(IconRasterRequest(size, a, dp, density, direction, repetition))
    }
    if (plan == IconRasterPlan.Geometry) {
        NativeIconGeometryFixtures.hand.forEach { addCase(it) }
        NativeIconGeometryFixtures.converted.forEach { addCase(it) }
    } else if (plan != IconRasterPlan.Artwork) {
        addCase(NativeIconGeometryFixtures.hand.first())
    } else {
        for (a in NativeIconCatalog.artwork) for (dp in listOf(18, 20, 24, 48)) for (density in listOf(1, 3)) addCase(a, dp, density)
        for (a in NativeIconCatalog.artwork.filter { it.mirrors }) for (dp in listOf(18, 20, 24, 48)) for (density in listOf(1, 3)) {
            addCase(a, dp, density, LayoutDirection.Ltr, "cycle-before")
            addCase(a, dp, density, LayoutDirection.Rtl, "cycle-rtl")
            addCase(a, dp, density, LayoutDirection.Ltr, "cycle-after")
        }
        NativeIconCatalog.artwork.filter { !it.mirrors }.forEach { addCase(it, direction = LayoutDirection.Rtl, repetition = "nonmirror-control") }
    }
}

internal fun requireIconStructure(vector: ImageVector, mirror: Boolean) {
    check(vector.defaultWidth == 24.dp && vector.defaultHeight == 24.dp)
    check(vector.viewportWidth == 960f && vector.viewportHeight == 960f && vector.autoMirror == mirror)
    check(vector.tintColor == Color.Unspecified)
    val root = vector.root
    check(root.size == 1 && root.rotation == 0f && root.pivotX == 0f && root.pivotY == 0f && root.scaleX == 1f &&
        root.scaleY == 1f && root.translationX == 0f && root.translationY == 0f && root.clipPathData.isEmpty())
    val path = root[0] as? VectorPath ?: error("one compound path required")
    check(path.pathFillType == PathFillType.NonZero && path.fill == SolidColor(Color.Black) && path.fillAlpha == 1f && path.stroke == null)
    check(path.trimPathStart == 0f && path.trimPathEnd == 1f && path.trimPathOffset == 0f)
}

internal fun requireMainThread() { check(Looper.myLooper() == Looper.getMainLooper()) { "main thread required" } }
private fun isDebuggable(context: Context) = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0

/** One run per process, whichever controller owns it. */
private object IconRunLease {
    val occupied = AtomicBoolean(false)
    var busy by mutableStateOf(false)
}
private class IconPainterBinding(val request: IconRasterRequest, val painter: Painter)

/** Root lifetime, not a lazy-list-item lifetime. Owns one job and drains exports on cancellation. */
internal class NativeIconRasterController(context: Context, private val scope: CoroutineScope) {
    private val app = context.applicationContext
    private var eligible by mutableStateOf(false)
    private var resumed by mutableStateOf(false)
    var busy by mutableStateOf(false); private set
    var status by mutableStateOf("Idle; explicit Start required"); private set
    var current by mutableStateOf<IconRasterRequest?>(null); private set
    /** Bumped between readiness frames: an unrelated recomposition of the painter scope. */
    var recompositionProbe by mutableIntStateOf(0); private set
    private var job: Job? = null
    private var journal: IconRasterJournal? = null
    private var binding: CompletableDeferred<IconPainterBinding>? = null
    private var rebinding: CompletableDeferred<IconPainterBinding>? = null
    private var boundPainter: Painter? = null
    private var cancelReason: String? = null
    val canStart: Boolean
        get() = eligible && resumed && isDebuggable(app) && !busy && !IconRunLease.busy && !IconRunLease.occupied.get()

    fun eligibility(value: Boolean) { requireMainThread(); eligible = value; if (!value) cancel("preview eligibility lost") }
    fun active(value: Boolean) { requireMainThread(); resumed = value; if (!value) cancel("lifecycle below RESUMED") }
    fun release(reason: String) { requireMainThread(); eligible = false; resumed = false; cancel(reason) }

    fun cancel(reason: String) {
        requireMainThread()
        val session = journal ?: return
        if (!busy || !session.cancel(reason)) return
        cancelReason = cancelReason ?: reason
        status = "Stopping; $reason"
        job?.cancel(CancellationException(reason))
    }

    fun bind(request: IconRasterRequest, vector: ImageVector, painter: Painter, probe: Int) {
        requireMainThread()
        if (current !== request || cancelReason != null) return
        val first = binding ?: return
        val result = runCatching {
            requireIconStructure(vector, request.artwork.mirrors)
            check(vector === request.artwork.vector()) { "lazy vector identity changed" }
            IconPainterBinding(request, painter)
        }
        if (!first.isCompleted) {
            result.onSuccess { boundPainter = it.painter; first.complete(it) }.onFailure { first.completeExceptionally(it) }
            return
        }
        val next = rebinding ?: return
        if (next.isCompleted || probe != recompositionProbe) return
        result.onSuccess {
            if (it.painter === boundPainter) next.complete(it)
            else next.completeExceptionally(IllegalStateException("painter identity changed on unrelated recomposition"))
        }.onFailure { next.completeExceptionally(it) }
    }

    private fun checkLive(session: IconRasterJournal, request: IconRasterRequest? = null) {
        requireMainThread()
        check(journal === session && eligible && resumed && isDebuggable(app) && cancelReason == null) { "run is no longer eligible" }
        if (request != null) check(current === request) { "request superseded" }
        check(session.cancellationReason() == null) { "journal cancelled" }
    }

    fun start(plan: IconRasterPlan) {
        requireMainThread()
        if (!canStart) return
        val cases = iconRasterCases(plan)
        check(cases.isNotEmpty() && cases.size <= ICON_RASTER_MAX_CASES && cases.all { it.pixels in 1..ICON_RASTER_MAX_PIXELS })
        if (!IconRunLease.occupied.compareAndSet(false, true)) return
        IconRunLease.busy = true
        val session = IconRasterJournal(app.cacheDir, plan, cases.size)
        journal = session; cancelReason = null; busy = true; status = "Preparing ${session.path}"
        job = scope.launch(start = CoroutineStart.UNDISPATCHED) { run(session, plan, cases) }
    }

    private suspend fun run(session: IconRasterJournal, plan: IconRasterPlan, cases: List<IconRasterRequest>) {
        var terminalFailure: String? = null
        var preservationFailure: String? = null
        try {
            // The run deadline is checked at every case boundary and inside the locked commit decision,
            // so no coroutine timeout can race the journal's terminal commit.
            val deadline = SystemClock.elapsedRealtime() + ICON_RASTER_RUN_MS
            // The incomplete index is published first, even when a cancellation is already pending, so a
            // started run keeps its directory, index and reason unless private storage itself fails.
            withContext(NonCancellable + Dispatchers.IO) { session.open() }
            // Hashing stops on cancellation; the identity, or the reason it is missing, reaches the next revision.
            withContext(Dispatchers.IO) { session.identify(iconPackageIdentity(app) { isActive }) }
            var cycleHash: String? = null
            for (request in cases) {
                checkLive(session)
                check(SystemClock.elapsedRealtime() <= deadline) { "run deadline exceeded" }
                withContext(Dispatchers.IO) { session.beginCase(request) }
                checkLive(session)
                binding = CompletableDeferred(); rebinding = null; boundPainter = null
                current = request
                status = "Capturing ${request.ordinal + 1}/${cases.size}; ${session.path}"
                val captures = mutableListOf<IconCapture>()
                var readinessFailure: String? = null
                try {
                    withTimeout(ICON_RASTER_READINESS_MS) {
                        val first = binding!!.await()
                        withFrameNanos { }
                        checkLive(session, request)
                        captures += captureIcon(first.painter, request, 0)
                        val next = CompletableDeferred<IconPainterBinding>()
                        rebinding = next
                        recompositionProbe++
                        val second = next.await()
                        withFrameNanos { }
                        checkLive(session, request)
                        captures += captureIcon(second.painter, request, 1)
                        check(captures.all { it.visible }) { "empty readiness capture" }
                        check(captures[0].hash == captures[1].hash) { "readiness pair differs" }
                        check(plan != IconRasterPlan.ReadinessFailure) { "injected readiness failure" }
                        if (request.repetition == "cycle-before") cycleHash = captures.last().hash
                        if (request.repetition == "cycle-after") check(cycleHash == captures.last().hash) { "LTR return is not repeatable" }
                    }
                } catch (failure: Throwable) {
                    readinessFailure = failure.toString()
                    throw failure
                } finally {
                    // Sole bitmap ownership moves to the bounded IO transaction, which always finishes.
                    withContext(NonCancellable + Dispatchers.IO) { session.export(request, captures, readinessFailure) }
                }
                checkLive(session, request)
                binding = null; rebinding = null; boundPainter = null
            }
            checkLive(session)
            withContext(Dispatchers.IO) {
                // Explicit, lifecycle, eligibility and disposal cancellation reach journal.cancel() under the
                // terminal lock. Job state and the deadline are read again at the locked commit decision.
                val owner = coroutineContext[Job]
                check(session.finish { owner?.isActive == true && SystemClock.elapsedRealtime() <= deadline }) {
                    "cancelled before terminal commit"
                }
            }
        } catch (failure: Throwable) {
            if (!session.isComplete()) terminalFailure = cancelReason ?: failure.toString()
        } finally {
            current = null; binding = null; rebinding = null; boundPainter = null
            try {
                if (!session.isComplete()) withContext(NonCancellable + Dispatchers.IO) {
                    try { session.failure(terminalFailure ?: cancelReason ?: "run ended before completion") }
                    catch (failure: Throwable) { preservationFailure = "index preservation failed: $failure" }
                }
            } finally {
                // Main thread, even when a cancelled caller discards the dispatched IO result. The journal names
                // only what it finished writing, which may be nothing.
                status = if (session.isComplete()) "Complete; ${session.path}"
                    else listOfNotNull("Incomplete", terminalFailure ?: cancelReason ?: "run ended before completion",
                        preservationFailure, session.retained()).joinToString("; ")
                journal = null; job = null; busy = false
                IconRunLease.occupied.set(false); IconRunLease.busy = false
            }
        }
    }
}

/** Public painter draw into a software sRGB bitmap with explicit pixels, density and direction. */
internal fun captureIcon(painter: Painter, request: IconRasterRequest, frame: Int): IconCapture {
    requireMainThread()
    val bitmap = Bitmap.createBitmap(request.pixels, request.pixels, Bitmap.Config.ARGB_8888, true, ColorSpace.get(ColorSpace.Named.SRGB))
    try {
        bitmap.density = Bitmap.DENSITY_NONE; bitmap.setPremultiplied(true); bitmap.eraseColor(android.graphics.Color.TRANSPARENT)
        val androidCanvas = AndroidCanvas(bitmap)
        check(!androidCanvas.isHardwareAccelerated)
        val size = Size(request.pixels.toFloat(), request.pixels.toFloat())
        CanvasDrawScope().draw(Density(request.density.toFloat(), 1f), request.direction, ComposeCanvas(androidCanvas), size) {
            with(painter) { draw(size, alpha = 1f, colorFilter = ColorFilter.tint(Color.Black, BlendMode.SrcIn)) }
        }
        return IconCapture(bitmap, iconPixels(bitmap), frame)
    } catch (failure: Throwable) {
        bitmap.recycle()
        throw failure
    }
}

@Composable
internal fun NativeIconRasterBinding(controller: NativeIconRasterController, fixtureEligible: Boolean) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(controller, lifecycle) {
        controller.active(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
        val observer = LifecycleEventObserver { _, _ -> controller.active(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); controller.release("raster binding disposed") }
    }
    // Equal writes are quiet; a false value cancels an active run with its own reason.
    SideEffect { controller.eligibility(fixtureEligible) }
    val request = controller.current ?: return
    key(request.painterKey) {
        CompositionLocalProvider(LocalDensity provides Density(request.density.toFloat(), 1f), LocalLayoutDirection provides request.direction) {
            val vector = request.artwork.vector()
            val painter = rememberVectorPainter(vector)
            val probe = controller.recompositionProbe
            SideEffect { controller.bind(request, vector, painter, probe) }
        }
    }
}
