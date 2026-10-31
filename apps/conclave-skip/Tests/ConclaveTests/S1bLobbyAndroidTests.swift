#if !SKIP
import Foundation
import Testing

struct S1bLobbyAndroidTests {
    static let rowsFile = "Sources/Conclave/Skip/ui/lobby/LobbyStatusRow.kt"
    static let entryFile = "Sources/Conclave/Skip/ui/lobby/EntryStatusBlock.kt"
    static let primingFile = "Sources/Conclave/Skip/ui/lobby/PermissionPrimingRow.kt"
    static let cardFile = "Sources/Conclave/Skip/ui/lobby/LobbyPreviewCard.kt"
    static let screenFile = "Sources/Conclave/Skip/ui/lobby/LobbyScreen.kt"
    static let scrimFile = "Sources/Conclave/Skip/ui/components/ConclaveFloatingActionScrim.kt"
    static let lobbyFiles = [rowsFile, entryFile, primingFile, cardFile, screenFile]

    @Test func eachStatusRowIsOneStockListItem() throws {
        let raw = try s1blaSource(Self.rowsFile)
        let rows = s1blaFlat(raw)
        #expect(rows.contains("internal fun LobbyStatusRows(premeeting: PremeetingPresenter, routeId: Int) {"))
        #expect(rows.contains("val status = premeeting.lobbyStatus?.takeIf { it.routeId == routeId } val media = premeeting.lobbyMedia?.takeIf { it.routeId == routeId }"))
        #expect(rows.contains("LobbyStatusPolicy.rows( status = status, media = media, supportsRationale = PermissionPrimingPolicy.platformSupportsRationale, offersAppInfo = LobbyStatusPolicy.platformOffersAppInfo, )"),
                "the shared policy decides which rows show, in which order")
        #expect(rows.components(separatedBy: "ListItem(").count - 1 == 1, "one stock ListItem per row")
        #expect(rows.contains("headlineContent = { Text(line, style = MaterialTheme.typography.bodyMedium,"))
        #expect(rows.contains("leadingContent = { Icon(icon, contentDescription = null) },"))
        #expect(rows.contains("colors = ListItemDefaults.colors(containerColor = scheme.surface, headlineColor = scheme.onSurfaceVariant),"))
        #expect(rows.contains("modifier = Modifier.testTag(LobbyStatusRowUi.identifier(model.kind)),"))
        #expect(!raw.contains("tint ="), "the leading icon takes the ListItem's own colour")
        #expect(!raw.contains("FlowRow") && !raw.contains("Column("), "no hand-built row layout")
    }

    @Test func theRowActionMovesIntoTheSupportingSlotAtLargeText() throws {
        let rows = s1blaFlat(try s1blaSource(Self.rowsFile))
        #expect(rows.contains("BoxWithConstraints(modifier.fillMaxWidth()) { val stacked = LocalDensity.current.fontScale > 1.3f || maxWidth < 320.dp"))
        #expect(rows.contains("supportingContent = if (action != null && stacked) { { LobbyStatusAction(action) } } else null,"))
        #expect(rows.contains("trailingContent = if (action != null && !stacked) { { LobbyStatusAction(action) } } else null,"))
        #expect(rows.components(separatedBy: "LobbyStatusAction(action)").count - 1 == 2, "one action, in one of two stock slots")
    }

    @Test func theSingleCameraRowKeepsItsDeniedContainerAsOnIOS() throws {
        let raw = try s1blaSource(Self.rowsFile)
        let rows = s1blaFlat(raw)
        #expect(rows.contains("modifier = if (model.kind == LobbyStatusRowKind.camera) { Modifier.semantics { isTraversalGroup = true }.testTag(\"lobby.camera.denied\") } else Modifier,"),
                "automation finds the single camera row by lobby.camera.denied on both platforms")
        #expect(rows.contains("onOpenSettings: () -> Unit, modifier: Modifier = Modifier, ) {"))
        #expect(raw.components(separatedBy: "lobby.camera.denied").count - 1 == 1)
        #expect(raw.contains("import androidx.compose.ui.semantics.isTraversalGroup\n"))
    }

    @Test func allowAsksForOnePermissionAndCarriesAClickLabel() throws {
        let raw = try s1blaSource(Self.rowsFile)
        let rows = s1blaFlat(raw)
        #expect(rows.contains("onAllow = { if (model.mediaKind == LobbyMediaKind.camera) premeeting.setCameraIntent(true) else premeeting.setMicIntent(true) },"))
        #expect(rows.contains("onOpenSettings = { premeeting.openSystemSettings() },"))
        #expect(rows.contains("title = conclaveString(\"pm_allow\"), identifier = \"$base.allow\", clickLabel = if (model.mediaKind == LobbyMediaKind.camera) conclaveString(\"pm_status_allow_camera_label\") else conclaveString(\"pm_status_allow_mic_label\"), onClick = onAllow,"))
        #expect(rows.contains("title = conclaveString(\"ds_open_settings\"), identifier = \"$base.openSettings\", clickLabel = null, onClick = onOpenSettings,"),
                "Open settings reads clearly after the row and needs no click label")
        let action = s1blaFlat(try s1blaBlock(raw, from: "private fun LobbyStatusAction(", to: "private class LobbyStatusActionUi("))
        #expect(action.contains("TextButton( onClick = action.onClick, modifier = Modifier.testTag(action.identifier) .then(if (label != null) Modifier.semantics { onClick(label = label) { action.onClick(); true } } else Modifier), ) { Text(action.title) }"),
                "the click label is written with its action, so the merged node still clicks")
        #expect(!action.contains("colors") && !action.contains("style ="), "stock TextButton colours and label style")
    }

    @Test func rowsAnnounceOnlyAfterTheLobbySettles() throws {
        let rows = s1blaFlat(try s1blaSource(Self.rowsFile))
        #expect(rows.contains("var settled by remember(routeId) { mutableStateOf(false) } LaunchedEffect(routeId) { settled = true }"))
        #expect(rows.contains("announces = settled,"))
        #expect(rows.contains("modifier = if (announces) Modifier.semantics { liveRegion = LiveRegionMode.Polite } else Modifier)"),
                "nothing is announced when the lobby first opens")
        #expect(rows.components(separatedBy: "liveRegion = LiveRegionMode.Polite").count - 1 == 1)
    }

    @Test func rowCopyAndIconsFollowTheStatusTable() throws {
        let rows = s1blaFlat(try s1blaSource(Self.rowsFile))
        for line in [
            "LobbyStatusRowKind.issue -> conclaveString(\"pm_status_app_suspended\")",
            "if (model.restricted) conclaveString(\"pm_status_media_restricted\") else conclaveString(\"pm_status_media_off\")",
            "if (model.restricted) conclaveString(\"pm_status_camera_restricted\") else conclaveString(\"pm_camera_denied_title\")",
            "if (model.restricted) conclaveString(\"pm_status_mic_restricted\") else conclaveString(\"pm_mic_denied_title\")",
            "LobbyStatusRowKind.issue -> ConclaveIcons.InfoFill0",
            "LobbyStatusRowKind.camera -> ConclaveIcons.VideocamOffFill1",
            "LobbyStatusRowKind.microphone, LobbyStatusRowKind.media -> ConclaveIcons.MicOffFill1",
            "LobbyStatusRowKind.issue -> \"lobby.issue\"",
            "LobbyStatusRowKind.media -> \"lobby.media.permission\"",
            "LobbyStatusRowKind.camera -> PermissionPrimingUi.rowIdentifier(LobbyMediaKind.camera)",
            "LobbyStatusRowKind.microphone -> PermissionPrimingUi.rowIdentifier(LobbyMediaKind.microphone)",
        ] {
            #expect(rows.contains(line), "LobbyStatusRow.kt lacks \(line)")
        }
    }

    @Test func theLobbyLeavesTheBannerTheRationaleAndRedBehind() throws {
        for file in Self.lobbyFiles {
            let text = try s1blaSource(file)
            for banned in ["ConclaveBanner(", "ConclaveBannerKind", "pm_mic_rationale", "pm_camera_rationale", "ds_not_now", "notNow",
                           "scheme.error", "ErrorFill1", "\"pm_offline\"", "\"pm_offline_waiting\"", "microphoneDismissed",
                           "cameraDismissed", "LobbyIssueBanner", "PermissionPrimingRows(", "pm_announce_couldnt_join",
                           "statusWarning", "AccountCircleFill0"] {
                #expect(!text.contains(banned), "\(file) still uses \(banned)")
            }
        }
        let screen = s1blaFlat(try s1blaSource(Self.screenFile))
        #expect(screen.components(separatedBy: "LobbyStatusRows(premeeting, routeId)").count - 1 == 1)
        #expect(screen.contains("val isPromotion = premeeting.lobbyStatus?.takeIf { it.routeId == routeId }?.intent == LobbyIntent.promotion LobbyStatusRows(premeeting, routeId) LobbyAudioItem(premeeting)"),
                "the status rows lead the controls, directly above Audio")
        #expect(screen.contains("PermissionPrimingResumeEffect(premeeting, routeId)"))
        let priming = s1blaFlat(try s1blaSource(Self.primingFile))
        #expect(priming.contains("internal fun PermissionPrimingResumeEffect(premeeting: PremeetingPresenter, routeId: Int) {"))
        #expect(priming.contains("internal fun permissionReasonText(kind: LobbyMediaKind, reason: PermissionPrimingKind): String {"))
        #expect(priming.contains("internal object PermissionPrimingUi {"))
        #expect(!priming.contains("fun PermissionPrimingRow(") && !priming.contains("TextButton"), "the row views moved to LobbyStatusRow.kt")
    }

    @Test func theFloatingActionHasNoCardAndOneButton() throws {
        let screenRaw = try s1blaSource(Self.screenFile)
        #expect(s1blaMatches(#"(?<![A-Za-z])Surface\("#, in: screenRaw).isEmpty, "no card behind the floating action")
        #expect(!screenRaw.contains("shadowElevation") && !screenRaw.contains("RoundedCornerShape"))
        let floating = s1blaFlat(try s1blaBlock(screenRaw, from: "private fun LobbyFloatingAction(", to: "\n}\n"))
        #expect(floating.contains(".onSizeChanged { onHeightChanged(it.height) }, ) { EntryStatusBlock(premeeting, status) }"),
                "the same block renders for every mode")
        #expect(!floating.contains("status.mode"))

        let entryRaw = try s1blaSource(Self.entryFile)
        let entry = s1blaFlat(entryRaw)
        #expect(entry.contains("internal fun EntryStatusBlock(premeeting: PremeetingPresenter, status: LobbyStatusUi) {"))
        #expect(entry.components(separatedBy: "EntryPrimaryButton(").count - 1 == 2, "the declaration and one call site")
        let content = s1blaFlat(try s1blaBlock(entryRaw, from: "private fun EntryStatusContent(", to: "private fun EntryStatusLine("))
        #expect(content.components(separatedBy: "EntryPrimaryButton(").count - 1 == 1, "one main action call site for every mode")
        for line in [
            "val failed = status.mode == LobbyMode.failed",
            "val pendingKind = if (snapshot != null) LobbyStatusPolicy.pendingKind(status = snapshot) else LobbyPendingKind.none",
            "val enabled = if (snapshot != null) LobbyStatusPolicy.primaryEnabled(status = snapshot, isSignedIn = isSignedIn) else false",
            "val pending = status.mode == LobbyMode.connecting || status.mode == LobbyMode.waiting || status.isPrimaryPending",
            "val title = if (failed) conclaveString(\"ds_try_again\") else when (pendingKind) {",
            "LobbyPendingKind.joining -> conclaveString(\"pm_joining\")",
            "LobbyPendingKind.starting -> conclaveString(\"pm_starting\")",
            "LobbyPendingKind.reconnecting -> conclaveString(\"pm_reconnecting\")",
            "LobbyPendingKind.asking -> conclaveString(\"pm_asking_to_join\")",
            "else -> lobbyPrimaryTitle(status.intent)",
            "identifier = if (failed) \"lobby.retry\" else \"lobby.primary\", modifier = Modifier.focusRequester(retryFocus), ) { if (failed) premeeting.retryJoin() else premeeting.startOrJoin() }",
            "LaunchedEffect(status.routeId, failed) { if (failed) runCatching { retryFocus.requestFocus() } }",
        ] {
            #expect(content.contains(line), "EntryStatusContent lacks \(line)")
        }
        for gone in ["background(", "Surface(", "FilledTonalButton", "lobby.waiting.cancel", "EntryFloatingNote", "EntryWaitingBlock",
                     "EntryFailedBlock", "fun entryWaitingBody(", "fun entryFailureBody(", "fun lobbyPrimaryReasonText(", "heading()",
                     "pm_wait_", "pm_still_connecting", "pm_fail_network\")"] {
            #expect(!entryRaw.contains(gone), "EntryStatusBlock.kt still has \(gone)")
        }
        #expect(!entry.contains("background(scheme.surface, MaterialTheme.shapes.medium)"), "no surface pill under the action")
        #expect(entry.contains("internal fun entryFailureBodyName(issue: LobbyIssue): String = when (issue) {"), "the outcome screen still reads it")
        #expect(entry.contains("internal fun StopAskingDialog(premeeting: PremeetingPresenter) {"))
        #expect(entry.contains("BackHandler(enabled = busy) { onBack() }"))
        #expect(entry.contains("LaunchedEffect(status.routeId, status.mode) { val prior = previous previous = status.mode"))
        #expect(entry.contains("} else if (status.mode == LobbyMode.failed && prior != LobbyMode.failed) { announcement = failureLine }"),
                "entering failed speaks the visible line once")
        #expect(entry.contains("conclaveStringOf(context, \"pm_announce_joining\", label)") && entry.contains("conclaveStringOf(context, \"pm_admitted\")"))
    }

    @Test func theLineIsAnIconAndTextOnTheBand() throws {
        let entryRaw = try s1blaSource(Self.entryFile)
        let entry = s1blaFlat(entryRaw)
        #expect(entry.contains("val snapshot = premeeting.lobbyStatus?.takeIf { it.routeId == status.routeId }"))
        #expect(entry.contains("val isSignedIn = premeeting.lobbyIdentity?.takeIf { it.routeId == status.routeId }?.isSignedIn ?: false"))
        #expect(entry.contains("LobbyStatusPolicy.line(status = snapshot, isSignedIn = isSignedIn)"))
        let line = s1blaFlat(try s1blaBlock(entryRaw, from: "private fun EntryStatusLine(", to: "internal fun EntryPrimaryButton("))
        #expect(line.contains("CompositionLocalProvider(LocalContentColor provides scheme.onSurfaceVariant) { Row( verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.testTag(identifier), ) { if (icon != null) { Icon(icon, contentDescription = null, modifier = Modifier.size(16.dp)) } Text( text, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center,"))
        #expect(line.contains("val limited = LocalDensity.current.fontScale <= 1.3f"))
        #expect(line.contains("maxLines = if (limited) LobbyStatusPolicy.lineMaxLines else Int.MAX_VALUE, overflow = if (limited) TextOverflow.Ellipsis else TextOverflow.Clip,"),
                "two lines with an ellipsis at default text, no limit at large text")
        #expect(line.contains("modifier = if (announces) Modifier.semantics { liveRegion = LiveRegionMode.Polite } else Modifier,"))
        for banned in ["tint", "color =", "background", "Surface(", "shape", "padding"] {
            #expect(!line.contains(banned), "the line draws no ground of its own: \(banned)")
        }
        let content = s1blaFlat(try s1blaBlock(entryRaw, from: "private fun EntryStatusContent(", to: "private fun EntryStatusLine("))
        #expect(content.contains("var settled by remember(status.routeId) { mutableStateOf(false) } LaunchedEffect(status.routeId) { settled = true }"))
        #expect(content.contains("var failedEntryLine by remember(status.routeId, failed) { mutableStateOf(if (failed) lineText else null) } LaunchedEffect(lineText) { if (lineText != failedEntryLine) failedEntryLine = null }"),
                "the line shown on entering failed is remembered until it changes")
        #expect(content.contains("identifier = entryStatusLineIdentifier(lineKind, status.mode), announces = settled && lineText != failedEntryLine && entryStatusLineAnnounces(lineKind, status.mode),"),
                "only the line the announcer spoke on entering failed has no live region; later failed-mode changes are announced")
        #expect(entry.contains("private fun entryStatusLineIdentifier(kind: LobbyStatusLineKind, mode: LobbyMode): String = if (mode == LobbyMode.editing && kind == LobbyStatusLineKind.failedServerText) \"lobby.primary.reason\" else LobbyStatusPolicy.lineIdentifier(kind)"),
                "the editing server text is found as lobby.primary.reason, the failed one as lobby.status")
        #expect(entry.contains("private fun entryStatusLineAnnounces(kind: LobbyStatusLineKind, mode: LobbyMode): Boolean = LobbyStatusPolicy.announcesLine(kind) && (kind != LobbyStatusLineKind.failedServerText || mode == LobbyMode.editing)"),
                "server text is announced in editing only, like every other failure line")
        #expect(!content.contains("!failed"), "failed mode does not silence every line")
        let settledAt = try #require(content.range(of: "var settled by remember(status.routeId)"))
        let lineAt = try #require(content.range(of: "if (lineKind != LobbyStatusLineKind.none"))
        #expect(settledAt.lowerBound < lineAt.lowerBound, "the settled flag outlives the line, so a line that appears later is announced")

        for mapping in [
            "LobbyStatusLineKind.offline -> conclaveString(\"ds_offline_title\")",
            "LobbyStatusLineKind.updateRequired -> conclaveString(\"pm_status_update_required\")",
            "LobbyStatusLineKind.signInRequired -> conclaveString(\"pm_status_sign_in_required\")",
            "LobbyStatusLineKind.roomNotFound -> conclaveString(\"pm_status_room_not_found\")",
            "LobbyStatusLineKind.stillConnecting -> conclaveString(\"pm_status_still_connecting\")",
            "LobbyStatusLineKind.failedNetwork -> conclaveString(\"pm_status_fail_network\")",
            "LobbyStatusLineKind.failedMedia -> conclaveString(\"pm_status_fail_media\")",
            "LobbyStatusLineKind.failedServerBusy -> conclaveString(\"pm_status_fail_server_busy\")",
            "LobbyStatusLineKind.failedServerText -> LobbyStatusPolicy.serverLine(status.issueServerText)",
            "if (status.intent == LobbyIntent.newMeeting) conclaveString(\"pm_couldnt_start\") else conclaveString(\"pm_couldnt_join\")",
            "LobbyStatusLineKind.waitingStandard -> conclaveString(\"pm_status_wait_standard\")",
            "LobbyStatusLineKind.waitingLocked -> conclaveString(\"pm_status_wait_locked\")",
            "LobbyStatusLineKind.waitingNoHost -> conclaveString(\"pm_status_wait_no_host\")",
            "LobbyStatusLineKind.waitingHostAvailable -> conclaveString(\"pm_status_wait_host_available\")",
            "LobbyStatusLineKind.waitingReconnecting -> conclaveString(\"pm_status_wait_reconnecting\")",
            "LobbyStatusLineKind.waitingOffline -> conclaveString(\"pm_status_wait_offline\")",
            "if (status.waitingText.isNotEmpty()) LobbyStatusPolicy.serverLine(status.waitingText) else conclaveString(\"pm_status_wait_server_restart\")",
            "if (status.reason == LobbyPrimaryReason.nameMissingStart) conclaveString(\"pm_need_name_start\") else conclaveString(\"pm_need_name_join\")",
            "LobbyStatusLineKind.offline, LobbyStatusLineKind.waitingOffline -> ConclaveIcons.WifiOffFill0",
            "LobbyStatusLineKind.stillConnecting, LobbyStatusLineKind.failedNetwork -> ConclaveIcons.SignalWifiBadFill0",
            "LobbyStatusLineKind.updateRequired, LobbyStatusLineKind.roomNotFound, LobbyStatusLineKind.failedMedia, LobbyStatusLineKind.failedServerBusy, LobbyStatusLineKind.failedServerText, LobbyStatusLineKind.failedUnknown -> ConclaveIcons.InfoFill0",
            "else -> null",
        ] {
            #expect(entry.contains(mapping), "EntryStatusBlock.kt lacks \(mapping)")
        }
    }

    @Test func theLobbyBandIsOpaqueAndOtherScrimsKeepTheVeil() throws {
        let scrimRaw = try s1blaSource(Self.scrimFile)
        let scrim = s1blaFlat(scrimRaw)
        #expect(scrim.contains("internal fun ConclaveFloatingActionScrim(modifier: Modifier = Modifier, bottomPadding: Dp = 0.dp, opaque: Boolean = false) {"))
        #expect(scrim.contains("val ground = if (opaque) veil.copy(alpha = alpha).compositeOver(MaterialTheme.colorScheme.surface) else veil.copy(alpha = alpha)"))
        #expect(scrim.contains("val clear = ground.copy(alpha = 0f) val solid = ground"), "the same ramp, on an opaque ground when asked")
        let composites = s1blaMatches(#"[^\n]*compositeOver\([^\n]*"#, in: scrimRaw)
        #expect(composites.count == 1)
        #expect(composites.allSatisfy { $0.contains("if (opaque) veil.copy(alpha = alpha).compositeOver(") }, "compositeOver only under opaque")

        let screen = s1blaFlat(try s1blaSource(Self.screenFile))
        #expect(screen.contains("} } ConclaveFloatingActionScrim( modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(actionClearance), bottomPadding = padding.calculateBottomPadding(), opaque = true, ) } } }"),
                "the lobby band shows in every mode")
        #expect(!screen.contains("mode == LobbyMode.editing"))
        for file in ["Sources/Conclave/Skip/ui/transcript/TranscriptPage.kt", "Sources/Conclave/Skip/ui/activities/ActivitiesPage.kt"] {
            let text = try s1blaSource(file)
            #expect(text.contains("ConclaveFloatingActionScrim("), "\(file)")
            #expect(!text.contains("opaque"), "\(file) keeps the translucent veil by the default")
        }
    }

    @Test func theTileSaysCameraUnavailableAndTheCaptionIsGone() throws {
        let cardRaw = try s1blaSource(Self.cardFile)
        #expect(!cardRaw.contains("LobbyPreviewCaption") && !cardRaw.contains("lobby.preview.caption"))
        #expect(!(try s1blaSource(Self.screenFile)).contains("LobbyPreviewCaption"))
        let cameraOffRaw = try s1blaBlock(cardRaw, from: "private fun LobbyCameraOffContent(", to: "private fun LobbyToggles(")
        let cameraOff = s1blaFlat(cameraOffRaw)
        #expect(cameraOff.contains("if (card.preview == PreviewState.starting) { CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp, color = scheme.onSurface) } else if (card.cameraIsUnavailable) { Text(conclaveString(\"pm_camera_unavailable\"), style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis) }"))
        #expect(cameraOffRaw.components(separatedBy: "Text(").count - 1 == 1, "the only text in the tile content is its label")
        #expect(cameraOffRaw.components(separatedBy: ".clearAndSetSemantics { }").count - 1 == 2, "the preview's state description stays the one TalkBack reads")
        let card = s1blaFlat(cardRaw)
        #expect(card.contains("card.cameraIsUnavailable -> conclaveString(\"pm_camera_unavailable\") else -> conclaveString(\"pm_camera_off\")"))
        #expect(card.contains("stateDescription = previewValue"))
    }

    @Test func theInviteNoteAndTitleUseLessCopy() throws {
        let screen = s1blaFlat(try s1blaSource(Self.screenFile))
        #expect(screen.contains("error = if (identity.inviteCodeInvalid) conclaveString(\"pm_invite_code_wrong\") else null,"))
        #expect(!screen.contains("pm_invite_invalid"), "the webinar landing keeps the long sentence")
        #expect(!screen.contains("pm_subtitle_joining") && !screen.contains("pm_subtitle_reconnecting"))
        #expect(screen.contains("val subtitle = when (status?.mode) { LobbyMode.connecting, LobbyMode.waiting, LobbyMode.failed -> \"\""),
                "the pending button already says Joining or Reconnecting")
    }

    @Test func lobbyStatusFilesStayFlatQuietAndResolve() throws {
        let resources = try s1blaSource("Android/app/src/main/res/values/strings.xml")
        for file in Self.lobbyFiles + [Self.scrimFile] {
            let text = try s1blaSource(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.contains("//") && !text.contains("/*"), "\(file) has a prose comment")
            #expect(s1blaMatches(#"Text\(\s*""#, in: text).isEmpty, "\(file) has a literal Text")
            #expect(s1blaMatches(#"Color\(\s*0x"#, in: text).isEmpty, "\(file) builds a colour from a literal")
            #expect(!text.contains("@Stable") && !text.contains("@Immutable") && !text.contains("MeetingState"), "\(file)")
            #expect(!text.contains("animate") && !text.contains("Animated") && !text.contains("infiniteRepeatable"), "\(file): status changes are instant")
            if file != Self.scrimFile {
                #expect(!text.lowercased().contains("gradi" + "ent") && !text.contains("Brush"), "\(file) draws no ramp")
            }
            for match in s1blaMatches(#"conclaveString\("[a-z0-9_]+""#, in: text) {
                let name = String(match.dropFirst("conclaveString(\"".count).dropLast())
                #expect(resources.contains("<string name=\"\(name)\""), "\(file): missing Android resource \(name)")
            }
        }
        for (name, value) in [("pm_status_allow_mic_label", "Allow the microphone so people can hear you"),
                              ("pm_status_allow_camera_label", "Allow the camera so people can see you")] {
            #expect(resources.contains("<string name=\"\(name)\">\(value)</string>"), "\(name)")
        }
        for gone in ["pm_mic_rationale", "pm_camera_rationale", "pm_subtitle_joining", "pm_subtitle_reconnecting", "pm_announce_couldnt_join"] {
            #expect(!resources.contains("<string name=\"\(gone)\""), "\(gone) is still in strings.xml")
        }
    }
}

private func s1blaPackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func s1blaSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: s1blaPackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func s1blaFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private struct S1bLobbyBlockMissing: Error {}

private func s1blaBlock(_ text: String, from start: String, to end: String) throws -> String {
    guard let lower = text.range(of: start), let upper = text.range(of: end, range: lower.upperBound..<text.endIndex) else {
        throw S1bLobbyBlockMissing()
    }
    return String(text[lower.lowerBound..<upper.lowerBound])
}

private func s1blaMatches(_ pattern: String, in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        Range(match.range, in: text).map { String(text[$0]) }
    }
}
#endif
