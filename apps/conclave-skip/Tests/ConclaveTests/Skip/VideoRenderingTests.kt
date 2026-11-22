package conclave.module

import android.graphics.SurfaceTexture
import android.os.Looper
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowChoreographer
import org.webrtc.VideoFrame
import java.time.Duration
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

private class RecordingBackend : VideoRenderBackend {
    private val queue = LinkedBlockingDeque<Runnable>()
    private val thread = Thread {
        try {
            while (true) queue.take().run()
        } catch (interrupted: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }.apply {
        isDaemon = true
        start()
    }
    val calls: MutableList<String> = Collections.synchronizedList(mutableListOf())
    val layouts: MutableList<VideoDrawLayout> = Collections.synchronizedList(mutableListOf())
    val drawn: MutableList<VideoFrame> = Collections.synchronizedList(mutableListOf())
    val corners: MutableList<String> = Collections.synchronizedList(mutableListOf())
    val refusals = AtomicInteger(0)
    @Volatile var refusesSurfaces = false
    @Volatile var swapSucceeds = true
    @Volatile var drawSucceeds = true
    @Volatile var bindSucceeds = true
    @Volatile var width = 400
    @Volatile var height = 400
    @Volatile var sizeOfTheNextSurface: Pair<Int, Int>? = null
    @Volatile var duringDraw: (() -> Unit)? = null
    @Volatile private var stalledSwap: CountDownLatch? = null
    @Volatile private var stalledBind: CountDownLatch? = null
    @Volatile private var stalledUnbind: CountDownLatch? = null
    private val stalled = CountDownLatch(1)
    val unbound: MutableList<Any> = Collections.synchronizedList(mutableListOf())
    @Volatile var stopped = false
        private set
    private val surfaces = AtomicInteger(0)

    override fun post(task: Runnable): Boolean {
        if (stopped) return false
        queue.addLast(task)
        return true
    }

    override fun postFirst(task: Runnable): Boolean {
        if (stopped) return false
        queue.addFirst(task)
        return true
    }

    override fun release() { stopped = true }

    override fun createSurface(target: Any): Any? {
        if (refusesSurfaces) {
            refusals.incrementAndGet()
            return null
        }
        calls.add("create")
        sizeOfTheNextSurface?.let { size ->
            width = size.first
            height = size.second
            sizeOfTheNextSurface = null
        }
        return "surface-" + surfaces.incrementAndGet()
    }
    override fun destroySurface(surface: Any) { calls.add("destroy $surface") }
    override fun unbindSurface(surface: Any) {
        stallOn(stalledUnbind) { stalledUnbind = null }
        unbound.add(surface)
    }
    override fun makeCurrent(surface: Any): Boolean {
        stallOn(stalledBind) { stalledBind = null }
        return bindSucceeds
    }
    override fun surfaceWidth(surface: Any): Int = width
    override fun surfaceHeight(surface: Any): Int = height
    override fun swap(surface: Any): Boolean {
        calls.add("swap $surface")
        stallOn(stalledSwap) { stalledSwap = null }
        return swapSucceeds
    }

    private fun stallOn(stall: CountDownLatch?, taken: () -> Unit) {
        if (stall == null) return
        taken()
        stalled.countDown()
        stall.await()
    }
    override fun clear(red: Float, green: Float, blue: Float) { calls.add("clear") }
    override fun draw(frame: VideoFrame, layout: VideoDrawLayout): Boolean {
        calls.add("draw")
        drawn.add(frame)
        layouts.add(layout)
        duringDraw?.invoke()
        return drawSucceeds
    }
    override fun cutCorners(width: Int, height: Int, radius: Float): Boolean {
        corners.add("$width x $height r$radius")
        return true
    }

    fun settle() {
        val done = CountDownLatch(1)
        queue.addLast { done.countDown() }
        assertTrue("the render thread is stuck", done.await(5, TimeUnit.SECONDS))
    }

    fun park(): CountDownLatch {
        val parked = CountDownLatch(1)
        val gate = CountDownLatch(1)
        queue.addLast {
            parked.countDown()
            gate.await()
        }
        assertTrue("the render thread is stuck", parked.await(5, TimeUnit.SECONDS))
        return gate
    }

    fun stallNextSwap(): CountDownLatch = CountDownLatch(1).also { stalledSwap = it }
    fun stallNextBind(): CountDownLatch = CountDownLatch(1).also { stalledBind = it }
    fun stallNextUnbind(): CountDownLatch = CountDownLatch(1).also { stalledUnbind = it }

    fun awaitStall() {
        assertTrue("the render thread never reached the stall", stalled.await(5, TimeUnit.SECONDS))
    }

    fun count(prefix: String): Int = calls.count { it.startsWith(prefix) }
    fun shutdown() { thread.interrupt() }
}

private class CountingBuffer(private val bufferWidth: Int, private val bufferHeight: Int) : VideoFrame.Buffer {
    val references = AtomicInteger(1)
    override fun getWidth(): Int = bufferWidth
    override fun getHeight(): Int = bufferHeight
    override fun toI420(): VideoFrame.I420Buffer = throw UnsupportedOperationException()
    override fun retain() { references.incrementAndGet() }
    override fun release() { references.decrementAndGet() }
    override fun cropAndScale(cropX: Int, cropY: Int, cropWidth: Int, cropHeight: Int, scaleWidth: Int, scaleHeight: Int): VideoFrame.Buffer =
        throw UnsupportedOperationException()
}

private class CountingTexture : SurfaceTexture(0) {
    val releases = AtomicInteger(0)
    override fun release() { releases.incrementAndGet() }
}

@RunWith(RobolectricTestRunner::class)
class VideoRenderingTests {
    private val backend = RecordingBackend()
    private val buffers = mutableListOf<CountingBuffer>()
    private val frameSizes: MutableList<String> = Collections.synchronizedList(mutableListOf())
    private val firstFrames: MutableList<Int> = Collections.synchronizedList(mutableListOf())
    private val shownSizes: MutableList<String> = Collections.synchronizedList(mutableListOf())
    private val clockNanos = AtomicLong(1)

    @After fun tearDown() { backend.shutdown() }

    private fun renderer(letterboxInBuffer: Boolean = true): VideoTileRenderer = VideoTileRenderer(
        backend = backend, letterboxInBuffer = letterboxInBuffer, backgroundRgb = 0x0A0A0BL,
        onFrameSizeChanged = { width, height -> frameSizes.add("$width x $height") },
        onFirstFramePresented = { generation -> firstFrames.add(generation) },
        onBufferSizeShown = { generation, width, height -> shownSizes.add("$generation: $width x $height") },
        nanoTime = { clockNanos.get() },
    )

    private fun frame(width: Int = 640, height: Int = 360, rotation: Int = 0): VideoFrame {
        val buffer = CountingBuffer(width, height)
        buffers.add(buffer)
        return VideoFrame(buffer, rotation, 0L)
    }

    private fun assertLayout(expected: VideoDrawLayout, actual: VideoDrawLayout) {
        assertEquals(listOf(expected.x, expected.y, expected.width, expected.height), listOf(actual.x, actual.y, actual.width, actual.height))
        assertEquals(expected.scaleX, actual.scaleX, 0.0001f)
        assertEquals(expected.scaleY, actual.scaleY, 0.0001f)
        assertEquals(expected.mirror, actual.mirror)
        assertEquals(expected.clearsSurface, actual.clearsSurface)
    }

    private fun assertEveryFrameGivenBack() {
        for (buffer in buffers) assertEquals("a frame is still held or was released twice", 1, buffer.references.get())
    }

    @Test fun aFrameWithNoSurfaceIsGivenBackUndrawn() {
        val renderer = renderer()
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(0, backend.count("draw"))
        assertEveryFrameGivenBack()
    }

    @Test fun eachFrameIsDrawnPresentedAndGivenBack() {
        val renderer = renderer()
        renderer.attachSurface("window", 1)
        renderer.onFrame(frame())
        backend.settle()
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(2, backend.count("draw"))
        assertEquals(2, backend.count("swap"))
        assertEveryFrameGivenBack()
    }

    @Test fun onlyTheNewestFrameOfABacklogIsDrawn() {
        val renderer = renderer()
        renderer.attachSurface("window", 1)
        backend.settle()
        val gate = backend.park()
        val stale = frame()
        val staler = frame()
        val newest = frame()
        renderer.onFrame(staler)
        renderer.onFrame(stale)
        renderer.onFrame(newest)
        gate.countDown()
        backend.settle()
        assertEquals(listOf(newest), backend.drawn.toList())
        assertEquals(1, backend.count("swap"))
        assertEveryFrameGivenBack()
    }

    @Test fun aSurfaceTheSystemRefusesDropsTheFrameAndIsAskedForAgain() {
        backend.refusesSurfaces = true
        val renderer = renderer()
        renderer.attachSurface("window", 1)
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(0, backend.count("draw"))
        backend.refusesSurfaces = false
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(listOf("create", "draw", "swap surface-1"), backend.calls.toList())
        assertEquals(listOf(1), firstFrames.toList())
        assertEveryFrameGivenBack()
    }

    @Test fun aSurfaceRefusedOverAndOverIsAskedForLessOftenButNeverGivenUpOn() {
        backend.refusesSurfaces = true
        val renderer = renderer()
        renderer.attachSurface("window", 1)
        for (index in 0 until 200) {
            renderer.onFrame(frame())
            backend.settle()
        }
        assertEquals(10, backend.refusals.get())
        backend.refusesSurfaces = false
        for (index in 0 until 32) {
            renderer.onFrame(frame())
            backend.settle()
        }
        assertEquals(1, backend.count("create"))
        assertTrue(backend.count("draw") >= 1)
        assertEveryFrameGivenBack()
    }

    @Test fun aSurfaceWithNoSizeYetIsNotDrawnInto() {
        val renderer = renderer()
        backend.width = 0
        backend.height = 0
        renderer.attachSurface("window", 1)
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(0, backend.count("draw"))
        backend.width = 400
        backend.height = 400
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(1, backend.count("draw"))
        assertEveryFrameGivenBack()
    }

    @Test fun eachFrameIsLaidOutForTheBufferItIsDrawnInto() {
        val renderer = renderer()
        renderer.fit = true
        renderer.attachSurface("window", 1)
        renderer.onFrame(frame(640, 360))
        backend.settle()
        backend.width = 320
        backend.height = 400
        renderer.onFrame(frame(640, 360))
        backend.settle()
        assertLayout(VideoDrawLayout(0, 87, 400, 225, 1f, 1f, mirror = false, clearsSurface = true), backend.layouts[0])
        assertLayout(VideoDrawLayout(0, 110, 320, 180, 1f, 1f, mirror = false, clearsSurface = true), backend.layouts[1])
    }

    private fun rendererWithA160By62Window(): VideoTileRenderer = renderer().also {
        it.windowSized(160, 62)
        backend.width = 160
        backend.height = 62
    }

    @Test fun aBufferTheWindowWouldRefuseIsGivenUpByRebuildingTheSurface() {
        val renderer = rendererWithA160By62Window()
        backend.width = 1032
        backend.height = 400
        renderer.attachSurface("window", 1)
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(listOf("create", "destroy surface-1", "create"), backend.calls.toList())
        assertTrue(firstFrames.isEmpty())
        backend.sizeOfTheNextSurface = 160 to 62
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(listOf("create", "destroy surface-1", "create", "destroy surface-2", "create", "draw", "swap surface-3"),
            backend.calls.toList())
        assertEquals(listOf(1), firstFrames.toList())
        assertEveryFrameGivenBack()
    }

    @Test fun aBufferThatNeverGetsTheWindowsSizeIsDrawnIntoAfterASecond() {
        val renderer = rendererWithA160By62Window()
        backend.width = 1032
        backend.height = 400
        renderer.attachSurface("window", 1)
        renderer.onFrame(frame())
        backend.settle()
        clockNanos.addAndGet(TimeUnit.MILLISECONDS.toNanos(900))
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(0, backend.count("draw"))
        clockNanos.addAndGet(TimeUnit.MILLISECONDS.toNanos(200))
        renderer.onFrame(frame())
        backend.settle()
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(2, backend.count("draw"))
        assertEquals(2, backend.count("swap"))
        assertEquals("a window given up on is not rebuilt for every frame", 4, backend.count("create"))
        assertEquals(listOf(1), firstFrames.toList())
        assertEveryFrameGivenBack()
    }

    @Test fun givingUpOnOneWindowSizeStillChecksTheBufferAfterTheNextResize() {
        val renderer = rendererWithA160By62Window()
        backend.width = 1032
        backend.height = 400
        renderer.attachSurface("window", 1)
        renderer.onFrame(frame())
        backend.settle()
        clockNanos.addAndGet(TimeUnit.MILLISECONDS.toNanos(1_100))
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(1, backend.count("swap"))
        backend.width = 160
        backend.height = 62
        renderer.onFrame(frame())
        backend.settle()
        renderer.windowSized(320, 124)
        backend.sizeOfTheNextSurface = 320 to 124
        val before = backend.calls.size
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(listOf("destroy surface-3", "create", "draw", "swap surface-4"), backend.calls.toList().drop(before))
        assertEveryFrameGivenBack()
    }

    @Test fun afterAResizeTheNextFrameGoesIntoABufferOfTheNewSizeNotTheOneTakenBefore() {
        val renderer = rendererWithA160By62Window()
        renderer.attachSurface("window", 1)
        renderer.onFrame(frame())
        backend.settle()
        renderer.windowSized(320, 124)
        backend.sizeOfTheNextSurface = 320 to 124
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(listOf("create", "draw", "swap surface-1", "destroy surface-1", "create", "draw", "swap surface-2"), backend.calls.toList())
        assertEquals(listOf("1: 160 x 62", "1: 320 x 124"), shownSizes.toList())
        assertEquals(listOf(1), firstFrames.toList())
        assertEveryFrameGivenBack()
    }

    @Test fun theSizeOfTheBufferOnScreenIsReportedEachTimeItChanges() {
        val renderer = rendererWithA160By62Window()
        renderer.attachSurface("window", 1)
        renderer.onFrame(frame())
        backend.settle()
        renderer.onFrame(frame())
        backend.settle()
        renderer.windowSized(320, 124)
        backend.width = 320
        backend.height = 124
        renderer.onFrame(frame())
        backend.settle()
        renderer.attachSurface("window", 2)
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(listOf("1: 160 x 62", "1: 320 x 124", "2: 320 x 124"), shownSizes.toList())
        assertEveryFrameGivenBack()
    }

    @Test fun aWindowResizedWhileItsFirstFrameIsDrawnDoesNotGetThatBuffer() {
        val renderer = rendererWithA160By62Window()
        renderer.attachSurface("window", 1)
        backend.duringDraw = { renderer.windowSized(320, 124) }
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(listOf("create", "draw"), backend.calls.toList())
        assertTrue(firstFrames.isEmpty())
        assertEveryFrameGivenBack()
    }

    @Test fun aDetachIsAnsweredOnlyAfterTheSurfaceIsDestroyedAndLaterFramesAreDropped() {
        val renderer = renderer()
        renderer.attachSurface("window", 1)
        renderer.onFrame(frame())
        backend.settle()
        assertTrue(renderer.surfaceGoneAfterDetach().await(5, TimeUnit.SECONDS))
        assertEquals(1, backend.count("destroy"))
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(1, backend.count("draw"))
        assertEveryFrameGivenBack()
    }

    @Test fun aNewSurfaceReplacesTheOldOne() {
        val renderer = renderer()
        renderer.attachSurface("first", 1)
        renderer.attachSurface("second", 2)
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(listOf("create", "destroy surface-1", "create", "draw", "swap surface-2"), backend.calls.toList())
    }

    @Test fun aReleasedRendererDestroysItsSurfaceAndHoldsNoFrame() {
        val renderer = renderer()
        renderer.attachSurface("window", 1)
        backend.settle()
        val gate = backend.park()
        renderer.onFrame(frame())
        renderer.release()
        renderer.onFrame(frame())
        gate.countDown()
        backend.settle()
        assertEquals(0, backend.count("draw"))
        assertEquals(1, backend.count("destroy"))
        assertEveryFrameGivenBack()
    }

    @Test fun theFirstPresentedFrameIsAnnouncedOncePerSurfaceWithItsGeneration() {
        val renderer = renderer()
        renderer.attachSurface("window", 7)
        renderer.onFrame(frame())
        backend.settle()
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(listOf(7), firstFrames.toList())
        renderer.attachSurface("again", 8)
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(listOf(7, 8), firstFrames.toList())
    }

    @Test fun afterTheImageIsForgottenTheNextFrameIsAFirstFrameAgainWithoutADraw() {
        val renderer = renderer()
        renderer.attachSurface("window", 3)
        renderer.onFrame(frame())
        backend.settle()
        renderer.forgetImage(4)
        backend.settle()
        assertEquals(1, backend.count("swap"))
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(listOf(3, 4), firstFrames.toList())
    }

    @Test fun clearingPaintsTheBackgroundAndDropsTheUndrawnFrame() {
        val renderer = renderer()
        renderer.attachSurface("window", 1)
        backend.settle()
        val gate = backend.park()
        renderer.onFrame(frame())
        renderer.clearImage(2)
        gate.countDown()
        backend.settle()
        assertEquals(listOf("create", "clear", "swap surface-1"), backend.calls.toList())
        assertEveryFrameGivenBack()
    }

    @Test fun aFrameThatArrivesAfterAClearIsDrawnAfterItNotPaintedOver() {
        val renderer = renderer()
        renderer.attachSurface("window", 1)
        backend.settle()
        val gate = backend.park()
        renderer.onFrame(frame())
        renderer.clearImage(2)
        val fresh = frame()
        renderer.onFrame(fresh)
        gate.countDown()
        backend.settle()
        assertEquals(listOf("create", "clear", "swap surface-1", "draw", "swap surface-1"), backend.calls.toList())
        assertEquals(listOf(fresh), backend.drawn.toList())
        assertEquals(listOf(2), firstFrames.toList())
        assertEveryFrameGivenBack()
    }

    @Test fun aFrameWaitingForANewSurfaceIsDrawnOnItAsSoonAsItExists() {
        val renderer = renderer()
        val gate = backend.park()
        val waiting = frame()
        renderer.onFrame(waiting)
        renderer.attachSurface("window", 5)
        gate.countDown()
        backend.settle()
        assertEquals(listOf(waiting), backend.drawn.toList())
        assertEquals(listOf(5), firstFrames.toList())
        assertEveryFrameGivenBack()
    }

    @Test fun aFrameThatFailsToDrawIsNeitherShownNorAnnounced() {
        backend.drawSucceeds = false
        val renderer = renderer()
        renderer.attachSurface("window", 1)
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(0, backend.count("swap"))
        assertTrue(firstFrames.isEmpty())
        backend.drawSucceeds = true
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(1, backend.count("swap"))
        assertEquals(listOf(1), firstFrames.toList())
        assertEveryFrameGivenBack()
    }

    @Test fun aDetachGoesAheadOfADrawThatIsAlreadyQueued() {
        val renderer = renderer()
        renderer.attachSurface("window", 1)
        backend.settle()
        val gate = backend.park()
        renderer.onFrame(frame())
        renderer.detachSurface(null)
        gate.countDown()
        backend.settle()
        assertEquals(listOf("create", "destroy surface-1"), backend.calls.toList())
        assertEveryFrameGivenBack()
    }

    @Test fun anAttachOvertakenByItsDetachCreatesNoSurfaceOnTheDeadWindow() {
        val renderer = renderer()
        val gate = backend.park()
        renderer.attachSurface("gone", 1)
        renderer.onFrame(frame())
        renderer.detachSurface(null)
        gate.countDown()
        backend.settle()
        assertTrue(backend.calls.isEmpty())
        assertEveryFrameGivenBack()
        renderer.attachSurface("window", 2)
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(listOf("create", "draw", "swap surface-1"), backend.calls.toList())
        assertEquals(listOf(2), firstFrames.toList())
    }

    @Test fun aStoppedBackendHoldsNoFrameAndAnswersDetachAndReleaseAtOnce() {
        val renderer = renderer()
        backend.release()
        renderer.onFrame(frame())
        assertEveryFrameGivenBack()
        var detached = false
        var released = false
        renderer.detachSurface { detached = true }
        renderer.release { released = true }
        assertTrue(detached)
        assertTrue(released)
        assertEquals(0L, renderer.surfaceGoneAfterDetach().count)
    }

    @Test fun afterReleaseADetachIsStillAnsweredOnlyOnceTheSurfaceIsGone() {
        val renderer = renderer()
        renderer.attachSurface("window", 1)
        backend.settle()
        val gate = backend.park()
        renderer.release()
        backend.release()
        val gone = renderer.surfaceGoneAfterDetach()
        assertFalse("the surface was reported gone while it still existed", gone.await(300, TimeUnit.MILLISECONDS))
        assertEquals(0, backend.count("destroy"))
        gate.countDown()
        assertTrue(gone.await(5, TimeUnit.SECONDS))
        assertEquals(1, backend.count("destroy"))
    }

    @Test fun aFailedSwapIsNotAFirstFrameAndTheSurfaceIsRebuilt() {
        backend.swapSucceeds = false
        val renderer = renderer()
        renderer.attachSurface("window", 1)
        renderer.onFrame(frame())
        backend.settle()
        assertTrue(firstFrames.isEmpty())
        assertEquals(listOf("create", "draw", "swap surface-1", "destroy surface-1"), backend.calls.toList())
        backend.swapSucceeds = true
        for (index in 0 until 2) {
            renderer.onFrame(frame())
            backend.settle()
        }
        assertEquals(listOf("create", "draw", "swap surface-1", "destroy surface-1", "create", "draw", "swap surface-2"), backend.calls.toList())
        assertEquals(listOf(1), firstFrames.toList())
        assertEveryFrameGivenBack()
    }

    @Test fun aSurfaceThatCannotBeBoundIsRebuiltWithTheSameBackoff() {
        val renderer = renderer()
        renderer.attachSurface("window", 1)
        backend.settle()
        backend.bindSucceeds = false
        for (index in 0 until 20) {
            renderer.onFrame(frame())
            backend.settle()
        }
        assertEquals(0, backend.count("draw"))
        assertEquals(4, backend.count("create"))
        assertEquals(4, backend.count("destroy"))
        backend.bindSucceeds = true
        for (index in 0 until 16) {
            renderer.onFrame(frame())
            backend.settle()
        }
        assertTrue(backend.count("draw") >= 1)
        assertEquals(listOf(1), firstFrames.toList())
        assertEveryFrameGivenBack()
    }

    @Test fun fillCropsTheFrameToTheViewAndCoversTheSurface() {
        val renderer = renderer()
        renderer.viewAspect = 1f
        renderer.attachSurface("window", 1)
        renderer.onFrame(frame(640, 360))
        backend.settle()
        assertLayout(VideoDrawLayout(0, 0, 400, 400, 0.5625f, 1f, mirror = false, clearsSurface = false), backend.layouts.single())
        assertEquals(0, backend.count("clear"))
    }

    @Test fun aTallFrameInAWideTileIsCroppedVertically() {
        val layout = VideoDrawLayoutPolicy.layout(frameWidth = 360, frameHeight = 640, surfaceWidth = 800, surfaceHeight = 400,
            viewAspect = 2f, fit = false, letterboxInBuffer = true, mirror = false)
        assertEquals(1f, layout.scaleX, 0f)
        assertEquals(0.28125f, layout.scaleY, 0.0001f)
    }

    @Test fun fitKeepsTheWholeFrameInACentredBoxOverTheBackground() {
        val renderer = renderer()
        renderer.fit = true
        backend.width = 400
        backend.height = 800
        renderer.attachSurface("window", 1)
        renderer.onFrame(frame(640, 360))
        backend.settle()
        assertLayout(VideoDrawLayout(0, 287, 400, 225, 1f, 1f, mirror = false, clearsSurface = true), backend.layouts.single())
        assertEquals(listOf("create", "clear", "draw", "swap surface-1"), backend.calls.toList())
    }

    @Test fun fitInAWiderSurfaceLeavesBarsLeftAndRight() {
        val layout = VideoDrawLayoutPolicy.layout(frameWidth = 360, frameHeight = 640, surfaceWidth = 800, surfaceHeight = 400,
            viewAspect = 2f, fit = true, letterboxInBuffer = true, mirror = false)
        assertLayout(VideoDrawLayout(287, 0, 225, 400, 1f, 1f, mirror = false, clearsSurface = true), layout)
    }

    @Test fun aFitFrameThatAlreadyMatchesTheSurfaceNeedsNoClear() {
        val layout = VideoDrawLayoutPolicy.layout(frameWidth = 640, frameHeight = 360, surfaceWidth = 320, surfaceHeight = 180,
            viewAspect = 0f, fit = true, letterboxInBuffer = true, mirror = false)
        assertLayout(VideoDrawLayout(0, 0, 320, 180, 1f, 1f, mirror = false, clearsSurface = false), layout)
    }

    @Test fun aViewThatFitsWithItsOwnTransformGetsTheWholeFrameStretchedOverItsBuffer() {
        val renderer = renderer(letterboxInBuffer = false)
        renderer.fit = true
        renderer.viewAspect = 0.5f
        backend.width = 400
        backend.height = 800
        renderer.attachSurface("texture", 1)
        renderer.onFrame(frame(640, 360))
        backend.settle()
        assertLayout(VideoDrawLayout(0, 0, 400, 800, 1f, 1f, mirror = false, clearsSurface = false), backend.layouts.single())
    }

    @Test fun aSidewaysFrameIsLaidOutByItsRotatedSize() {
        val renderer = renderer()
        renderer.fit = true
        backend.width = 400
        backend.height = 800
        renderer.attachSurface("window", 1)
        renderer.onFrame(frame(640, 360, rotation = 90))
        backend.settle()
        assertLayout(VideoDrawLayout(0, 44, 400, 711, 1f, 1f, mirror = false, clearsSurface = true), backend.layouts.single())
    }

    @Test fun theMirrorFlagReachesTheDraw() {
        val renderer = renderer()
        renderer.mirror = true
        renderer.attachSurface("window", 1)
        renderer.onFrame(frame())
        backend.settle()
        assertTrue(backend.layouts.single().mirror)
    }

    @Test fun cornersAreCutOnlyWithARadiusAndInBufferPixels() {
        val renderer = renderer()
        backend.width = 200
        backend.height = 150
        renderer.attachSurface("window", 1)
        renderer.onFrame(frame())
        backend.settle()
        assertTrue(backend.corners.isEmpty())
        renderer.cornerRadiusInViewPixels = 42f
        renderer.viewWidth = 400
        renderer.onFrame(frame())
        backend.settle()
        assertEquals(listOf("200 x 150 r21.0"), backend.corners.toList())
    }

    @Test fun theFrameSizeIsReportedWhenItChangesIncludingAQuarterTurn() {
        val renderer = renderer()
        renderer.onFrame(frame(640, 360))
        renderer.onFrame(frame(640, 360))
        renderer.onFrame(frame(640, 360, rotation = 90))
        renderer.onFrame(frame(320, 180))
        backend.settle()
        assertEquals(listOf("640 x 360", "360 x 640", "320 x 180"), frameSizes.toList())
        assertEquals(320, renderer.frameWidth)
        assertEquals(180, renderer.frameHeight)
        assertEveryFrameGivenBack()
    }

    @Test fun aBufferIsNeverLargerThanTheVisiblePartOfTheFrame() {
        assertEquals(VideoBufferSize(162, 360), VideoBufferSizePolicy.bufferSize(1080, 2400, 640, 360, fit = false))
        assertEquals(VideoBufferSize(640, 1422), VideoBufferSizePolicy.bufferSize(1080, 2400, 640, 360, fit = true))
    }

    @Test fun aFrameWithEnoughPixelsKeepsTheBufferAtTheViewSize() {
        assertEquals(VideoBufferSize(516, 453), VideoBufferSizePolicy.bufferSize(516, 453, 1280, 720, fit = false))
        assertEquals(VideoBufferSize(516, 453), VideoBufferSizePolicy.bufferSize(516, 453, 640, 360, fit = true))
        assertEquals(VideoBufferSize(680, 380), VideoBufferSizePolicy.bufferSize(680, 380, 640, 360, fit = false))
    }

    @Test fun aSmallerBufferKeepsTheViewsShape() {
        val size = VideoBufferSizePolicy.bufferSize(1080, 2400, 640, 360, fit = false)
        assertEquals(1080f / 2400f, size.width.toFloat() / size.height.toFloat(), 0.01f)
    }

    @Test fun unknownOrTinySizesFallBackToTheView() {
        assertEquals(VideoBufferSize(400, 300), VideoBufferSizePolicy.bufferSize(400, 300, 0, 0, fit = false))
        assertEquals(VideoBufferSize(0, 300), VideoBufferSizePolicy.bufferSize(0, 300, 640, 360, fit = false))
        assertEquals(VideoBufferSize(400, 4000), VideoBufferSizePolicy.bufferSize(400, 4000, 32, 32, fit = false))
    }

    @Test fun theCornerPassTouchesOnlyTheFourCornerSquares() {
        val vertices = VideoCornerGeometry.vertices(width = 200, height = 100, radius = 20f)
        assertEquals(VideoCornerGeometry.VERTEX_COUNT * VideoCornerGeometry.FLOATS_PER_VERTEX, vertices.size)
        var index = 0
        while (index < vertices.size) {
            val x = vertices[index]
            val y = vertices[index + 1]
            assertTrue("x $x is outside a corner square", kotlin.math.abs(x) >= 0.8f - 0.0001f && kotlin.math.abs(x) <= 1f)
            assertTrue("y $y is outside a corner square", kotlin.math.abs(y) >= 0.6f - 0.0001f && kotlin.math.abs(y) <= 1f)
            index += VideoCornerGeometry.FLOATS_PER_VERTEX
        }
    }

    @Test fun cornerDistancesRunFromTheArcCentreToTheSurfaceCorner() {
        val vertices = VideoCornerGeometry.vertices(width = 200, height = 100, radius = 20f)
        var index = 0
        while (index < vertices.size) {
            val x = vertices[index]
            val y = vertices[index + 1]
            val localX = vertices[index + 2]
            val localY = vertices[index + 3]
            assertEquals(if (kotlin.math.abs(x) == 1f) 20f else 0f, localX, 0f)
            assertEquals(if (kotlin.math.abs(y) == 1f) 20f else 0f, localY, 0f)
            index += VideoCornerGeometry.FLOATS_PER_VERTEX
        }
    }

    @Test fun aCornerRadiusNeverExceedsHalfTheShorterSide() {
        assertEquals(20f, VideoCornerGeometry.clampedRadius(200, 100, 20f), 0f)
        assertEquals(50f, VideoCornerGeometry.clampedRadius(200, 100, 80f), 0f)
        assertEquals(0f, VideoCornerGeometry.clampedRadius(200, 100, 0f), 0f)
        assertEquals(0f, VideoCornerGeometry.clampedRadius(0, 100, 20f), 0f)
    }

    @Test fun theBackOfTheStageGoesToDefaultLevelSurfaces() {
        for (role in listOf(StageSlotRole.grid, StageSlotRole.gridWide, StageSlotRole.spotlightMain, StageSlotRole.programFeed)) {
            for (hasRail in listOf(false, true)) {
                assertEquals(role.rawValue, StageVideoBacking.Surface,
                    StageVideoBackingPolicy.backing(role = role, hasRail = hasRail, fadesWithChrome = false))
            }
        }
    }

    @Test fun railTilesGoOneLevelUpUnlessTheyFadeWithTheChrome() {
        assertEquals(StageVideoBacking.OverlaySurface,
            StageVideoBackingPolicy.backing(role = StageSlotRole.rail, hasRail = true, fadesWithChrome = false))
        assertEquals(StageVideoBacking.Texture,
            StageVideoBackingPolicy.backing(role = StageSlotRole.rail, hasRail = true, fadesWithChrome = true))
    }

    @Test fun aFloatingTileTakesTheOverlayLevelOnlyWhenNoRailNeedsIt() {
        for (role in listOf(StageSlotRole.selfFloating, StageSlotRole.speakerInset)) {
            assertEquals(StageVideoBacking.OverlaySurface, StageVideoBackingPolicy.backing(role = role, hasRail = false, fadesWithChrome = false))
            assertEquals(StageVideoBacking.Texture, StageVideoBackingPolicy.backing(role = role, hasRail = true, fadesWithChrome = false))
        }
    }

    @Test fun tilesThatZoomOrHideStayLayersInTheWindow() {
        for (role in listOf(StageSlotRole.share, StageSlotRole.selfMinimized)) {
            assertEquals(StageVideoBacking.Texture, StageVideoBackingPolicy.backing(role = role, hasRail = false, fadesWithChrome = false))
        }
    }

    @Test fun noTwoOverlappingTilesShareASurfaceLevelInAnyLayout() {
        val portrait = stageViewportFrom(width = 411.0, height = 914.0, top = 24.0, bottom = 24.0, leading = 0.0, trailing = 0.0)
        val landscape = stageViewportFrom(width = 914.0, height = 411.0, top = 24.0, bottom = 24.0, leading = 0.0, trailing = 0.0)
        val tablet = stageViewportFrom(width = 1280.0, height = 800.0, top = 24.0, bottom = 24.0, leading = 0.0, trailing = 0.0)
        fun person(id: String, role: StageSlotRole) = StageSlot(id = "p:$id", role = role, userId = id, fit = StageVideoFit.fill)
        val rail = listOf(person("b", StageSlotRole.rail), person("c", StageSlotRole.rail), person("d", StageSlotRole.rail))
        val layouts = listOf(
            StageKind.oneOnOne to listOf(person("a", StageSlotRole.spotlightMain), person("me", StageSlotRole.selfFloating)),
            StageKind.grid to listOf(person("a", StageSlotRole.grid), person("b", StageSlotRole.grid), person("c", StageSlotRole.grid),
                person("d", StageSlotRole.grid), person("me", StageSlotRole.selfFloating)),
            StageKind.spotlight to listOf(person("a", StageSlotRole.spotlightMain)) + rail,
            StageKind.spotlight to listOf(person("a", StageSlotRole.spotlightMain)) + rail + person("me", StageSlotRole.selfFloating),
            StageKind.sidebar to listOf(person("a", StageSlotRole.spotlightMain)) + rail + person("me", StageSlotRole.selfFloating),
            StageKind.presentation to listOf(StageSlot(id = "share:a", role = StageSlotRole.share, userId = "a", fit = StageVideoFit.fit)) +
                rail + person("me", StageSlotRole.selfFloating),
            StageKind.attendeeLive to listOf(person("a", StageSlotRole.programFeed), person("b", StageSlotRole.speakerInset)),
        )
        var overlapsSeen = 0
        for (viewport in listOf(portrait, landscape, tablet)) {
            for ((kind, slots) in layouts) {
                for (corner in listOf("top-left", "top-right", "bottom-left", "bottom-right")) {
                    val frames = StageLayoutPolicy.frames(viewport = viewport, kind = kind, slots = skip.lib.Array(slots), selfCorner = corner)
                    val hasRail = StageVideoBackingPolicy.hasRail(slots)
                    val compactHeight = StageLayoutPolicy.isCompactHeight(viewport)
                    for (later in slots.indices) {
                        for (earlier in 0 until later) {
                            val below = StageLayoutPolicy.find(slots[earlier].id, frames) ?: continue
                            val above = StageLayoutPolicy.find(slots[later].id, frames) ?: continue
                            if (!StageLayoutPolicy.overlaps(below, above)) continue
                            overlapsSeen += 1
                            val backings = listOf(slots[earlier], slots[later]).map { slot ->
                                StageVideoBackingPolicy.backing(role = slot.role, hasRail = hasRail,
                                    fadesWithChrome = ShareZoomPolicy.railHidesWithChrome(kind = kind, role = slot.role, isCompactHeight = compactHeight))
                            }
                            if (backings.contains(StageVideoBacking.Texture)) continue
                            assertEquals("$kind ${slots[earlier].id} under ${slots[later].id} at $corner", StageVideoBacking.Surface, backings[0])
                            assertEquals("$kind ${slots[earlier].id} under ${slots[later].id} at $corner", StageVideoBacking.OverlaySurface, backings[1])
                        }
                    }
                }
            }
        }
        assertTrue("the layouts no longer stack tiles, so this test checks nothing", overlapsSeen > 20)
    }

    @Test fun aLostSurfaceIsCountedOnceAndItsReturnOnce() {
        val ledger = RendererIdentityLedger()
        val records = VideoHostRecords()
        records.attachIdentity(ledger, "stage:p:r1")
        records.surfaceAvailable()
        records.surfaceDestroyed()
        records.surfaceDestroyed()
        records.surfaceAvailable()
        records.surfaceAvailable()
        assertEquals(RendererIdentityCounts(created = 1, released = 0, live = 1, surfaceLost = 1, surfaceRestored = 1), ledger.counts(RendererSlot.stage))
        records.releaseIdentity()
        records.releaseIdentity()
        assertEquals(RendererIdentityCounts(created = 1, released = 1, live = 0, surfaceLost = 1, surfaceRestored = 1), ledger.counts(RendererSlot.stage))
    }

    @Test fun aPipRendererIsCountedInThePipSlot() {
        val ledger = RendererIdentityLedger()
        VideoHostRecords().attachIdentity(ledger, "pip:1:r1:track")
        assertEquals(1, ledger.counts(RendererSlot.pip).live)
        assertEquals(0, ledger.counts(RendererSlot.stage).live)
    }

    @Test fun theFrameSizeReachesTheStoreWhicheverComesFirst() {
        val store = RendererFrameSizeStore()
        val early = VideoHostRecords()
        early.frameSizeChanged(640, 360)
        early.attachFrameSizes(store, "p:r1")
        assertEquals(RendererFrameSize(width = 640, height = 360), store.size(slotId = "p:r1"))
        val late = VideoHostRecords()
        late.attachFrameSizes(store, "p:r2")
        assertEquals(RendererFrameSize.zero, store.size(slotId = "p:r2"))
        late.frameSizeChanged(320, 180)
        assertEquals(RendererFrameSize(width = 320, height = 180), store.size(slotId = "p:r2"))
        late.detachFrameSizes()
        assertEquals(RendererFrameSize.zero, store.size(slotId = "p:r2"))
    }

    private fun surfaceHost(overlay: Boolean = false, detachWait: VideoDetachWait = VideoDetachWait(limitMillis = 5_000, windowMillis = 5_000)) =
        SurfaceVideoHost(RuntimeEnvironment.getApplication(), backend, overlay, detachWait)

    private fun settleMainFrames() {
        shadowOf(Looper.getMainLooper()).idleFor(200, TimeUnit.MILLISECONDS)
    }

    private fun runOneMainFrame() {
        shadowOf(Looper.getMainLooper()).idleFor(ShadowChoreographer.getFrameDelay())
    }

    @Test fun aSurfaceTileStaysCoveredUntilItsFirstFrameIsOnScreen() {
        val host = surfaceHost()
        assertFalse(host.hasFrame)
        host.surfaceAvailable("window")
        backend.settle()
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(host.hasFrame)
        host.sink.onFrame(frame())
        backend.settle()
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(host.hasFrame)
        assertEveryFrameGivenBack()
    }

    @Test fun losingTheSurfaceCoversTheTileAgainAndAnOldFirstFrameCannotUncoverTheNewSurface() {
        val ledger = RendererIdentityLedger()
        val host = surfaceHost()
        host.attachIdentity(ledger, "stage:p:r1")
        host.surfaceAvailable("window")
        host.sink.onFrame(frame())
        backend.settle()
        host.surfaceDestroyed(host.holder)
        assertEquals(1, backend.count("destroy"))
        host.surfaceAvailable("window")
        backend.settle()
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(host.hasFrame)
        assertEquals(RendererIdentityCounts(created = 1, released = 0, live = 1, surfaceLost = 1, surfaceRestored = 1), ledger.counts(RendererSlot.stage))
        host.sink.onFrame(frame())
        backend.settle()
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(host.hasFrame)
    }

    @Test fun aFirstFrameNoticeFromBeforeAClearCannotUncoverTheTile() {
        val host = surfaceHost()
        host.surfaceAvailable("window")
        host.sink.onFrame(frame())
        backend.settle()
        host.clearImage()
        backend.settle()
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(host.hasFrame)
    }

    @Test fun clearingASurfaceTileCoversItWithoutDrawing() {
        val host = surfaceHost()
        host.surfaceAvailable("window")
        host.sink.onFrame(frame())
        backend.settle()
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(host.hasFrame)
        host.clearImage()
        backend.settle()
        assertFalse(host.hasFrame)
        assertEquals(0, backend.count("clear"))
        assertEquals(1, backend.count("swap"))
        host.sink.onFrame(frame())
        backend.settle()
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(host.hasFrame)
    }

    @Test fun aReleasedSurfaceTileIgnoresLateFrames() {
        val host = surfaceHost(overlay = true)
        host.surfaceAvailable("window")
        host.release()
        host.sink.onFrame(frame())
        backend.settle()
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(host.hasFrame)
        assertEquals(0, backend.count("draw"))
        assertEquals(1, backend.count("destroy"))
        assertTrue("a released view must stop its render loop", backend.stopped)
        assertEveryFrameGivenBack()
    }

    @Test fun theFrameSizeOfASurfaceTileReachesTheStageStore() {
        val store = RendererFrameSizeStore()
        val host = surfaceHost()
        host.attachFrameSizes(store, "p:r1")
        host.sink.onFrame(frame(640, 360, rotation = 90))
        backend.settle()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(RendererFrameSize(width = 360, height = 640), store.size(slotId = "p:r1"))
        assertNotEquals(0, store.revision)
    }

    private fun showPicture(host: SurfaceVideoHost, bufferWidth: Int, bufferHeight: Int, picture: VideoFrame) {
        backend.width = bufferWidth
        backend.height = bufferHeight
        host.surfaceChanged(host.holder, 0, bufferWidth, bufferHeight)
        host.sink.onFrame(picture)
        backend.settle()
        settleMainFrames()
    }

    @Test fun aWindowSizeIsForgottenWithItsSurfaceSoTheNextSurfacesFirstFrameIsNotHeldBack() {
        val host = surfaceHost()
        backend.width = 160
        backend.height = 62
        host.surfaceAvailable("window")
        host.surfaceChanged(host.holder, 0, 160, 62)
        host.sink.onFrame(frame())
        backend.settle()
        host.surfaceDestroyed(host.holder)
        backend.width = 504
        backend.height = 400
        host.surfaceAvailable("window")
        host.sink.onFrame(frame())
        backend.settle()
        assertEquals(listOf("create", "draw", "swap surface-1", "destroy surface-1", "create", "draw", "swap surface-2"), backend.calls.toList())
        assertEveryFrameGivenBack()
    }

    @Test fun aSurfaceTilesFirstPictureGoesIntoTheBufferItWasCreatedWithAndTheResizeFollows() {
        val host = surfaceHost()
        host.layout(0, 0, 1032, 400)
        host.sink.onFrame(frame(160, 90))
        settleMainFrames()
        assertEquals("a window with no picture was asked to resize", VideoBufferSize(0, 0), host.bufferSize)
        host.surfaceAvailable("window")
        showPicture(host, 1032, 400, frame(160, 90))
        assertEquals(listOf("create", "draw", "swap surface-1"), backend.calls.toList())
        assertTrue(host.hasFrame)
        assertEquals(VideoBufferSize(160, 62), host.bufferSize)
        assertEveryFrameGivenBack()
    }

    @Test fun aSurfaceTileAsksForItsNextBufferSizeOnlyOnceTheLastOneIsOnScreen() {
        val host = surfaceHost()
        host.layout(0, 0, 1032, 400)
        host.surfaceAvailable("window")
        showPicture(host, 1032, 400, frame(160, 90))
        assertEquals(VideoBufferSize(160, 62), host.bufferSize)
        host.sink.onFrame(frame(320, 180))
        backend.settle()
        settleMainFrames()
        assertEquals("a second size was asked for before the first was on screen", VideoBufferSize(160, 62), host.bufferSize)
        showPicture(host, 160, 62, frame(320, 180))
        assertEquals(VideoBufferSize(320, 124), host.bufferSize)
        assertEveryFrameGivenBack()
    }

    private fun hostShowingA320By180Picture(width: Int, height: Int): SurfaceVideoHost {
        val host = surfaceHost()
        host.layout(0, 0, width, height)
        host.surfaceAvailable("window")
        showPicture(host, width, height, frame(320, 180))
        showPicture(host, host.bufferSize.width, host.bufferSize.height, frame(320, 180))
        return host
    }

    @Test fun aSurfaceTileAsksForItsBufferOnlyOnceANewLayoutHasSettled() {
        val host = hostShowingA320By180Picture(1920, 1080)
        assertEquals(VideoBufferSize(320, 180), host.bufferSize)
        host.layout(0, 0, 1080, 1920)
        assertEquals("the size of a layout whose fit has not followed yet was asked for", VideoBufferSize(320, 180), host.bufferSize)
        host.setFit(true)
        settleMainFrames()
        assertEquals(VideoBufferSize(320, 569), host.bufferSize)
        assertEveryFrameGivenBack()
    }

    @Test fun aSurfaceTileKeepsItsBufferWhileItsSizeChangesFrameAfterFrame() {
        ShadowChoreographer.setFrameDelay(Duration.ofMillis(16))
        val host = hostShowingA320By180Picture(1920, 1080)
        for (width in listOf(1600, 1200, 800)) {
            host.layout(0, 0, width, width * 9 / 16)
            runOneMainFrame()
            assertEquals(VideoBufferSize(320, 180), host.bufferSize)
        }
        host.layout(0, 0, 160, 90)
        settleMainFrames()
        assertEquals(VideoBufferSize(160, 90), host.bufferSize)
        assertEveryFrameGivenBack()
    }

    @Test fun aSurfaceIsDestroyedWhenItsCallbackReturnsEvenUnderABusyRenderThreadAndTheNextOneAttaches() {
        val host = surfaceHost(detachWait = VideoDetachWait(limitMillis = 50, windowMillis = 60_000))
        host.surfaceAvailable("window")
        backend.settle()
        val gate = backend.park()
        host.surfaceDestroyed(host.holder)
        assertEquals(listOf("create", "destroy surface-1"), backend.calls.toList())
        host.surfaceAvailable("window")
        host.sink.onFrame(frame())
        gate.countDown()
        backend.settle()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(listOf("create", "destroy surface-1", "create", "draw", "swap surface-2"), backend.calls.toList())
        assertEquals(listOf<Any>("surface-1"), backend.unbound.toList())
        assertTrue(host.hasFrame)
        assertEveryFrameGivenBack()
    }

    @Test fun aStalledSwapDoesNotHoldTheSurfaceCallbackAndItsSurfaceIsDestroyedWhileOtherTilesKeepDrawing() {
        val stalled = RecordingBackend()
        val others = List(2) { RecordingBackend() }
        try {
            val wait = VideoDetachWait(limitMillis = 100, windowMillis = 60_000)
            val host = SurfaceVideoHost(RuntimeEnvironment.getApplication(), stalled, overlay = false, detachWait = wait)
            val neighbours = others.map { SurfaceVideoHost(RuntimeEnvironment.getApplication(), it, overlay = false, detachWait = wait) }
            host.surfaceAvailable("window")
            neighbours.forEach { it.surfaceAvailable("window") }
            val stall = stalled.stallNextSwap()
            host.sink.onFrame(frame())
            stalled.awaitStall()
            val started = System.nanoTime()
            host.surfaceDestroyed(host.holder)
            val heldMillis = (System.nanoTime() - started) / 1_000_000
            assertTrue("a stalled swap held the main thread for $heldMillis ms", heldMillis < 1_000)
            assertEquals(listOf("create", "draw", "swap surface-1", "destroy surface-1"), stalled.calls.toList())
            neighbours.forEach { it.sink.onFrame(frame()) }
            others.forEach { it.settle() }
            others.forEach { assertEquals(listOf("create", "draw", "swap surface-1"), it.calls.toList()) }
            stall.countDown()
            stalled.settle()
            assertEquals(listOf("create", "draw", "swap surface-1", "destroy surface-1"), stalled.calls.toList())
            assertEquals(listOf<Any>("surface-1"), stalled.unbound.toList())
            assertEveryFrameGivenBack()
        } finally {
            (others + stalled).forEach { it.shutdown() }
        }
    }

    @Test fun aSurfaceIsDestroyedBeforeItIsTakenOffItsContextSoABlockedUnbindCannotKeepIt() {
        val host = surfaceHost(detachWait = VideoDetachWait(limitMillis = 100, windowMillis = 60_000))
        host.surfaceAvailable("window")
        backend.settle()
        val stall = backend.stallNextUnbind()
        host.surfaceDestroyed(host.holder)
        assertEquals(listOf("create", "destroy surface-1"), backend.calls.toList())
        stall.countDown()
        backend.settle()
        assertEquals(listOf("create", "destroy surface-1"), backend.calls.toList())
        assertEquals(listOf<Any>("surface-1"), backend.unbound.toList())
    }

    @Test fun aSurfaceStillBeingBoundForTheFirstTimeIsDestroyedByItsCallbackToo() {
        val host = surfaceHost(detachWait = VideoDetachWait(limitMillis = 100, windowMillis = 60_000))
        val stall = backend.stallNextBind()
        host.surfaceAvailable("window")
        host.sink.onFrame(frame())
        backend.awaitStall()
        host.surfaceDestroyed(host.holder)
        assertEquals(listOf("create", "destroy surface-1"), backend.calls.toList())
        stall.countDown()
        backend.settle()
        assertEquals("a frame was drawn into a surface that had been destroyed", listOf("create", "destroy surface-1"), backend.calls.toList())
        assertEveryFrameGivenBack()
    }

    @Test fun twoStalledSwapsInARowCostTheMainThreadOneShortWaitAndBothSurfacesAreDestroyed() {
        val stalled = List(2) { RecordingBackend() }
        try {
            val wait = VideoDetachWait(limitMillis = 100, windowMillis = 60_000)
            val hosts = stalled.map { SurfaceVideoHost(RuntimeEnvironment.getApplication(), it, overlay = false, detachWait = wait) }
            hosts.forEach { it.surfaceAvailable("window") }
            val stalls = stalled.map { it.stallNextSwap() }
            hosts.forEach { it.sink.onFrame(frame()) }
            stalled.forEach { it.awaitStall() }
            val started = System.nanoTime()
            hosts.forEach { it.surfaceDestroyed(it.holder) }
            val heldMillis = (System.nanoTime() - started) / 1_000_000
            assertTrue("two stalled swaps held the main thread for $heldMillis ms", heldMillis < 1_000)
            stalled.forEach { assertEquals(1, it.count("destroy")) }
            stalls.forEach { it.countDown() }
            stalled.forEach { it.settle() }
            stalled.forEach { assertEquals("a surface was destroyed twice", 1, it.count("destroy")) }
            assertEveryFrameGivenBack()
        } finally {
            stalled.forEach { it.shutdown() }
        }
    }

    @Test fun theSharedWaitIsSpentOncePerWindowAndThenComesBack() {
        val wait = VideoDetachWait(limitMillis = 300, windowMillis = 900)
        val never = CountDownLatch(1)
        val started = System.nanoTime()
        assertFalse(wait.await(never))
        val first = (System.nanoTime() - started) / 1_000_000
        assertFalse(wait.await(never))
        val both = (System.nanoTime() - started) / 1_000_000
        assertTrue("the first wait took $first ms", first >= 290)
        assertTrue("a second wait in the same window took ${both - first} ms", both - first < 200)
        assertTrue("a surface that is already gone needs no wait", wait.await(CountDownLatch(0)))
        Thread.sleep(maxOf(0L, 950 - both))
        val again = System.nanoTime()
        assertFalse(wait.await(never))
        assertTrue("the wait did not come back with the next window", (System.nanoTime() - again) / 1_000_000 >= 290)
    }

    @Test fun tenSurfacesInARowLeaveNoneBehindAndReleaseStopsTheRenderLoop() {
        val host = surfaceHost()
        repeat(10) {
            host.surfaceAvailable("window")
            host.sink.onFrame(frame())
            backend.settle()
            host.surfaceDestroyed(host.holder)
        }
        host.release()
        assertEquals(10, backend.count("create"))
        assertEquals(10, backend.count("destroy"))
        assertEquals(10, backend.count("swap"))
        assertTrue(backend.stopped)
        assertEveryFrameGivenBack()
    }

    @Test fun destroyingSeveralBusySurfaceTilesHoldsTheMainThreadForOneShortWaitInTotal() {
        val busy = List(4) { RecordingBackend() }
        try {
            val hosts = busy.map { SurfaceVideoHost(RuntimeEnvironment.getApplication(), it, overlay = false) }
            hosts.forEach { it.surfaceAvailable("window") }
            val gates = busy.map { it.park() }
            val started = System.nanoTime()
            hosts.forEach { it.surfaceDestroyed(it.holder) }
            val heldMillis = (System.nanoTime() - started) / 1_000_000
            assertTrue("destroying 4 busy tiles held the main thread for $heldMillis ms", heldMillis < 1_000)
            busy.forEach { assertEquals(listOf("create", "destroy surface-1"), it.calls.toList()) }
            gates.forEach { it.countDown() }
            busy.forEach { it.settle() }
            busy.forEach { assertEquals(listOf("create", "destroy surface-1"), it.calls.toList()) }
        } finally {
            busy.forEach { it.shutdown() }
        }
    }

    private fun textureHost(): TextureVideoHost = TextureVideoHost(RuntimeEnvironment.getApplication(), backend)

    @Test fun aTextureDestroyedUnderTheRendererIsReleasedOnlyOnceItsSurfaceIsGone() {
        val host = textureHost()
        val texture = CountingTexture()
        host.onSurfaceTextureAvailable(texture, 320, 180)
        backend.settle()
        val gate = backend.park()
        assertFalse("the view must not release a texture the render thread still draws into", host.onSurfaceTextureDestroyed(texture))
        assertEquals(0, texture.releases.get())
        assertEquals(0, backend.count("destroy"))
        gate.countDown()
        backend.settle()
        assertEquals(listOf("create", "destroy surface-1"), backend.calls.toList())
        assertEquals(1, texture.releases.get())
    }

    @Test fun aTextureThatArrivesWhileTheOldOneIsLettingGoIsAttachedOnceItHas() {
        val host = textureHost()
        val first = CountingTexture()
        val second = CountingTexture()
        host.onSurfaceTextureAvailable(first, 320, 180)
        backend.settle()
        val gate = backend.park()
        host.onSurfaceTextureDestroyed(first)
        host.onSurfaceTextureAvailable(second, 320, 180)
        assertEquals(1, backend.count("create"))
        gate.countDown()
        backend.settle()
        shadowOf(Looper.getMainLooper()).idle()
        host.sink.onFrame(frame())
        backend.settle()
        assertEquals(listOf("create", "destroy surface-1", "create", "draw", "swap surface-2"), backend.calls.toList())
        assertEquals(1, first.releases.get())
        assertEquals(0, second.releases.get())
        assertEveryFrameGivenBack()
    }

    @Test fun aTextureDestroyedAfterReleaseButBeforeEglLetsGoIsKeptUntilItHas() {
        val host = textureHost()
        val texture = CountingTexture()
        val other = CountingTexture()
        host.onSurfaceTextureAvailable(texture, 320, 180)
        backend.settle()
        val gate = backend.park()
        host.release()
        assertFalse(host.onSurfaceTextureDestroyed(texture))
        assertTrue("a texture the renderer never had is the view's to release", host.onSurfaceTextureDestroyed(other))
        assertEquals(0, texture.releases.get())
        gate.countDown()
        backend.settle()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(1, backend.count("destroy"))
        assertEquals(1, texture.releases.get())
        assertEquals(0, other.releases.get())
    }

    @Test fun aTextureDestroyedAfterReleaseHasFinishedGoesBackToTheView() {
        val host = textureHost()
        val texture = CountingTexture()
        host.onSurfaceTextureAvailable(texture, 320, 180)
        host.release()
        backend.settle()
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(host.onSurfaceTextureDestroyed(texture))
        assertEquals(0, texture.releases.get())
        assertEquals(1, backend.count("destroy"))
    }
}
