#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// SYS-5 (OUT/PLAN-screens.md section 5; S70 4, 0.6 SX5, SX11, 0.7 SY8): the keep-awake and proximity rules
/// (`ProximityPolicy`, `KeepAwakePolicy`), the edge writer in `CallScreenAwake.swift` over a recording seam (4 l1,
/// 4 l3), the presence and system fixture wiring, and source scans of the iOS branch, the Android controller and the
/// call service (S70 O14: no iOS-hosted test bundle). Proximity itself is a physical-device cell (4 l4). Not run in
/// the heads-down push.
@MainActor
struct SYS5ProximityTests {
    // MARK: Helpers

    /// The recording writers (S70 4 l3). The proximity writer reports monitoring back the way the platforms do:
    /// iOS reads back `isProximityMonitoringEnabled`, Android whether it holds the wake lock.
    @MainActor
    final class RecordingWriters {
        var idleTimer: [Bool] = []
        var proximity: [Bool] = []
        /// False models a device without a sensor (iPad, many tablets).
        var monitoringAvailable = true
        weak var state: CallScreenAwakeState?

        func make() -> ScreenAwakeWriters {
            ScreenAwakeWriters(
                setIdleTimerDisabled: { [unowned self] active in
                    self.idleTimer.append(active)
                },
                setProximityMonitoring: { [unowned self] armed in
                    self.proximity.append(armed)
                    self.state?.reportProximityMonitoring(active: armed && self.monitoringAvailable)
                }
            )
        }
    }

    private func makeState(_ writers: RecordingWriters, presenceDrivesIdleTimer: Bool = true) -> CallScreenAwakeState {
        let state = CallScreenAwakeState(writers: writers.make(), presenceDrivesIdleTimer: presenceDrivesIdleTimer)
        writers.state = state
        return state
    }

    static func snapshot(phase: CallPresencePhase = .live, isMuted: Bool = true, isCameraOn: Bool = false,
                         keepsScreenAwake: Bool = true, proximityArmed: Bool = false, revision: Int = 1) -> CallPresenceSnapshot {
        CallPresenceSnapshot(
            revision: revision, presenceSession: 1, callSession: 1, phase: phase, title: "lily-zoro-iris",
            roomId: "lily-zoro-iris", joinedAtMillis: 1_000, isMuted: isMuted, isCameraOn: isCameraOn, isPresenting: false,
            isAttendee: false, surface: .none, surfaceStatus: .inactive, interruption: .none, pip: .eligible,
            isInPictureInPicture: false, pipTarget: nil, keepsScreenAwake: keepsScreenAwake, proximityArmed: proximityArmed,
            cameraContinuesInBackground: false, endReason: .none
        )
    }

    private let receiver = AudioRouteOption(id: "receiver", kind: .receiver, name: "iPhone", isConnecting: false)
    private let speaker = AudioRouteOption(id: "speaker", kind: .speaker, name: "Speaker", isConnecting: false)
    private let headset = AudioRouteOption(id: "bt-1", kind: .bluetooth, name: "AirPods Pro", isConnecting: false)

    private func routes(current: String) -> AudioRoutePlatformState {
        AudioRoutePlatformState.make(options: [receiver, speaker, headset], currentId: current, defaultId: "receiver")
    }

    private func inputs(_ phase: MeetingPhaseKind, isCameraOff: Bool = true, isScreenSharing: Bool = false,
                        isAppActive: Bool = true) -> CallPresenceInputs {
        CallPresenceInputs.make(
            callSession: 1,
            sessionPhase: phase,
            roomLabel: "lily-zoro-iris",
            isMuted: false,
            isCameraOff: isCameraOff,
            isScreenSharing: isScreenSharing,
            joinedAtMillis: 1_000,
            isAppActive: isAppActive
        )
    }

    // MARK: S70 4 l1: the arming table (every row of 4 f)

    @Test func proximityArmsOnlyOnTheReceiverWithTheCameraOffNotPresentingNotInPipAndActive() {
        // Receiver, camera off: armed.
        #expect(ProximityPolicy.armed(route: .receiver, isCameraOn: false, isPresenting: false, isInPip: false, isAppActive: true))
        // Camera turned on, presenting starts, PiP, background: off.
        #expect(!ProximityPolicy.armed(route: .receiver, isCameraOn: true, isPresenting: false, isInPip: false, isAppActive: true))
        #expect(!ProximityPolicy.armed(route: .receiver, isCameraOn: false, isPresenting: true, isInPip: false, isAppActive: true))
        #expect(!ProximityPolicy.armed(route: .receiver, isCameraOn: false, isPresenting: false, isInPip: true, isAppActive: true))
        #expect(!ProximityPolicy.armed(route: .receiver, isCameraOn: false, isPresenting: false, isInPip: false, isAppActive: false))
        // Route to speaker or a headset (and an unknown route, which iPad and an unpublished route report): off.
        for route in AudioRouteKind.allCases where route != .receiver {
            #expect(!ProximityPolicy.armed(route: route, isCameraOn: false, isPresenting: false, isInPip: false, isAppActive: true),
                    "\(route)")
        }
    }

    @Test func keepAwakeAndArmingFollowThePhase() {
        let inProgress: Set<CallPresencePhase> = [.waiting, .connecting, .live, .recovering, .onHold]
        for phase in CallPresencePhase.allCases {
            // Waiting, connecting, live, recovering, on hold keep the screen on; idle and ending clear both (4 f).
            #expect(KeepAwakePolicy.keepsScreenAwake(phase: phase) == inProgress.contains(phase), "\(phase)")
            #expect(ProximityPolicy.armedInCall(phase: phase, route: .receiver, isCameraOn: false, isPresenting: false,
                                                isInPip: false, isAppActive: true) == inProgress.contains(phase), "\(phase)")
            #expect(!ProximityPolicy.armedInCall(phase: phase, route: .speaker, isCameraOn: false, isPresenting: false,
                                                 isInPip: false, isAppActive: true), "\(phase)")
        }
    }

    @Test func controllerStateMovesBetweenArmedAndNearOnlyWhileMonitoring() {
        #expect(ProximityPolicy.state(armed: false, monitoringActive: false, isNear: false) == .off)
        #expect(ProximityPolicy.state(armed: false, monitoringActive: true, isNear: true) == .off)
        // No sensor (iPad, tablets): the platform reads back no monitoring and the state stays off.
        #expect(ProximityPolicy.state(armed: true, monitoringActive: false, isNear: false) == .off)
        #expect(ProximityPolicy.state(armed: true, monitoringActive: false, isNear: true) == .off)
        #expect(ProximityPolicy.state(armed: true, monitoringActive: true, isNear: false) == .armed)
        #expect(ProximityPolicy.state(armed: true, monitoringActive: true, isNear: true) == .near)
        #expect(ProximityState.allCases.map { ProximityPolicy.readout($0) } == ["off", "armed", "near"])
        #expect(KeepAwakePolicy.readout(true) == "1" && KeepAwakePolicy.readout(false) == "0")
        #expect(CallScreenAwakeReadout.awakeKey == "sys.awake" && CallScreenAwakeReadout.proximityKey == "sys.proximity")
    }

    @Test func idleTimerCombinesTheLegacyGateWithThePresenceRuleOnIOSOnly() {
        // iOS: either source keeps the screen on, so waiting stays awake on every route.
        #expect(KeepAwakePolicy.idleTimerDisabled(legacyActive: false, presenceKeepsAwake: true, presenceDrivesIdleTimer: true))
        #expect(KeepAwakePolicy.idleTimerDisabled(legacyActive: true, presenceKeepsAwake: false, presenceDrivesIdleTimer: true))
        #expect(!KeepAwakePolicy.idleTimerDisabled(legacyActive: false, presenceKeepsAwake: false, presenceDrivesIdleTimer: true))
        // Android: the presence rule is Compose-scoped; SkipUI's window flag stays the legacy route's.
        #expect(!KeepAwakePolicy.idleTimerDisabled(legacyActive: false, presenceKeepsAwake: true, presenceDrivesIdleTimer: false))
        #expect(KeepAwakePolicy.idleTimerDisabled(legacyActive: true, presenceKeepsAwake: false, presenceDrivesIdleTimer: false))
    }

    // MARK: S70 4 l3: one writer call per edge (recording adapter)

    @Test func writersRunExactlyOncePerEdge() {
        let writers = RecordingWriters()
        let state = makeState(writers)
        let adapter = state.makePresenceAdapter()
        var old = CallPresenceSnapshot.idle
        func push(_ new: CallPresenceSnapshot) {
            adapter.presenceDidChange(old, new)
            old = new
        }

        push(Self.snapshot(phase: .connecting, revision: 1))
        #expect(writers.idleTimer == [true] && writers.proximity.isEmpty)
        push(Self.snapshot(phase: .live, revision: 2))
        #expect(writers.idleTimer == [true] && writers.proximity.isEmpty)
        push(Self.snapshot(phase: .live, proximityArmed: true, revision: 3))
        #expect(writers.proximity == [true])
        #expect(state.proximityState == .armed && state.proximityReadout == "armed")
        // Another field changes (unmute): no writer runs.
        push(Self.snapshot(phase: .live, isMuted: false, proximityArmed: true, revision: 4))
        #expect(writers.idleTimer == [true] && writers.proximity == [true])
        // Camera turned on: one release; off again: one arm.
        push(Self.snapshot(phase: .live, isMuted: false, isCameraOn: true, proximityArmed: false, revision: 5))
        push(Self.snapshot(phase: .live, isMuted: false, isCameraOn: false, proximityArmed: true, revision: 6))
        #expect(writers.proximity == [true, false, true])
        // Ending clears both, once each; idle afterwards writes nothing.
        push(Self.snapshot(phase: .ending, keepsScreenAwake: false, proximityArmed: false, revision: 7))
        push(Self.snapshot(phase: .idle, keepsScreenAwake: false, proximityArmed: false, revision: 8))
        #expect(writers.idleTimer == [true, false])
        #expect(writers.proximity == [true, false, true, false])
        #expect(state.idleTimerWriteCount == 2 && state.keepAwakeEdgeCount == 2 && state.proximityWriteCount == 4)
        #expect(state.proximityState == .off && state.awakeReadout == "0")
    }

    @Test func theLegacyGateAndThePresenceRuleShareOneIdleTimerWriter() {
        let writers = RecordingWriters()
        let state = makeState(writers)
        state.updateLegacyGate(false)
        #expect(writers.idleTimer.isEmpty)
        // Waiting (presence only), then joined (legacy too): one write.
        state.applyPresence(keepsAwake: true, armed: false)
        state.updateLegacyGate(true)
        #expect(writers.idleTimer == [true] && state.awakeReadout == "1")
        // Leave: the presence edge first, then the legacy gate; the timer clears once, after both.
        state.applyPresence(keepsAwake: false, armed: false)
        #expect(writers.idleTimer == [true])
        state.updateLegacyGate(false)
        #expect(writers.idleTimer == [true, false] && state.awakeReadout == "0")
    }

    @Test func androidLeavesTheWindowFlagToTheLegacyGateAndPublishesThePresenceRule() {
        let writers = RecordingWriters()
        let state = makeState(writers, presenceDrivesIdleTimer: false)
        state.applyPresence(keepsAwake: true, armed: false)
        // KeepScreenOnEffect reads keepsScreenAwake; SkipUI's FLAG_KEEP_SCREEN_ON is not written.
        #expect(state.keepsScreenAwake && writers.idleTimer.isEmpty && state.keepAwakeEdgeCount == 1)
        #expect(state.awakeReadout == "1")
        state.applyPresence(keepsAwake: true, armed: false)
        #expect(state.keepAwakeEdgeCount == 1)
        state.updateLegacyGate(true)
        state.updateLegacyGate(false)
        #expect(writers.idleTimer == [true, false])
        state.applyPresence(keepsAwake: false, armed: false)
        #expect(!state.keepsScreenAwake && writers.idleTimer == [true, false] && state.keepAwakeEdgeCount == 2)
        // The macOS host (like iOS) lets the presence rule drive the idle timer; only the SKIP build returns false.
        #expect(CallScreenAwake.presenceDrivesIdleTimer)
    }

    @Test func nearAndFarStayInsideTheControllerAndNeverReachThePresence() {
        let writers = RecordingWriters()
        let state = makeState(writers)
        let presence = CallPresence()
        var recorded = 0
        presence.adapters = CallPresenceAdapters([
            CallPresenceAdapter(name: "recording", presenceDidChange: { _, _ in recorded += 1 }),
            state.makePresenceAdapter()
        ])
        presence.apply(inputs(.entering))
        presence.apply(inputs(.inCall))
        let fanOuts = presence.adapterFanOutCount
        let revision = presence.snapshot.revision
        let recordedBefore = recorded
        // The arming edge as the adapter would deliver it, then a phone moving to the ear and away, twice.
        state.applyPresence(keepsAwake: true, armed: true)
        state.reportProximityNear(true)
        #expect(state.proximityState == .near && state.proximityReadout == "near")
        state.reportProximityNear(false)
        state.reportProximityNear(true)
        state.reportProximityNear(false)
        #expect(state.proximityState == .armed && state.proximityReadout == "armed")
        #expect(presence.adapterFanOutCount == fanOuts && presence.snapshot.revision == revision && recorded == recordedBefore)
        #expect(writers.proximity == [true])
    }

    @Test func theCameraOnEdgeWhileNearTurnsProximityOffAndARearmStartsFar() {
        let writers = RecordingWriters()
        let state = makeState(writers)
        state.applyPresence(keepsAwake: true, armed: true)
        state.reportProximityNear(true)
        #expect(state.proximityState == .near)
        // Camera on while at the ear: released (the platform waits for the sensor to clear before the screen returns).
        state.applyPresence(keepsAwake: true, armed: false)
        #expect(state.proximityState == .off && writers.proximity == [true, false])
        // A near report while released is ignored; re-arming starts far.
        state.reportProximityNear(true)
        #expect(state.proximityState == .off)
        state.applyPresence(keepsAwake: true, armed: true)
        #expect(state.proximityState == .armed)
        // Android lifecycle: the host pauses (lock released) and resumes (held again) without a snapshot edge.
        state.reportProximityMonitoring(active: false)
        #expect(state.proximityState == .off)
        state.reportProximityMonitoring(active: true)
        #expect(state.proximityState == .armed && writers.proximity == [true, false, true])
    }

    @Test func aDeviceWithoutASensorStaysOff() {
        let writers = RecordingWriters()
        writers.monitoringAvailable = false
        let state = makeState(writers)
        state.applyPresence(keepsAwake: true, armed: true)
        state.reportProximityNear(true)
        #expect(writers.proximity == [true])
        #expect(state.proximityState == .off && state.proximityReadout == "off")
    }

    // MARK: Presence wiring (HD/requests/B6-T8.md R1, R2): fails until the batch 6 integrator applies them

    @Test func presenceArmsProximityFromTheRouteOwnerAndTheMediaFields() {
        let writers = RecordingWriters()
        let state = makeState(writers)
        let presence = CallPresence()
        presence.adapters = CallPresenceAdapters([state.makePresenceAdapter()])
        let owner = AudioRouteOwner()
        owner.presence = presence

        presence.apply(inputs(.waiting))
        #expect(presence.snapshot.keepsScreenAwake && !presence.snapshot.proximityArmed)
        #expect(writers.idleTimer == [true])
        owner.publish(routes(current: "receiver"))
        // Waiting on the receiver with the camera off arms too (keep awake while waiting, 4 a).
        #expect(presence.snapshot.proximityArmed)
        presence.apply(inputs(.entering))
        presence.apply(inputs(.inCall))
        #expect(presence.snapshot.proximityArmed)
        #expect(writers.proximity == [true])

        presence.apply(inputs(.inCall, isCameraOff: false))
        #expect(!presence.snapshot.proximityArmed)
        presence.apply(inputs(.inCall))
        presence.apply(inputs(.inCall, isScreenSharing: true))
        #expect(!presence.snapshot.proximityArmed)
        presence.apply(inputs(.inCall))
        presence.reportPictureInPicture(active: true, availability: .active)
        #expect(!presence.snapshot.proximityArmed)
        presence.reportPictureInPicture(active: false, availability: .eligible)
        presence.apply(inputs(.inCall, isAppActive: false))
        #expect(!presence.snapshot.proximityArmed)
        presence.apply(inputs(.inCall))
        owner.publish(routes(current: "speaker"))
        #expect(!presence.snapshot.proximityArmed)
        owner.publish(routes(current: "bt-1"))
        #expect(!presence.snapshot.proximityArmed)
        owner.publish(routes(current: "receiver"))
        #expect(presence.snapshot.proximityArmed)
        #expect(writers.proximity == [true, false, true, false, true, false, true, false, true, false, true])

        // Recovering and on hold stay armed; leaving and home clear both.
        presence.apply(inputs(.recovering))
        #expect(presence.snapshot.proximityArmed && presence.snapshot.keepsScreenAwake)
        presence.apply(inputs(.inCall))
        presence.handle(.hold, source: .system, presenceSession: presence.snapshot.presenceSession)
        #expect(presence.snapshot.phase == .onHold && presence.snapshot.proximityArmed)
        presence.handle(.resume, source: .system, presenceSession: presence.snapshot.presenceSession)
        presence.apply(inputs(.leaving))
        #expect(!presence.snapshot.proximityArmed && !presence.snapshot.keepsScreenAwake)
        presence.apply(inputs(.home))
        #expect(!presence.snapshot.proximityArmed && !presence.snapshot.keepsScreenAwake)
        #expect(writers.idleTimer == [true, false])
        #expect(state.proximityState == .off)
    }

    @Test func theRouteSurvivesAPresenceReset() {
        let presence = CallPresence()
        let owner = AudioRouteOwner()
        owner.presence = presence
        owner.publish(routes(current: "receiver"))
        presence.apply(inputs(.entering))
        presence.apply(inputs(.inCall))
        #expect(presence.snapshot.proximityArmed)
        presence.reset()
        #expect(!presence.snapshot.proximityArmed)
        // The route is device state, not call state: the next call on the receiver arms without a new route report.
        presence.apply(inputs(.entering))
        presence.apply(inputs(.inCall))
        #expect(presence.snapshot.proximityArmed)
    }

    // MARK: System fixture (HD/requests/B6-T8.md R4): fails until the batch 6 integrator applies it

    @Test func theReceiverFixtureArmsProximityAndTheSpeakerReleasesIt() {
        guard let receiverState = SystemFixtureScript.state(named: "receiver-camera-off") else {
            Issue.record("SystemFixtureState receiver-camera-off is missing (HD/requests/B6-T8.md R4)")
            return
        }
        let session = SystemFixtureSession(state: receiverState)
        session.start()
        #expect(session.presenceReadout == "live/none/inactive/1")
        #expect(session.presence.snapshot.proximityArmed && session.presence.snapshot.keepsScreenAwake)
        // Switching the fixture route to the speaker releases it (S70 4 l2).
        let owner = AudioRouteOwner()
        owner.presence = session.presence
        owner.publish(routes(current: "speaker"))
        #expect(!session.presence.snapshot.proximityArmed)

        // presence-live stays on the speaker: awake, never armed.
        let live = SystemFixtureSession(state: .presenceLive)
        live.start()
        #expect(live.presence.snapshot.keepsScreenAwake && !live.presence.snapshot.proximityArmed)
        let ended = SystemFixtureSession(state: .presenceEnded)
        ended.start()
        #expect(!ended.presence.snapshot.keepsScreenAwake && !ended.presence.snapshot.proximityArmed)
    }

    // MARK: Source scans (S70 4 l3, SY8; 16 l6)

    @Test func proximityCallsLiveOnlyInTheIOSBranchOfCallScreenAwake() throws {
        let source = try sys5Source("Sources/Conclave/Core/Call/CallScreenAwake.swift")
        var region = "shared"
        var iosHits = 0
        var skipLines: [String] = []
        for rawLine in source.components(separatedBy: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("#if SKIP") {
                region = "skip"
                continue
            }
            if line.hasPrefix("#elseif os(iOS)") {
                region = "ios"
                continue
            }
            if line.hasPrefix("#else") {
                region = "other"
                continue
            }
            if line.hasPrefix("#endif") {
                region = "shared"
                continue
            }
            if line.hasPrefix("#if") {
                region = "conditional"
                continue
            }
            if line.hasPrefix("//") {
                continue
            }
            if region == "skip" {
                skipLines.append(line)
            }
            for token in ["UIDevice", "isProximityMonitoringEnabled", "proximityStateDidChangeNotification"] where line.contains(token) {
                #expect(region == "ios", "\(token) outside the #elseif os(iOS) branch: \(line)")
                iosHits += 1
            }
        }
        #expect(iosHits >= 4)
        // The SKIP branches keep SkipUI's idle timer mapping and hand proximity to the Kotlin controller.
        #expect(skipLines.contains("UIApplication.shared.isIdleTimerDisabled = active"))
        #expect(skipLines.contains("ProximityController.setArmed(armed)"))
        // Written only on change; iPad reads back false.
        #expect(source.contains("if device.isProximityMonitoringEnabled != armed {"))
        #expect(source.contains("CallScreenAwakeState.shared.reportProximityMonitoring(active: device.isProximityMonitoringEnabled)"))
        #expect(source.contains("CallScreenAwakeState.shared.reportProximityNear(UIDevice.current.proximityState)"))
        // The legacy gate stays (testNativeCallCorrectnessBlockersStayFixed pins the view model calls).
        #expect(source.contains("static func setActive(_ active: Bool) {"))
    }

    @Test func androidControllerHoldsTheProximityLockOnlyWhileArmedAndResumed() throws {
        let controller = try sys5Source("Sources/Conclave/Skip/ProximityController.kt")
        #expect(controller.contains("const val WAKE_LOCK_TAG = \"conclave:proximity\""))
        #expect(controller.contains("power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)"))
        #expect(controller.contains("power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, WAKE_LOCK_TAG)"))
        #expect(controller.contains("PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY"))
        #expect(controller.contains("if (wanted && hostResumed) {"))
        #expect(controller.contains("ProcessLifecycleOwner.get().lifecycle"))
        #expect(controller.contains("CallScreenAwakeState.shared.reportProximityMonitoring(active = isHeld)"))
        #expect(controller.contains("ApplicationInfo.FLAG_DEBUGGABLE"))
        // Compose-scoped keep awake with reference-counted holds.
        #expect(controller.contains("fun KeepScreenOnEffect(on: Boolean) {"))
        #expect(controller.contains("view.keepScreenOn = true"))
        #expect(controller.contains("KeepScreenOnEffect(CallScreenAwakeState.shared.keepsScreenAwake)"))
        #expect(controller.contains("Modifier.testTag(CallScreenAwakeReadout.awakeKey)"))
        #expect(controller.contains("Modifier.testTag(CallScreenAwakeReadout.proximityKey)"))
        // Event driven (4 k): no polling, no timers.
        for pattern in ["postDelayed", "Timer(", "while (true)", "delay("] {
            #expect(!controller.contains(pattern), "ProximityController uses \(pattern)")
        }
    }

    @Test func callServiceReleasesItsWakeLockOnEveryPathAndStaysUntimed() throws {
        let service = try sys5Source("Sources/Conclave/Skip/CallForegroundService.kt")
        let removed = try sys5Body(service, from: "override fun onTaskRemoved(rootIntent: Intent?) {", to: "super.onTaskRemoved(rootIntent)")
        let release = try #require(removed.range(of: "releaseCallWakeLock()"))
        let proximity = try #require(removed.range(of: "ProximityController.releaseNow()"))
        let leave = try #require(removed.range(of: "CallActionDispatcher.handleCurrentNow(SystemCallCommandKind.leave, SystemCallSource.system)"))
        #expect(release.lowerBound < leave.lowerBound && proximity.lowerBound < leave.lowerBound)
        #expect(removed.contains("} finally {\n            stopCallService()\n        }"))
        let stop = try sys5Body(service, from: "private fun stopCallService() {", to: "stopSelf()")
        #expect(stop.contains("releaseCallWakeLock()"))
        let destroy = try sys5Body(service, from: "override fun onDestroy() {", to: "super.onDestroy()")
        #expect(destroy.contains("releaseCallWakeLock()"))
        #expect(service.contains("ACTION_STOP -> {\n                stopCallService()"))
        // Untimed (revision 2): a timeout renewed only on updates would lapse in a static call with the screen off.
        let ensure = try sys5Body(service, from: "private fun ensureCallWakeLock() {", to: "private fun releaseCallWakeLock() {")
        #expect(ensure.contains("acquire()\n"))
        #expect(!ensure.contains("acquire(1") && !ensure.contains("acquire(TimeUnit") && !ensure.contains("acquire(timeout"))
        #expect(service.contains("internal val isCallWakeLockHeld: Boolean"))
    }

    @Test func ownedFilesKeepTheDesignAndTextRules() throws {
        let files = [
            "Sources/Conclave/Core/Call/ProximityPolicy.swift", "Sources/Conclave/Core/Call/CallScreenAwake.swift",
            "Sources/Conclave/Skip/ProximityController.kt", "Sources/Conclave/Skip/CallForegroundService.kt",
        ]
        for file in files {
            let text = try sys5Source(file)
            for pattern in ["conclaveGestureFeedback(", "HapticManager", "ConclaveHapticFeedback", "performHapticFeedback",
                            "FeedbackToken(", "Gradient", "Color(0x"] {
                #expect(!text.contains(pattern), "\(file) uses \(pattern)")
            }
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has a dash")
        }
        // The policy file stays pure (SX11): no platform import.
        let policy = try sys5Source("Sources/Conclave/Core/Call/ProximityPolicy.swift")
        #expect(!policy.contains("import UIKit") && !policy.contains("import SwiftUI") && !policy.contains("#if"))
    }

    /// The hooks HD/requests/B6-T8.md asks other owners for. Fails until the batch 6 integrator applies them.
    @Test func requestedHooksAreWired() throws {
        let sync = try sys5Source("Sources/Conclave/Core/Call/CallPresenceSync.swift")
        #expect(sync.contains("func reportAudioRoute(_ kind: AudioRouteKind) {"))
        #expect(sync.contains("ProximityPolicy.armedInCall("))
        #expect(sync.contains("keepsScreenAwake: KeepAwakePolicy.keepsScreenAwake(phase: phase),"))
        #expect(!sync.contains("proximityArmed: false,"))
        let owner = try sys5Source("Sources/Conclave/Core/Call/AudioRouteOwner.swift")
        #expect(owner.contains("presence?.reportAudioRoute(route.routeKind)"))
        let viewModel = try sys5Source("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        #expect(viewModel.contains("CallScreenAwake.makePresenceAdapter()"))
        #expect(viewModel.contains("callPresence.reportAudioRoute(AudioRouteOwner.shared.route.routeKind)"))
        #expect(viewModel.contains("CallScreenAwake.setActive(true)") && viewModel.contains("CallScreenAwake.setActive(false)"))
        let fixtures = try sys5Source("Sources/Conclave/Core/Call/SystemFixtures.swift")
        #expect(fixtures.contains("case receiverCameraOff = \"receiver-camera-off\""))
        #expect(fixtures.contains("func setAudioRoute(_ kind: AudioRouteKind) {"))
        let iosFixture = try sys5Source("Sources/Conclave/Core/Call/SystemFixtureView+iOS.swift")
        #expect(iosFixture.contains("CallScreenAwake.makePresenceAdapter()"))
        #expect(iosFixture.contains(".accessibilityIdentifier(CallScreenAwakeReadout.awakeKey)"))
        #expect(iosFixture.contains(".accessibilityIdentifier(CallScreenAwakeReadout.proximityKey)"))
        let androidFixture = try sys5Source("Sources/Conclave/Skip/ui/session/SystemFixtureRoot.kt")
        #expect(androidFixture.contains("CallScreenAwake.withScreenAwake(CallNotificationBridge.fixtureAdapters(it.presence))"))
        #expect(androidFixture.contains("CallKeepScreenOnEffect()"))
        #expect(androidFixture.contains("ScreenAwakeFixtureReadouts()"))
        let callRoot = try sys5Source("Sources/Conclave/Skip/ui/call/stage/CallRoot.kt")
        #expect(callRoot.contains("CallKeepScreenOnEffect()"))
        let premeeting = try sys5Source("Sources/Conclave/Skip/ui/home/PremeetingHost.kt")
        #expect(premeeting.contains("CallKeepScreenOnEffect()"))
        let presenceTests = try sys5Source("Tests/ConclaveTests/CallPresenceTests.swift")
        #expect(presenceTests.contains(".receiverCameraOff: \"live/none/inactive/1\""))
    }
}

private func sys5PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func sys5Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: sys5PackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private struct SYS5SourceRangeMissing: Error {
    let marker: String
}

/// The text between `start` and the first `end` after it.
private func sys5Body(_ source: String, from start: String, to end: String) throws -> String {
    guard let startRange = source.range(of: start) else { throw SYS5SourceRangeMissing(marker: start) }
    guard let endRange = source.range(of: end, range: startRange.upperBound..<source.endIndex) else {
        throw SYS5SourceRangeMissing(marker: end)
    }
    return String(source[startRange.upperBound..<endRange.lowerBound])
}
#endif
