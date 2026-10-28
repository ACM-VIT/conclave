#if !SKIP
import Foundation
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
        #expect(ScreenShareStartPolicy.returnWindowMs == 5_000)
        #expect(ScreenShareStartPolicy.connectGraceMs == 8_000)

        #expect(UInt64(ScreenShareStartPolicy.connectGraceMs) * 1_000_000 == ScreenCaptureReconnectPolicy.graceNanoseconds)
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

    @Test func theAndroidBridgesSuppressOnEveryApiLevelAndHoldUntilTheResult() throws {
        let capture = try sys10Source("Sources/Conclave/Skip/ScreenCaptureManager.kt")

        let suppress = "PipManager.suppressForExternalHandoff(ExternalHandoffKind.mediaProjectionConsent)\n            launcher.launch(pm.createScreenCaptureIntent())"
        #expect(capture.contains(suppress))
        #expect(!sys10Line(containing: "suppressForExternalHandoff", in: capture).contains("SDK_INT"))
        let flat = capture.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        #expect(flat.contains("awaitingConsent = false } PipManager.restoreAutoEnterAfterExternalActivity() if (result.resultCode == Activity.RESULT_OK && result.data != null) {"))
        #expect(capture.contains("fun isAwaitingConsent(): Boolean"))
        #expect(capture.contains("fun lastStartFailure(): ScreenShareFailure"))
        #expect(capture.contains("ScreenShareCapabilityPolicy.current(platform = ScreenSharePlatform.android, apiLevel = Build.VERSION.SDK_INT)"))
        #expect(capture.contains("policy.getScreenCaptureDisabled(null)"))
        #expect(capture.contains("AudioPlaybackCaptureConfiguration.Builder(projection)"))
        #expect(capture.contains("for (usage in ScreenShareCapabilityPolicy.playbackCaptureUsages)"))
        #expect(!capture.contains("USAGE_VOICE_COMMUNICATION)"), "the call voice stream is never a matching usage")

        #expect(capture.components(separatedBy: "consentGranted = true, serviceRefused = true").count - 1 == 2)
        let pip = try sys10Source("Sources/Conclave/Skip/PipManager.kt")
        #expect(pip.contains("if (ScreenSharePipPolicy.holdsSuppressionUntilResult(kind)) {\n            holdSuppressionUntilResult()\n        }"))
        #expect(pip.contains("isSuppressed = suppressNextAutoEnter || consentHold,"))
        #expect(pip.contains("if (consentHold) return true"))
        #expect(pip.contains("mainHandler.postDelayed(cap, ScreenSharePipPolicy.consentHoldCapMs.toLong())"))
        #expect(pip.contains("if (consentHold && !ScreenCaptureManager.isAwaitingConsent()) {"))

        #expect(pip.contains("if (!ExternalHandoffPolicy.suppressesAutoEnter(kind)) return"))
        #expect(pip.contains("PipController.recordSuppression(reason)"))
        #expect(pip.contains("val wasInPip = PipController.inPipMode"))
        #expect(pip.contains("configureForActiveCall(active = false, muted = PipController.muted)"))
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
        let service = try sys10Source("Sources/Conclave/Skip/ScreenCaptureService.kt")
        for pattern in [
            "res.string(ScreenShareNotificationPolicy.channelNameResource)",
            "res.string(ScreenShareNotificationPolicy.channelDescriptionResource)",
            "res.string(ScreenShareNotificationPolicy.titleResource)",
            "res.string(ScreenShareNotificationPolicy.stopActionResource)",
            "res.drawable(ScreenShareNotificationPolicy.stopActionDrawable)",
            "res.drawable(ScreenShareNotificationPolicy.smallIconDrawable)",
            ".setCategory(NotificationCompat.CATEGORY_SERVICE)",
            ".setVisibility(NotificationCompat.VISIBILITY_PUBLIC)",
            "ScreenCaptureManager.onServiceForegroundFailed()",
            "ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION",
        ] {
            #expect(service.contains(pattern), "\(pattern)")
        }

        for legacy in ["\"Screen Sharing\"", "\"Stop Sharing\"", "\"Sharing your screen\"", "\"Conclave\"", "Shows when you're sharing"] {
            #expect(!service.contains(legacy), "\(legacy)")
        }

        for drawable in [ScreenShareNotificationPolicy.stopActionDrawable, ScreenShareNotificationPolicy.smallIconDrawable] {
            #expect(FileManager.default.fileExists(atPath: sys10PackagePath("Android/app/src/main/res/drawable/\(drawable).xml")), "\(drawable)")
        }
        let manifest = try sys10Source("Android/app/src/main/AndroidManifest.xml")
        #expect(manifest.contains("android:name=\"conclave.module.ScreenCaptureService\"\n            android:foregroundServiceType=\"mediaProjection\""))
        #expect(manifest.contains("android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION"))
    }

    @Test func theIOSAdapterRunsTheLifecycleBoundWindow() throws {
        let manager = try sys10Source("Sources/Conclave/Core/WebRTC/ScreenCaptureManager.swift")

        for removed in ["ScreenCaptureStartPolicy", "12_000_000_000", "startTimeoutTask", "scheduleStartTimeout"] {
            #expect(!manager.contains(removed), "\(removed)")
        }
        for pattern in [
            "switch ScreenShareStartPolicy.decision(startWindow, nowMs: now) {",
            "ScreenShareStartPolicy.busRecordIsCurrent(updatedAtSeconds: updatedAt,",
            "applyStartEvent(ScreenShareStartEvent.extensionStarting, nowMs: nowMs)",
            "applyStartEvent(ScreenShareStartEvent.connected, nowMs: Self.nowMs())",
            "UIApplication.shared.applicationState == .active",
            "failPendingStart(generation: generation, failure: ScreenShareFailure.extensionTimeout,\n                             stopReason: ScreenShareBroadcastStopReason.startTimeout)",

            "guard let button = Self.firstButton(in: picker) else {",
            "failPendingStart(generation: generation, failure: ScreenShareFailure.notConfigured, stopReason: nil)",
            "guard RPScreenRecorder.shared().isAvailable else {",
            "picker.showsMicrophoneButton = false",
            "requestBroadcastStop(reason: ScreenShareBroadcastStopReason.person)",
            "onCapturePhaseChanged?(phase)",
        ] {
            #expect(manager.contains(pattern), "\(pattern)")
        }

        #expect(manager.contains("static func lastStartFailure() -> ScreenShareFailure { fatalError() }"))
        #expect(manager.contains("static func canShareDeviceAudio() -> Bool { fatalError() }"))
        #expect(ScreenShareLifecycleBusKeys.stopReason == "conclave.screenShare.lifecycle.stopReason")
        #expect(ScreenShareBroadcastStopReason.startTimeout.rawValue == "startTimeout")
        #expect(ScreenShareBroadcastStopReason.person.rawValue == "person")
    }

    @Test func theExtensionFinishesWithFriendlyLocalizedSentences() throws {
        let handler = try sys10Source("Darwin/ScreenShareExtension/SampleHandler.swift")
        #expect(!handler.contains("user stopped the screen share"), "the lowercase stop message is gone (CE P13)")
        #expect(!handler.contains("Unable to start screen sharing"))
        for key in [
            "NSLocalizedString(\n        \"Screen sharing stopped.\"",
            "NSLocalizedString(\n        \"Screen sharing stopped because Conclave lost the connection.\"",
            "NSLocalizedString(\n        \"Couldn’t start screen sharing. Try again.\"",
        ] {
            #expect(handler.contains(key), "\(key)")
        }

        #expect(handler.contains("private let stopReasonKey = \"\(ScreenShareLifecycleBusKeys.stopReason)\""))
        #expect(handler.contains("raw == \"\(ScreenShareBroadcastStopReason.startTimeout.rawValue)\" ? .startTimeout : .stoppedByApp"))

        #expect(handler.contains("guard sampleBufferType == .video else { return }"))
        #expect(!handler.contains(".audioApp {") && !handler.contains("case .audioApp"))

        #expect(!handler.contains("import Conclave"))
    }

    @Test func sys10FilesAreFlatDashFreeAndHapticFree() throws {
        let files = [
            "Sources/Conclave/Core/Call/ScreenShareStartPolicy.swift",
            "Sources/Conclave/Core/WebRTC/ScreenCaptureManager.swift",
            "Sources/Conclave/Skip/ScreenCaptureManager.kt",
            "Sources/Conclave/Skip/ScreenCaptureService.kt",
            "Sources/Conclave/Skip/PipManager.kt",
            "Darwin/ScreenShareExtension/SampleHandler.swift",
        ]
        for file in files + ["Tests/ConclaveTests/SYS10ScreenShareTests.swift"] {
            let text = try sys10Source(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has a dash")
        }

        for file in files {
            let text = try sys10Source(file)
            for pattern in ["Gradient", "HapticManager", "performHapticFeedback", "conclaveGestureFeedback("] {
                #expect(!text.contains(pattern), "\(file) uses \(pattern)")
            }
        }

        let policy = try sys10Source("Sources/Conclave/Core/Call/ScreenShareStartPolicy.swift")
        for pattern in ["#if", "import UIKit", "import ReplayKit", "import AVFoundation", "protocol ", "inout "] {
            #expect(!policy.contains(pattern), "\(pattern)")
        }
    }

    @Test func requestedHooksAreWired() throws {
        let vm = try sys10Source("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        for pattern in [
            "private(set) var screenShare = ScreenShareSnapshot.idle",
            "publishScreenShare(ScreenSharePhasePolicy.began(screenShare))",
            "ScreenCaptureManager.shared.onCapturePhaseChanged = { [weak self] phase in",
            "let failure = ScreenCaptureManager.failure(for: error)",
            "let consentFailure = granted ? ScreenShareFailure.none : ScreenCaptureManager.lastStartFailure()",
            "reportScreenShareFailure(consentFailure)",
            "stage.postLocal(ScreenShareFailurePolicy.notice(failure))",
            "private func stopScreenCaptureManager(source: ScreenShareStopSource) async {",
            "stopSource: ScreenShareStopSource.system))",
            "settleScreenSharePhase()",
        ] {
            #expect(vm.contains(pattern), "R1: \(pattern)")
        }
        #expect(!vm.contains("await stopScreenCaptureManager()\n"), "R1 k: every stop names its source")
        let classifier = try sys10Source("Sources/Conclave/Core/Session/MeetingErrorClassifier.swift")
        #expect(classifier.contains("if let shareError = error as? ScreenShareStartError {"), "R2")
        let iosLanes = try sys10Source("Sources/Conclave/Features/Meeting/Stage/NoticeLanes+iOS.swift")
        #expect(iosLanes.contains("ScreenShareFailurePolicy.iosCopyKey(detail: notice.detail)"), "R3 a")
        let androidLanes = try sys10Source("Sources/Conclave/Skip/ui/call/stage/NoticeLanes.kt")
        #expect(androidLanes.contains("ScreenShareFailurePolicy.androidResourceName(detail = notice.detail)"), "R3 b")
        let core = try sys10Source("Tests/ConclaveTests/ConclaveTests.swift")
        #expect(!core.contains("ScreenCaptureStartPolicy"), "R4")
        #expect(FileManager.default.fileExists(atPath: sys10PackagePath("Darwin/ScreenShareExtension/Localizable.xcstrings")), "R5 a")
        let project = try sys10Source("Darwin/Conclave.xcodeproj/project.pbxproj")
        let plist = try #require(try PropertyListSerialization.propertyList(from: Data(project.utf8), format: nil) as? [String: Any])
        let objects = try #require(plist["objects"] as? [String: [String: Any]])
        let buildFile = try #require(objects["5C10A7E12EB0B6A100D1A010"])
        #expect(buildFile["isa"] as? String == "PBXBuildFile" && buildFile["fileRef"] as? String == "5C10A7E12EB0B6A100D1A011", "R5 b")
        let resources = try #require(objects["D8437152ED65B65BAD66390E"]?["files"] as? [String])
        #expect(resources.filter { $0 == "5C10A7E12EB0B6A100D1A010" }.count == 1)
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
#endif
