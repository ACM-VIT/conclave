//
//  ScreenCaptureManager.swift
//  Conclave
//
//  Coordinates whole-device screen sharing via a ReplayKit Broadcast Upload
//  Extension (NOT in-app RPScreenRecorder, which can only capture this app's own
//  window). Standing up an App-Group socket server, then presenting the system
//  broadcast picker, lets the user share ANY app / their whole screen — the
//  extension streams JPEG frames back over the socket, which we decode and feed
//  into the WebRTC screen producer. Mirrors the working react-native-webrtc flow.
//

#if SKIP
enum ScreenCaptureManager {
    static var onProjectionRevoked: (() -> Void)?

    static func requestCapture() async -> Bool { fatalError() }
    static func isCaptureActive() -> Bool { fatalError() }
    static func stopCapture() { fatalError() }
}
#endif

#if canImport(UIKit) && !SKIP
import UIKit
import ReplayKit
import WebRTC
import Combine

/// Manages screen capture coordination between the broadcast extension and WebRTC.
@MainActor
final class ScreenCaptureManager: NSObject {
    static let shared = ScreenCaptureManager()

    // MARK: - Configuration
    private let appGroupIdentifier = "group.com.acmvit.conclave"
    private let broadcastExtensionBundleId = "com.acmvit.conclave.ScreenShareExtension"

    // MARK: - Publishers
    let isCapturing = CurrentValueSubject<Bool, Never>(false)
    let captureError = PassthroughSubject<Error, Never>()

    /// Invoked when the broadcast ends from OUTSIDE the app (Control Center /
    /// status bar / the extension's own timeout) so the meeting can tear down
    /// its producer and reset UI state. Set by MeetingViewModel.
    var onBroadcastStopped: (() -> Void)?

    /// How long to wait for the broadcast extension to actually connect after
    /// presenting the picker. Covers the user cancelling / dismissing the
    /// system sheet (matches the extension's own initialConnectionTimeout).
    private let startTimeout: TimeInterval = 12

    // MARK: - Properties
    private weak var webRTCClient: WebRTCClient?
    private var server: ScreenShareSocketServer?
    private var connected = false
    private var startGeneration = 0
    private var pendingStartContinuation: CheckedContinuation<Void, Error>?

    // MARK: - Public Methods

    var isCaptureActive: Bool {
        server != nil && connected
    }

    /// Stand up the socket server and present the system broadcast picker. The
    /// share becomes live once the user confirms the picker and the extension
    /// connects (frames then flow in via the server). Returns only after that
    /// connection is established, so callers do not mark the meeting as
    /// sharing when the user cancels the system sheet.
    func startCapture(webRTCClient: WebRTCClient) async throws {
        if server != nil {
            await stopCapture()
        }

        self.webRTCClient = webRTCClient
        self.connected = false
        startGeneration &+= 1
        let generation = startGeneration

        guard let server = ScreenShareSocketServer(appGroupIdentifier: appGroupIdentifier) else {
            throw ScreenCaptureError.appGroupUnavailable
        }

        let started = server.start(
            onFrame: { [weak self] box in
                // Hop to the main actor (WebRTCClient is @MainActor-isolated)
                // via DispatchQueue.main.async — it preserves FIFO order across
                // the hop, unlike unstructured Tasks which can reorder frames.
                DispatchQueue.main.async { [weak self] in
                    guard self?.startGeneration == generation else { return }
                    self?.webRTCClient?.feedScreenFrame(box.frame)
                }
            },
            onConnect: { [weak self] in
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    guard self.startGeneration == generation,
                          self.server != nil else { return }
                    self.connected = true
                    self.isCapturing.send(true)
                    self.finishPendingStart(.success(()))
                }
            },
            onDisconnect: { [weak self] in
                DispatchQueue.main.async { [weak self] in
                    guard self?.startGeneration == generation else { return }
                    self?.handleExternalStop()
                }
            }
        )
        guard started else {
            throw ScreenCaptureError.socketUnavailable
        }
        self.server = server

        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                pendingStartContinuation = continuation

                if Task.isCancelled {
                    cancelPendingStart(generation: generation)
                    return
                }

                presentBroadcastPicker()

                // If the extension never connects (the user cancelled or dismissed
                // the system sheet), tear everything back down so the share button
                // never flips to a dead producer.
                DispatchQueue.main.asyncAfter(deadline: .now() + startTimeout) { [weak self] in
                    guard let self else { return }
                    guard self.startGeneration == generation,
                          self.server != nil,
                          !self.connected else { return }
                    self.handleExternalStop()
                }
            }
        } onCancel: { [weak self] in
            Task { @MainActor in
                self?.cancelPendingStart(generation: generation)
            }
        }
    }

    /// Tear down from the app side (the in-app Share toggle). Closing the socket
    /// makes the extension's next write fail, which finishes the broadcast
    /// gracefully.
    func stopCapture() async {
        startGeneration &+= 1
        connected = false
        server?.stop()
        server = nil
        webRTCClient = nil
        isCapturing.send(false)
        finishPendingStart(.failure(ScreenCaptureError.cancelled))
    }

    // MARK: - Private

    private func handleExternalStop() {
        guard server != nil else { return }
        startGeneration &+= 1
        connected = false
        server?.stop()
        server = nil
        webRTCClient = nil
        isCapturing.send(false)
        finishPendingStart(.failure(ScreenCaptureError.cancelled))
        onBroadcastStopped?()
    }

    private func cancelPendingStart(generation: Int) {
        guard startGeneration == generation,
              pendingStartContinuation != nil else { return }
        startGeneration &+= 1
        connected = false
        server?.stop()
        server = nil
        webRTCClient = nil
        isCapturing.send(false)
        finishPendingStart(.failure(ScreenCaptureError.cancelled))
    }

    private func finishPendingStart(_ result: Result<Void, Error>) {
        guard let continuation = pendingStartContinuation else { return }
        pendingStartContinuation = nil
        switch result {
        case .success:
            continuation.resume()
        case .failure(let error):
            continuation.resume(throwing: error)
        }
    }

    private func presentBroadcastPicker() {
        let picker = RPSystemBroadcastPickerView(
            frame: CGRect(x: 0, y: 0, width: 1, height: 1)
        )
        picker.preferredExtension = broadcastExtensionBundleId
        picker.showsMicrophoneButton = false

        // The picker must be in the view hierarchy to present its system sheet.
        if let window = Self.keyWindow {
            window.addSubview(picker)
        }

        // Programmatically tap the internal button to surface the system sheet.
        for subview in picker.subviews {
            if let button = subview as? UIButton {
                button.sendActions(for: .touchUpInside)
                break
            }
        }

        // Remove the throwaway picker shortly after; the system sheet is its own
        // presentation and outlives this view.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            picker.removeFromSuperview()
        }
    }

    private static var keyWindow: UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }
            ?? UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap { $0.windows }
                .first
    }
}

// MARK: - Errors
enum ScreenCaptureError: Error, LocalizedError, Equatable {
    case appGroupUnavailable
    case socketUnavailable
    case cancelled

    var errorDescription: String? {
        switch self {
        case .appGroupUnavailable:
            return "Screen sharing is not configured (App Group unavailable)."
        case .socketUnavailable:
            return "Could not start screen sharing. Please try again."
        case .cancelled:
            return "Screen sharing was cancelled."
        }
    }
}

#endif
