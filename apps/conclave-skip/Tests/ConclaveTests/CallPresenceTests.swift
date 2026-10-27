#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// SYS-1 (S70 0.5, 0.6 SX1 to SX3 and SX11, 0.7 SY1, SY2, SY4, 1 l): the CallPresence snapshot, its command table,
/// the adapter fan-out and the pure system policies. The iOS adapter and the Kotlin service are not compiled by this
/// host, so their rules are pinned by source scans; the transpiled policies also run in `T/Skip/SystemBridgeTests.kt`.
@MainActor
struct CallPresenceTests {
    // MARK: Helpers

    private final class Recorder {
        var changes: [(CallPresenceSnapshot, CallPresenceSnapshot)] = []
        var commands: [SystemCallCommand] = []
    }

    private func makePresence(_ recorder: Recorder) -> CallPresence {
        let presence = CallPresence()
        presence.adapters = CallPresenceAdapters([
            CallPresenceAdapter(name: "recording") { old, new in recorder.changes.append((old, new)) }
        ])
        presence.onCommand = { command in recorder.commands.append(command) }
        return presence
    }

    private func inputs(
        _ phase: MeetingPhaseKind,
        callSession: Int = 1,
        outcome: MeetingTerminalOutcomeKind? = nil,
        isMuted: Bool = false,
        isCameraOff: Bool = true,
        isAttendee: Bool = false,
        joinedAtMillis: Double = 0,
        isMicrophonePending: Bool = false,
        isRedirectContinuation: Bool = false,
        roomLabel: String = "lily-zoro-iris"
    ) -> CallPresenceInputs {
        CallPresenceInputs.make(
            callSession: callSession,
            sessionPhase: phase,
            outcome: outcome,
            roomLabel: roomLabel,
            isWebinarAttendee: isAttendee,
            isMuted: isMuted,
            isCameraOff: isCameraOff,
            joinedAtMillis: joinedAtMillis,
            isMicrophonePending: isMicrophonePending,
            isRedirectContinuation: isRedirectContinuation
        )
    }

    // MARK: Phase and end-reason tables (SY1)

    @Test func phaseTableMapsEverySessionPhase() {
        let expected: [MeetingPhaseKind: CallPresencePhase] = [
            .home: .idle, .outcome: .idle, .entering: .connecting, .waiting: .waiting,
            .inCall: .live, .recovering: .recovering, .leaving: .ending,
        ]
        for phase in MeetingPhaseKind.allCases {
            #expect(CallPresencePhasePolicy.phase(sessionPhase: phase, interruption: .none) == expected[phase], "\(phase)")
        }
        #expect(CallPresencePhasePolicy.phase(sessionPhase: .inCall, interruption: .held) == .onHold)
        #expect(CallPresencePhasePolicy.phase(sessionPhase: .inCall, interruption: .otherAudio) == .live)
    }

    @Test func endReasonTableMatchesTheSpec() {
        #expect(CallEndReasonPolicy.reason(outcome: .left, phaseBeforeTeardown: .live) == .userLeft)
        #expect(CallEndReasonPolicy.reason(outcome: .left, phaseBeforeTeardown: .recovering) == .userLeft)
        #expect(CallEndReasonPolicy.reason(outcome: .left, phaseBeforeTeardown: .onHold) == .userLeft)
        #expect(CallEndReasonPolicy.reason(outcome: .left, phaseBeforeTeardown: .waiting) == .cancelledWhileWaiting)
        #expect(CallEndReasonPolicy.reason(outcome: .left, phaseBeforeTeardown: .connecting) == .cancelledWhileWaiting)
        #expect(CallEndReasonPolicy.reason(outcome: .endedByYou, phaseBeforeTeardown: .live) == .userLeft)
        #expect(CallEndReasonPolicy.reason(outcome: .endedByHost, phaseBeforeTeardown: .live) == .endedByHost)
        #expect(CallEndReasonPolicy.reason(outcome: .roomClosed, phaseBeforeTeardown: .live) == .endedByHost)
        #expect(CallEndReasonPolicy.reason(outcome: .removed, phaseBeforeTeardown: .live) == .removed)
        #expect(CallEndReasonPolicy.reason(outcome: .denied, phaseBeforeTeardown: .waiting) == .denied)
        #expect(CallEndReasonPolicy.reason(outcome: .joinFailed, phaseBeforeTeardown: .connecting) == .joinFailed)
        #expect(CallEndReasonPolicy.reason(outcome: .connectionLost, phaseBeforeTeardown: .recovering) == .connectionLost)
        #expect(CallEndReasonPolicy.reason(outcome: .serverDisconnected, phaseBeforeTeardown: .live) == .serverDisconnected)
        #expect(CallEndReasonPolicy.reason(outcome: nil, phaseBeforeTeardown: .live) == CallEndReason.none)

        #expect(CallEndReasonPolicy.callKitEnd(.userLeft) == .localEndRequest)
        #expect(CallEndReasonPolicy.callKitEnd(.cancelledWhileWaiting) == .localEndRequest)
        for reason in [CallEndReason.endedByHost, .removed, .denied] {
            #expect(CallEndReasonPolicy.callKitEnd(reason) == .remoteEnded, "\(reason)")
        }
        for reason in [CallEndReason.joinFailed, .connectionLost, .serverDisconnected, .none] {
            #expect(CallEndReasonPolicy.callKitEnd(reason) == .failed, "\(reason)")
        }
    }

    // MARK: Command table (every SystemCommandResult row)

    @Test func everyCommandResultRow() {
        func snapshot(_ phase: MeetingPhaseKind, muted: Bool, attendee: Bool = false, held: Bool = false) -> CallPresenceSnapshot {
            let recorder = Recorder()
            let presence = makePresence(recorder)
            presence.apply(inputs(.entering, isMuted: muted, isAttendee: attendee))
            presence.apply(inputs(phase, isMuted: muted, isAttendee: attendee))
            if held {
                presence.handle(.hold, source: .callKit, presenceSession: presence.snapshot.presenceSession)
            }
            return presence.snapshot
        }
        func result(_ kind: SystemCallCommandKind, _ snap: CallPresenceSnapshot, pending: Bool = false, session: Int? = nil) -> SystemCommandResult {
            SystemCallCommandPolicy.result(
                SystemCallCommand(kind: kind, source: .callKit, presenceSession: session ?? snap.presenceSession),
                snapshot: snap,
                isMicrophonePending: pending
            )
        }
        let liveUnmuted = snapshot(.inCall, muted: false)
        let liveMuted = snapshot(.inCall, muted: true)
        // Mute: already muted (every CallKit echo of an in-app mute) or dispatched; never dropped while pending.
        #expect(result(.mute, liveMuted) == .alreadyInEffect)
        #expect(result(.mute, liveUnmuted) == .dispatched)
        #expect(result(.mute, liveUnmuted, pending: true) == .dispatched)
        #expect(result(.mute, snapshot(.recovering, muted: false)) == .dispatched)
        #expect(result(.mute, snapshot(.inCall, muted: false, held: true)) == .dispatched)
        #expect(result(.mute, snapshot(.waiting, muted: false)) == .dispatched)
        #expect(result(.mute, snapshot(.entering, muted: false)) == .dispatched)
        #expect(result(.mute, CallPresenceSnapshot.idle) == .alreadyInEffect)
        // Unmute: already unmuted; a mute owns the guard (fail closed); attendee; recovering records intent.
        #expect(result(.unmute, liveUnmuted) == .alreadyInEffect)
        #expect(result(.unmute, liveMuted) == .dispatched)
        #expect(result(.unmute, liveMuted, pending: true) == .duplicate)
        #expect(result(.unmute, snapshot(.inCall, muted: true, attendee: true)) == .unavailable)
        #expect(result(.unmute, snapshot(.recovering, muted: true)) == .dispatched)
        #expect(result(.unmute, snapshot(.waiting, muted: true)) == .unavailable)
        // Leave: dispatched in any call phase, already in effect once ending or idle.
        #expect(result(.leave, liveUnmuted) == .dispatched)
        #expect(result(.leave, snapshot(.waiting, muted: true)) == .dispatched)
        #expect(result(.leave, snapshot(.leaving, muted: true)) == .alreadyInEffect)
        #expect(result(.leave, CallPresenceSnapshot.idle) == .alreadyInEffect)
        // Hold, resume and return to call.
        for kind in [SystemCallCommandKind.hold, .resume, .returnToCall] {
            #expect(result(kind, liveMuted) == .dispatched, "\(kind)")
            #expect(result(kind, CallPresenceSnapshot.idle) == .unavailable, "\(kind)")
        }
        // Stale: any command from another presence session.
        for kind in SystemCallCommandKind.allCases {
            #expect(result(kind, liveUnmuted, session: liveUnmuted.presenceSession + 1) == .stale, "\(kind)")
        }
        #expect(SystemCommandResult.dispatched.fulfillsSystemAction && SystemCommandResult.alreadyInEffect.fulfillsSystemAction)
        #expect(!SystemCommandResult.duplicate.fulfillsSystemAction && !SystemCommandResult.unavailable.fulfillsSystemAction)
        #expect(!SystemCommandResult.stale.fulfillsSystemAction)
    }

    @Test func staleSessionCommandIsDroppedAndAbsoluteMuteNeverInverts() {
        let recorder = Recorder()
        let presence = makePresence(recorder)
        presence.apply(inputs(.entering))
        presence.apply(inputs(.inCall, isMuted: true))
        let first = presence.snapshot.presenceSession
        presence.apply(inputs(.home, outcome: .left))
        presence.apply(inputs(.entering, callSession: 2))
        presence.apply(inputs(.inCall, callSession: 2, isMuted: false))
        #expect(presence.snapshot.presenceSession == first + 1)

        // A mute posted in the old session changes nothing.
        #expect(presence.handle(.mute, source: .notification, presenceSession: first) == .stale)
        #expect(recorder.commands.isEmpty)
        // An absolute mute while already muted never toggles back on.
        presence.apply(inputs(.inCall, callSession: 2, isMuted: true))
        #expect(presence.handle(.mute, source: .notification, presenceSession: presence.snapshot.presenceSession) == .alreadyInEffect)
        #expect(recorder.commands.isEmpty)
        #expect(presence.commandLog == ["mute:notification:stale", "mute:notification:alreadyInEffect"])
    }

    @Test func inAppMuteFollowedByItsCallKitEchoDispatchesNothing() {
        let recorder = Recorder()
        let presence = makePresence(recorder)
        presence.apply(inputs(.entering))
        presence.apply(inputs(.inCall, isMuted: false))
        // The in-app mute reaches the snapshot first; CallKit's echo then finds it in effect.
        presence.apply(inputs(.inCall, isMuted: true))
        #expect(presence.handle(.mute, source: .callKit, presenceSession: presence.snapshot.presenceSession) == .alreadyInEffect)
        #expect(recorder.commands.isEmpty)
    }

    @Test func localLeaveThenItsEchoLeavesOnce() {
        let recorder = Recorder()
        let presence = makePresence(recorder)
        presence.onCommand = { command in
            recorder.commands.append(command)
            // The core applies the leave: the session phase becomes leaving.
            presence.apply(self.inputs(.leaving, outcome: .left))
        }
        presence.apply(inputs(.entering))
        presence.apply(inputs(.inCall))
        let session = presence.snapshot.presenceSession
        #expect(presence.handle(.leave, source: .notification, presenceSession: session) == .dispatched)
        #expect(presence.snapshot.phase == .ending)
        #expect(presence.snapshot.endReason == .userLeft)
        #expect(presence.handle(.leave, source: .callKit, presenceSession: session) == .alreadyInEffect)
        #expect(recorder.commands.count == 1)
    }

    @Test func holdAndResumeDriveTheOnHoldPhase() {
        let recorder = Recorder()
        let presence = makePresence(recorder)
        presence.apply(inputs(.entering))
        presence.apply(inputs(.inCall, isMuted: true))
        let session = presence.snapshot.presenceSession
        #expect(presence.handle(.hold, source: .callKit, presenceSession: session) == .dispatched)
        #expect(presence.snapshot.phase == .onHold)
        #expect(presence.snapshot.interruption == .held)
        #expect(presence.handle(.resume, source: .callKit, presenceSession: session) == .dispatched)
        #expect(presence.snapshot.phase == .live)
        #expect(recorder.commands.map { $0.kind } == [.hold, .resume])
    }

    // MARK: Fan-out (S70 0.5)

    @Test func oneInputChangeGivesOneAdapterCallAndAnEqualInputNone() {
        let recorder = Recorder()
        let second = Recorder()
        let presence = CallPresence()
        presence.adapters = CallPresenceAdapters([
            CallPresenceAdapter(name: "first") { old, new in recorder.changes.append((old, new)) },
            CallPresenceAdapter(name: "second") { old, new in second.changes.append((old, new)) },
        ])
        presence.apply(inputs(.entering))
        #expect(recorder.changes.count == 1 && second.changes.count == 1)
        #expect(presence.adapterFanOutCount == 1)
        presence.apply(inputs(.entering))
        #expect(recorder.changes.count == 1 && second.changes.count == 1)
        presence.apply(inputs(.inCall, isMuted: false))
        #expect(recorder.changes.count == 2 && second.changes.count == 2)
        #expect(recorder.changes[1].0.phase == .connecting && recorder.changes[1].1.phase == .live)
        #expect(recorder.changes[1].1.revision == recorder.changes[1].0.revision + 1)
        // An input no adapter-visible field depends on (pending microphone) publishes nothing.
        presence.apply(inputs(.inCall, isMuted: false, isMicrophonePending: true))
        #expect(recorder.changes.count == 2)
    }

    @Test func adapterReportsDuringTheFanOutApplyAfterItInOrder() {
        let presence = CallPresence()
        var seen: [String] = []
        presence.adapters = CallPresenceAdapters([
            CallPresenceAdapter(name: "reporter") { _, new in
                seen.append("reporter:\(new.surfaceStatus.rawValue)")
                if new.surfaceStatus == .inactive && new.phase == .connecting {
                    presence.reportSurface(.callKit, status: .starting)
                }
            },
            CallPresenceAdapter(name: "observer") { _, new in seen.append("observer:\(new.surfaceStatus.rawValue)") },
        ])
        presence.apply(inputs(.entering))
        #expect(seen == ["reporter:inactive", "observer:inactive", "reporter:starting", "observer:starting"])
        #expect(presence.snapshot.surface == .callKit && presence.snapshot.surfaceStatus == .starting)
    }

    @Test func presenceSessionIncrementsOnLeavingIdleAndSurvivesARedirect() {
        let recorder = Recorder()
        let presence = makePresence(recorder)
        #expect(presence.snapshot.presenceSession == 0)
        presence.apply(inputs(.entering))
        #expect(presence.snapshot.presenceSession == 1)
        presence.apply(inputs(.inCall, joinedAtMillis: 1000))
        // A same-room redirect: new call session, the teardown clears the room, phases may pass through home.
        presence.apply(inputs(.home, callSession: 2, isRedirectContinuation: true, roomLabel: ""))
        #expect(presence.snapshot.phase == .connecting)
        #expect(presence.snapshot.presenceSession == 1)
        #expect(presence.snapshot.title == "lily-zoro-iris")
        presence.apply(inputs(.inCall, callSession: 2, joinedAtMillis: 1000))
        #expect(presence.snapshot.presenceSession == 1)
        #expect(presence.snapshot.callSession == 2)
        // A real end and a new call start a new presence session.
        presence.apply(inputs(.home, callSession: 2, outcome: .endedByHost))
        #expect(presence.snapshot.phase == .idle && presence.snapshot.endReason == .endedByHost)
        presence.apply(inputs(.entering, callSession: 3))
        #expect(presence.snapshot.presenceSession == 2)
        #expect(presence.snapshot.endReason == CallEndReason.none)
    }

    @Test func cameraContinuesInBackgroundOnlyWithAHeldCameraType() {
        let recorder = Recorder()
        let presence = makePresence(recorder)
        presence.apply(inputs(.entering))
        presence.apply(inputs(.inCall, isCameraOff: false))
        #expect(!presence.snapshot.cameraContinuesInBackground)
        presence.reportForegroundServiceTypes(microphone: true, camera: true)
        #expect(presence.snapshot.cameraContinuesInBackground)
        #expect(presence.holdsMicrophoneServiceType)
        presence.apply(inputs(.inCall, isCameraOff: true))
        #expect(!presence.snapshot.cameraContinuesInBackground)
    }

    // MARK: CallKit rules (SY2, 1 l1)

    @Test func scriptedSessionYieldsExactlyTheCallKitReports() {
        let presence = CallPresence()
        var reports: [CallKitReport] = []
        var connected = false
        presence.adapters = CallPresenceAdapters([
            CallPresenceAdapter(name: "callKitPolicy") { old, new in
                let next = CallKitReportPolicy.reports(old: old, new: new, hasReportedConnected: connected)
                // The adapter's own bookkeeping: connected once per call.
                for report in next {
                    if report.kind == .startCall || report.kind == .endCall { connected = false }
                    if report.kind == .reportConnected { connected = true }
                }
                reports += next
            }
        ])
        presence.apply(inputs(.waiting, isMuted: false))
        presence.apply(inputs(.entering, isMuted: false))
        presence.apply(inputs(.inCall, isMuted: false, joinedAtMillis: 5_000))
        presence.apply(inputs(.inCall, isMuted: false, isCameraOff: false, joinedAtMillis: 5_000))
        presence.apply(inputs(.leaving, outcome: .left, isMuted: false, isCameraOff: false, joinedAtMillis: 5_000))
        presence.apply(inputs(.home, outcome: .left, isMuted: true))
        #expect(reports.map { $0.kind } == [.startCall, .reportConnecting, .updateCall, .reportConnected, .updateCall, .endCall])
        #expect(!reports[0].hasVideo)
        #expect(reports[2].title == "lily-zoro-iris" && !reports[2].hasVideo)
        #expect(reports[3].connectedAtMillis == 5_000)
        #expect(reports[4].hasVideo)
        #expect(reports[5].endKind == .localEndRequest)
    }

    @Test func everyEndRowYieldsItsCallKitEnd() {
        let rows: [(MeetingTerminalOutcomeKind, MeetingPhaseKind, MeetingPhaseKind, CallKitEndKind)] = [
            (.left, .inCall, .leaving, .localEndRequest),
            (.endedByYou, .inCall, .home, .localEndRequest),
            (.left, .waiting, .leaving, .localEndRequest),
            (.roomClosed, .inCall, .home, .remoteEnded),
            (.endedByHost, .inCall, .home, .remoteEnded),
            (.removed, .inCall, .outcome, .remoteEnded),
            (.denied, .waiting, .outcome, .remoteEnded),
            (.joinFailed, .entering, .outcome, .failed),
            (.connectionLost, .recovering, .outcome, .failed),
        ]
        for (outcome, before, after, expected) in rows {
            let presence = CallPresence()
            var ends: [CallKitReport] = []
            presence.adapters = CallPresenceAdapters([
                CallPresenceAdapter(name: "ends") { old, new in
                    ends += CallKitReportPolicy.reports(old: old, new: new, hasReportedConnected: true).filter { $0.kind == .endCall }
                }
            ])
            presence.apply(inputs(.entering))
            presence.apply(inputs(before))
            presence.apply(inputs(after, outcome: outcome))
            #expect(ends.map { $0.endKind } == [expected], "\(outcome) from \(before)")
        }
        let cancelled = CallPresence()
        cancelled.apply(inputs(.waiting))
        cancelled.apply(inputs(.leaving, outcome: .left))
        #expect(cancelled.snapshot.endReason == .cancelledWhileWaiting)
    }

    @Test func callKitUpdatesTrackNameVideoAndMuteWithinOneCall() {
        let live = CallPresence()
        live.apply(inputs(.entering, isMuted: true))
        let connecting = live.snapshot
        let startReports = CallKitReportPolicy.reports(old: CallPresenceSnapshot.idle, new: connecting, hasReportedConnected: false)
        // A muted start mirrors the mute once.
        #expect(startReports.map { $0.kind } == [.startCall, .reportConnecting, .updateCall, .setMuted])
        live.apply(inputs(.inCall, isMuted: false))
        let unmuted = live.snapshot
        #expect(CallKitReportPolicy.reports(old: connecting, new: unmuted, hasReportedConnected: false).map { $0.kind } == [.reportConnected, .setMuted])
        #expect(CallKitReportPolicy.reports(old: connecting, new: unmuted, hasReportedConnected: true).map { $0.kind } == [.setMuted])
    }

    // MARK: Android notification policies (SY4, 1 l3, 1 l4)

    @Test func notificationPostPolicyFollowsThePhase() {
        let presence = CallPresence()
        presence.apply(inputs(.waiting, isMuted: true))
        let waiting = presence.snapshot
        #expect(NotificationPostPolicy.statusKind(waiting) == .waiting)
        #expect(NotificationPostPolicy.primaryAction(waiting) == .unmute)
        #expect(!NotificationPostPolicy.showsChronometer(waiting))
        #expect(NotificationPostPolicy.command(old: CallPresenceSnapshot.idle, new: waiting, isAppActive: true, isRunning: false) == .start)
        #expect(NotificationPostPolicy.command(old: CallPresenceSnapshot.idle, new: waiting, isAppActive: false, isRunning: false) == CallNotificationServiceCommand.none)
        presence.apply(inputs(.entering, isMuted: true))
        #expect(NotificationPostPolicy.statusKind(presence.snapshot) == .joining)
        presence.apply(inputs(.inCall, isMuted: false, joinedAtMillis: 1_000))
        let live = presence.snapshot
        #expect(NotificationPostPolicy.statusKind(live) == CallNotificationStatusKind.none)
        #expect(NotificationPostPolicy.primaryAction(live) == .mute)
        #expect(NotificationPostPolicy.showsChronometer(live))
        #expect(NotificationPostPolicy.command(old: waiting, new: live, isAppActive: true, isRunning: true) == .update)
        #expect(NotificationPostPolicy.command(old: live, new: live.withRevision(live.revision + 1), isAppActive: true, isRunning: true) == CallNotificationServiceCommand.none)
        presence.apply(inputs(.recovering, isMuted: false, joinedAtMillis: 1_000))
        #expect(NotificationPostPolicy.statusKind(presence.snapshot) == .reconnecting)
        presence.apply(inputs(.inCall, isAttendee: true, joinedAtMillis: 1_000))
        #expect(NotificationPostPolicy.primaryAction(presence.snapshot) == CallNotificationActionKind.none)
        let attendee = presence.snapshot
        presence.apply(inputs(.leaving, outcome: .left))
        #expect(NotificationPostPolicy.command(old: attendee, new: presence.snapshot, isAppActive: true, isRunning: true) == .stop)
        #expect(NotificationPostPolicy.statusResourceName(.waiting) == "sys_call_waiting")
        #expect(NotificationPostPolicy.statusResourceName(.joining) == "sys_call_joining")
        #expect(NotificationPostPolicy.statusResourceName(.reconnecting) == "sys_call_reconnecting")
        #expect(NotificationPostPolicy.statusResourceName(.onHold) == "sys_call_on_hold")
        #expect(NotificationPostPolicy.actionResourceName(.mute) == "sys_call_mute")
        #expect(NotificationPostPolicy.actionResourceName(.unmute) == "sys_call_unmute")
        #expect(NotificationPostPolicy.actionDrawableName(.mute) == "conclave_mic_fill1")
        #expect(NotificationPostPolicy.actionDrawableName(.unmute) == "conclave_mic_off_fill1")
    }

    @Test func channelMigrationMatrix() {
        let none = NotificationChannelMigrationPolicy.importanceNone
        let low = NotificationChannelMigrationPolicy.importanceLow
        for api in [28, 34] {
            let userSet: Bool? = api >= 29 ? true : nil
            let untouched: Bool? = api >= 29 ? false : nil
            #expect(NotificationChannelMigrationPolicy.legacyState(exists: false, importance: 0, userSetImportance: nil, api: api) == .absent)
            #expect(NotificationChannelMigrationPolicy.legacyState(exists: true, importance: none, userSetImportance: userSet, api: api) == .blocked)
            #expect(NotificationChannelMigrationPolicy.legacyState(exists: true, importance: low, userSetImportance: untouched, api: api) == .untouched)
            let userState = NotificationChannelMigrationPolicy.legacyState(
                exists: true, importance: api >= 29 ? low : 3, userSetImportance: userSet, api: api
            )
            #expect(userState == .userSet, "API \(api)")
        }
        #expect(NotificationChannelMigrationPolicy.decision(legacy: .absent) == .createNew)
        #expect(NotificationChannelMigrationPolicy.decision(legacy: .blocked) == .keepLegacyBlocked)
        #expect(NotificationChannelMigrationPolicy.decision(legacy: .userSet) == .keepLegacy)
        #expect(NotificationChannelMigrationPolicy.decision(legacy: .untouched) == .createNewAndDeleteLegacy)
        #expect(NotificationChannelMigrationPolicy.postingChannelId(.createNew) == "conclave_ongoing_call")
        #expect(NotificationChannelMigrationPolicy.postingChannelId(.createNewAndDeleteLegacy) == "conclave_ongoing_call")
        #expect(NotificationChannelMigrationPolicy.postingChannelId(.keepLegacy) == "conclave_call_channel")
        #expect(NotificationChannelMigrationPolicy.postingChannelId(.keepLegacyBlocked) == "conclave_call_channel")
    }

    // MARK: System fixture (SX1)

    @Test func systemFixtureScriptsReachTheirStates() {
        let expected: [SystemFixtureState: String] = [
            .presenceWaiting: "waiting/none/inactive/1",
            .presenceConnecting: "connecting/none/inactive/1",
            .presenceLive: "live/none/inactive/1",
            .presenceLiveMuted: "live/none/inactive/1",
            .presenceLiveCamera: "live/none/inactive/1",
            .presenceRecovering: "recovering/none/inactive/1",
            .presenceOnHold: "onHold/none/inactive/1",
            .presenceAttendee: "live/none/inactive/1",
            .presenceEnded: "idle/none/inactive/1",
        ]
        for state in SystemFixtureState.allCases {
            let session = SystemFixtureSession(state: state)
            session.start()
            #expect(session.presenceReadout == expected[state], "\(state)")
            #expect(SystemFixtureScript.state(named: state.rawValue) == state)
        }
        let muted = SystemFixtureSession(state: .presenceLiveMuted)
        muted.start()
        #expect(muted.presence.snapshot.isMuted)
        #expect(muted.send(.unmute, source: .notification) == .dispatched)
        #expect(muted.dispatchedCommands.map { $0.kind } == [.unmute])
        #expect(muted.commandsReadout == "unmute:notification:dispatched")
        #expect(SystemFixtureReadout.commands([]) == "none")
        #expect(SystemFixtureScript.state(named: "missing") == nil)
    }

    // MARK: Source scans (iOS adapter, Kotlin service, no haptics)

    @Test func iosCallKitAdapterKeepsItsBookkeeping() throws {
        let adapter = try callPresenceSource("Sources/Conclave/Core/Call/CallKitPresenceAdapter+iOS.swift")
        #expect(adapter.hasPrefix("#if os(iOS) && !SKIP\n"))
        #expect(adapter.contains("pendingLocalEndUUID"))
        #expect(adapter.contains("reportedMuted = muted"))
        #expect(adapter.contains("return result.fulfillsSystemAction"))
        #expect(adapter.contains("CallKitReportPolicy.reports(old: old, new: new, hasReportedConnected: hasReportedConnected)"))
        let manager = try callPresenceSource("Sources/Conclave/Core/Call/CallKitManager.swift")
        #expect(manager.contains("configuration.includesCallsInRecents = false"))
        #expect(manager.contains("configuration.iconTemplateImageData = template"))
        #expect(manager.contains("update.supportsHolding = true"))
        #expect(manager.contains("reason: failed ? .failed : .remoteEnded"))
        #expect(manager.contains("if self.actionHandler?.providerSetMuted(uuid: uuid, muted: muted) == true {"))
        #expect(manager.contains("action.fail()"))
    }

    @Test func systemSurfacesNeverPlayHaptics() throws {
        // S70 12 l3: no gesture route, legacy route or token publish inside the system call layer.
        let files = [
            "Sources/Conclave/Core/Call/CallPresenceState.swift", "Sources/Conclave/Core/Call/CallPresenceSync.swift",
            "Sources/Conclave/Core/Call/CallKitPresenceAdapter+iOS.swift", "Sources/Conclave/Core/Call/CallKitManager.swift",
            "Sources/Conclave/Core/Call/CallSessionCoordinator.swift", "Sources/Conclave/Core/Call/SystemFixtures.swift",
            "Sources/Conclave/Skip/CallForegroundService.kt", "Sources/Conclave/Skip/CallNotificationBuilder.kt",
            "Sources/Conclave/Skip/CallNotificationBridge.kt", "Sources/Conclave/Skip/CallActionDispatcher.kt",
        ]
        for file in files {
            let text = try callPresenceSource(file)
            for pattern in ["conclaveGestureFeedback(", "HapticManager", "ConclaveHapticFeedback", "performHapticFeedback", "FeedbackToken("] {
                #expect(!text.contains(pattern), "\(file) uses \(pattern)")
            }
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has a dash")
        }
    }

    @Test func androidCallServiceFollowsTheSystemRules() throws {
        let service = try callPresenceSource("Sources/Conclave/Skip/CallForegroundService.kt")
        #expect(service.contains("override fun onTaskRemoved(rootIntent: Intent?) {"))
        #expect(service.contains("CallActionDispatcher.handleCurrentNow(SystemCallCommandKind.leave, SystemCallSource.system)"))
        #expect(service.contains("if (isGranted(android.Manifest.permission.RECORD_AUDIO)) {"))
        #expect(service.contains("CallActionDispatcher.reportForegroundServiceTypes(microphone = microphone, camera = camera)"))
        #expect(!service.contains("CALL_TOGGLE_MUTE -> CallActionDispatcher.toggleMute()"))
        let builder = try callPresenceSource("Sources/Conclave/Skip/CallNotificationBuilder.kt")
        #expect(builder.contains("NotificationCompat.CallStyle.forOngoingCall(person, hangUp)"))
        #expect(builder.contains("PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE"))
        #expect(builder.contains("putExtra(CallNotificationModel.EXTRA_PRESENCE_SESSION, presenceSession)"))
        #expect(!builder.contains("setColorized"))
        #expect(builder.contains("setSound(null, null)"))
        #expect(builder.contains("NotificationManager.IMPORTANCE_DEFAULT"))
    }

    @Test func viewModelRoutesSystemCommandsThroughThePresence() throws {
        let viewModel = try callPresenceSource("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        #expect(!viewModel.contains("CallKitManager.shared"))
        #expect(!viewModel.contains("CallNotificationBridge.startCall("))
        #expect(!viewModel.contains("CallNotificationBridge.updateCallState("))
        #expect(viewModel.contains("callPresence.apply(makeCallPresenceInputs())"))
        #expect(viewModel.contains("callPresence.onCommand = { [weak self] command in"))
        let coordinator = try callPresenceSource("Sources/Conclave/Core/Call/CallSessionCoordinator.swift")
        #expect(coordinator.contains("presence.handle(muted ? .mute : .unmute, source: .callKit"))
        #expect(!coordinator.contains("callTitle") && !coordinator.contains("activeSpeakerUserId"))
    }

    @Test func sysStringResourcesExistForEveryNameTheBuilderAsks() throws {
        // Merged by the integrator from HD/strings/B1-T2.json into the app-module strings.xml.
        let xml = try callPresenceSource("Android/app/src/main/res/values/strings.xml")
        for name in ["sys_call_fallback_title", "sys_call_waiting", "sys_call_joining", "sys_call_reconnecting",
                     "sys_call_on_hold", "sys_call_mute", "sys_call_unmute",
                     "sys_channel_call", "sys_channel_call_desc"] {
            #expect(xml.contains("<string name=\"\(name)\""), "missing \(name)")
        }
    }
}

private func callPresenceSource(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}
#endif
