

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

        configuration.supportedHandleTypes = [.generic]

        configuration.includesCallsInRecents = false

        if let template = UIImage(named: "CallKitIcon")?.pngData() {
            configuration.iconTemplateImageData = template
        }
        self.provider = CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

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

    func requestSetHeld(uuid: UUID, onHold: Bool, completion: @escaping (Bool) -> Void) {
        let heldAction = CXSetHeldCallAction(call: uuid, onHold: onHold)
        callController.request(CXTransaction(action: heldAction)) { error in
            if let error = error {
                debugLog("[CallKit] setHeld request failed: \(error.localizedDescription)")
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

extension CallKitManager: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {
        Task { @MainActor in
            self.actionHandler?.providerDidReset()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {

        Self.configureAudioSession()
        action.fulfill()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let uuid = action.callUUID
        Task { @MainActor in

            _ = self.actionHandler?.providerEnd(uuid: uuid)
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        let uuid = action.callUUID
        let muted = action.isMuted
        Task { @MainActor in

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

        debugLog("[CallKit] didActivate audio session")
        Task { @MainActor in
            CallAudioSession.shared.handleCallKitActivation()
        }
    }

    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        debugLog("[CallKit] didDeactivate audio session")
        Task { @MainActor in

            CallAudioSession.shared.handleCallKitDeactivation()
        }
    }

    nonisolated static func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {

            try CallAudioSession.configureCallCategory(on: session, options: CallAudioSession.voiceCallCategoryOptions(for: session))
        } catch {
            debugLog("[CallKit] configureAudioSession failed: \(error.localizedDescription)")
        }
    }
}
#endif
