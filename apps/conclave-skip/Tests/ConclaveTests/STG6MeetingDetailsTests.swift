#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct STG6MeetingDetailsTests {
    static let longSleep: (Double) async -> Void = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }

    private func presenter() -> StagePresenter {
        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.sleep = STG6MeetingDetailsTests.longSleep
        stage.captions.sleep = STG6MeetingDetailsTests.longSleep
        stage.shell.panels.onSnapshotChanged = { [weak stage] in stage?.panelSnapshotChanged() }
        stage.setViewport(StagePoliciesTests.iphoneSE)
        return stage
    }

    private func hostInputs(isRecovering: Bool = false, extraGuest: Bool = false, session: Int = 1) -> StageInputs {
        var rows = StageFixtureScript.hostRoster(count: 4)
        if extraGuest {
            rows.append(StageParticipantInput.make(userId: "g9", displayName: "Gus", isCameraOff: true, joinSerial: 9))
        }
        let base = StageFixtureScript.copy(StageFixtureScript.base(count: 4), participants: rows, isRecovering: isRecovering)
        return StageInputs.make(callSession: session, isInCall: base.isInCall, localUserId: base.localUserId,
                                roomLabel: base.roomLabel, meetingLink: base.meetingLink, participants: base.participants,
                                isAloneConfirmed: base.isAloneConfirmed, isRecovering: base.isRecovering,
                                joinedAtMillis: base.joinedAtMillis)
    }

    private func details(_ quality: ConnectionQuality, hasSample: Bool = true, failed: Bool = false, session: Int = 1,
                         webinarLink: String = "") -> StageDetailsInputs {
        StageDetailsInputs.make(callSession: session, roomCode: StageFixtureScript.roomLabel, isWebinarEnabled: true,
                                webinarLinkURL: webinarLink, connectionQuality: quality, connectionHasSample: hasSample,
                                connectionStatsFailed: failed)
    }

    @Test func connectionLabelPolicyVectors() {
        #expect(ConnectionQualityLabelPolicy.label(.emergency, hasSample: true, statsFailed: false) == .veryPoor)
        #expect(ConnectionQualityLabelPolicy.label(.good, hasSample: true, statsFailed: false) == .good)
        #expect(ConnectionQualityLabelPolicy.label(.fair, hasSample: true, statsFailed: false) == .fair)
        #expect(ConnectionQualityLabelPolicy.label(.poor, hasSample: true, statsFailed: false) == .poor)

        #expect(ConnectionQualityLabelPolicy.label(.unknown, hasSample: false, statsFailed: false) == .measuring)
        #expect(ConnectionQualityLabelPolicy.label(.unknown, hasSample: true, statsFailed: true) == .unavailable)
        #expect(ConnectionQualityLabelPolicy.label(.unknown, hasSample: false, statsFailed: true) == .measuring)
        #expect(!ConnectionQualityLabelPolicy.statsFailed(hasSample: true, consecutiveUnknownSamples: 2))
        #expect(ConnectionQualityLabelPolicy.statsFailed(hasSample: true, consecutiveUnknownSamples: 3))
        #expect(!ConnectionQualityLabelPolicy.statsFailed(hasSample: false, consecutiveUnknownSamples: 10))

        #expect(ConnectionQualityLabelPolicy.stable(previous: .fair, next: .measuring, isRecovering: true) == .fair)
        #expect(ConnectionQualityLabelPolicy.stable(previous: .fair, next: .measuring, isRecovering: false) == .measuring)
        #expect(ConnectionQualityLabelPolicy.stable(previous: .measuring, next: .measuring, isRecovering: true) == .measuring)
        #expect(ConnectionQualityLabelPolicy.stable(previous: .good, next: .unavailable, isRecovering: true) == .unavailable)

        var keys = Set<String>()
        var names = Set<String>()
        for label in ConnectionQualityLabel.allCases {
            keys.insert(ConnectionQualityLabelPolicy.catalogKey(label))
            names.insert(ConnectionQualityLabelPolicy.androidResourceName(label))
        }
        #expect(keys == ["Measuring…", "Good", "Fair", "Poor", "Very Poor", "Unavailable"])
        #expect(names.count == 6 && names.allSatisfy { $0.hasPrefix("set_quality_") })
    }

    @Test func hostFixtureShowsTheWireframeRowsInOrder() throws {
        let session = StageFixtureSession(state: .meetingInfoHost)
        let info = try #require(session.stage.meetingInfo)
        #expect(MeetingInfoPolicy.rowIds(info) == ["roomCode", "copyCode", "meetingLink", "shareInvite", "copyLink", "meetingLocked",
                                                  "liveNotes", "captions", "inviteCodeRequired", "shareWebinarLink",
                                                  "copyWebinarLink", "hosts", "started", "connection", "hostControls"])
        #expect(MeetingInfoPolicy.sections(info) == [.room, .status, .webinar, .details, .host])
        #expect(info.roomCode == StageFixtureScript.roomLabel && info.link == StageFixtureScript.meetingLink)
        #expect(info.isLocked && info.liveNotes == .live && info.captionsOn && info.requiresInviteCode)
        #expect(info.hostNames == ["Avery", "You"])
        #expect(info.connection == .good && info.isHost && !info.isAttendee && info.webinarLink.isEmpty)
        #expect(MeetingInfoPolicy.isHostControlsEnabled(info))
        #expect(session.panelReadout() == "panel=meetingInfo invoker=call destination=none")
        #expect(session.meetingInfoReadout().hasPrefix("rows=roomCode,copyCode,meetingLink"))
    }

    @Test func guestFixtureHasNoHostRowsAndMeasuresTheConnection() throws {
        let info = try #require(StageFixtureSession(state: .meetingInfoGuest).stage.meetingInfo)
        #expect(MeetingInfoPolicy.rowIds(info) == ["roomCode", "copyCode", "meetingLink", "shareInvite", "copyLink", "meetingLocked",
                                                  "liveNotes", "hosts", "started", "connection"])
        #expect(info.connection == .measuring && !info.isHost && info.hostNames == ["Avery"])
        #expect(MeetingInfoPolicy.liveNotesCatalogKey(info.liveNotes) == "Off")
    }

    @Test func openingThePanelGeneratesNoWebinarLinkAndShareGeneratesExactlyOne() async throws {
        let session = StageFixtureSession(state: .meetingInfoHost)
        #expect(session.counters.generateWebinarLink == 0, "opening Meeting Details never generates a webinar link (R34)")
        let first = await session.ensureWebinarLink()
        #expect(first == StageFixtureScript.webinarLink)
        #expect(session.counters.generateWebinarLink == 1)
        #expect(session.stage.meetingInfo?.webinarLink == StageFixtureScript.webinarLink)
        let second = await session.ensureWebinarLink()
        #expect(second == StageFixtureScript.webinarLink && session.counters.generateWebinarLink == 1)

        let presenter = try stageSource("Sources/Conclave/Features/Meeting/Stage/StagePresenter.swift")
        #expect(!presenter.contains("func ensureWebinarLink") && !presenter.contains("copyableWebinarLink"))
        let ios = try stageSource("Sources/Conclave/Features/Meeting/Stage/MeetingDetailsPanel+iOS.swift")
        let android = try stageSource("Sources/Conclave/Skip/ui/call/stage/MeetingDetailsPage.kt")
        for source in [ios, android] {
            #expect(!source.contains("generateWebinarLink") && !source.contains("copyableWebinarLink"))
        }
        let iosRoot = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/CallRoot+iOS.swift"))
        #expect(iosRoot.contains("return { await people.host.ensureWebinarLink() }"))
        let androidRoot = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/CallRoot.kt"))
        #expect(androidRoot.contains("return suspend { owner.host.ensureWebinarLink() }"))
    }

    @Test func aScriptedLockWhileOpenUpdatesMeetingLockedAndRosterChurnChangesNothing() throws {
        let session = StageFixtureSession(state: .meetingInfoGuest)
        let before = try #require(session.stage.meetingInfo)
        #expect(!before.isLocked)
        session.toggleRoomLock()
        let after = try #require(session.stage.meetingInfo)
        #expect(after.isLocked)

        let stage = presenter()
        stage.apply(hostInputs())
        stage.applyDetails(details(.good))
        stage.openMeetingInfo()
        let opened = try #require(stage.meetingInfo)
        stage.apply(hostInputs(extraGuest: true))
        #expect(stage.meetingInfo == opened)
    }

    @Test func recoveringKeepsCopyAndShareButDisablesHostControls() throws {
        let info = try #require(StageFixtureSession(state: .meetingInfoRecovering).stage.meetingInfo)
        #expect(info.isRecovering && info.rowsContain("hostControls"))
        #expect(!MeetingInfoPolicy.isHostControlsEnabled(info))

        #expect(MeetingInfoPolicy.isWebinarLinkActionEnabled(info))
        let missing = MeetingInfoPolicy.snapshot(inputs: StageFixtureScript.inputs(for: .meetingInfoRecovering),
                                                 details: StageDetailsInputs.make(callSession: 1, isWebinarEnabled: true),
                                                 connection: .good)
        #expect(missing.isHost && !MeetingInfoPolicy.isWebinarLinkActionEnabled(missing))
        #expect(info.connection == .fair)
    }

    @Test func customTenantSharesALinkCarryingTheClientId() throws {
        let info = try #require(StageFixtureSession(state: .meetingInfoTenant).stage.meetingInfo)
        #expect(info.link == "https://conclave.acmvit.in/abc-defg-hij?clientId=acme-events")
        #expect(MeetingLinkBuilder.displayText(info.link) == "conclave.acmvit.in/abc-defg-hij?clientId=acme-events")
    }

    @Test func attendeeVariantIsWebinarDetailsWithOneSettingsRow() throws {
        let session = StageFixtureSession(state: .meetingInfoAttendee)
        let info = try #require(session.stage.meetingInfo)
        #expect(info.isAttendee)
        #expect(MeetingInfoPolicy.rowIds(info) == ["webinarTitle", "hosts", "shareWebinarLink", "settings"])
        #expect(!MeetingInfoPolicy.rowIds(info).contains("roomCode") && !MeetingInfoPolicy.rowIds(info).contains("connection"))
        #expect(info.webinarTitle == StageFixtureScript.webinarTitle)

        let privateWebinar = MeetingInfoSnapshot(roomCode: "", link: "", roomLabel: "", isLocked: false, liveNotes: .off,
                                                 captionsOn: false, hostNames: [], joinedAtMillis: 0, connection: .good,
                                                 isHost: false, requiresInviteCode: false, isWebinarEnabled: true,
                                                 webinarLink: StageFixtureScript.webinarLink, isWebinarPublic: false,
                                                 isAttendee: true, webinarTitle: "", isRecovering: false)
        #expect(MeetingInfoPolicy.rowIds(privateWebinar) == ["webinarTitle", "settings"])
    }

    @Test func moreBuildsTheSnapshotAndClosingClearsIt() {
        let stage = presenter()
        stage.apply(hostInputs())
        stage.applyDetails(details(.good))
        #expect(stage.meetingInfo == nil, "nothing is built while the panel is closed")
        stage.shell.panels.present(MeetingPanel.meetingInfo, from: PanelInvoker.more)
        #expect(stage.meetingInfo?.connection == .good)
        let presentation = stage.shell.panels.snapshot.current?.presentationID ?? 0
        stage.shell.panels.dismiss(cancelPending: true)
        stage.shell.panels.didDismiss(session: stage.shell.panels.snapshot.session, presentationID: presentation)
        #expect(stage.meetingInfo == nil)

        stage.apply(StageFixtureScript.copy(hostInputs(), isRoomLocked: true))
        #expect(stage.meetingInfo == nil)
    }

    @Test func theConnectionValueStaysStableAcrossARecoveryRejoin() {
        let stage = presenter()
        stage.apply(hostInputs())
        stage.applyDetails(details(.good))
        stage.openMeetingInfo()
        #expect(stage.meetingInfo?.connection == .good)

        stage.apply(hostInputs(isRecovering: true))
        stage.applyDetails(details(.unknown))
        #expect(stage.meetingInfo?.connection == .good)
        stage.applyDetails(details(.fair))
        #expect(stage.meetingInfo?.connection == .fair)

        stage.applyDetails(details(.unknown, failed: true))
        #expect(stage.meetingInfo?.connection == .unavailable)

        stage.apply(hostInputs(session: 2))
        stage.applyDetails(details(.unknown, hasSample: false, session: 2))
        #expect(stage.connectionLabel == .measuring)
    }

    @Test func copySnackbarAndValueCopy() {
        #expect(MeetingInfoPolicy.showsCopySnackbar(sdkInt: 28) && MeetingInfoPolicy.showsCopySnackbar(sdkInt: 32))
        #expect(!MeetingInfoPolicy.showsCopySnackbar(sdkInt: 33) && !MeetingInfoPolicy.showsCopySnackbar(sdkInt: 35))
        #expect(MeetingInfoPolicy.copiedMillis == 2000)
        let keys = LiveNotesState.allCases.map { MeetingInfoPolicy.liveNotesCatalogKey($0) }
        #expect(keys == ["Off", "Starting", "On", "Paused", "Needs Attention"])
        let names = LiveNotesState.allCases.map { MeetingInfoPolicy.liveNotesAndroidName($0) }
        #expect(names == ["stg_off", "stg_state_starting", "stg_on", "stg_state_paused", "stg_state_needs_attention"])
    }

    @Test func iosMeetingDetailsCopiesInlineAndPushesInsideThePanel() throws {
        let ios = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/MeetingDetailsPanel+iOS.swift"))
        #expect(ios.contains("PanelShell(title: isAttendee ? ConclaveStrings.text(\"Webinar Details\") : ConclaveStrings.text(\"Meeting Details\")"))
        #expect(ios.contains("path: $path"))
        #expect(ios.contains(".navigationDestination(for: MeetingInfoRoute.self)"))
        #expect(ios.contains("if next > previous { adapter.promoteToLarge() }"), "a push promotes a medium sheet to large (R34)")
        #expect(ios.contains(".conclaveGestureFeedback(.linkCopied, trigger: copies)"))
        #expect(ios.contains("UIPasteboard.general.url = url") && ios.contains("UIPasteboard.general.string = value"))
        #expect(ios.contains("try? await Task.sleep(for: .milliseconds(Int(MeetingInfoPolicy.copiedMillis)))"))
        #expect(ios.contains("ShareLink(item: url, subject: Text(ConclaveStrings.text(\"Join My Conclave Meeting\"))"))
        #expect(ios.contains("NavigationLink(value: MeetingInfoRoute.host(PeopleRoute.hostControls))"))

        #expect(ios.contains("HostPageView(people: people, page: route, link: { MeetingInfoRoute.host($0) })"))
        #expect(ios.contains("Text(ConclaveStrings.text(\"Unavailable while reconnecting\"))"))
        #expect(ios.contains(".listStyle(.insetGrouped)"))

        #expect(!ios.contains("postLocal") && !ios.contains("HapticManager") && !ios.contains("MeetingShare."))
    }

    @Test func androidMeetingDetailsUsesThePageStackAndTheOldApiSnackbar() throws {
        let android = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/MeetingDetailsPage.kt"))
        #expect(android.contains("val pages = LocalPanelPageStack.current"))
        #expect(android.contains("contentMode = InCallPageContent.lazyList"))
        #expect(android.contains("isNested = pages?.isNested == true"))
        #expect(android.contains("onBack = { pages?.pop() }"))
        #expect(android.contains("items(entries, key = { it.key }, contentType = { it.kind })"))
        #expect(android.contains("if (MeetingInfoPolicy.showsCopySnackbar(sdkInt = Build.VERSION.SDK_INT))"))
        #expect(android.contains("haptics.gesture(FeedbackKind.linkCopied)"))
        #expect(android.contains("putExtra(Intent.EXTRA_TITLE, title)") && android.contains("Intent.createChooser(intent, null)"))
        #expect(android.contains("PipManager.suppressNextAutoEnter(\"meeting_share\")"))
        #expect(android.contains("conclaveString(\"ds_unavailable_reconnecting\")"))

        #expect(android.contains("HostPageContent(people, route, reservation, snackbar, onPush)"))
        #expect(android.contains("if (!keepsHostPages && meetingDetailsIsHostPage(pages?.top)) pages?.popToRoot()"))
        #expect(!android.contains("MeetingShare.") && !android.contains("Text(\""))
    }

    @Test func callRootsMountMeetingDetailsAndTheAttendeeLayer() throws {
        let ios = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/CallRoot+iOS.swift"))
        #expect(ios.contains("if presentation.request.panel == .meetingInfo, let stage { "))
        #expect(ios.contains("MeetingDetailsPanel(stage: stage, shell: shell, people: people, adapter: adapter"))
        #expect(ios.contains("AttendeeWaitingLayer(stage: stage) .accessibilitySortPriority(3)"))
        let android = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/CallRoot.kt"))
        #expect(android.contains("if (request.panel == MeetingPanel.meetingInfo) {"))
        #expect(android.contains("MeetingDetailsPage( stage = stage,"))
        #expect(android.contains("AttendeeWaitingLayer(stage, Modifier.attendeeLayer())"))
    }
}

private extension MeetingInfoSnapshot {
    func rowsContain(_ id: String) -> Bool {
        MeetingInfoPolicy.rowIds(self).contains(id)
    }
}
#endif
