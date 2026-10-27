package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * STG-1 and STG-4 through the transpiled stage policies and presenter (the Swift halves are T/StagePoliciesTests.swift
 * and T/STG4ChromeAutoHideTests.swift): SL1 caps at the S20 2 l1 sizes with the same results as Swift, the kind
 * chooser, the SL2 order and promotion timing with an injected clock, SL4 store isolation, SC6 audio never paused,
 * the SL8 chrome state machine, the reaction rules, the Android viewport classes and the SL14 fixture script. Pure:
 * no composition (only the first composition in a JVM keeps recomposing under Robolectric, PanelStageBridgeTests owns
 * it).
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class StageBridgeTests {
    private fun viewport(width: Double, height: Double, top: Double, bottom: Double, trailing: Double = 0.0,
                         widthClass: String = StageSizeClass.compact, heightClass: String = StageSizeClass.regular) =
        StageViewport(width = width, height = height, insetTop = top, insetBottom = bottom, insetLeading = 0.0, insetTrailing = trailing,
            widthClass = widthClass, heightClass = heightClass, placement = StageChromePlacement.bottomBar)

    private val iphoneSE = viewport(375.0, 667.0, 76.0, 64.0)
    private val iphone17e = viewport(390.0, 844.0, 103.0, 98.0)
    private val android360 = viewport(360.0, 800.0, 84.0, 124.0, heightClass = StageSizeClass.medium)

    private fun presenter(inputs: StageInputs, at: StageViewport = iphoneSE): StagePresenter {
        val stage = StagePresenter(shell = MeetingShellPresenter())
        stage.setViewport(at)
        stage.apply(inputs)
        return stage
    }

    private fun personIds(stage: StagePresenter): List<String> {
        val ids = mutableListOf<String>()
        for (slot in stage.layout.slots) {
            if (slot.id.startsWith("p:")) ids.add(slot.userId)
        }
        return ids
    }

    @Test fun capsMatchSwiftAtTheWorkedSizes() {
        assertEquals(6, StageLayoutPolicy.gridCap(viewport = iphoneSE, viewMaxTiles = 16))
        assertEquals(8, StageLayoutPolicy.gridCap(viewport = iphone17e, viewMaxTiles = 16))
        assertEquals(8, StageLayoutPolicy.gridCap(viewport = android360, viewMaxTiles = 16))
        assertEquals(4, StageLayoutPolicy.gridCap(viewport = iphone17e, viewMaxTiles = 5))
        val content = StageLayoutPolicy.contentFrame(android360)
        assertEquals(576.0, content.height, 0.001)
        assertEquals(168.0, (content.width - 8.0) / 2.0, 0.001)
    }

    @Test fun framesAgreeWithCapacityAndNeverOverlapOnAndroidSizes() {
        val sizes = listOf(
            android360,
            stageViewportFrom(width = 800.0, height = 360.0, top = 24.0, bottom = 0.0, leading = 0.0, trailing = 48.0),
            stageViewportFrom(width = 673.0, height = 841.0, top = 24.0, bottom = 48.0, leading = 0.0, trailing = 0.0),
        )
        for (size in sizes) {
            val cap = StageLayoutPolicy.gridCap(viewport = size, viewMaxTiles = 16)
            val content = StageLayoutPolicy.contentFrame(size)
            for (count in 2..16) {
                val stage = presenter(StageFixtureScript.copy(StageFixtureScript.base(count = count), viewMode = "tiled"), size)
                val frames = stage.currentFrames()
                assertEquals(stage.layout.slots.count, frames.count)
                if (count > cap) assertEquals(cap, stage.layout.slots.count)
                for (index in 0 until frames.count) {
                    val a = frames[index]
                    assertTrue(a.x >= content.x - 0.01 && a.maxX <= content.maxX + 0.01)
                    assertTrue(a.y >= content.y - 0.01 && a.maxY <= content.maxY + 0.01)
                    for (other in index + 1 until frames.count) {
                        assertFalse(StageLayoutPolicy.overlaps(a, frames[other]))
                    }
                }
            }
        }
    }

    @Test fun androidViewportClassesFollowTheMaterialWindowClasses() {
        val phone = stageViewportFrom(width = 360.0, height = 800.0, top = 24.0, bottom = 48.0, leading = 0.0, trailing = 0.0)
        assertEquals(StageSizeClass.compact, phone.widthClass)
        assertEquals(StageSizeClass.medium, phone.heightClass)
        assertEquals(84.0, phone.insetTop, 0.001)
        assertEquals(124.0, phone.insetBottom, 0.001)
        assertEquals(StageChromePlacement.bottomBar, phone.placement)
        val landscape = stageViewportFrom(width = 800.0, height = 360.0, top = 24.0, bottom = 0.0, leading = 0.0, trailing = 48.0)
        assertEquals(StageSizeClass.medium, landscape.widthClass)
        assertEquals(StageSizeClass.compact, landscape.heightClass)
        val tablet = stageViewportFrom(width = 1280.0, height = 800.0, top = 24.0, bottom = 48.0, leading = 0.0, trailing = 0.0)
        assertEquals(StageSizeClass.expanded, tablet.widthClass)
        assertEquals(8, StageLayoutPolicy.gridCap(viewport = phone, viewMaxTiles = 16))
    }

    @Test fun grid12OverflowAndKindChooserMatchSwift() {
        val se = presenter(StageFixtureScript.base(count = 12))
        assertEquals(StageKind.grid, se.layout.kind)
        assertEquals(5, personIds(se).size)
        assertEquals(7, se.layout.overflowCount)
        assertEquals(StageSlot.overflowId, se.layout.slots[se.layout.slots.count - 1].id)
        val wide = presenter(StageFixtureScript.base(count = 12), iphone17e)
        assertEquals(7, personIds(wide).size)
        assertEquals(5, wide.layout.overflowCount)
        assertEquals(StageKind.oneOnOne, StageLayoutPolicy.kind(StageFixtureScript.base(count = 2), showsVideoOverActivity = false))
        assertEquals(StageKind.sidebar, StageLayoutPolicy.kind(StageFixtureScript.base(count = 13), showsVideoOverActivity = false))
        val sharing = StageFixtureScript.copy(StageFixtureScript.base(count = 4), screenShareUserId = "r1")
        assertEquals(StageKind.presentation, StageLayoutPolicy.kind(sharing, showsVideoOverActivity = false))
        assertEquals(StageKind.spotlight, StageLayoutPolicy.kind(StageFixtureScript.copy(sharing, pinnedUserId = "r2"), showsVideoOverActivity = false))
        assertEquals(StageKind.game, StageLayoutPolicy.kind(StageFixtureScript.copy(sharing, isGameActive = true), showsVideoOverActivity = false))
    }

    @Test fun speakersInAFittingGridOnlyLightTheRing() {
        val stage = presenter(StageFixtureScript.inputs(StageFixtureState.grid6))
        val revision = stage.layout.revision
        val capsule = stage.capsule
        var at = 1000.0
        for (id in StageFixtureScript.speakerScript(StageFixtureState.grid6)) {
            stage.speakerChanged(id, atMillis = at)
            at += 300.0
            assertTrue(stage.speaking.isSpeaking(id))
        }
        assertEquals(revision, stage.layout.revision)
        assertEquals(capsule, stage.capsule)
        assertEquals(0, stage.promotionTasksStarted)
        assertEquals(listOf("r1", "r2", "r3", "r4", "r5", "you"), personIds(stage))
    }

    @Test fun promotionWaitsAndSwapsAtMostOncePerEightSeconds() {
        var clock = 10_000.0
        val stage = StagePresenter(shell = MeetingShellPresenter())
        stage.now = { clock }
        stage.setViewport(iphoneSE)
        stage.apply(StageFixtureScript.base(count = 12))
        val hidden = StageFixtureScript.hiddenSpeaker(StageFixtureState.grid12)
        val revision = stage.layout.revision
        stage.speakerChanged(hidden, atMillis = clock)
        assertEquals(hidden, stage.pendingPromotionCandidate)
        assertEquals(1200.0, stage.pendingPromotionDelayMillis, 0.001)
        clock += 1200.0
        stage.firePendingPromotion()
        assertEquals(revision + 1, stage.layout.revision)
        assertTrue(personIds(stage).contains(hidden))
        clock += 100.0
        stage.speakerChanged(StageFixtureScript.remoteId(9), atMillis = clock)
        assertEquals(7900.0, stage.pendingPromotionDelayMillis, 0.001)
        stage.reset()
        assertFalse(stage.hasLivePromotionTask)
        assertEquals(0, stage.tileChrome.count)
    }

    @Test fun storesIsolateTilesAndBindings() {
        val stage = presenter(StageFixtureScript.inputs(StageFixtureState.grid6))
        val entry = stage.tileChrome.entry("r2")
        val binding = stage.bindings.binding("p:r2")
        assertEquals("probe:r2", binding.videoKey)
        val revision = stage.layout.revision
        val rows = mutableListOf<StageParticipantInput>()
        for (row in StageFixtureScript.inputs(StageFixtureState.grid6).participants) {
            rows.add(if (row.userId == "r2") StageParticipantInput.make(userId = "r2", displayName = row.displayName, isMuted = !row.isMuted,
                isCameraOff = row.isCameraOff, joinSerial = row.joinSerial, videoKey = "consumer-2") else row)
        }
        stage.apply(StageFixtureScript.copy(StageFixtureScript.inputs(StageFixtureState.grid6), participants = skip.lib.Array(rows)))
        assertSame(entry, stage.tileChrome.entry("r2"))
        assertSame(binding, stage.bindings.binding("p:r2"))
        assertEquals("consumer-2", binding.videoKey)
        assertEquals(revision, stage.layout.revision)
    }

    @Test fun hiddenCameraOffSpeakerStaysAudibleThroughAFakeClient() {
        val stage = presenter(StageFixtureScript.inputs(StageFixtureState.hideTiles))
        assertFalse(personIds(stage).contains("r2"))
        stage.speakerChanged("r2", atMillis = 1000.0)
        assertTrue(personIds(stage).contains("r2"))
        val report = StageVisibilityPolicy.report(frames = stage.currentFrames(), slots = stage.layout.slots, viewport = iphoneSE,
            kind = stage.layout.kind, coverage = "none", chromeHidden = false, isInPip = false, pipTarget = null)
        val consumers = skip.lib.Array(listOf(
            StageConsumerInput(consumerId = "a-r2", userId = "r2", kind = StageConsumerKind.audio, isPaused = false),
            StageConsumerInput(consumerId = "a-r3", userId = "r3", kind = StageConsumerKind.audio, isPaused = false),
            StageConsumerInput(consumerId = "v-r9", userId = "r9", kind = StageConsumerKind.video, isPaused = false),
        ))
        val paused = mutableListOf<String>()
        for (decision in StageConsumerVisibilityPolicy.decisions(consumers = consumers, report = report, receiveVideo = true)) {
            if (decision.action == StageConsumerAction.pause) paused.add(decision.consumerId)
            if (decision.kind == StageConsumerKind.audio) assertEquals(StageConsumerAction.keep, decision.action)
        }
        assertEquals(listOf("v-r9"), paused)
    }

    @Test fun chromeStateMachineMatchesSwift() {
        val visible = ChromeVisibilityState.initial
        val hidden = ChromeAutoHidePolicy.reduce(visible, event = ChromeVisibilityEvent.tap, canAutoHide = true)
        assertTrue(hidden.isHidden)
        assertFalse(ChromeAutoHidePolicy.reduce(visible, event = ChromeVisibilityEvent.tap, canAutoHide = false).isHidden)
        assertFalse(ChromeAutoHidePolicy.reduce(hidden, event = ChromeVisibilityEvent.muteChanged, canAutoHide = true).isHidden)
        assertFalse(ChromeAutoHidePolicy.reduce(visible, event = ChromeVisibilityEvent.timerFired, canAutoHide = false).isHidden)
        assertTrue(ChromeAutoHidePolicy.reduce(visible, event = ChromeVisibilityEvent.timerFired, canAutoHide = true).isHidden)
        assertFalse(ChromeAutoHidePolicy.shouldArm(hidden, canAutoHide = true))
        assertFalse(ChromeAutoHidePolicy.canAutoHide(blocker = AutoHideBlocker.none, voiceOver = true, switchControl = false, focusInChrome = false))
        assertEquals(7500.0, ChromeAutoHidePolicy.hideDelayMillis(timeoutMillis = 7500.0, holdUntilMillis = 0.0, nowMillis = 1.0), 0.001)
        // The Kotlin chrome state wrapper reveals while blocked and hides on the timer only when allowed.
        val state = StageChromeVisibilityState()
        state.setCanAutoHide(true)
        state.send(ChromeVisibilityEvent.timerFired)
        assertTrue(state.state.isHidden)
        state.setCanAutoHide(false)
        assertFalse(state.state.isHidden)
        // Presenter blockers: Always Show Controls, panels and transient ids (S30 CC16, S60 C6-14).
        val stage = presenter(StageFixtureScript.base(count = 4))
        assertEquals(AutoHideBlocker.none, stage.autoHideBlocker)
        stage.setTransientChrome(id = ChromeAutoHidePolicy.moreSheet, open = true)
        assertEquals(AutoHideBlocker.panelOpen, stage.autoHideBlocker)
        stage.setTransientChrome(id = ChromeAutoHidePolicy.moreSheet, open = false)
        assertEquals("none", stage.transientChromeSummary)
        assertEquals(AutoHideBlocker.noRemoteVideo, presenter(StageFixtureScript.inputs(StageFixtureState.audioOnly)).autoHideBlocker)
    }

    @Test fun reactionRulesAndFixtureScriptMatchSwift() {
        assertEquals(20, StageReactionPolicy.renderLimit(participantCount = 19))
        assertEquals(12, StageReactionPolicy.renderLimit(participantCount = 20))
        assertEquals(8, StageReactionPolicy.renderLimit(participantCount = 36))
        val six = presenter(StageFixtureScript.inputs(StageFixtureState.reactionsBurst25))
        six.reactionsChanged(StageFixtureScript.reactions(count = 25))
        assertEquals(20, StageReactionPolicy.visibleEvents(six.reactions).count)
        assertEquals(listOf("none", "static", "live"), RendererProbePattern.values().map { it.rawValue })
        assertEquals(StageFixtureState.grid6, StageFixtureScript.state(named = "grid-6"))
        assertNull(StageFixtureScript.state(named = "nope"))
        val session = StageFixtureSession(state = StageFixtureState.grid6)
        session.magicTap()
        assertEquals(1, session.counters.toggleMicrophone)
        session.minimize()
        assertEquals(1, session.counters.minimize)
        assertEquals(0, session.counters.leave)
        assertEquals(MeetingPhaseKind.inCall, session.shell.session.phase)
    }

    @Test fun ledgerBalancesAcrossCycles() {
        val ledger = RendererIdentityLedger()
        val keep = ledger.created(key = "p:r1", slot = RendererSlot.stage)
        for (cycle in 0 until 20) {
            val key = "p:r${cycle % 3 + 2}"
            val serial = ledger.created(key = key, slot = RendererSlot.stage)
            ledger.released(key = key, serial = serial, slot = RendererSlot.stage)
        }
        assertEquals(1, ledger.counts(RendererSlot.stage).live)
        assertEquals(keep, ledger.serial("p:r1"))
    }
}
