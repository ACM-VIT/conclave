package conclave.module

import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * ENT-3 and ENT-8 (S10 6, 0.5 lobby snapshots, 0.6 L8, L12, 0.8 C1, C2; S20 SC21, SC23; RECONCILE R14, R22, R50): the
 * transpiled lobby presenter, policies and link builder as Kotlin sees them, the Android lobby caches and route rows,
 * and the share intent. Mirrors `T/ENT3LobbyTests.swift` and `T/ENT8MeetingLinkBuilderTests.swift`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class ENT3LobbyBridgeTests {
    private fun presenter(): PremeetingPresenter {
        val presenter = PremeetingPresenter()
        presenter.nowMillis = { 1793102400000.0 }
        presenter.apply(PremeetingInputs.make(accountName = "Avery"))
        return presenter
    }

    @Test fun linkBuilderMatchesTheWebVectors() {
        assertEquals("/rose-sora-luffy", MeetingLinkBuilder.path(roomCode = "rose-sora-luffy", clientId = null))
        assertEquals("https://conclave.acmvit.in/rose-sora-luffy", MeetingLinkBuilder.url(roomCode = "rose-sora-luffy", clientId = "conclave"))
        assertEquals("/rose-sora-luffy", MeetingLinkBuilder.path(roomCode = "rose-sora-luffy", clientId = "DEFAULT"))
        assertEquals("/rose-sora-luffy", MeetingLinkBuilder.path(roomCode = "rose-sora-luffy", clientId = "public"))
        assertEquals("https://conclave.acmvit.in/rose-sora-luffy?clientId=acme",
            MeetingLinkBuilder.url(roomCode = "rose-sora-luffy", clientId = " acme "))
        assertEquals("/r?clientId=a.b%3Ac-d_e", MeetingLinkBuilder.path(roomCode = "r", clientId = "a.b:c-d_e"))
        assertEquals("/r", MeetingLinkBuilder.path(roomCode = "r", clientId = "bad id"))
        assertEquals("/room%2Fwith%3Freserved%23chars", MeetingLinkBuilder.path(roomCode = " room/with?reserved#chars ", clientId = null))
        assertEquals("/a%20b", MeetingLinkBuilder.path(roomCode = "a b", clientId = null))
        assertEquals("/caf%C3%A9", MeetingLinkBuilder.path(roomCode = "café", clientId = null))
        assertEquals("/it's(1)!~*", MeetingLinkBuilder.path(roomCode = "it's(1)!~*", clientId = null))
        assertEquals("", MeetingLinkBuilder.url(roomCode = " ", clientId = "acme"))
        assertEquals("conclave.acmvit.in/r", MeetingLinkBuilder.displayText("https://conclave.acmvit.in/r"))
    }

    @Test fun theTranspiledPresenterPublishesTheSixLobbySnapshots() {
        val presenter = presenter()
        presenter.handleIncomingURL("https://conclave.acmvit.in/rose-sora-luffy?clientId=acme")
        val routeId = presenter.path.last?.id ?: -1
        assertEquals(routeId, presenter.lobbyStatus?.routeId)
        assertEquals(routeId, presenter.lobbyMedia?.routeId)
        assertEquals(routeId, presenter.lobbyPresence?.routeId)
        assertEquals(routeId, presenter.lobbyIdentity?.routeId)
        assertEquals(routeId, presenter.lobbyLink?.routeId)
        assertEquals(routeId, presenter.lobbyAudio?.routeId)
        assertEquals("https://conclave.acmvit.in/rose-sora-luffy?clientId=acme", presenter.lobbyLink?.meetingLink)
        assertEquals("Avery", presenter.lobbyIdentity?.guestName)
        assertEquals(true, presenter.lobbyStatus?.isPrimaryEnabled)
        presenter.setGuestName("")
        assertEquals(false, presenter.lobbyStatus?.isPrimaryEnabled)
        assertEquals(LobbyPrimaryReason.nameMissingJoin.rawValue, presenter.lobbyStatus?.primaryReason)
        presenter.applyPermissions(microphone = MediaPermissionState.granted, camera = MediaPermissionState.denied,
            canAskAgainMicrophone = true, canAskAgainCamera = false)
        assertEquals(PreviewState.blocked, presenter.lobbyMedia?.preview)
        presenter.setPath(skip.lib.Array(listOf<PremeetingRoute>()))
        assertNull(presenter.lobbyStatus)
        assertNull(presenter.lobbyMedia)
        assertEquals(0, presenter.liveTaskCount)
    }

    @Test fun intentAndRouteChoicesReachOnlyTheHooks() {
        val presenter = presenter()
        val intents = mutableListOf<String>()
        val routes = mutableListOf<String>()
        val joins = mutableListOf<LobbyJoinRequest>()
        val hooks = LobbyCoreHooks()
        hooks.setEntryMediaIntent = { mic, camera -> intents.add("$mic:$camera") }
        hooks.setPrejoinAudioRouteIntent = { kind, input -> routes.add("$kind|$input") }
        hooks.join = { request -> joins.add(request) }
        presenter.lobbyHooks = hooks
        presenter.handleIncomingURL("https://conclave.acmvit.in/rose-sora-luffy")
        presenter.applyPermissions(microphone = MediaPermissionState.granted, camera = MediaPermissionState.granted,
            canAskAgainMicrophone = true, canAskAgainCamera = true)
        presenter.setMicIntent(true)
        assertEquals(listOf("true:false"), intents)
        presenter.selectAudioOutput(kind = "speaker")
        assertEquals(listOf("speaker|"), routes)
        assertEquals("speaker", presenter.lobbyAudio?.routeKind)
        presenter.startOrJoin()
        assertEquals(1, joins.size)
        assertEquals("rose-sora-luffy", joins[0].roomId)
        assertEquals("Avery", joins[0].displayName)
        assertFalse(joins[0].isHost)
    }

    @Test fun lobbyUiCacheReusesInstancesForEqualSnapshots() {
        val presenter = presenter()
        presenter.handleIncomingURL("https://conclave.acmvit.in/rose-sora-luffy")
        val cache = LobbyUiCache()
        val media = presenter.lobbyMedia
        assertNotNull(media)
        val first = cache.card(media!!)
        assertSame(first, cache.card(media))
        val builds = cache.builds
        assertSame(first, cache.card(presenter.lobbyMedia!!))
        assertEquals(builds, cache.builds)
        presenter.applyPermissions(microphone = MediaPermissionState.granted, camera = MediaPermissionState.denied,
            canAskAgainMicrophone = false, canAskAgainCamera = false)
        val second = cache.card(presenter.lobbyMedia!!)
        assertNotSame(first, second)
        assertTrue(second.isCameraBlocked)
        val status = cache.status(presenter.lobbyStatus!!)
        assertSame(status, cache.status(presenter.lobbyStatus!!))
        assertEquals(LobbyPrimaryReason.none, status.reason)
        assertFalse(status.isBusy)
    }

    @Test fun routeRowsNameTheKindsAndMarkTheCurrentOne() {
        val presenter = presenter()
        presenter.handleIncomingURL("https://conclave.acmvit.in/rose-sora-luffy")
        presenter.applyAudioRoutes(
            outputs = skip.lib.Array(listOf(
                AudioRouteOption(id = "out:1", kind = AudioRouteKind.receiver, name = "", isConnecting = false),
                AudioRouteOption(id = "out:2", kind = AudioRouteKind.speaker, name = "Speaker", isConnecting = false),
            )),
            currentOutputId = "out:2", inputOptions = skip.lib.Array(listOf<AudioRouteOption>()), currentInputId = "")
        val rows = LobbyRouteRows.rows(presenter.lobbyAudio!!) { kind -> "[" + LobbyRouteRows.resourceName(kind) + "]" }
        assertEquals(2, rows.size)
        assertEquals("[ctl_route_phone]", rows[0].name)
        assertFalse(rows[0].selected)
        assertTrue(rows[1].selected)
        assertEquals("ctl_route_wired", LobbyRouteRows.resourceName("wired"))
        assertEquals("ctl_route_hearing_aid", LobbyRouteRows.resourceName("hearingAid"))
    }

    @Test fun thePreviewLatchAndFeedbackRulesHoldInKotlin() {
        var machine = LocalPreviewMachine.initial
        machine = LocalPreviewPolicy.next(machine, event = LocalPreviewEvent.start)
        machine = LocalPreviewPolicy.next(machine, event = LocalPreviewEvent.bound)
        assertEquals(PreviewState.live, machine.state)
        machine = LocalPreviewPolicy.next(machine, event = LocalPreviewEvent.releasedByCall)
        assertTrue(machine.isLatched)
        assertEquals(PreviewState.published, machine.state)
        assertEquals(machine, LocalPreviewPolicy.next(machine, event = LocalPreviewEvent.start))
        assertFalse(LocalPreviewPolicy.mayCapture(machine))
        assertEquals(FeedbackKind.cameraOn, LobbyToggleFeedbackPolicy.kind(isOn = false, permission = MediaPermissionState.granted,
            onKind = FeedbackKind.cameraOn, offKind = FeedbackKind.cameraOff))
        assertNull(LobbyToggleFeedbackPolicy.kind(isOn = false, permission = MediaPermissionState.denied,
            onKind = FeedbackKind.cameraOn, offKind = FeedbackKind.cameraOff))
        assertEquals(FeedbackKind.micOn, LobbyToggleFeedbackPolicy.kind(isOn = false, permission = MediaPermissionState.denied,
            onKind = FeedbackKind.micOn, offKind = FeedbackKind.micOff, canAskAgain = true))
    }

    @Test fun theShareIntentCarriesTheF00PayloadAndTheRoomTitle() {
        val intent = NativeMeetingShare.buildShareIntent(subject = "Join my Conclave meeting",
            text = "Join me in this Conclave meeting.\nhttps://conclave.acmvit.in/r", title = "r")
        assertEquals(Intent.ACTION_SEND, intent.action)
        assertEquals("text/plain", intent.type)
        assertEquals("Join my Conclave meeting", intent.getStringExtra(Intent.EXTRA_SUBJECT))
        assertEquals("r", intent.getStringExtra(Intent.EXTRA_TITLE))
        assertTrue(intent.getStringExtra(Intent.EXTRA_TEXT)!!.endsWith("https://conclave.acmvit.in/r"))
        assertFalse(intent.hasExtra("android.intent.extra.IS_SENSITIVE"))
        assertNull(NativeMeetingShare.buildShareIntent(subject = "s", text = "t", title = "").getStringExtra(Intent.EXTRA_TITLE))
        assertTrue(lobbyShowsCopySnackbar(sdk = 28))
        assertTrue(lobbyShowsCopySnackbar(sdk = 32))
        assertFalse(lobbyShowsCopySnackbar(sdk = 33))
    }

    @Test fun lobbyFixturesRunThroughTheTranspiledSession() {
        val session = PremeetingFixtureSession(state = PremeetingFixtureState.lobby)
        session.start()
        try {
            assertEquals(PreviewState.blocked, session.premeeting.lobbyMedia?.preview)
            assertEquals(LobbyIntent.join, session.premeeting.lobbyStatus?.intent)
            session.premeeting.setMicIntent(true)
            assertEquals(true, session.premeeting.lobbyMedia?.micIntentOn)
        } finally {
            session.stop()
        }
        val fresh = PremeetingFixtureSession(state = PremeetingFixtureState.lobbyNewMeeting)
        fresh.start()
        try {
            assertEquals(PremeetingFixtureScript.newMeetingCode, fresh.premeeting.lobbyLink?.roomLabel)
            assertEquals(false, fresh.premeeting.lobbyLink?.canShare)
        } finally {
            fresh.stop()
        }
    }
}
