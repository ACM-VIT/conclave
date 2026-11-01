#if !SKIP
import Foundation
import Observation
import Testing
@testable import Conclave

struct SYS10ScreenShareTests {

    struct ScriptedStep {
        let atMs: Double
        let event: ScreenShareStartEvent
    }

    struct ScriptedRun {
        let phases: [ScreenSharePhase]
        let decision: ScreenShareStartDecision
        let decidedAtMs: Double
        let toasts: Int
    }

    static func run(_ steps: [ScriptedStep], untilMs: Double = 60_000) -> ScriptedRun {
        var window = ScreenShareStartPolicy.apply(.presented, to: ScreenShareStartWindow.closed, nowMs: 0)
        var phases = [ScreenShareStartPolicy.phase(window)]
        var pending = steps
        var now = 0.0
        while now <= untilMs {
            while let next = pending.first, next.atMs <= now {
                window = ScreenShareStartPolicy.apply(next.event, to: window, nowMs: next.atMs)
                pending.removeFirst()
                let phase = ScreenShareStartPolicy.phase(window)
                if phase != phases.last { phases.append(phase) }
            }
            let decision = ScreenShareStartPolicy.decision(window, nowMs: now)
            if decision != .wait {
                let failure = ScreenShareStartPolicy.failure(decision)
                return ScriptedRun(phases: phases, decision: decision, decidedAtMs: now,
                                   toasts: ScreenShareFailurePolicy.showsToast(failure) ? 1 : 0)
            }
            now += ScreenShareStartPolicy.pollIntervalMs
        }
        return ScriptedRun(phases: phases, decision: .wait, decidedAtMs: -1, toasts: 0)
    }

    @Test func returningWithNoStartingEventCancelsSilentlyAfterNSeconds() {

        let run = Self.run([
            ScriptedStep(atMs: 300, event: .systemUIShown),
            ScriptedStep(atMs: 9_000, event: .systemUIHidden),
        ])
        #expect(run.decision == .cancelSilently)
        #expect(run.decidedAtMs == 9_000 + ScreenShareStartPolicy.returnWindowMs)
        #expect(run.toasts == 0)
        #expect(run.phases == [.choosing])
        #expect(ScreenShareStartPolicy.failure(run.decision) == .cancelled)

        var window = ScreenShareStartPolicy.apply(.presented, to: .closed, nowMs: 0)
        window = ScreenShareStartPolicy.apply(.systemUIShown, to: window, nowMs: 300)
        window = ScreenShareStartPolicy.apply(.systemUIHidden, to: window, nowMs: 9_000)
        #expect(ScreenShareStartPolicy.decision(window, nowMs: 9_000 + ScreenShareStartPolicy.returnWindowMs - 1) == .wait)
    }

    @Test func startingThenAConnectGoesStartingThenLive() {
        let run = Self.run([
            ScriptedStep(atMs: 300, event: .systemUIShown),
            ScriptedStep(atMs: 6_000, event: .extensionStarting),
            ScriptedStep(atMs: 6_200, event: .systemUIHidden),
            ScriptedStep(atMs: 7_100, event: .connected),
        ])
        #expect(run.phases == [.choosing, .starting])
        #expect(run.decision == .live)
        #expect(run.toasts == 0)
        #expect(ScreenShareStartPolicy.failure(.live) == ScreenShareFailure.none)
    }

    @Test func startingWithNoConnectWithinTheGraceIsExtensionTimeoutWithExactlyOneToast() {
        let run = Self.run([
            ScriptedStep(atMs: 300, event: .systemUIShown),
            ScriptedStep(atMs: 4_000, event: .extensionStarting),
            ScriptedStep(atMs: 4_500, event: .systemUIHidden),
        ])
        #expect(run.decision == .extensionTimeout)
        #expect(run.decidedAtMs == 4_000 + ScreenShareStartPolicy.connectGraceMs)
        #expect(run.toasts == 1)
        #expect(run.phases == [.choosing, .starting])
        #expect(ScreenShareStartPolicy.failure(run.decision) == .extensionTimeout)

        var window = ScreenShareStartPolicy.apply(.presented, to: .closed, nowMs: 0)
        window = ScreenShareStartPolicy.apply(.systemUIShown, to: window, nowMs: 100)
        window = ScreenShareStartPolicy.apply(.extensionStarting, to: window, nowMs: 2_000)
        #expect(ScreenShareStartPolicy.decision(window, nowMs: 2_000 + ScreenShareStartPolicy.connectGraceMs - 1) == .wait)
        #expect(ScreenShareStartPolicy.decision(window, nowMs: 2_000 + ScreenShareStartPolicy.connectGraceMs) == .extensionTimeout)
    }

    @Test func theWindowIsLifecycleBoundAndHasNoTwelveSecondTimer() {

        let run = Self.run([ScriptedStep(atMs: 200, event: .systemUIShown)], untilMs: 60_000)
        #expect(run.decision == .wait)
        #expect(run.phases == [.choosing])

        let neverShown = Self.run([])
        #expect(neverShown.decision == .cancelSilently)
        #expect(neverShown.decidedAtMs == ScreenShareStartPolicy.returnWindowMs)
        #expect(ScreenShareStartPolicy.returnWindowMs == 10_000)
        #expect(ScreenShareStartPolicy.connectGraceMs == 8_000)

        #expect(UInt64(ScreenShareStartPolicy.connectGraceMs) * 1_000_000 == ScreenCaptureReconnectPolicy.graceNanoseconds)
    }

    @Test func aStartAfterTheCountdownAndAColdLaunchStillGoesLive() {
        let run = Self.run([
            ScriptedStep(atMs: 300, event: .systemUIShown),
            ScriptedStep(atMs: 4_000, event: .systemUIHidden),
            ScriptedStep(atMs: 9_500, event: .extensionStarting),
            ScriptedStep(atMs: 9_800, event: .connected),
        ])
        #expect(run.phases == [.choosing, .starting])
        #expect(run.decision == .live)
        #expect(run.toasts == 0)

        var window = ScreenShareStartPolicy.apply(.presented, to: .closed, nowMs: 0)
        window = ScreenShareStartPolicy.apply(.systemUIShown, to: window, nowMs: 300)
        window = ScreenShareStartPolicy.apply(.systemUIHidden, to: window, nowMs: 4_000)
        #expect(window.returnedAtMs == 4_000)
        #expect(9_000 - window.returnedAtMs >= 5_000, "the old 5 s window cancelled this start at 9_000")
        #expect(ScreenShareStartPolicy.decision(window, nowMs: 9_000) == .wait)
        #expect(ScreenShareStartPolicy.decision(window, nowMs: 9_500 + ScreenShareStartPolicy.pollIntervalMs) == .wait)
        #expect(ScreenShareStartPolicy.decision(window, nowMs: 4_000 + ScreenShareStartPolicy.returnWindowMs) == .cancelSilently)
    }

    @Test func theAppGivesUpBeforeTheExtensionDoes() throws {
        #expect(ScreenShareStartPolicy.connectGraceMs < 12_000)
    }

    @Test func startingThenStoppedBeforeAConnectIsASilentCancel() {
        let run = Self.run([
            ScriptedStep(atMs: 300, event: .systemUIShown),
            ScriptedStep(atMs: 3_000, event: .extensionStarting),
            ScriptedStep(atMs: 3_400, event: .extensionStopped),
        ])
        #expect(run.decision == .cancelSilently)
        #expect(run.toasts == 0)
    }

    @Test func windowEventsKeepTheirFirstTimesAndIgnoreAClosedWindow() {
        var window = ScreenShareStartPolicy.apply(.presented, to: .closed, nowMs: 1_000)
        #expect(window.isOpen && window.returnedAtMs == 1_000 && window.startingAtMs == -1)
        window = ScreenShareStartPolicy.apply(.systemUIShown, to: window, nowMs: 1_200)
        window = ScreenShareStartPolicy.apply(.systemUIHidden, to: window, nowMs: 4_000)

        window = ScreenShareStartPolicy.apply(.systemUIHidden, to: window, nowMs: 5_000)
        #expect(window.returnedAtMs == 4_000)
        window = ScreenShareStartPolicy.apply(.extensionStarting, to: window, nowMs: 4_500)
        window = ScreenShareStartPolicy.apply(.extensionStarting, to: window, nowMs: 4_750)
        #expect(window.startingAtMs == 4_500)

        let closed = ScreenShareStartWindow.closed
        #expect(ScreenShareStartPolicy.apply(.connected, to: closed, nowMs: 10) == closed)
        #expect(ScreenShareStartPolicy.decision(closed, nowMs: 99_999) == .wait)
        #expect(ScreenShareStartPolicy.phase(closed) == .idle)

        let reopened = ScreenShareStartPolicy.apply(.presented, to: window, nowMs: 20_000)
        #expect(reopened == ScreenShareStartPolicy.opened(nowMs: 20_000))
    }

    @Test func onlyABusRecordWrittenAfterThePresentationCounts() {
        #expect(ScreenShareStartPolicy.busRecordIsCurrent(updatedAtSeconds: 1_700_000_010, presentedAtSeconds: 1_700_000_000))
        #expect(ScreenShareStartPolicy.busRecordIsCurrent(updatedAtSeconds: 1_700_000_000, presentedAtSeconds: 1_700_000_000))

        #expect(!ScreenShareStartPolicy.busRecordIsCurrent(updatedAtSeconds: 1_699_999_000, presentedAtSeconds: 1_700_000_000))
        #expect(!ScreenShareStartPolicy.busRecordIsCurrent(updatedAtSeconds: 0, presentedAtSeconds: 0))
    }

    @Test func theSnapshotMovesThroughThePhasesAndEndsWithItsReason() {
        let idle = ScreenSharePhasePolicy.withCapability(ScreenShareSnapshot.idle, canShareDeviceAudio: false)
        let choosing = ScreenSharePhasePolicy.began(idle)
        #expect(choosing.phase == .choosing && choosing.failure == ScreenShareFailure.none && choosing.stopSource == ScreenShareStopSource.none)
        let starting = ScreenSharePhasePolicy.starting(choosing)
        #expect(starting.phase == .starting)

        let live = ScreenSharePhasePolicy.live(starting, isSharingDeviceAudio: true)
        #expect(live.phase == .live)
        #expect(!live.isSharingDeviceAudio, "no device audio without the capability")
        #expect(ScreenSharePhasePolicy.starting(live) == live)
        #expect(ScreenSharePhasePolicy.starting(idle) == idle)
        let stopping = ScreenSharePhasePolicy.stopping(live)
        #expect(stopping.phase == .stopping)
        #expect(ScreenSharePhasePolicy.stopping(idle) == idle)
        let stopped = ScreenSharePhasePolicy.ended(stopping, failure: .none, stopSource: .person)
        #expect(stopped.phase == .idle && stopped.stopSource == .person && stopped.failure == ScreenShareFailure.none)

        #expect(ScreenSharePhasePolicy.ended(idle, failure: .none, stopSource: .callEnded) == idle)

        let failed = ScreenSharePhasePolicy.ended(choosing, failure: .extensionTimeout, stopSource: .none)
        #expect(failed.phase == .idle && failed.failure == .extensionTimeout)
        #expect(ScreenSharePhasePolicy.began(failed).failure == ScreenShareFailure.none)

        let capable = ScreenSharePhasePolicy.withCapability(ScreenSharePhasePolicy.began(idle), canShareDeviceAudio: true)
        let liveWithAudio = ScreenSharePhasePolicy.live(capable, isSharingDeviceAudio: true)
        #expect(liveWithAudio.isSharingDeviceAudio && liveWithAudio.canShareDeviceAudio)
        #expect(!ScreenSharePhasePolicy.withCapability(liveWithAudio, canShareDeviceAudio: false).isSharingDeviceAudio)
        #expect(!ScreenSharePhasePolicy.ended(liveWithAudio, failure: .none, stopSource: .system).isSharingDeviceAudio)

        #expect(ScreenSharePhase.allCases.map { $0.rawValue } == ["idle", "choosing", "starting", "live", "stopping"])
        #expect(ScreenShareFailure.allCases.map { $0.rawValue } == [
            "none", "cancelled", "deniedBySystem", "extensionTimeout", "serviceRefused", "producerFailed", "notConfigured",
            "interrupted",
        ])
        #expect(ScreenShareStopSource.allCases.map { $0.rawValue } == ["none", "person", "system", "host", "recovery", "callEnded"])
    }

    @Test func onlyACancelIsSilentAndEveryFailureHasItsCopy() {
        for failure in ScreenShareFailure.allCases {
            let silent = failure == .none || failure == .cancelled
            #expect(ScreenShareFailurePolicy.showsToast(failure) == !silent, "\(failure)")
            #expect(ScreenShareFailurePolicy.diagnosticCode(failure) == "share." + failure.rawValue)
        }
        #expect(ScreenShareFailurePolicy.category(.cancelled) == .cancelled)
        #expect(ScreenShareFailurePolicy.category(.deniedBySystem) == .screenCapturePermission)
        for failure: ScreenShareFailure in [.extensionTimeout, .serviceRefused, .producerFailed, .notConfigured] {
            #expect(ScreenShareFailurePolicy.category(failure) == .platformRefused, "\(failure)")
            #expect(ScreenShareFailurePolicy.iosCopyKey(detail: failure.rawValue) == "Couldn’t start screen sharing. Try again.")
            #expect(ScreenShareFailurePolicy.androidResourceName(detail: failure.rawValue) == "sys_share_failed")
            #expect(ScreenShareStartError(failure: failure).errorDescription == "Couldn't start screen sharing. Try again.")
        }
        #expect(ScreenShareFailurePolicy.iosCopyKey(detail: "deniedBySystem") == "Screen sharing isn’t allowed on this device.")
        #expect(ScreenShareFailurePolicy.androidResourceName(detail: "deniedBySystem") == "sys_err_screen_denied")
        #expect(ScreenShareFailurePolicy.iosCopyKey(detail: "interrupted") == "Screen sharing stopped. Share your screen again.")
        #expect(ScreenShareFailurePolicy.androidResourceName(detail: "interrupted") == "sys_share_interrupted")
        #expect(ScreenShareStartError(failure: .interrupted).errorDescription == "Screen sharing stopped. Share your screen again.")

        #expect(ScreenShareFailurePolicy.failure(detail: "") == .producerFailed)
        let notice = ScreenShareFailurePolicy.notice(.serviceRefused)
        #expect(notice.kind == NoticeKind.shareFailed)
        #expect(notice.lane == .toast && notice.isFailure && notice.detail == "serviceRefused")
        #expect(NoticeKind.localToastKinds.contains(NoticeKind.shareFailed))
    }

    @Test func androidFailuresFollowTheBridgeOrder() {

        let cancel = ScreenShareFailurePolicy.androidFailure(blockedByPolicy: false, launchFailed: false, consentGranted: false, serviceRefused: false)
        #expect(cancel == .cancelled && !ScreenShareFailurePolicy.showsToast(cancel))
        let refused = ScreenShareFailurePolicy.androidFailure(blockedByPolicy: false, launchFailed: false, consentGranted: true, serviceRefused: true)
        #expect(refused == .serviceRefused && ScreenShareFailurePolicy.showsToast(refused))
        #expect(ScreenShareFailurePolicy.androidFailure(blockedByPolicy: true, launchFailed: true, consentGranted: false, serviceRefused: true) == .deniedBySystem)
        #expect(ScreenShareFailurePolicy.androidFailure(blockedByPolicy: false, launchFailed: true, consentGranted: false, serviceRefused: false) == .notConfigured)
        #expect(ScreenShareFailurePolicy.androidFailure(blockedByPolicy: false, launchFailed: false, consentGranted: true, serviceRefused: false) == ScreenShareFailure.none)
    }

    @Test func deviceAudioIsCapabilityGatedAndNeverCapturesTheCallVoiceStream() {

        #expect(!ScreenShareCapabilityPolicy.iosDeviceAudioShips)
        #expect(!ScreenShareCapabilityPolicy.androidDeviceAudioPublishShips)
        #expect(!ScreenShareCapabilityPolicy.current(platform: .ios, apiLevel: 0))
        #expect(!ScreenShareCapabilityPolicy.current(platform: .android, apiLevel: 36))

        #expect(!ScreenShareCapabilityPolicy.canShareDeviceAudio(platform: .android, apiLevel: 28, publishPathShips: true))
        #expect(ScreenShareCapabilityPolicy.canShareDeviceAudio(platform: .android, apiLevel: 29, publishPathShips: true))
        #expect(ScreenShareCapabilityPolicy.canShareDeviceAudio(platform: .ios, apiLevel: 0, publishPathShips: true))
        #expect(!ScreenShareCapabilityPolicy.canShareDeviceAudio(platform: .ios, apiLevel: 0, publishPathShips: false))

        #expect(!ScreenShareCapabilityPolicy.attachesDeviceAudio(canShareDeviceAudio: true, preferenceOn: false))
        #expect(!ScreenShareCapabilityPolicy.attachesDeviceAudio(canShareDeviceAudio: false, preferenceOn: true))
        #expect(ScreenShareCapabilityPolicy.attachesDeviceAudio(canShareDeviceAudio: true, preferenceOn: true))

        #expect(ScreenShareCapabilityPolicy.playbackCaptureUsages == [1, 14, 0])
        #expect(!ScreenShareCapabilityPolicy.playbackCaptureUsages.contains(ScreenShareCapabilityPolicy.excludedVoiceCommunicationUsage))
        #expect(ScreenShareCapabilityPolicy.excludedVoiceCommunicationUsage == 2)
        #expect(ScreenShareCapabilityPolicy.androidPlaybackCaptureMinApi == 29)
        #expect(ScreenShareSnapshot.idle.canShareDeviceAudio == false && ScreenShareSnapshot.idle.isSharingDeviceAudio == false)
    }

    @Test func onlyTheConsentHoldsItsSuppressionUntilTheResult() {
        for kind in ExternalHandoffKind.allCases {
            #expect(ScreenSharePipPolicy.holdsSuppressionUntilResult(kind) == (kind == .mediaProjectionConsent), "\(kind)")
        }
        #expect(ExternalHandoffPolicy.suppressesAutoEnter(.mediaProjectionConsent))
        #expect(ExternalHandoffPolicy.reason(.mediaProjectionConsent) == "media_projection")
        #expect(ScreenSharePipPolicy.consentHoldCapMs == 120_000)
    }

    @Test func theFallbackNotificationUsesSentenceCaseResourcesByName() throws {
        #expect(ScreenShareNotificationPolicy.channelId == "conclave_screen_capture_channel")
        #expect(ScreenShareNotificationPolicy.channelNameResource == "sys_channel_share")
        #expect(ScreenShareNotificationPolicy.channelDescriptionResource == "sys_channel_share_desc")
        #expect(ScreenShareNotificationPolicy.titleResource == "sys_share_notif_title")
        #expect(ScreenShareNotificationPolicy.stopActionResource == "sys_call_stop_sharing")
        #expect(ScreenShareNotificationPolicy.stopActionDrawable == "conclave_cancel_presentation_fill1")
        #expect(ScreenShareNotificationPolicy.smallIconDrawable == "conclave_ic_stat")
        #expect(ScreenShareNotificationPolicy.accentColor == "sys_notification_accent")

        for drawable in [ScreenShareNotificationPolicy.stopActionDrawable, ScreenShareNotificationPolicy.smallIconDrawable] {
            #expect(FileManager.default.fileExists(atPath: sys10PackagePath("Android/app/src/main/res/drawable/\(drawable).xml")), "\(drawable)")
        }
        let manifest = try sys10Source("Android/app/src/main/AndroidManifest.xml")
        #expect(manifest.contains("android:name=\"conclave.module.ScreenCaptureService\"\n            android:foregroundServiceType=\"mediaProjection\""))
        #expect(manifest.contains("android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION"))
    }

    @Test func theIOSAdapterRunsTheLifecycleBoundWindow() throws {
        #expect(ScreenShareLifecycleBusKeys.stopReason == "conclave.screenShare.lifecycle.stopReason")
        #expect(ScreenShareBroadcastStopReason.startTimeout.rawValue == "startTimeout")
        #expect(ScreenShareBroadcastStopReason.person.rawValue == "person")
    }

    @Test func requestedHooksAreWired() throws {
        #expect(FileManager.default.fileExists(atPath: sys10PackagePath("Darwin/ScreenShareExtension/Localizable.xcstrings")), "R5 a")
        let project = try sys10Source("Darwin/Conclave.xcodeproj/project.pbxproj")
        let plist = try #require(try PropertyListSerialization.propertyList(from: Data(project.utf8), format: nil) as? [String: Any])
        let objects = try #require(plist["objects"] as? [String: [String: Any]])
        let buildFile = try #require(objects["5C10A7E12EB0B6A100D1A010"])
        #expect(buildFile["isa"] as? String == "PBXBuildFile" && buildFile["fileRef"] as? String == "5C10A7E12EB0B6A100D1A011", "R5 b")
        let resources = try #require(objects["D8437152ED65B65BAD66390E"]?["files"] as? [String])
        #expect(resources.filter { $0 == "5C10A7E12EB0B6A100D1A010" }.count == 1)
    }

    private static func shareModel(kind: CallControlKind = CallControlKind.screenShare, isOn: Bool = false, isPending: Bool = false,
                                   isBlocked: Bool = false,
                                   reason: ControlBlockedReason = ControlBlockedReason.none) -> CallControlModel {
        CallControlModel(id: kind.rawValue, kind: kind, isOn: isOn, visual: ControlBarPolicy.visual(kind: kind, isOn: isOn),
                         isBlocked: isBlocked, isPending: isPending, reason: reason, reasonName: "", appliesAfterReconnect: false,
                         badgeCount: 0, showsDot: false, hasShortcut: false)
    }

    private static func pickerMode(_ model: CallControlModel, composition: ControlBarComposition = ControlBarComposition.wide,
                                   width: ControlsWindowClass = ControlsWindowClass.regular, isPhone: Bool = false,
                                   isAttendee: Bool = false, isPickerAvailable: Bool = true) -> ScreenSharePickerMode {
        ScreenSharePickerPolicy.mode(model: model, composition: composition, windowWidth: width, isPhone: isPhone,
                                     isAttendee: isAttendee, isPickerAvailable: isPickerAvailable)
    }

    @Test func thePickerOnlyHostsOnARegularWidthIPadBar() {
        let idle = Self.shareModel()
        #expect(Self.pickerMode(idle) == .interactive)
        #expect(Self.pickerMode(idle, isPhone: true) == ScreenSharePickerMode.none)
        #expect(Self.pickerMode(idle, width: .compact) == ScreenSharePickerMode.none)
        #expect(Self.pickerMode(idle, composition: .compact) == ScreenSharePickerMode.none)
        #expect(Self.pickerMode(idle, composition: .attendee) == ScreenSharePickerMode.none)
        #expect(Self.pickerMode(idle, isAttendee: true) == ScreenSharePickerMode.none)
        #expect(Self.pickerMode(idle, isPickerAvailable: false) == ScreenSharePickerMode.none)
        let blockedReasons: [ControlBlockedReason] = [.remoteShareActive, .audioOnly, .offline, .reconnecting, .leaving, .unsupported]
        for reason in blockedReasons {
            #expect(Self.pickerMode(Self.shareModel(isBlocked: true, reason: reason)) == ScreenSharePickerMode.none, "\(reason)")
            #expect(Self.pickerMode(Self.shareModel(reason: reason)) == ScreenSharePickerMode.none, "unblocked \(reason)")
        }
        #expect(Self.pickerMode(Self.shareModel(isPending: true)) == .holding)
        #expect(Self.pickerMode(Self.shareModel(isOn: true)) == ScreenSharePickerMode.none)
        #expect(Self.pickerMode(Self.shareModel(isOn: true, isPending: true)) == ScreenSharePickerMode.none)
        for kind in CallControlKind.allCases where kind != .screenShare {
            #expect(Self.pickerMode(Self.shareModel(kind: kind)) == ScreenSharePickerMode.none, "\(kind)")
        }
        #expect(ScreenSharePickerMode.allCases.map { $0.rawValue } == ["none", "interactive", "holding"])
    }

    @MainActor
    private final class PickerHarness {
        let shell = MeetingShellPresenter()
        let stage: StagePresenter
        let controls: CallControlsPresenter
        var commands: [MeetingShellCommand] = []

        init() {
            stage = StagePresenter(shell: shell)
            controls = CallControlsPresenter(shell: shell, stage: stage)
            shell.onCommand = { [weak self] command, _ in self?.commands.append(command) }
        }

        func push(sharing: Bool = false, inFlight: Bool = false, remote: Bool = false, supported: Bool = true) {
            shell.apply(MeetingShellInputs.make(
                identity: MeetingSessionIdentity(callSession: 1, attempt: 1, attemptToken: "picker"),
                connectionState: .joined, roomId: "abc-defg-hij", displayName: "You", isScreenSharing: sharing,
                hasActiveRemoteScreenShare: remote, isScreenShareSupported: supported, screenShareToggleInFlight: inFlight))
            controls.apply(CallControlsInputs.fromShell(shell))
        }

        func mode() -> ScreenSharePickerMode {
            guard let model = controls.model(.screenShare) else { return ScreenSharePickerMode.none }
            return controls.systemSharePickerMode(model, isPickerAvailable: true)
        }

        func shareRow() -> MeetingControlRow? {
            shell.controls.rows.first { $0.id == MeetingControlID.screenShare.rawValue }
        }
    }

    @MainActor @Test func aWindowThatArrivesAfterTheFirstRenderStillSwitchesTheCellToThePicker() {
        let h = PickerHarness()
        h.controls.setCompositionOverride(.wide)
        h.push()
        #expect(h.mode() == ScreenSharePickerMode.none)

        var notified = false
        withObservationTracking {
            _ = h.mode()
        } onChange: {
            notified = true
        }
        h.controls.setWindow(width: .regular, height: .regular, isPhone: false)
        #expect(notified)
        #expect(h.mode() == .interactive)
    }

    @MainActor @Test func thePresenterHostsThePickerAndDispatchesTheSystemPickerCommand() {
        let h = PickerHarness()
        h.controls.setWindow(width: .regular, height: .regular, isPhone: false)
        h.push()
        #expect(h.controls.bar.composition == .wide)
        #expect(h.mode() == .interactive)
        #expect(h.controls.beginSystemSharePicker() == .dispatched)
        #expect(h.commands == [.startScreenShareFromSystemPicker])

        h.push(inFlight: true)
        #expect(h.mode() == .holding)
        #expect(h.controls.beginSystemSharePicker() == .ignored)
        #expect(h.commands.count == 1)

        h.push(sharing: true)
        #expect(h.mode() == ScreenSharePickerMode.none)
        #expect(h.controls.beginSystemSharePicker() == .ignored)

        h.push()
        h.controls.setWindow(width: .compact, height: .regular, isPhone: false)
        #expect(h.mode() == ScreenSharePickerMode.none)
        #expect(h.controls.beginSystemSharePicker() == .ignored)

        h.controls.setWindow(width: .regular, height: .regular, isPhone: true)
        h.controls.setCompositionOverride(.wide)
        #expect(h.controls.bar.control(.screenShare) != nil)
        #expect(h.mode() == ScreenSharePickerMode.none)
        h.controls.setCompositionOverride(nil)

        h.controls.setWindow(width: .regular, height: .regular, isPhone: false)
        h.controls.setOverflow(ids: [CallControlKind.screenShare.rawValue])
        #expect(h.mode() == ScreenSharePickerMode.none)
        #expect(h.controls.beginSystemSharePicker() == .ignored)
        h.controls.setOverflow(ids: [])
        #expect(h.mode() == .interactive)

        h.push(remote: true)
        #expect(h.controls.model(.screenShare)?.reason == .remoteShareActive)
        #expect(h.mode() == ScreenSharePickerMode.none)
        #expect(h.controls.beginSystemSharePicker() == .ignored)
        #expect(h.commands == [.startScreenShareFromSystemPicker])
        #expect(h.controls.tap(.screenShare) == .explained)
        #expect(h.commands == [.startScreenShareFromSystemPicker])
    }

    @MainActor @Test func theShellRefusesASystemPickerStartWhileSharingOrPending() {
        let h = PickerHarness()
        h.push(sharing: true)
        #expect(h.shell.startScreenShareFromSystemPicker() == .unavailable)
        h.push(sharing: true, inFlight: true)
        #expect(h.shell.startScreenShareFromSystemPicker() == .unavailable)
        h.push(remote: true)
        #expect(h.shell.startScreenShareFromSystemPicker() == .unavailable)
        h.push(supported: false)
        #expect(h.shell.startScreenShareFromSystemPicker() == .unavailable)
        h.push(inFlight: true)
        #expect(h.shell.startScreenShareFromSystemPicker() == .duplicate)
        #expect(h.commands.isEmpty)

        h.push()
        #expect(h.shell.reportFailure(.screenShare, MeetingActionResult.failed(MeetingActionFailure.rejectedByServer)))
        #expect(h.shareRow()?.failure == MeetingActionFailure.rejectedByServer)
        #expect(h.shell.startScreenShareFromSystemPicker() == .dispatched)
        #expect(h.shareRow()?.failure == MeetingActionFailure.none)
        #expect(h.commands == [.startScreenShareFromSystemPicker])
        #expect(h.shell.toggleScreenShare() == .dispatched)
        #expect(h.commands == [.startScreenShareFromSystemPicker, .toggleScreenShare])
    }

    @Test func aPickerArmIsHonoredOnlyWithinItsLifetime() {
        #expect(!ScreenShareStartPolicy.pickerArmIsCurrent(armedAtMs: -1.0, nowMs: 0.0))
        #expect(ScreenShareStartPolicy.pickerArmIsCurrent(armedAtMs: 0.0, nowMs: 0.0))
        #expect(ScreenShareStartPolicy.pickerArmIsCurrent(armedAtMs: 0.0, nowMs: 10_000.0))
        #expect(!ScreenShareStartPolicy.pickerArmIsCurrent(armedAtMs: 0.0, nowMs: 10_001.0))
        #expect(!ScreenShareStartPolicy.pickerArmIsCurrent(armedAtMs: 5_000.0, nowMs: 4_999.0))
        #expect(ScreenShareStartPolicy.pickerArmIsCurrent(armedAtMs: 5_000.0, nowMs: 5_000.0 + ScreenShareStartPolicy.pickerArmLifetimeMs))
        #expect(ScreenSharePresentation.allCases.map { $0.rawValue } == ["programmatic", "systemPicker"])
    }

    private static func foldedPhases(_ steps: [ShareFixtureStep]) -> [ScreenSharePhase] {
        var phases: [ScreenSharePhase] = []
        for step in steps where phases.last != step.snapshot.phase {
            phases.append(step.snapshot.phase)
        }
        return phases
    }

    @MainActor @Test func sharePhaseFixturesCoverEveryPhaseOnBothPlatforms() {
        for phase in ShareFixturePhase.allCases {
            let state = ShareFixtureScript.state(for: phase)
            #expect(state.rawValue == "share-" + phase.rawValue)
            #expect(ShareFixtureScript.phase(for: state) == phase)
            #expect(SystemFixtureScript.state(named: state.rawValue) == state)
        }
        #expect(ShareFixtureScript.failure(platform: .ios) == .extensionTimeout)
        #expect(ShareFixtureScript.failure(platform: .android) == .serviceRefused)

        let readouts: [ShareFixturePhase: (String, String, Bool, Bool, [ScreenSharePhase])] = [
            .requesting: ("choosing/none/none/video", "choosing/app/wait", false, true, [.choosing]),
            .consent: ("choosing/none/none/video", "choosing/system/wait", false, true, [.choosing]),
            .starting: ("starting/none/none/video", "starting/app/wait", false, true, [.choosing, .starting]),
            .live: ("live/none/none/video", "idle/app/wait", true, false, [.choosing, .starting, .live]),
            .stopping: ("stopping/none/none/video", "idle/app/wait", true, true, [.choosing, .starting, .live, .stopping]),
            .failed: ("", "idle/app/wait", false, false, [.choosing, .starting, .idle]),
        ]
        for platform in ScreenSharePlatform.allCases {
            let failure = ShareFixtureScript.failure(platform: platform)
            for phase in ShareFixturePhase.allCases {
                let label = "\(platform) \(phase)"
                guard let row = readouts[phase] else {
                    Issue.record("missing \(label)")
                    continue
                }
                let session = SystemFixtureSession(state: ShareFixtureScript.state(for: phase), platform: platform)
                session.start()
                guard let share = session.share else {
                    Issue.record("no rig for \(label)")
                    continue
                }
                #expect(share.platform == platform)
                #expect(session.presenceReadout == "live/none/inactive/1", "\(label)")
                let expectedShare = phase == .failed ? "idle/" + failure.rawValue + "/none/video" : row.0
                #expect(session.shareReadout == expectedShare, "\(label)")
                #expect(session.shareWindowReadout == row.1, "\(label)")
                #expect(session.shareCommandsReadout == "none", "\(label)")
                let model = share.controls.model(.screenShare)
                #expect(model?.isOn == row.2, "\(label)")
                #expect(model?.isPending == row.3, "\(label)")
                #expect(model?.isBlocked == false, "\(label)")
                #expect(share.controls.bar.composition == .wide, "\(label)")
                #expect(Self.foldedPhases(ShareFixtureScript.steps(phase, platform: platform)) == row.4, "\(label)")
                #expect(share.stage.layout.isLocalPresenting == row.2, "\(label)")
                if phase == .failed {
                    let notice = share.notice
                    #expect(notice?.kind == NoticeKind.shareFailed, "\(label)")
                    #expect(notice?.detail == failure.rawValue, "\(label)")
                    #expect(ScreenShareFailurePolicy.showsToast(failure))
                    #expect(session.shareNoticeReadout == "shareFailed:" + failure.rawValue, "\(label)")
                    #expect(share.stage.noticesReadout().contains("toast=shareFailed"), "\(label)")
                    if platform == .ios {
                        #expect(ScreenShareFailurePolicy.iosCopyKey(detail: failure.rawValue) == "Couldn’t start screen sharing. Try again.")
                    } else {
                        #expect(ScreenShareFailurePolicy.androidResourceName(detail: failure.rawValue) == "sys_share_failed")
                    }
                    session.repostShareFailure()
                    #expect(share.stage.noticesReadout().contains("toast=shareFailed"), "\(label)")
                    #expect(session.shareNoticeReadout == "shareFailed:" + failure.rawValue, "\(label)")
                } else {
                    #expect(share.notice == nil, "\(label)")
                    #expect(session.shareNoticeReadout == "none", "\(label)")
                    #expect(!share.stage.noticesReadout().contains("toast=shareFailed"), "\(label)")
                }
            }
        }

        let live = SystemFixtureSession(state: .shareLive, platform: .ios)
        live.start()
        #expect(live.share?.controls.tap(.screenShare) == .dispatched)
        #expect(live.shareCommandsReadout == "toggleScreenShare")

        for state in SystemFixtureState.allCases where ShareFixtureScript.phase(for: state) == nil {
            let session = SystemFixtureSession(state: state)
            session.start()
            #expect(session.share == nil, "\(state)")
            #expect(session.shareReadout == "none", "\(state)")
        }
        #expect(SystemFixtureScript.currentPlatform == .ios)
    }

    @MainActor @Test func shareFixturesNeverClaimDeviceAudio() {
        for platform in ScreenSharePlatform.allCases {
            for phase in ShareFixturePhase.allCases {
                for step in ShareFixtureScript.steps(phase, platform: platform) {
                    #expect(!step.snapshot.canShareDeviceAudio, "\(platform) \(phase) \(step.atMs)")
                    #expect(!step.snapshot.isSharingDeviceAudio, "\(platform) \(phase) \(step.atMs)")
                }
                let session = SystemFixtureSession(state: ShareFixtureScript.state(for: phase), platform: platform)
                session.start()
                #expect(session.share?.snapshot.canShareDeviceAudio == false, "\(platform) \(phase)")
                #expect(session.share?.snapshot.isSharingDeviceAudio == false, "\(platform) \(phase)")
                #expect(session.shareReadout.hasSuffix("/video"), "\(platform) \(phase)")
            }
        }
        for api in 29...36 {
            #expect(!ScreenShareCapabilityPolicy.current(platform: .android, apiLevel: api), "API \(api)")
        }
        #expect(!ScreenShareCapabilityPolicy.current(platform: .ios, apiLevel: 0))
    }
}

private func sys10PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func sys10PackagePath(_ packageRelativePath: String) -> String {
    sys10PackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL.path
}

private func sys10Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: sys10PackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func sys10Line(containing needle: String, in text: String) -> String {
    text.split(separator: "\n", omittingEmptySubsequences: false).first { $0.contains(needle) }.map { String($0) } ?? ""
}

private func sys10Body(_ signature: String, in text: String, closing: String) -> String {
    guard let start = text.range(of: signature) else { return "" }
    let rest = text[start.lowerBound...]
    guard let end = rest.range(of: closing) else { return String(rest) }
    return String(rest[..<end.upperBound])
}
#endif
