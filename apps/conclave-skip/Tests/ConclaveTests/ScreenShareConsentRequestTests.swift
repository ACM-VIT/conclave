#if os(macOS) && !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
final class FakeScreenShareConsent: ScreenShareConsentPort {
    private let calls: HeldStubCalls
    var onProjectionRevoked: (() -> Void)?
    private(set) var consent: Int?
    private(set) var serviceRunning = false
    private(set) var issued: [Int] = []
    var refusesNext: ScreenShareFailure?
    var stopsProjectionOnGrant = false
    var afterGrant: (() -> Void)?
    private var failure = ScreenShareFailure.none
    private var inFlight = false

    init(calls: HeldStubCalls) {
        self.calls = calls
    }

    var holdsAnything: Bool { consent != nil || serviceRunning }

    func requestConsent() async -> Int? {
        guard !inFlight else { return nil }
        inFlight = true
        defer { inFlight = false }
        failure = ScreenShareFailure.none
        do {
            try await calls.pass("requestConsent", generation: 0)
        } catch {
            failure = ScreenShareFailure.cancelled
            return nil
        }
        if let refused = refusesNext {
            refusesNext = nil
            failure = refused
            return nil
        }
        let grant = (issued.last ?? 0) + 1
        issued.append(grant)
        consent = grant
        serviceRunning = !stopsProjectionOnGrant
        afterGrant?()
        afterGrant = nil
        return grant
    }

    func lastConsentFailure() -> ScreenShareFailure { failure }

    func isConsentActive(_ grant: Int) -> Bool { consent == grant && serviceRunning }

    func releaseConsent(_ grant: Int) {
        guard consent == grant else { return }
        consent = nil
        serviceRunning = false
    }

    func stopCapture() {
        consent = nil
        serviceRunning = false
    }
}

@MainActor
private final class ConsentShareCall {
    let call = RejoinHarness()
    let consent: FakeScreenShareConsent

    init() {
        consent = FakeScreenShareConsent(calls: call.calls)
        call.viewModel.screenShareConsent = consent
        call.media.testReleasesScreenConsent = { [weak consent] grant in consent?.releaseConsent(grant) }
    }

    var viewModel: MeetingViewModel { call.viewModel }
    var phase: ScreenSharePhase { viewModel.screenShare.phase }

    func ended(_ count: Int) async -> Bool {
        await settle { self.call.endedToggleCount("toggleScreenShare") == count }
    }

    func openConsentDialog() async -> Bool {
        call.calls.hold("requestConsent")
        viewModel.toggleScreenShare()
        return await settle { self.call.calls.isHolding("requestConsent") }
    }

    func holdStart() {
        call.calls.hold("startScreenSharing")
    }

    func startIsHeld() async -> Bool {
        await settle { self.call.calls.isHolding("startScreenSharing") }
    }

    func rejoinWithUnconfiguredClient() async -> Bool {
        call.media.isConfigured = false
        let calls = call.calls
        calls.hold("joinFetch")
        viewModel.testJoinFetch = { try await calls.pass("joinFetch", generation: 0) }
        let teardowns = call.joinAttemptCount
        viewModel.state.connectionState = .reconnecting
        viewModel.state.isRecoveringConnection = true
        viewModel.shouldRejoinAfterReconnect = true
        await viewModel.rejoinIfPossible()
        guard await settle({ calls.isHolding("joinFetch") }) else { return false }
        return call.joinAttemptCount == teardowns
    }

    func reconfigure() {
        call.media.configure(
            socketManager: viewModel.socketManager,
            rtpCapabilities: RtpCapabilities(codecs: nil, headerExtensions: nil),
            iceServersJSON: nil
        )
    }

    func holdsNothing() -> Bool {
        !consent.holdsAnything && call.media.testScreenShareGrant == nil
    }

    func settledOff() -> Bool {
        !viewModel.state.isScreenSharing
            && phase != ScreenSharePhase.choosing
            && phase != ScreenSharePhase.starting
            && phase != ScreenSharePhase.stopping
    }

    func finish() async {
        viewModel.screenShareConsent = nil
        call.media.testReleasesScreenConsent = nil
        await call.finish()
    }
}

@Suite(.serialized)
@MainActor
struct ScreenShareConsentRequestTests {
    @Test
    func aConsentApprovedAfterAnUnconfiguredRecoveryReleasesItsConsentServiceAndNotification() async {
        let share = ConsentShareCall()
        #expect(await share.call.join(muted: true))
        #expect(await share.openConsentDialog())
        #expect(share.phase == ScreenSharePhase.choosing)

        #expect(await share.rejoinWithUnconfiguredClient(), "recovery cleaned up an unconfigured client")
        #expect(share.call.media.testScreenShareGrant == nil, "a capture session existed before the dialog closed")

        share.call.calls.release("requestConsent")
        #expect(await share.ended(1))
        #expect(share.consent.issued == [1])
        #expect(share.consent.consent == nil, "the stale request kept its consent")
        #expect(!share.consent.serviceRunning, "the stale request kept its share service and notification")
        #expect(share.settledOff(), "the share phase stayed \(share.phase.rawValue)")
        await share.finish()
    }

    @Test
    func aStaleRequestReleasesOnlyItsOwnConsentAndLeavesANewerRequestAlone() async {
        let share = ConsentShareCall()
        #expect(await share.call.join(muted: true))
        #expect(await share.openConsentDialog())
        #expect(await share.rejoinWithUnconfiguredClient())

        share.consent.afterGrant = { [share] in
            share.call.markJoined()
            share.call.calls.hold("requestConsent")
            share.viewModel.toggleScreenShare()
        }
        share.call.calls.release("requestConsent")
        #expect(await share.ended(1))
        #expect(await settle { share.call.calls.isHolding("requestConsent") }, "the newer request never opened its dialog")
        #expect(share.consent.consent == nil)
        #expect(!share.consent.serviceRunning)
        #expect(share.phase == ScreenSharePhase.choosing, "the stale request settled the newer request's phase")

        share.call.calls.release("requestConsent")
        #expect(await share.ended(2))
        #expect(share.consent.issued == [1, 2])
        #expect(share.consent.consent == 2, "the stale request released the newer request's consent")
        #expect(share.consent.serviceRunning)
        #expect(share.call.media.testScreenShareGrant == 2)
        #expect(share.viewModel.state.isScreenSharing)
        #expect(share.phase == ScreenSharePhase.live)
        await share.finish()
    }

    @Test
    func anOrphanedStartThatARecoveryConfigureEndsDoesNotLeaveThePhaseStarting() async {
        let share = ConsentShareCall()
        #expect(await share.call.join(muted: true))
        share.holdStart()
        share.viewModel.toggleScreenShare()
        #expect(await share.startIsHeld())
        #expect(share.phase == ScreenSharePhase.starting)

        #expect(await share.rejoinWithUnconfiguredClient())
        share.reconfigure()
        share.call.calls.release("startScreenSharing")
        #expect(await share.ended(1))
        #expect(share.holdsNothing())
        #expect(share.settledOff(), "the share phase stayed \(share.phase.rawValue)")
        await share.finish()
    }

    enum StaleExit: String, CaseIterable, CustomTestStringConvertible {
        case consentAfterRecovery
        case consentAfterAudioOnly
        case consentWithProjectionStopped
        case consentRefused
        case startRefused
        case startAfterRecovery
        case startAfterRecoveryConfigure
        case startAfterConfiguredRecovery
        case startAfterAudioOnly

        var testDescription: String { rawValue }
    }

    @Test(arguments: StaleExit.allCases)
    func everyExitBeforeTheShareGoesLiveHoldsNothing(_ exit: StaleExit) async {
        let share = ConsentShareCall()
        #expect(await share.call.join(muted: true))
        switch exit {
        case .consentAfterRecovery:
            #expect(await share.openConsentDialog())
            #expect(await share.rejoinWithUnconfiguredClient())
            share.call.calls.release("requestConsent")
        case .consentAfterAudioOnly:
            #expect(await share.openConsentDialog())
            share.viewModel.setAudioOnlyMode(true)
            share.call.calls.release("requestConsent")
        case .consentWithProjectionStopped:
            share.consent.stopsProjectionOnGrant = true
            share.viewModel.toggleScreenShare()
        case .consentRefused:
            share.consent.refusesNext = ScreenShareFailure.cancelled
            share.viewModel.toggleScreenShare()
        case .startRefused:
            share.call.media.testRefusesScreenShareStart = true
            share.viewModel.toggleScreenShare()
        case .startAfterRecovery:
            share.holdStart()
            share.viewModel.toggleScreenShare()
            #expect(await share.startIsHeld())
            #expect(await share.rejoinWithUnconfiguredClient())
            share.call.calls.release("startScreenSharing")
        case .startAfterRecoveryConfigure:
            share.holdStart()
            share.viewModel.toggleScreenShare()
            #expect(await share.startIsHeld())
            #expect(await share.rejoinWithUnconfiguredClient())
            share.reconfigure()
            share.call.calls.release("startScreenSharing")
        case .startAfterConfiguredRecovery:
            share.holdStart()
            share.viewModel.toggleScreenShare()
            #expect(await share.startIsHeld())
            #expect(await share.call.rejoin())
            share.call.calls.release("startScreenSharing")
        case .startAfterAudioOnly:
            share.holdStart()
            share.viewModel.toggleScreenShare()
            #expect(await share.startIsHeld())
            share.viewModel.setAudioOnlyMode(true)
            share.call.calls.release("startScreenSharing")
        }
        #expect(await share.ended(1))
        #expect(share.consent.consent == nil, "\(exit.rawValue) kept its consent")
        #expect(!share.consent.serviceRunning, "\(exit.rawValue) kept its share service and notification")
        #expect(share.call.media.testScreenShareGrant == nil, "\(exit.rawValue) kept its published share")
        #expect(share.settledOff(), "\(exit.rawValue) left the share phase \(share.phase.rawValue)")
        await share.finish()
    }

    @Test
    func aShareThatGoesLiveHandsItsConsentToTheCall() async {
        let share = ConsentShareCall()
        #expect(await share.call.join(muted: true))
        share.viewModel.toggleScreenShare()
        #expect(await share.ended(1))
        #expect(share.consent.consent == 1)
        #expect(share.consent.serviceRunning)
        #expect(share.call.media.testScreenShareGrant == 1)
        #expect(share.viewModel.state.isScreenSharing)
        #expect(share.phase == ScreenSharePhase.live)

        share.viewModel.toggleScreenShare()
        #expect(await share.ended(2))
        #expect(share.holdsNothing())
        #expect(share.settledOff())
        await share.finish()
    }
}
#endif
