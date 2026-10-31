package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class S1bLobbyStatusBridgeTests {
    private val permissionConfigs = listOf(
        Pair(MediaPermissionState.granted, false), Pair(MediaPermissionState.notDetermined, true),
        Pair(MediaPermissionState.denied, true), Pair(MediaPermissionState.denied, false),
        Pair(MediaPermissionState.restricted, false), Pair(MediaPermissionState.unavailable, false),
    )

    private fun status(
        mode: LobbyMode = LobbyMode.editing,
        intent: LobbyIntent = LobbyIntent.join,
        issue: LobbyIssue = LobbyIssue.none,
        serverText: String = "",
        enabled: Boolean = true,
        reason: LobbyPrimaryReason = LobbyPrimaryReason.none,
        slow: Boolean = false,
        waiting: WaitingKind = WaitingKind.standard,
        pending: Boolean = false,
        waitingText: String = "",
    ): LobbyStatusSnapshot = LobbyStatusSnapshot(
        routeId = 1, intent = intent, mode = mode, issue = issue, issueServerText = serverText, isPrimaryEnabled = enabled,
        primaryReason = LobbyPrimaryPolicy.snapshotValue(reason), showsSlowNotice = slow, waitingKind = waiting,
        isPrimaryPending = pending, waitingText = waitingText,
    )

    private fun media(
        microphone: MediaPermissionState,
        camera: MediaPermissionState,
        askMicrophone: Boolean = false,
        askCamera: Boolean = false,
    ): LobbyMediaSnapshot = LobbySnapshotPolicy.media(
        routeId = 1, micIntentOn = false, cameraIntentOn = false,
        device = LobbyDeviceInputs.initial.withPermissions(microphone = microphone, camera = camera,
            canAskAgainMicrophone = askMicrophone, canAskAgainCamera = askCamera),
        avatarName = "Avery", avatarSeed = "",
    )

    private fun row(
        kind: LobbyStatusRowKind,
        action: LobbyStatusRowAction,
        restricted: Boolean = false,
        mediaKind: LobbyMediaKind = LobbyMediaKind.microphone,
        issue: LobbyIssue = LobbyIssue.none,
    ): LobbyStatusRowModel = LobbyStatusRowModel(kind = kind, issue = issue, mediaKind = mediaKind, restricted = restricted, action = action)

    private fun rows(media: LobbyMediaSnapshot, android: Boolean, status: LobbyStatusSnapshot? = null): List<LobbyStatusRowModel> =
        LobbyStatusPolicy.rows(status = status, media = media, supportsRationale = android, offersAppInfo = android).toList()

    private fun line(status: LobbyStatusSnapshot, signedIn: Boolean = false): LobbyStatusLineKind =
        LobbyStatusPolicy.line(status = status, isSignedIn = signedIn)

    private fun enabled(status: LobbyStatusSnapshot, signedIn: Boolean = false): Boolean =
        LobbyStatusPolicy.primaryEnabled(status = status, isSignedIn = signedIn)

    private fun expectedAction(priming: PermissionPrimingKind): LobbyStatusRowAction = when (priming) {
        PermissionPrimingKind.rationale -> LobbyStatusRowAction.allow
        PermissionPrimingKind.openSettings -> LobbyStatusRowAction.openSettings
        else -> LobbyStatusRowAction.none
    }

    @Test fun rowsFollowTheMergeRuleForEveryPrimingPairOnBothPlatforms() {
        assertTrue(LobbyStatusPolicy.platformOffersAppInfo)
        assertTrue(PermissionPrimingPolicy.platformSupportsRationale)
        for (android in listOf(true, false)) {
            for (mic in permissionConfigs) {
                for (camera in permissionConfigs) {
                    val result = rows(media(mic.first, camera.first, askMicrophone = mic.second, askCamera = camera.second), android)
                    val label = "$android ${mic.first.rawValue} ${mic.second} ${camera.first.rawValue} ${camera.second}"
                    val micPriming = PermissionPrimingPolicy.priming(permission = mic.first, canAskAgain = mic.second,
                        supportsRationale = android, rationaleDismissed = false)
                    val cameraPriming = PermissionPrimingPolicy.priming(permission = camera.first, canAskAgain = camera.second,
                        supportsRationale = android, rationaleDismissed = false)
                    val bothRestricted = micPriming == PermissionPrimingKind.restricted
                    val expected: List<LobbyStatusRowModel> = if (micPriming == cameraPriming &&
                        (micPriming == PermissionPrimingKind.openSettings || micPriming == PermissionPrimingKind.restricted)) {
                        listOf(row(LobbyStatusRowKind.media,
                            if (bothRestricted) LobbyStatusRowAction.none else LobbyStatusRowAction.openSettings,
                            restricted = bothRestricted))
                    } else if (expectedAction(micPriming) != LobbyStatusRowAction.none) {
                        listOf(row(LobbyStatusRowKind.microphone, expectedAction(micPriming)))
                    } else if (expectedAction(cameraPriming) != LobbyStatusRowAction.none) {
                        listOf(row(LobbyStatusRowKind.camera, expectedAction(cameraPriming), mediaKind = LobbyMediaKind.camera))
                    } else if (micPriming == PermissionPrimingKind.restricted) {
                        listOf(row(LobbyStatusRowKind.microphone, LobbyStatusRowAction.none, restricted = true))
                    } else if (cameraPriming == PermissionPrimingKind.restricted) {
                        listOf(row(LobbyStatusRowKind.camera, LobbyStatusRowAction.none, restricted = true, mediaKind = LobbyMediaKind.camera))
                    } else {
                        emptyList()
                    }
                    assertEquals(label, expected, result)
                    assertTrue("$label: one media row at most", result.size <= 1)
                    if (micPriming == PermissionPrimingKind.rationale || cameraPriming == PermissionPrimingKind.rationale) {
                        assertFalse("$label: no merged row when either priming is askable", result.any { it.kind == LobbyStatusRowKind.media })
                    }
                    if ((micPriming == PermissionPrimingKind.restricted && cameraPriming == PermissionPrimingKind.openSettings) ||
                        (micPriming == PermissionPrimingKind.openSettings && cameraPriming == PermissionPrimingKind.restricted)) {
                        assertEquals("$label: a restricted permission never shares a row with a Settings fix", 1, result.size)
                        assertFalse(label, result.first().restricted)
                        assertEquals(label, LobbyStatusRowAction.openSettings, result.first().action)
                    }
                    if (!android) assertFalse("$label: iOS has no Allow", result.any { it.action == LobbyStatusRowAction.allow })
                }
            }
        }
    }

    @Test fun rowVectorsForTheOwnerStates() {
        val denied = MediaPermissionState.denied
        val restricted = MediaPermissionState.restricted
        val granted = MediaPermissionState.granted
        val notDetermined = MediaPermissionState.notDetermined
        assertEquals(listOf(row(LobbyStatusRowKind.media, LobbyStatusRowAction.openSettings)), rows(media(denied, denied), android = false))
        assertEquals(listOf(row(LobbyStatusRowKind.media, LobbyStatusRowAction.openSettings)), rows(media(denied, denied), android = true))
        assertEquals("iOS has no rationale, so both denied always merge",
            listOf(row(LobbyStatusRowKind.media, LobbyStatusRowAction.openSettings)),
            rows(media(denied, denied, askMicrophone = true, askCamera = true), android = false))
        assertEquals("Allow asks for the microphone alone", listOf(row(LobbyStatusRowKind.microphone, LobbyStatusRowAction.allow)),
            rows(media(denied, denied, askMicrophone = true, askCamera = true), android = true))
        assertEquals(listOf(row(LobbyStatusRowKind.microphone, LobbyStatusRowAction.openSettings)),
            rows(media(denied, denied, askMicrophone = false, askCamera = true), android = true))
        assertEquals(listOf(row(LobbyStatusRowKind.microphone, LobbyStatusRowAction.allow)),
            rows(media(denied, denied, askMicrophone = true, askCamera = false), android = true))
        assertEquals(listOf(row(LobbyStatusRowKind.camera, LobbyStatusRowAction.openSettings, mediaKind = LobbyMediaKind.camera)),
            rows(media(granted, denied), android = false))
        assertEquals(listOf(row(LobbyStatusRowKind.camera, LobbyStatusRowAction.allow, mediaKind = LobbyMediaKind.camera)),
            rows(media(notDetermined, denied, askCamera = true), android = true))
        assertEquals(listOf(row(LobbyStatusRowKind.camera, LobbyStatusRowAction.openSettings, mediaKind = LobbyMediaKind.camera)),
            rows(media(restricted, denied), android = false))
        assertEquals(listOf(row(LobbyStatusRowKind.camera, LobbyStatusRowAction.openSettings, mediaKind = LobbyMediaKind.camera)),
            rows(media(restricted, denied), android = true))
        assertEquals(listOf(row(LobbyStatusRowKind.media, LobbyStatusRowAction.none, restricted = true)),
            rows(media(restricted, restricted), android = true))
        assertEquals(listOf(row(LobbyStatusRowKind.microphone, LobbyStatusRowAction.none, restricted = true)),
            rows(media(restricted, notDetermined), android = false))
        assertEquals(listOf(row(LobbyStatusRowKind.microphone, LobbyStatusRowAction.none, restricted = true)),
            rows(media(restricted, notDetermined), android = true))
        assertEquals(listOf(row(LobbyStatusRowKind.camera, LobbyStatusRowAction.none, restricted = true, mediaKind = LobbyMediaKind.camera)),
            rows(media(granted, restricted), android = false))
        assertEquals(listOf(row(LobbyStatusRowKind.camera, LobbyStatusRowAction.none, restricted = true, mediaKind = LobbyMediaKind.camera)),
            rows(media(granted, restricted), android = true))
        assertTrue("camera unavailable is the tile's label, not a row", rows(media(granted, MediaPermissionState.unavailable), android = false).isEmpty())
        assertTrue(rows(media(granted, MediaPermissionState.unavailable), android = true).isEmpty())
        assertTrue("the toggle asks; nothing is said before",
            rows(media(notDetermined, notDetermined, askMicrophone = true, askCamera = true), android = true).isEmpty())
        assertTrue(LobbyStatusPolicy.rows(status = null, media = null, supportsRationale = true, offersAppInfo = true).toList().isEmpty())
    }

    @Test fun theIssueRowShowsOnlyInEditingForASuspendedApp() {
        val both = media(MediaPermissionState.denied, MediaPermissionState.denied)
        val suspended = status(issue = LobbyIssue.appSuspended)
        assertEquals(
            listOf(row(LobbyStatusRowKind.issue, LobbyStatusRowAction.openSettings, issue = LobbyIssue.appSuspended),
                row(LobbyStatusRowKind.media, LobbyStatusRowAction.openSettings)),
            rows(both, android = true, status = suspended),
        )
        assertEquals(
            listOf(row(LobbyStatusRowKind.issue, LobbyStatusRowAction.none, issue = LobbyIssue.appSuspended),
                row(LobbyStatusRowKind.media, LobbyStatusRowAction.openSettings)),
            rows(both, android = false, status = suspended),
        )
        assertEquals(LobbyStatusPolicy.maxRows, rows(both, android = true, status = suspended).size)
        assertFalse(rows(both, android = true, status = status(mode = LobbyMode.connecting, issue = LobbyIssue.appSuspended))
            .any { it.kind == LobbyStatusRowKind.issue })
        for (issue in LobbyIssue.entries) {
            if (issue == LobbyIssue.appSuspended) continue
            assertFalse(issue.rawValue, rows(both, android = true, status = status(issue = issue)).any { it.kind == LobbyStatusRowKind.issue })
        }
        for (mode in LobbyMode.entries) {
            for (issue in LobbyIssue.entries) {
                for (mic in permissionConfigs) {
                    val value = rows(media(mic.first, MediaPermissionState.denied, askMicrophone = mic.second), android = true,
                        status = status(mode = mode, issue = issue))
                    assertTrue("${mode.rawValue} ${issue.rawValue} ${mic.first.rawValue}", value.size <= LobbyStatusPolicy.maxRows)
                }
            }
        }
    }

    @Test fun theTranspiledLineFollowsItsPrecedenceInEveryMode() {
        assertEquals(LobbyStatusLineKind.none, line(status()))
        assertEquals(LobbyStatusLineKind.updateRequired,
            line(status(issue = LobbyIssue.updateRequired, enabled = false, reason = LobbyPrimaryReason.updateRequired)))
        assertEquals(LobbyStatusLineKind.offline, line(status(enabled = false, reason = LobbyPrimaryReason.offline)))
        assertEquals("a form error the classifier reads as offline", LobbyStatusLineKind.offline, line(status(issue = LobbyIssue.offline)))
        assertEquals(LobbyStatusLineKind.signInRequired, line(status(issue = LobbyIssue.signInRequired)))
        assertEquals(LobbyStatusLineKind.none, line(status(issue = LobbyIssue.signInRequired), signedIn = true))
        assertEquals("sign in comes before the name", LobbyStatusLineKind.signInRequired,
            line(status(issue = LobbyIssue.signInRequired, enabled = false, reason = LobbyPrimaryReason.nameMissingJoin)))
        assertEquals(LobbyStatusLineKind.nameMissing, line(status(enabled = false, reason = LobbyPrimaryReason.nameMissingJoin)))
        assertEquals(LobbyStatusLineKind.nameMissing,
            line(status(intent = LobbyIntent.newMeeting, enabled = false, reason = LobbyPrimaryReason.nameMissingStart)))
        assertEquals("the name comes before a room issue", LobbyStatusLineKind.nameMissing,
            line(status(issue = LobbyIssue.roomNotFound, enabled = false, reason = LobbyPrimaryReason.nameMissingJoin)))
        assertEquals(LobbyStatusLineKind.roomNotFound, line(status(issue = LobbyIssue.roomNotFound)))
        assertEquals("offline masks a room issue", LobbyStatusLineKind.offline,
            line(status(issue = LobbyIssue.roomNotFound, enabled = false, reason = LobbyPrimaryReason.offline)))
        assertEquals(LobbyStatusLineKind.failedServerText,
            line(status(issue = LobbyIssue.failedServerText, serverText = "You are not allowed to join this meeting.")))
        assertEquals("no line without server text", LobbyStatusLineKind.none, line(status(issue = LobbyIssue.failedServerText)))
        assertEquals("the suspension is a row", LobbyStatusLineKind.none, line(status(issue = LobbyIssue.appSuspended)))
        assertEquals("the wrong code is the field's footer", LobbyStatusLineKind.none, line(status(issue = LobbyIssue.inviteCodeInvalid)))
        assertEquals(LobbyStatusLineKind.none, line(status(issue = LobbyIssue.inviteCodeRequired)))

        assertEquals(LobbyStatusLineKind.none, line(status(mode = LobbyMode.connecting, enabled = false)))
        assertEquals(LobbyStatusLineKind.stillConnecting, line(status(mode = LobbyMode.connecting, enabled = false, slow = true)))
        assertEquals(LobbyStatusLineKind.offline,
            line(status(mode = LobbyMode.connecting, issue = LobbyIssue.offline, enabled = false, reason = LobbyPrimaryReason.offline, slow = true)))

        assertEquals(LobbyStatusLineKind.updateRequired,
            line(status(mode = LobbyMode.failed, issue = LobbyIssue.updateRequired, enabled = false, reason = LobbyPrimaryReason.updateRequired)))
        assertEquals(LobbyStatusLineKind.offline,
            line(status(mode = LobbyMode.failed, issue = LobbyIssue.failedNetwork, enabled = false, reason = LobbyPrimaryReason.offline)))
        assertEquals("a failed update and name reads the name", LobbyStatusLineKind.nameMissing,
            line(status(mode = LobbyMode.failed, issue = LobbyIssue.failedNetwork, enabled = false, reason = LobbyPrimaryReason.nameMissingJoin)))
        assertEquals(LobbyStatusLineKind.failedNetwork, line(status(mode = LobbyMode.failed, issue = LobbyIssue.failedNetwork, enabled = false)))
        assertEquals(LobbyStatusLineKind.failedMedia, line(status(mode = LobbyMode.failed, issue = LobbyIssue.failedMedia, enabled = false)))
        assertEquals(LobbyStatusLineKind.failedServerBusy,
            line(status(mode = LobbyMode.failed, issue = LobbyIssue.failedServerBusy, enabled = false)))
        assertEquals(LobbyStatusLineKind.failedServerText,
            line(status(mode = LobbyMode.failed, issue = LobbyIssue.failedServerText, serverText = "Ended.", enabled = false)))
        assertEquals(LobbyStatusLineKind.failedUnknown, line(status(mode = LobbyMode.failed, issue = LobbyIssue.failedServerText, enabled = false)))
        assertEquals(LobbyStatusLineKind.failedUnknown, line(status(mode = LobbyMode.failed, issue = LobbyIssue.failedUnknown, enabled = false)))

        val waiting = listOf(
            Pair(WaitingKind.standard, LobbyStatusLineKind.waitingStandard), Pair(WaitingKind.locked, LobbyStatusLineKind.waitingLocked),
            Pair(WaitingKind.noHost, LobbyStatusLineKind.waitingNoHost), Pair(WaitingKind.hostAvailable, LobbyStatusLineKind.waitingHostAvailable),
            Pair(WaitingKind.reconnecting, LobbyStatusLineKind.waitingReconnecting), Pair(WaitingKind.offline, LobbyStatusLineKind.waitingOffline),
            Pair(WaitingKind.serverRestarting, LobbyStatusLineKind.waitingServerRestarting),
        )
        assertEquals(WaitingKind.entries.size, waiting.size)
        for ((kind, expected) in waiting) {
            assertEquals(kind.rawValue, expected, line(status(mode = LobbyMode.waiting, enabled = false, waiting = kind)))
        }
    }

    @Test fun primaryEnabledMatchesWhatTheMainActionCanDo() {
        assertTrue(enabled(status()))
        assertFalse(enabled(status(enabled = false, reason = LobbyPrimaryReason.nameMissingJoin)))
        assertFalse("Sign in to join disables Join", enabled(status(issue = LobbyIssue.signInRequired)))
        assertTrue("signing in enables Join; the next Join clears the issue", enabled(status(issue = LobbyIssue.signInRequired), signedIn = true))
        assertTrue("a room can open later", enabled(status(issue = LobbyIssue.roomNotFound)))
        assertTrue(enabled(status(mode = LobbyMode.failed, issue = LobbyIssue.failedNetwork, enabled = false)))
        assertFalse("Try Again waits for a connection",
            enabled(status(mode = LobbyMode.failed, issue = LobbyIssue.failedNetwork, enabled = false, reason = LobbyPrimaryReason.offline)))
        assertFalse(enabled(status(mode = LobbyMode.failed, issue = LobbyIssue.failedNetwork, enabled = false, reason = LobbyPrimaryReason.nameMissingJoin)))
        assertFalse(enabled(status(mode = LobbyMode.failed, issue = LobbyIssue.failedNetwork, enabled = false, pending = true)))
        assertFalse(enabled(status(mode = LobbyMode.connecting, enabled = true)))
        assertFalse(enabled(status(mode = LobbyMode.waiting, enabled = true)))
    }

    @Test fun pendingKindNamesThePendingControl() {
        assertEquals(LobbyPendingKind.joining, LobbyStatusPolicy.pendingKind(status = status(mode = LobbyMode.connecting)))
        assertEquals(LobbyPendingKind.starting,
            LobbyStatusPolicy.pendingKind(status = status(mode = LobbyMode.connecting, intent = LobbyIntent.newMeeting)))
        assertEquals(LobbyPendingKind.reconnecting,
            LobbyStatusPolicy.pendingKind(status = status(mode = LobbyMode.connecting, waiting = WaitingKind.reconnecting)))
        assertEquals(LobbyPendingKind.reconnecting, LobbyStatusPolicy.pendingKind(
            status = status(mode = LobbyMode.connecting, intent = LobbyIntent.newMeeting, waiting = WaitingKind.reconnecting)))
        assertEquals(LobbyPendingKind.asking, LobbyStatusPolicy.pendingKind(status = status(mode = LobbyMode.waiting)))
        assertEquals("the collision check keeps its own title", LobbyPendingKind.none, LobbyStatusPolicy.pendingKind(status = status(pending = true)))
        assertEquals(LobbyPendingKind.none, LobbyStatusPolicy.pendingKind(status = status(mode = LobbyMode.failed)))
    }

    @Test fun announcementsIdentifiersAndServerText() {
        val announced = setOf(
            LobbyStatusLineKind.offline, LobbyStatusLineKind.stillConnecting, LobbyStatusLineKind.updateRequired,
            LobbyStatusLineKind.signInRequired, LobbyStatusLineKind.roomNotFound, LobbyStatusLineKind.failedServerText,
            LobbyStatusLineKind.waitingStandard, LobbyStatusLineKind.waitingLocked, LobbyStatusLineKind.waitingNoHost,
            LobbyStatusLineKind.waitingHostAvailable, LobbyStatusLineKind.waitingReconnecting, LobbyStatusLineKind.waitingOffline,
            LobbyStatusLineKind.waitingServerRestarting,
        )
        for (kind in LobbyStatusLineKind.entries) {
            assertEquals(kind.rawValue, announced.contains(kind), LobbyStatusPolicy.announcesLine(kind))
        }
        assertEquals(19, LobbyStatusLineKind.entries.size)
        for (kind in listOf(LobbyStatusLineKind.nameMissing, LobbyStatusLineKind.offline, LobbyStatusLineKind.updateRequired,
            LobbyStatusLineKind.signInRequired, LobbyStatusLineKind.roomNotFound)) {
            assertEquals(kind.rawValue, "lobby.primary.reason", LobbyStatusPolicy.lineIdentifier(kind))
        }
        assertEquals("lobby.slowNotice", LobbyStatusPolicy.lineIdentifier(LobbyStatusLineKind.stillConnecting))
        for (kind in listOf(LobbyStatusLineKind.failedNetwork, LobbyStatusLineKind.failedMedia, LobbyStatusLineKind.failedServerBusy,
            LobbyStatusLineKind.failedServerText, LobbyStatusLineKind.failedUnknown)) {
            assertEquals(kind.rawValue, "lobby.status", LobbyStatusPolicy.lineIdentifier(kind))
        }
        for (kind in listOf(LobbyStatusLineKind.waitingStandard, LobbyStatusLineKind.waitingLocked, LobbyStatusLineKind.waitingNoHost,
            LobbyStatusLineKind.waitingHostAvailable, LobbyStatusLineKind.waitingReconnecting, LobbyStatusLineKind.waitingOffline,
            LobbyStatusLineKind.waitingServerRestarting)) {
            assertEquals(kind.rawValue, "lobby.waiting.body", LobbyStatusPolicy.lineIdentifier(kind))
        }
        assertEquals("Ended", LobbyStatusPolicy.serverLine("Ended."))
        assertEquals("one trailing full stop only", "Wait..", LobbyStatusPolicy.serverLine("Wait..."))
        assertEquals("Hold on…", LobbyStatusPolicy.serverLine("Hold on…"))
        assertEquals("Really?", LobbyStatusPolicy.serverLine("Really?"))
        assertEquals("Ended", LobbyStatusPolicy.serverLine("  Ended.  "))
        assertEquals("", LobbyStatusPolicy.serverLine(""))
        assertEquals(2, LobbyStatusPolicy.maxRows)
        assertEquals(2, LobbyStatusPolicy.lineMaxLines)
        assertTrue("Android offers the app info page for the suspension row", LobbyStatusPolicy.platformOffersAppInfo)
        assertEquals(4, LobbyStatusRowKind.entries.size)
        assertEquals(3, LobbyStatusRowAction.entries.size)
        assertEquals(5, LobbyPendingKind.entries.size)
    }

    @Test fun serverTextKeepsOneKindInBothModesSoTheCallSitesResolveIt() {
        val editing = status(issue = LobbyIssue.failedServerText, serverText = "You are not allowed to join this meeting.")
        val failed = status(mode = LobbyMode.failed, issue = LobbyIssue.failedServerText, serverText = "Ended.", enabled = false)
        assertEquals(LobbyStatusLineKind.failedServerText, line(editing))
        assertEquals(LobbyStatusLineKind.failedServerText, line(failed))
        assertEquals("lobby.status", LobbyStatusPolicy.lineIdentifier(LobbyStatusLineKind.failedServerText))
        assertTrue(LobbyStatusPolicy.announcesLine(LobbyStatusLineKind.failedServerText))
        assertEquals("You are not allowed to join this meeting", LobbyStatusPolicy.serverLine(editing.issueServerText))
        assertEquals("Ended", LobbyStatusPolicy.serverLine(failed.issueServerText))
    }

    @Test fun theTranspiledFixturesReachTheirStates() {
        val offline = PremeetingFixtureSession(state = PremeetingFixtureState.lobbyOffline)
        offline.start()
        try {
            val status = offline.premeeting.lobbyStatus!!
            assertEquals(LobbyStatusLineKind.offline, line(status))
            assertFalse(LobbyStatusPolicy.primaryEnabled(status = status, isSignedIn = false))
            assertEquals(listOf(row(LobbyStatusRowKind.microphone, LobbyStatusRowAction.allow)),
                LobbyStatusPolicy.rows(status = status, media = offline.premeeting.lobbyMedia,
                    supportsRationale = PermissionPrimingPolicy.platformSupportsRationale,
                    offersAppInfo = LobbyStatusPolicy.platformOffersAppInfo).toList())
        } finally {
            offline.stop()
        }
        for (state in listOf(PremeetingFixtureState.failedNetwork, PremeetingFixtureState.joinFailed, PremeetingFixtureState.failedMedia,
            PremeetingFixtureState.failedServerText)) {
            val session = PremeetingFixtureSession(state = state)
            session.start()
            try {
                val status = session.premeeting.lobbyStatus!!
                assertEquals(state.rawValue, LobbyMode.failed, status.mode)
                assertEquals(state.rawValue, "", status.primaryReason)
                assertTrue(state.rawValue, LobbyStatusPolicy.primaryEnabled(status = status, isSignedIn = false))
            } finally {
                session.stop()
            }
        }
        val failedOffline = PremeetingFixtureSession(state = PremeetingFixtureState.failedOffline)
        failedOffline.start()
        try {
            val status = failedOffline.premeeting.lobbyStatus!!
            assertEquals(LobbyMode.failed, status.mode)
            assertEquals(LobbyStatusLineKind.offline, line(status))
            assertFalse(LobbyStatusPolicy.primaryEnabled(status = status, isSignedIn = false))
        } finally {
            failedOffline.stop()
        }
        val askable = PremeetingFixtureSession(state = PremeetingFixtureState.lobbyMediaAskable)
        askable.start()
        try {
            assertEquals(listOf(row(LobbyStatusRowKind.microphone, LobbyStatusRowAction.allow)),
                LobbyStatusPolicy.rows(status = askable.premeeting.lobbyStatus, media = askable.premeeting.lobbyMedia,
                    supportsRationale = true, offersAppInfo = true).toList())
        } finally {
            askable.stop()
        }
    }
}
