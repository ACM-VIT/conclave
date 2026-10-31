package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class S1StageAloneBridgeTests {
    private val android360 = StageViewport(width = 360.0, height = 800.0, insetTop = 84.0, insetBottom = 124.0, insetLeading = 0.0,
        insetTrailing = 0.0, widthClass = StageSizeClass.compact, heightClass = StageSizeClass.medium,
        placement = StageChromePlacement.bottomBar)

    private fun presenter(inputs: StageInputs, at: StageViewport = android360): StagePresenter {
        val stage = StagePresenter(shell = MeetingShellPresenter())
        stage.setViewport(at)
        stage.apply(inputs)
        return stage
    }

    private fun solo(roomLabel: String = StageFixtureScript.roomLabel, cameraOn: Boolean = false, confirmed: Boolean = true): StageInputs =
        StageInputs.make(callSession = 1, isInCall = true, localUserId = StageFixtureScript.localUserId, roomLabel = roomLabel,
            meetingLink = StageFixtureScript.meetingLink,
            participants = StageFixtureScript.roster(count = 1, localCameraOn = cameraOn), isAloneConfirmed = confirmed)

    @Test fun theTranspiledPresenterEmitsTheAloneCompositionOnlyForConfirmedPresenceWithTheCameraOff() {
        val stage = presenter(StageFixtureScript.inputs(StageFixtureState.soloCameraOffAlone))
        val alone = stage.alone
        assertNotNull(alone)
        assertEquals(StageSlot.participantId(StageFixtureScript.localUserId), alone!!.slotId)
        assertEquals(StageFixtureScript.roomLabel, alone.roomLabel)
        assertEquals(StageKind.solo, stage.layout.kind)
        assertEquals(alone, presenter(StageFixtureScript.inputs(StageFixtureState.soloCameraOff)).alone)
        assertNull(presenter(StageFixtureScript.inputs(StageFixtureState.soloCameraOn)).alone)
        assertNull(presenter(StageFixtureScript.inputs(StageFixtureState.soloUnconfirmed)).alone)
        assertNull(presenter(StageFixtureScript.inputs(StageFixtureState.oneOnOne)).alone)
        assertNull(presenter(StageFixtureScript.inputs(StageFixtureState.grid4)).alone)
        assertNull(presenter(StageFixtureScript.inputs(StageFixtureState.presentationLocal)).alone)
        assertNull(presenter(solo(roomLabel = " ")).alone)
    }

    @Test fun cameraArrivalsAndResetSwapTheCompositionWithoutReflowingTheSoloSlot() {
        val stage = presenter(solo(confirmed = false))
        assertNull(stage.alone)
        stage.apply(solo())
        assertNotNull(stage.alone)
        val revision = stage.layout.revision
        stage.apply(solo(cameraOn = true))
        assertNull(stage.alone)
        assertEquals(revision, stage.layout.revision)
        stage.apply(solo())
        assertNotNull(stage.alone)
        stage.apply(StageFixtureScript.base(count = 2))
        assertNull(stage.alone)
        assertEquals(StageKind.oneOnOne, stage.layout.kind)
        stage.apply(solo())
        assertNotNull(stage.alone)
        stage.reset()
        assertNull(stage.alone)
    }

    @Test fun theSeedIsTheRoomLabelAndDrivesTheFacehash() {
        for (label in listOf(StageFixtureScript.roomLabel, "lily-zoro-iris", "Design Review")) {
            val alone = presenter(solo(roomLabel = label)).alone!!
            assertEquals(label, alone.seed)
            assertEquals(label, alone.roomLabel)
            assertEquals(ConclaveAvatarIdentity.fromSeed(label), ConclaveAvatarIdentity.fromSeed(alone.seed))
        }
        assertEquals(72.0, StageAlonePolicy.avatarDiameter, 0.0)
    }

    @Test fun theSnapshotCarriesNoShareCopyOrLinkField() {
        val names = StageAloneSnapshot::class.java.declaredFields
            .filter { !java.lang.reflect.Modifier.isStatic(it.modifiers) }
            .map { it.name.lowercase() }
        assertTrue(names.toString(), names.containsAll(listOf("slotid", "roomlabel", "seed")))
        for (word in listOf("link", "share", "copy", "invite", "action", "url")) {
            assertFalse(word, names.any { it.contains(word) })
        }
    }

    @Test fun theChipRowIsReservedWheneverAStatusChipShows() {
        assertFalse(presenter(StageFixtureScript.inputs(StageFixtureState.grid4)).chipRowVisible)
        assertTrue(presenter(StageFixtureScript.inputs(StageFixtureState.handRaised)).chipRowVisible)
        assertTrue(presenter(StageFixtureScript.inputs(StageFixtureState.handRaising)).chipRowVisible)
        assertFalse(presenter(StageFixtureScript.inputs(StageFixtureState.soloCameraOn)).chipRowVisible)
        val playing = presenter(StageFixtureScript.inputs(StageFixtureState.nowPlaying))
        assertFalse(playing.chipRowVisible)
        playing.setShowsVideoOverActivity(true)
        assertTrue(playing.chipRowVisible)
        val hand = presenter(StageFixtureScript.inputs(StageFixtureState.handRaised))
        hand.apply(StageFixtureScript.inputs(StageFixtureState.grid4))
        assertFalse(hand.chipRowVisible)
        hand.apply(StageFixtureScript.inputs(StageFixtureState.handRaised))
        assertTrue(hand.chipRowVisible)
        hand.reset()
        assertFalse(hand.chipRowVisible)
    }

    @Test fun androidViewportsReserveTheChipRowInPortraitAndLandscape() {
        val chipBottom = 24.0 + 12.0 + 48.0 + 8.0 + 48.0
        val portrait = stageViewportFrom(width = 360.0, height = 800.0, top = 24.0, bottom = 48.0, leading = 0.0, trailing = 0.0)
        val reserved = stageViewportFrom(width = 360.0, height = 800.0, top = 24.0, bottom = 48.0, leading = 0.0, trailing = 0.0,
            chipRow = StageViewportPolicy.androidChipRowReserve)
        assertEquals(84.0, portrait.insetTop, 0.001)
        assertEquals(140.0, reserved.insetTop, 0.001)
        assertEquals(portrait.insetBottom, reserved.insetBottom, 0.001)
        assertTrue(StageLayoutPolicy.contentFrame(portrait).y < chipBottom)
        assertTrue(StageLayoutPolicy.contentFrame(reserved).y >= chipBottom)
        val landscape = stageViewportFrom(width = 800.0, height = 360.0, top = 24.0, bottom = 0.0, leading = 0.0, trailing = 48.0,
            chipRow = StageViewportPolicy.androidChipRowReserve)
        assertTrue(StageLayoutPolicy.contentFrame(landscape).y >= chipBottom)
        for (viewport in listOf(reserved, landscape)) {
            val stage = presenter(StageFixtureScript.inputs(StageFixtureState.handRaised), viewport)
            assertTrue(stage.chipRowVisible)
            for (frame in stage.currentFrames()) assertTrue(frame.slotId, frame.y >= chipBottom)
        }
        val ios = StageViewportPolicy.iOS(contentWidth = 390.0, contentHeight = 763.0,
            safeArea = StageChromeInsets(top = 47.0, bottom = 34.0, leading = 0.0, trailing = 0.0), regularWidth = false,
            compactHeight = false, topReserve = 56.0, barReserve = 64.0, trailingReserve = 64.0,
            chipRowReserve = StageViewportPolicy.iosChipRowReserve)
        assertEquals(47.0 + 56.0 + 52.0, ios.insetTop, 0.001)
    }

    @Test fun theToastLaneClearsTileNameTagsAboveTheBar() {
        val grid = presenter(StageFixtureScript.base(count = 4))
        var lowest = 0.0
        for (frame in grid.currentFrames()) lowest = maxOf(lowest, frame.maxY)
        assertEquals(android360.height - lowest + StageViewportPolicy.nameTagBand, grid.noticeGeometry.toastBottom, 0.001)
        assertEquals(204.0, grid.noticeGeometry.toastBottom, 0.001)
        val solo = presenter(StageFixtureScript.inputs(StageFixtureState.soloCameraOn))
        assertEquals(android360.insetBottom + StageViewportPolicy.tileControlGap + StageViewportPolicy.nameTagBand,
            solo.noticeGeometry.toastBottom, 0.001)
        val floor = android360.height - android360.insetBottom
        val high = StageFrame(slotId = "p:a", x = 8.0, y = 200.0, width = 160.0, height = floor - StageViewportPolicy.toastReach - 200.0)
        val slot = StageSlot(id = "p:a", role = StageSlotRole.grid, userId = "a", fit = StageVideoFit.fill)
        assertEquals(android360.insetBottom, StageViewportPolicy.toastBottom(viewport = android360, kind = StageKind.grid,
            frames = skip.lib.Array(listOf(high)), slots = skip.lib.Array(listOf(slot))), 0.001)
    }

    @Test fun theAloneCompositionClearsTheToastLaneAndTheLaneDoesNotRiseForAnUntaggedSoloSlot() {
        assertEquals(8.0 + 44.0, StageAlonePolicy.toastClearance, 0.0)
        val alone = presenter(StageFixtureScript.inputs(StageFixtureState.soloCameraOffAlone))
        assertNotNull(alone.alone)
        assertEquals(android360.insetBottom, alone.noticeGeometry.toastBottom, 0.001)
        assertEquals(android360.insetBottom + 52.0 + 24.0, StageAlonePolicy.bottomPadding(android360), 0.001)
        val toastTop = android360.height - alone.noticeGeometry.toastBottom - 8.0 - 44.0
        assertTrue(android360.height - StageAlonePolicy.bottomPadding(android360) + StageAlonePolicy.edgeInset <= toastTop)
        assertEquals(android360.insetBottom,
            presenter(StageFixtureScript.inputs(StageFixtureState.soloUnconfirmed)).noticeGeometry.toastBottom, 0.001)
        val localSlot = StageSlot.participantId(StageFixtureScript.localUserId)
        assertEquals(localSlot, StageViewportPolicy.untaggedSoloSlotId(StageFixtureScript.inputs(StageFixtureState.soloCameraOffAlone),
            kind = StageKind.solo))
        assertEquals("", StageViewportPolicy.untaggedSoloSlotId(StageFixtureScript.inputs(StageFixtureState.soloCameraOn),
            kind = StageKind.solo))
        assertEquals("", StageViewportPolicy.untaggedSoloSlotId(StageFixtureScript.inputs(StageFixtureState.soloCameraOffAlone),
            kind = StageKind.oneOnOne))
        val stage = presenter(StageFixtureScript.inputs(StageFixtureState.soloCameraOn))
        val raised = stage.noticeGeometry.toastBottom
        assertEquals(android360.insetBottom + StageViewportPolicy.tileControlGap + StageViewportPolicy.nameTagBand, raised, 0.001)
        stage.apply(StageFixtureScript.inputs(StageFixtureState.soloCameraOffAlone))
        assertEquals(android360.insetBottom, stage.noticeGeometry.toastBottom, 0.001)
        stage.apply(StageFixtureScript.inputs(StageFixtureState.soloCameraOn))
        assertEquals(raised, stage.noticeGeometry.toastBottom, 0.001)
    }

    @Test fun theAloneCompositionStaysBetweenTheChipRowAndTheToastLaneInLandscapeWithARaisedHand() {
        assertEquals(40.0, StageAlonePolicy.compactAvatarDiameter, 0.0)
        assertEquals(28.0, StageAlonePolicy.titleLineHeight, 0.0)
        assertEquals(20.0, StageAlonePolicy.statusLineHeight, 0.0)
        assertEquals(2, StageAlonePolicy.maxTitleLines)
        assertEquals(StageFixtureState.soloCameraOffAloneHand, StageFixtureScript.state(named = "solo-cameraOff-alone-hand"))
        val hand = presenter(StageFixtureScript.inputs(StageFixtureState.soloCameraOffAloneHand))
        assertNotNull(hand.alone)
        assertTrue(hand.chipRowVisible)
        assertTrue(StageFixtureSession(state = StageFixtureState.soloCameraOffAloneHand).stage.chipRowVisible)
        for (frame in hand.currentFrames()) {
            assertEquals(0.0, frame.y, 0.001)
            assertEquals(android360.height, frame.height, 0.001)
        }

        val landscape = stageViewportFrom(width = 891.0, height = 411.0, top = 24.0, bottom = 24.0, leading = 0.0, trailing = 0.0,
            chipRow = StageViewportPolicy.androidChipRowReserve)
        assertEquals(140.0, StageAlonePolicy.topPadding(landscape), 0.001)
        assertEquals(176.0, StageAlonePolicy.bottomPadding(landscape), 0.001)
        assertEquals(95.0, StageAlonePolicy.bandHeight(landscape), 0.001)
        assertTrue(StageAlonePolicy.usesCompactLayout(landscape, titleLine = 28.0, statusLine = 20.0))
        assertEquals(2, StageAlonePolicy.titleLineLimit(landscape, titleLine = 28.0, statusLine = 20.0))
        assertEquals(80.0, StageAlonePolicy.compositionHeight(compact = true, titleLines = 2, titleLine = 28.0, statusLine = 20.0), 0.001)
        assertTrue(StageAlonePolicy.usesCompactLayout(landscape, titleLine = 28.0 * 1.3, statusLine = 20.0 * 1.3))
        assertEquals(1, StageAlonePolicy.titleLineLimit(landscape, titleLine = 28.0 * 1.3, statusLine = 20.0 * 1.3))
        assertTrue(StageAlonePolicy.usesCompactLayout(landscape, titleLine = 56.0, statusLine = 40.0))
        assertEquals(1, StageAlonePolicy.titleLineLimit(landscape, titleLine = 56.0, statusLine = 40.0))

        val bare = stageViewportFrom(width = 891.0, height = 411.0, top = 24.0, bottom = 24.0, leading = 0.0, trailing = 0.0)
        assertFalse(StageAlonePolicy.usesCompactLayout(bare, titleLine = 28.0, statusLine = 20.0))
        assertEquals(1, StageAlonePolicy.titleLineLimit(bare, titleLine = 28.0, statusLine = 20.0))
        val portrait = stageViewportFrom(width = 360.0, height = 800.0, top = 24.0, bottom = 48.0, leading = 0.0, trailing = 0.0,
            chipRow = StageViewportPolicy.androidChipRowReserve)
        assertFalse(StageAlonePolicy.usesCompactLayout(portrait, titleLine = 56.0, statusLine = 40.0))
        assertEquals(2, StageAlonePolicy.titleLineLimit(portrait, titleLine = 56.0, statusLine = 40.0))

        for (viewport in listOf(landscape, bare, portrait, android360)) {
            val band = StageAlonePolicy.bandHeight(viewport)
            for (scale in listOf(1.0, 1.15, 1.3, 1.5, 1.8, 2.0)) {
                val title = 28.0 * scale
                val status = 20.0 * scale
                val compact = StageAlonePolicy.usesCompactLayout(viewport, titleLine = title, statusLine = status)
                val lines = StageAlonePolicy.titleLineLimit(viewport, titleLine = title, statusLine = status)
                val height = StageAlonePolicy.compositionHeight(compact = compact, titleLines = lines, titleLine = title, statusLine = status)
                assertTrue(lines == 1 || lines == 2)
                if (!compact) {
                    assertTrue(StageAlonePolicy.compositionHeight(compact = false, titleLines = 1, titleLine = title, statusLine = status) <= band)
                }
                if (StageAlonePolicy.compositionHeight(compact = true, titleLines = 1, titleLine = title, statusLine = status) <= band) {
                    assertTrue("${viewport.height} $scale", height <= band)
                    assertTrue("${viewport.height} $scale",
                        viewport.height - StageAlonePolicy.bottomPadding(viewport) - height >= StageAlonePolicy.topPadding(viewport))
                }
            }
        }
    }

    @Test fun theAloneFixtureResolvesByNameOnTheAndroidRoot() {
        assertEquals(StageFixtureState.soloCameraOffAlone, StageFixtureScript.state(named = "solo-cameraOff-alone"))
        val session = StageFixtureSession(state = StageFixtureState.soloCameraOffAlone)
        assertEquals(StageFixtureScript.roomLabel, session.stage.alone?.seed)
    }
}
