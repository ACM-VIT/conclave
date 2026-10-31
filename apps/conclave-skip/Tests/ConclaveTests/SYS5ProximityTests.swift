#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct SYS5ProximityTests {

    @MainActor
    final class RecordingWriters {
        var idleTimer: [Bool] = []
        var proximity: [Bool] = []

        var monitoringAvailable = true
        weak var state: CallScreenAwakeState?

        func make() -> ScreenAwakeWriters {
            ScreenAwakeWriters(
                setIdleTimerDisabled: { active in
                    self.idleTimer.append(active)
                },
                setProximityMonitoring: { armed in
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

    @Test func proximityArmsOnlyOnTheReceiverWithTheCameraOffNotPresentingNotInPipAndActive() {

        #expect(ProximityPolicy.armed(route: .receiver, isCameraOn: false, isPresenting: false, isInPip: false, isAppActive: true))

        #expect(!ProximityPolicy.armed(route: .receiver, isCameraOn: true, isPresenting: false, isInPip: false, isAppActive: true))
        #expect(!ProximityPolicy.armed(route: .receiver, isCameraOn: false, isPresenting: true, isInPip: false, isAppActive: true))
        #expect(!ProximityPolicy.armed(route: .receiver, isCameraOn: false, isPresenting: false, isInPip: true, isAppActive: true))
        #expect(!ProximityPolicy.armed(route: .receiver, isCameraOn: false, isPresenting: false, isInPip: false, isAppActive: false))

        for route in AudioRouteKind.allCases where route != .receiver {
            #expect(!ProximityPolicy.armed(route: route, isCameraOn: false, isPresenting: false, isInPip: false, isAppActive: true),
                    "\(route)")
        }
    }

    @Test func keepAwakeAndArmingFollowThePhase() {
        let inProgress: Set<CallPresencePhase> = [.waiting, .connecting, .live, .recovering, .onHold]
        for phase in CallPresencePhase.allCases {

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

        #expect(ProximityPolicy.state(armed: true, monitoringActive: false, isNear: false) == .off)
        #expect(ProximityPolicy.state(armed: true, monitoringActive: false, isNear: true) == .off)
        #expect(ProximityPolicy.state(armed: true, monitoringActive: true, isNear: false) == .armed)
        #expect(ProximityPolicy.state(armed: true, monitoringActive: true, isNear: true) == .near)
        #expect(ProximityState.allCases.map { ProximityPolicy.readout($0) } == ["off", "armed", "near"])
        #expect(KeepAwakePolicy.readout(true) == "1" && KeepAwakePolicy.readout(false) == "0")
        #expect(CallScreenAwakeReadout.awakeKey == "sys.awake" && CallScreenAwakeReadout.proximityKey == "sys.proximity")
    }

    @Test func idleTimerCombinesTheLegacyGateWithThePresenceRuleOnIOSOnly() {

        #expect(KeepAwakePolicy.idleTimerDisabled(legacyActive: false, presenceKeepsAwake: true, presenceDrivesIdleTimer: true))
        #expect(KeepAwakePolicy.idleTimerDisabled(legacyActive: true, presenceKeepsAwake: false, presenceDrivesIdleTimer: true))
        #expect(!KeepAwakePolicy.idleTimerDisabled(legacyActive: false, presenceKeepsAwake: false, presenceDrivesIdleTimer: true))

        #expect(!KeepAwakePolicy.idleTimerDisabled(legacyActive: false, presenceKeepsAwake: true, presenceDrivesIdleTimer: false))
        #expect(KeepAwakePolicy.idleTimerDisabled(legacyActive: true, presenceKeepsAwake: false, presenceDrivesIdleTimer: false))
    }

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

        push(Self.snapshot(phase: .live, isMuted: false, proximityArmed: true, revision: 4))
        #expect(writers.idleTimer == [true] && writers.proximity == [true])

        push(Self.snapshot(phase: .live, isMuted: false, isCameraOn: true, proximityArmed: false, revision: 5))
        push(Self.snapshot(phase: .live, isMuted: false, isCameraOn: false, proximityArmed: true, revision: 6))
        #expect(writers.proximity == [true, false, true])

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

        state.applyPresence(keepsAwake: true, armed: false)
        state.updateLegacyGate(true)
        #expect(writers.idleTimer == [true] && state.awakeReadout == "1")

        state.applyPresence(keepsAwake: false, armed: false)
        #expect(writers.idleTimer == [true])
        state.updateLegacyGate(false)
        #expect(writers.idleTimer == [true, false] && state.awakeReadout == "0")
    }

    @Test func androidLeavesTheWindowFlagToTheLegacyGateAndPublishesThePresenceRule() {
        let writers = RecordingWriters()
        let state = makeState(writers, presenceDrivesIdleTimer: false)
        state.applyPresence(keepsAwake: true, armed: false)

        #expect(state.keepsScreenAwake && writers.idleTimer.isEmpty && state.keepAwakeEdgeCount == 1)
        #expect(state.awakeReadout == "1")
        state.applyPresence(keepsAwake: true, armed: false)
        #expect(state.keepAwakeEdgeCount == 1)
        state.updateLegacyGate(true)
        state.updateLegacyGate(false)
        #expect(writers.idleTimer == [true, false])
        state.applyPresence(keepsAwake: false, armed: false)
        #expect(!state.keepsScreenAwake && writers.idleTimer == [true, false] && state.keepAwakeEdgeCount == 2)

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

        state.applyPresence(keepsAwake: true, armed: false)
        #expect(state.proximityState == .off && writers.proximity == [true, false])

        state.reportProximityNear(true)
        #expect(state.proximityState == .off)
        state.applyPresence(keepsAwake: true, armed: true)
        #expect(state.proximityState == .armed)

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

        presence.apply(inputs(.entering))
        presence.apply(inputs(.inCall))
        #expect(presence.snapshot.proximityArmed)
    }

    @Test func theReceiverFixtureArmsProximityAndTheSpeakerReleasesIt() {
        guard let receiverState = SystemFixtureScript.state(named: "receiver-camera-off") else {
            Issue.record("SystemFixtureState receiver-camera-off is missing (HD/requests/B6-T8.md R4)")
            return
        }
        let session = SystemFixtureSession(state: receiverState)
        session.start()
        #expect(session.presenceReadout == "live/none/inactive/1")
        #expect(session.presence.snapshot.proximityArmed && session.presence.snapshot.keepsScreenAwake)

        let owner = AudioRouteOwner()
        owner.presence = session.presence
        owner.publish(routes(current: "speaker"))
        #expect(!session.presence.snapshot.proximityArmed)

        let live = SystemFixtureSession(state: .presenceLive)
        live.start()
        #expect(live.presence.snapshot.keepsScreenAwake && !live.presence.snapshot.proximityArmed)
        let ended = SystemFixtureSession(state: .presenceEnded)
        ended.start()
        #expect(!ended.presence.snapshot.keepsScreenAwake && !ended.presence.snapshot.proximityArmed)
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

private func sys5Body(_ source: String, from start: String, to end: String) throws -> String {
    guard let startRange = source.range(of: start) else { throw SYS5SourceRangeMissing(marker: start) }
    guard let endRange = source.range(of: end, range: startRange.upperBound..<source.endIndex) else {
        throw SYS5SourceRangeMissing(marker: end)
    }
    return String(source[startRange.upperBound..<endRange.lowerBound])
}
#endif
