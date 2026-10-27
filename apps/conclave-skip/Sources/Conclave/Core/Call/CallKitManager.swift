//  iOS VoIP system call presence via CallKit: the real `CXProvider` and
//  `CXCallController` behind `CallProviding` (S70 SX2). `CallKitPresenceAdapter`
//  decides what to report from `CallPresence` snapshot diffs
//  (`CallKitReportPolicy`); this file only performs the CallKit calls and
//  forwards the provider delegate's actions back to the adapter.
//
//  While in a meeting this gives the person the system call UI on the lock
//  screen and in the Dynamic Island, mute and end controls that drive the real
//  call, and audio that keeps flowing in the background (UIBackgroundModes has
//  audio; CallKit activates the audio session).
//

#if os(iOS) && !SKIP
import Foundation
import CallKit
import AVFoundation
import UIKit

@MainActor
final class CallKitManager: NSObject, CallProviding {
    static let shared = CallKitManager()

    private let provider: CXProvider
    private let callController = CXCallController()
    weak var actionHandler: CallProviderActionHandler?

    private override init() {
        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = true
        configuration.maximumCallsPerCallGroup = 1
        configuration.maximumCallGroups = 1
        // Only supportedHandleTypes .generic - we don't dial phone numbers.
        configuration.supportedHandleTypes = [.generic]
        // O1: the handle is a room code, not a person, and redial would need App Intents plumbing.
        configuration.includesCallsInRecents = false
        // SX9: single-color template glyph (the simplified diamond); the system tints it.
        if let template = UIImage(named: "CallKitIcon")?.pngData() {
            configuration.iconTemplateImageData = template
        }
        self.provider = CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    // MARK: - CallProviding

    func requestStart(uuid: UUID, handle: String, isVideo: Bool, completion: @escaping (Bool) -> Void) {
        let startCallAction = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: handle))
        startCallAction.isVideo = isVideo
        callController.request(CXTransaction(action: startCallAction)) { error in
            if let error = error {
                debugLog("[CallKit] startCall request failed: \(error.localizedDescription)")
            }
            Task { @MainActor in completion(error == nil) }
        }
    }

    func reportConnecting(uuid: UUID) {
        provider.reportOutgoingCall(with: uuid, startedConnectingAt: Date())
    }

    func reportConnected(uuid: UUID, at date: Date) {
        provider.reportOutgoingCall(with: uuid, connectedAt: date)
    }

    func reportUpdate(uuid: UUID, handle: String, callerName: String, hasVideo: Bool) {
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: handle)
        update.localizedCallerName = callerName
        update.hasVideo = hasVideo
        update.supportsHolding = true
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        provider.reportCall(with: uuid, updated: update)
    }

    func requestSetMuted(uuid: UUID, muted: Bool, completion: @escaping (Bool) -> Void) {
        let muteAction = CXSetMutedCallAction(call: uuid, muted: muted)
        callController.request(CXTransaction(action: muteAction)) { error in
            if let error = error {
                debugLog("[CallKit] setMuted request failed: \(error.localizedDescription)")
            }
            Task { @MainActor in completion(error == nil) }
        }
    }

    func requestEnd(uuid: UUID, completion: @escaping (Bool) -> Void) {
        callController.request(CXTransaction(action: CXEndCallAction(call: uuid))) { error in
            if let error = error {
                debugLog("[CallKit] endCall request failed: \(error.localizedDescription)")
            }
            Task { @MainActor in completion(error == nil) }
        }
    }

    func reportEnded(uuid: UUID, failed: Bool) {
        provider.reportCall(with: uuid, endedAt: Date(), reason: failed ? .failed : .remoteEnded)
    }
}

// MARK: - CXProviderDelegate

extension CallKitManager: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {
        Task { @MainActor in
            self.actionHandler?.providerDidReset()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        // Configure the audio session for the call before fulfilling, then the
        // system calls didActivate where we actually start the WebRTC audio path.
        Self.configureAudioSession()
        action.fulfill()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let uuid = action.callUUID
        Task { @MainActor in
            // The adapter fulfills its own local end and the system's end alike; only a system end reaches leave().
            _ = self.actionHandler?.providerEnd(uuid: uuid)
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        let uuid = action.callUUID
        let muted = action.isMuted
        Task { @MainActor in
            // Fulfill on dispatched or alreadyInEffect (the echo of an in-app mute); fail otherwise, so the system
            // button never shows a state the call does not have.
            if self.actionHandler?.providerSetMuted(uuid: uuid, muted: muted) == true {
                action.fulfill()
            } else {
                action.fail()
            }
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
        let uuid = action.callUUID
        let held = action.isOnHold
        Task { @MainActor in
            if self.actionHandler?.providerSetHeld(uuid: uuid, held: held) == true {
                action.fulfill()
            } else {
                action.fail()
            }
        }
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
