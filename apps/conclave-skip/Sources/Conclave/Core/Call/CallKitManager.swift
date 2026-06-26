//  iOS VoIP system call presence via CallKit. While in a meeting this reports
//  an ongoing call to the OS so the user gets:
//    - the system call UI on the lock screen + Dynamic Island
//    - mute + end controls that drive the real call (via CallSessionCoordinator)
//    - audio that keeps flowing in the background (UIBackgroundModes has audio;
//      CallKit activates the audio session for us)
//
//  Apple's CallKit is the canonical VoIP background path, so we use it instead
//  of a bare local notification.
//

#if os(iOS) && !SKIP
import Foundation
import CallKit
import AVFoundation

@MainActor
final class CallKitManager: NSObject {
    static let shared = CallKitManager()

    private let provider: CXProvider
    private let callController = CXCallController()

    /// The UUID of the call currently reported to CallKit, if any.
    private(set) var activeCallUUID: UUID?
    private var reportedMuted: Bool?
    private var didReportConnectedCall = false

    private override init() {
        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = true
        configuration.maximumCallsPerCallGroup = 1
        configuration.maximumCallGroups = 1
        // Only supportedHandleTypes .generic — we don't dial phone numbers.
        configuration.supportedHandleTypes = [.generic]
        self.provider = CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    // MARK: - Reporting the call

    /// Report an ongoing outgoing call to CallKit when the user joins a meeting.
    /// Idempotent — calling it while a call is already reported is a no-op.
    func reportCallStarted(title: String) {
        guard activeCallUUID == nil else { return }
        let uuid = UUID()
        activeCallUUID = uuid
        reportedMuted = nil
        didReportConnectedCall = false

        let handle = CXHandle(type: .generic, value: title)
        let startCallAction = CXStartCallAction(call: uuid, handle: handle)
        startCallAction.isVideo = false
        let transaction = CXTransaction(action: startCallAction)
        callController.request(transaction) { [weak self] error in
            if let error = error {
                debugLog("[CallKit] startCall request failed: \(error.localizedDescription)")
                // CallKit refused the call (e.g. another app owns the call UI).
                // Drop our bookkeeping so we don't get wedged — but only if this
                // failure is for the call we still think is active (a fast
                // leave/rejoin could have replaced it).
                Task { @MainActor in
                    if self?.activeCallUUID == uuid {
                        self?.activeCallUUID = nil
                        self?.reportedMuted = nil
                        self?.didReportConnectedCall = false
                    }
                }
                return
            }
            // Mark the call as connected so it shows as in-progress (timer runs).
            // Guard on the captured uuid so a stale callback from a previous call
            // doesn't report-connected on a newer one.
            Task { @MainActor in
                guard let self = self, self.activeCallUUID == uuid else { return }
                self.provider.reportOutgoingCall(with: uuid, connectedAt: Date())
                self.didReportConnectedCall = true
            }
        }
    }

    /// Tell CallKit the call ended (user left, kicked, host ended, error). Called
    /// from the meeting teardown so the system call UI dismisses.
    func reportCallEnded() {
        guard let uuid = activeCallUUID else { return }
        provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
        activeCallUUID = nil
        reportedMuted = nil
        didReportConnectedCall = false
    }

    /// Reflect the in-app mute state onto the CallKit call UI so the system mute
    /// glyph matches the app (e.g. when the user mutes from the in-app button).
    func updateMuteState(muted: Bool) {
        guard let uuid = activeCallUUID else { return }
        let previousMuted = reportedMuted
        guard previousMuted != muted else { return }
        reportedMuted = muted

        let muteAction = CXSetMutedCallAction(call: uuid, muted: muted)
        let transaction = CXTransaction(action: muteAction)
        callController.request(transaction) { [weak self] error in
            if let error = error {
                debugLog("[CallKit] setMuted request failed: \(error.localizedDescription)")
                Task { @MainActor in
                    if self?.activeCallUUID == uuid, self?.reportedMuted == muted {
                        self?.reportedMuted = previousMuted
                    }
                }
            }
        }
    }
}

// MARK: - CXProviderDelegate

extension CallKitManager: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {
        Task { @MainActor in
            let shouldLeaveCall = self.didReportConnectedCall
            self.activeCallUUID = nil
            self.reportedMuted = nil
            self.didReportConnectedCall = false
            guard shouldLeaveCall else { return }
            CallSessionCoordinator.shared.leaveCall()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        // Configure the audio session for the call before fulfilling, then the
        // system calls didActivate where we actually start the WebRTC audio path.
        Self.configureAudioSession()
        action.fulfill()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        Task { @MainActor in
            // Only drive the app if THIS is our active call (avoid a feedback
            // loop when WE reported the end).
            if self.activeCallUUID == action.callUUID {
                self.activeCallUUID = nil
                self.reportedMuted = nil
                CallSessionCoordinator.shared.leaveCall()
            }
        }
        action.fulfill()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        let muted = action.isMuted
        Task { @MainActor in
            guard self.activeCallUUID == action.callUUID else { return }
            self.reportedMuted = muted
            CallSessionCoordinator.shared.setMuted(muted)
        }
        action.fulfill()
    }

    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        // CallKit has activated the shared audio session for us. Make sure the
        // WebRTC audio unit is (re)started against it. The WebRTC stack reads
        // AVAudioSession.sharedInstance(), which is this session.
        debugLog("[CallKit] didActivate audio session")
        Task { @MainActor in
            CallAudioSession.shared.handleCallKitActivation()
        }
    }

    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        debugLog("[CallKit] didDeactivate audio session")
    }

    /// Configure the shared audio session for a voice/video call. Mirrors the
    /// category WebRTCClient uses so CallKit's activation lands on the right
    /// configuration.
    nonisolated static func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: CallAudioSession.voiceCallCategoryOptions(for: session)
            )
        } catch {
            debugLog("[CallKit] configureAudioSession failed: \(error.localizedDescription)")
        }
    }
}
#endif
