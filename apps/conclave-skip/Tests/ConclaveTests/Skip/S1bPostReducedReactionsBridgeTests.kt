package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class S1bPostReducedReactionsBridgeTests {
    private fun event(id: Int) = ReactionEvent(id = id, senderName = "", isLocal = false, kind = "emoji", value = "x", label = "x")

    private fun snapshot(ids: List<Int>, renderLimit: Int = 20) =
        StageReactionsSnapshot(revision = 1, events = skip.lib.Array(ids.map { event(it) }), renderLimit = renderLimit)

    private fun ids(events: skip.lib.Array<ReactionEvent>): List<Int> = events.toList().map { it.id }

    @Test fun theTranspiledReducedListKeepsTheNewestReactionPerLaneInArrivalOrder() {
        val burst = snapshot((1..25).toList())
        val reduced = ids(StageReactionPolicy.visibleEvents(burst, true))
        assertEquals(listOf(23, 24, 25), reduced)
        assertEquals(listOf(2, 0, 1), reduced.map { StageReactionPolicy.lane(it) })
        assertEquals(listOf(7, 8), ids(StageReactionPolicy.visibleEvents(snapshot(listOf(1, 4, 7, 8)), true)))
        assertEquals(listOf(4, 6, 2), ids(StageReactionPolicy.visibleEvents(snapshot(listOf(3, 1, 4, 6, 2)), true)))
        assertEquals(listOf(24, 25), ids(StageReactionPolicy.visibleEvents(snapshot((1..25).toList(), renderLimit = 2), true)))
        assertEquals(listOf<Int>(), ids(StageReactionPolicy.visibleEvents(snapshot(listOf()), true)))
    }

    @Test fun theTranspiledMovingListIsTheRenderLimitedList() {
        val burst = snapshot((1..25).toList())
        val moving = ids(StageReactionPolicy.visibleEvents(burst, false))
        assertEquals(20, moving.size)
        assertEquals((6..25).toList(), moving)
        assertEquals(ids(StageReactionPolicy.visibleEvents(burst)), moving)
    }

    @Test fun theTranspiledReducedSlotsNeverOverlap() {
        assertEquals(72.0, StageReactionPolicy.reducedLaneOffset, 0.0)
        assertEquals(64.0, StageReactionPolicy.reducedSlotWidth, 0.0)
        assertTrue(StageReactionPolicy.reducedSlotWidth >= StageReactionPolicy.bubbleDiameter)
        assertEquals(StageReactionPolicy.reducedSlotWidth + 8.0, StageReactionPolicy.reducedLaneOffset, 0.0)
        assertEquals(8.0, (StageReactionPolicy.reducedSlotWidth - StageReactionPolicy.bubbleDiameter) / 2.0, 0.0)
        assertEquals(1.5, StageReactionPolicy.reducedPillMaxFontScale, 0.0)
        assertEquals(20.0, StageReactionPolicy.laneOffset, 0.0)
        assertEquals(3, StageReactionPolicy.laneCount)
        val slotsEnd = StageReactionPolicy.leadingInset + (StageReactionPolicy.laneCount - 1) * StageReactionPolicy.reducedLaneOffset +
            StageReactionPolicy.reducedSlotWidth
        assertEquals(220.0, slotsEnd, 0.0)
        for (count in 0..25) {
            for (limit in listOf(8, 12, 20)) {
                val label = "count $count limit $limit"
                val source = snapshot((1..count).toList(), renderLimit = limit)
                val limited = ids(StageReactionPolicy.visibleEvents(source))
                val shown = ids(StageReactionPolicy.visibleEvents(source, true))
                val lanes = shown.map { StageReactionPolicy.lane(it) }
                assertTrue(label, shown.size <= StageReactionPolicy.laneCount)
                assertEquals(label, lanes.size, lanes.toSet().size)
                assertEquals(label, limited.map { StageReactionPolicy.lane(it) }.toSet(), lanes.toSet())
                assertEquals(label, shown.sorted(), shown)
                for (id in shown) {
                    val newest = limited.last { StageReactionPolicy.lane(it) == StageReactionPolicy.lane(id) }
                    assertEquals("$label id $id", newest, id)
                }
                for (first in lanes) {
                    for (second in lanes) {
                        if (first == second) continue
                        val gap = kotlin.math.abs(first - second) * StageReactionPolicy.reducedLaneOffset - StageReactionPolicy.reducedSlotWidth
                        assertTrue(label, gap >= 8.0)
                    }
                }
            }
        }
    }

    private val androidLandscape = stageViewportFrom(width = 914.3, height = 411.4, top = 24.2, bottom = 24.2, leading = 0.0, trailing = 0.0)
    private val androidSafeBottom = 24.2
    private val androidCutoutLandscape = stageViewportFrom(width = 914.3, height = 411.4, top = 24.2, bottom = 24.2, leading = 32.0, trailing = 0.0)
    private val androidGestureLandscape = stageViewportFrom(width = 892.0, height = 412.0, top = 24.0, bottom = 24.0, leading = 0.0, trailing = 0.0)
    private val androidShortLandscape = stageViewportFrom(width = 800.0, height = 360.0, top = 24.0, bottom = 24.0, leading = 0.0, trailing = 0.0)
    private val androidGestureSafeBottom = 24.0
    private val iosLandscape = StageViewportPolicy.iOS(contentWidth = 750.0, contentHeight = 369.0,
        safeArea = StageChromeInsets(top = 0.0, bottom = 21.0, leading = 47.0, trailing = 47.0), regularWidth = false, compactHeight = true,
        topReserve = 56.0, barReserve = 64.0, trailingReserve = 64.0, chipRowReserve = 0.0)
    private val iosSafeBottom = 21.0
    private val shapes = listOf(StageReactionSlotShape.row, StageReactionSlotShape.column, StageReactionSlotShape.block)

    private fun burstStage(at: StageViewport, count: Int = 6): StagePresenter {
        val stage = StagePresenter(shell = MeetingShellPresenter())
        stage.setViewport(at)
        stage.apply(if (count == 6) StageFixtureScript.inputs(StageFixtureState.reactionsBurst25) else StageFixtureScript.base(count = count))
        return stage
    }

    private fun androidMetrics(fontScale: Double, viewport: StageViewport = androidLandscape,
                               safeBottom: Double = androidSafeBottom): StageReactionSlotMetrics {
        val line = ConclaveTypography.labelMedium.lineHeight.value.toDouble()
        val pill = ConclaveTypography.labelSmall.lineHeight.value.toDouble() * minOf(fontScale, StageReactionPolicy.reducedPillMaxFontScale)
        return StageReactionSlotMetrics(
            defaultBottomInset = StageReactionPolicy.layerBottomInset(barReserve = StageCanvasMetrics.BAR_RESERVE_DP,
                labelLineHeight = line * fontScale, defaultLabelLineHeight = line),
            layerLeading = viewport.insetLeading, layerBottom = safeBottom,
            slotHeight = StageReactionPolicy.reducedSlotHeight(pillLineHeight = pill),
            labelBand = StageReactionPolicy.tileLabelBand(lineHeight = line * fontScale), barMaxWidth = ControlBarPolicy.androidMaxToolbarWidth)
    }

    private fun iosMetrics(tileLine: Double, pillLine: Double) = StageReactionSlotMetrics(
        defaultBottomInset = StageReactionPolicy.layerBottomInset(barReserve = 64.0, labelLineHeight = tileLine, defaultLabelLineHeight = 15.5),
        layerLeading = iosLandscape.insetLeading, layerBottom = iosSafeBottom,
        slotHeight = StageReactionPolicy.reducedSlotHeight(pillLineHeight = pillLine),
        labelBand = StageReactionPolicy.tileLabelBand(lineHeight = tileLine), barMaxWidth = 0.0)

    private fun placementFor(stage: StagePresenter, metrics: StageReactionSlotMetrics): StageReactionSlotPlacement =
        StageReactionPolicy.reducedPlacement(viewport = stage.viewport, kind = stage.layout.kind, slots = stage.layout.slots,
            frames = stage.currentFrames(), metrics = metrics)

    private fun resting(metrics: StageReactionSlotMetrics) =
        StageReactionSlotPlacement(bottomInset = metrics.defaultBottomInset, shape = StageReactionSlotShape.row)

    private fun slotRects(placement: StageReactionSlotPlacement, viewport: StageViewport, metrics: StageReactionSlotMetrics): List<StageFrame> {
        val bottom = viewport.height - metrics.layerBottom - placement.bottomInset
        return (0 until StageReactionPolicy.laneCount).map { lane ->
            val x = metrics.layerLeading + StageReactionPolicy.leadingInset +
                StageReactionPolicy.slotOffsetX(lane = lane, reduceMotion = true, shape = placement.shape)
            val lift = StageReactionPolicy.slotOffsetY(lane = lane, shape = placement.shape, slotHeight = metrics.slotHeight)
            StageFrame(slotId = "slot$lane", x = x, y = bottom - lift - metrics.slotHeight, width = StageReactionPolicy.reducedSlotWidth,
                height = metrics.slotHeight)
        }
    }

    private fun tileLabels(viewport: StageViewport, layout: StageLayoutSnapshot, frames: List<StageFrame>, line: Double): List<StageFrame> {
        val labels = mutableListOf<StageFrame>()
        for (slot in layout.slots) {
            if (!StageViewportPolicy.carriesNameTag(slot.role)) continue
            val frame = frames.firstOrNull { it.slotId == slot.id } ?: continue
            val insets = StageViewportPolicy.tileInsets(kind = layout.kind, role = slot.role, viewport = viewport)
            val height = 2 * 4.0 + maxOf(16.0, line)
            for (inset in listOf(8.0, 4.0)) {
                val bottom = frame.maxY - insets.bottom - inset
                labels.add(StageFrame(slotId = slot.id, x = frame.x + insets.leading + inset, y = bottom - height,
                    width = frame.width - insets.leading - insets.trailing - 2 * inset, height = height))
            }
        }
        return labels
    }

    private fun coveredArea(rects: List<StageFrame>, labels: List<StageFrame>): Double {
        var total = 0.0
        for (rect in rects) {
            for (label in labels) {
                val width = minOf(rect.maxX, label.maxX) - maxOf(rect.x, label.x)
                val height = minOf(rect.maxY, label.maxY) - maxOf(rect.y, label.y)
                if (width > 0.0 && height > 0.0) total += width * height
            }
        }
        return total
    }

    private fun assertClear(viewport: StageViewport, layout: StageLayoutSnapshot, frames: List<StageFrame>, metrics: StageReactionSlotMetrics,
                            line: Double, name: String): StageReactionSlotPlacement {
        val placement = StageReactionPolicy.reducedPlacement(viewport = viewport, kind = layout.kind, slots = layout.slots,
            frames = skip.lib.Array(frames), metrics = metrics)
        val labels = tileLabels(viewport, layout, frames, line)
        assertTrue(name, labels.isNotEmpty())
        for (rect in slotRects(placement, viewport, metrics)) {
            for (label in labels) {
                assertFalse("$name ${rect.slotId} covers ${label.slotId}", StageLayoutPolicy.overlaps(rect, label))
            }
            assertTrue("$name ${rect.slotId} top", rect.y >= viewport.insetTop - 0.001)
            assertTrue("$name ${rect.slotId} bottom", rect.maxY <= viewport.height - metrics.layerBottom + 0.001)
            assertTrue("$name ${rect.slotId} leading", rect.x >= viewport.insetLeading + StageReactionPolicy.leadingInset - 0.001)
        }
        return placement
    }

    private fun assertClear(stage: StagePresenter, metrics: StageReactionSlotMetrics, line: Double, name: String): StageReactionSlotPlacement =
        assertClear(stage.viewport, stage.layout, stage.currentFrames().toList(), metrics, line, name)

    @Test fun theTranspiledReducedSlotsClearEveryTileLabelInATwoByThreeLandscapeGrid() {
        val android = burstStage(androidLandscape)
        val frames = android.currentFrames().toList()
        assertEquals(StageKind.grid, android.layout.kind)
        assertEquals(6, frames.size)
        assertEquals(3, frames.map { Math.round(it.x) }.toSet().size)
        assertEquals(2, frames.map { Math.round(it.y) }.toSet().size)

        val androidDefault = assertClear(android, androidMetrics(1.0), 16.0, "android default")
        assertEquals(StageReactionSlotShape.column, androidDefault.shape)
        assertEquals(71.0, androidDefault.bottomInset, 0.01)
        val androidLarge = assertClear(android, androidMetrics(2.0), 32.0, "android font 2.0")
        assertEquals(StageReactionSlotShape.column, androidLarge.shape)
        assertEquals(47.0, androidLarge.bottomInset, 0.01)
        for (rect in slotRects(androidLarge, androidLandscape, androidMetrics(2.0))) {
            assertTrue(frames.all { rect.maxX <= it.x })
        }

        val ios = burstStage(iosLandscape)
        assertEquals(6, ios.currentFrames().count)
        val iosDefault = assertClear(ios, iosMetrics(15.5, 13.13), 15.5, "ios default")
        assertEquals(StageReactionSlotShape.row, iosDefault.shape)
        assertTrue(iosDefault.bottomInset != 128.0)
        val iosLarge = assertClear(ios, iosMetrics(22.7, 20.29), 22.7, "ios AX5")
        assertEquals(StageReactionSlotShape.row, iosLarge.shape)
        assertTrue(kotlin.math.abs(iosLarge.bottomInset - 135.2) > 1.0)
    }

    @Test fun theTranspiledSlotsTakeAMarginBlockWhenNeitherARowNorAColumnClears() {
        val stage = burstStage(androidGestureLandscape, count = 7)
        val frames = stage.currentFrames().toList()
        assertEquals(StageKind.grid, stage.layout.kind)
        assertEquals(7, frames.size)
        assertEquals(2, frames.map { Math.round(it.y) }.toSet().size)
        for (scale in listOf(1.0, 2.0)) {
            val metrics = androidMetrics(scale, androidGestureLandscape, androidGestureSafeBottom)
            val labels = tileLabels(androidGestureLandscape, stage.layout, frames, 16.0 * scale)
            assertTrue("the resting row covers a label at $scale", coveredArea(slotRects(resting(metrics), androidGestureLandscape, metrics), labels) > 0.0)
            val placement = assertClear(stage, metrics, 16.0 * scale, "seven tiles $scale")
            assertEquals(StageReactionSlotShape.block, placement.shape)
            assertEquals(if (scale == 1.0) 34.0 else 18.0, placement.bottomInset, 0.01)
        }
    }

    @Test fun theTranspiledSlotsTakeTheLeastCoveredPlaceWhenNothingClears() {
        val stage = burstStage(androidGestureLandscape, count = 8)
        val frames = stage.currentFrames().toList()
        assertEquals(8, frames.size)
        val metrics = androidMetrics(2.0, androidGestureLandscape, androidGestureSafeBottom)
        val placement = placementFor(stage, metrics)
        assertNotEquals(resting(metrics), placement)
        val labels = tileLabels(androidGestureLandscape, stage.layout, frames, 32.0)
        val restingCover = coveredArea(slotRects(resting(metrics), androidGestureLandscape, metrics), labels)
        val placedCover = coveredArea(slotRects(placement, androidGestureLandscape, metrics), labels)
        assertTrue("covered $placedCover against $restingCover", placedCover < restingCover / 10.0)
        for (rect in slotRects(placement, androidGestureLandscape, metrics)) {
            assertTrue(rect.y >= androidGestureLandscape.insetTop - 0.001)
            assertTrue(rect.maxY <= androidGestureLandscape.height - metrics.layerBottom + 0.001)
        }
    }

    @Test fun theTranspiledShortLandscapeKeepsOneRowAndTheSlotsClearItsLabels() {
        val stage = burstStage(androidShortLandscape)
        val frames = stage.currentFrames().toList()
        assertEquals(StageKind.grid, stage.layout.kind)
        assertEquals(4, frames.size)
        assertTrue(stage.layout.slots.toList().any { it.role == StageSlotRole.overflow })
        assertEquals(1, frames.map { Math.round(it.y) }.toSet().size)
        for (scale in listOf(1.0, 2.0)) {
            val placement = assertClear(stage, androidMetrics(scale, androidShortLandscape, androidGestureSafeBottom), 16.0 * scale, "800 by 360 $scale")
            assertEquals(StageReactionSlotShape.row, placement.shape)
        }
    }

    @Test fun theTranspiledColumnMovesWithALeadingCutout() {
        val stage = burstStage(androidCutoutLandscape)
        assertEquals(32.0, androidCutoutLandscape.insetLeading, 0.0)
        assertTrue(stage.currentFrames().toList().all { it.x >= 32.0 })
        for (scale in listOf(1.0, 2.0)) {
            val metrics = androidMetrics(scale, androidCutoutLandscape)
            val placement = assertClear(stage, metrics, 16.0 * scale, "cutout $scale")
            assertEquals(StageReactionSlotShape.column, placement.shape)
            for (rect in slotRects(placement, androidCutoutLandscape, metrics)) {
                assertEquals(44.0, rect.x, 0.001)
            }
        }
    }

    @Test fun theTranspiledPlacementFollowsTheLayersOwnGeometryAfterARotation() {
        val portrait = stageViewportFrom(width = 411.4, height = 914.3, top = 24.2, bottom = 24.2, leading = 0.0, trailing = 0.0)
        val stage = burstStage(portrait)
        val layout = stage.layout
        assertEquals(StageKind.grid, layout.kind)
        assertEquals(6, layout.slots.count)
        val metrics = androidMetrics(1.0)
        val stale = placementFor(stage, metrics)
        assertEquals(resting(metrics), stale)
        val landscapeFrames = StageLayoutPolicy.frames(viewport = androidLandscape, kind = layout.kind, slots = layout.slots,
            selfCorner = layout.selfCorner).toList()
        val labels = tileLabels(androidLandscape, layout, landscapeFrames, 16.0)
        assertTrue(coveredArea(slotRects(stale, androidLandscape, metrics), labels) > 0.0)
        val rotated = assertClear(androidLandscape, layout, landscapeFrames, metrics, 16.0, "rotated")
        assertEquals(StageReactionSlotShape.column, rotated.shape)
        assertEquals(71.0, rotated.bottomInset, 0.01)
    }

    @Test fun theTranspiledPortraitAndClearLandscapeStagesKeepTheRestingLayer() {
        val portrait = stageViewportFrom(width = 411.4, height = 914.3, top = 24.2, bottom = 24.2, leading = 0.0, trailing = 0.0)
        for (scale in listOf(1.0, 2.0)) {
            val metrics = androidMetrics(scale)
            assertEquals(resting(metrics), placementFor(burstStage(portrait), metrics))
            val oneOnOne = burstStage(androidLandscape, count = 2)
            assertEquals(StageKind.oneOnOne, oneOnOne.layout.kind)
            assertEquals(resting(metrics), assertClear(oneOnOne, metrics, 16.0 * scale, "android one on one $scale"))
        }
        assertEquals(72.0, StageReactionPolicy.reducedSlotHeight(pillLineHeight = 16.0), 0.0)
        assertEquals(80.0, StageReactionPolicy.reducedSlotHeight(pillLineHeight = 24.0), 0.0)
        assertEquals(32.0, StageReactionPolicy.tileLabelBand(lineHeight = 16.0), 0.0)
        assertEquals(48.0, StageReactionPolicy.tileLabelBand(lineHeight = 32.0), 0.0)
        assertEquals(StageReactionPolicy.reducedLaneOffset - StageReactionPolicy.reducedSlotWidth, StageReactionPolicy.reducedSlotGap, 0.0)
        assertEquals(shapes, StageReactionPolicy.reducedShapes.toList())
        assertEquals(208.0, StageReactionPolicy.shapeWidth(StageReactionSlotShape.row), 0.0)
        assertEquals(64.0, StageReactionPolicy.shapeWidth(StageReactionSlotShape.column), 0.0)
        assertEquals(136.0, StageReactionPolicy.shapeWidth(StageReactionSlotShape.block), 0.0)
        assertEquals(232.0, StageReactionPolicy.shapeHeight(StageReactionSlotShape.column, slotHeight = 72.0), 0.0)
        assertEquals(152.0, StageReactionPolicy.shapeHeight(StageReactionSlotShape.block, slotHeight = 72.0), 0.0)
        val blockX = listOf(0.0, 72.0, 0.0)
        val blockY = listOf(0.0, 0.0, 80.0)
        for (lane in 0 until StageReactionPolicy.laneCount) {
            for (shape in shapes) {
                assertEquals(lane * StageReactionPolicy.laneOffset, StageReactionPolicy.slotOffsetX(lane = lane, reduceMotion = false, shape = shape), 0.0)
            }
            assertEquals(lane * StageReactionPolicy.reducedLaneOffset,
                StageReactionPolicy.slotOffsetX(lane = lane, reduceMotion = true, shape = StageReactionSlotShape.row), 0.0)
            assertEquals(0.0, StageReactionPolicy.slotOffsetX(lane = lane, reduceMotion = true, shape = StageReactionSlotShape.column), 0.0)
            assertEquals(blockX[lane], StageReactionPolicy.slotOffsetX(lane = lane, reduceMotion = true, shape = StageReactionSlotShape.block), 0.0)
            assertEquals(lane * 80.0, StageReactionPolicy.slotOffsetY(lane = lane, shape = StageReactionSlotShape.column, slotHeight = 72.0), 0.0)
            assertEquals(blockY[lane], StageReactionPolicy.slotOffsetY(lane = lane, shape = StageReactionSlotShape.block, slotHeight = 72.0), 0.0)
        }
        for (shape in shapes) {
            val rects = slotRects(StageReactionSlotPlacement(bottomInset = 0.0, shape = shape), androidLandscape, androidMetrics(1.0))
            for (first in rects.indices) {
                for (second in rects.indices) {
                    if (first < second) assertFalse("$shape $first $second", StageLayoutPolicy.overlaps(rects[first], rects[second]))
                }
            }
        }
    }
}
