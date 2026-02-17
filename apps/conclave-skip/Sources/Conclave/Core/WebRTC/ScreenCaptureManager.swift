//
//  ScreenCaptureManager.swift
//  Conclave
//
//  Manages ReplayKit screen capture and WebRTC integration.
//  Uses in-app capture via RPScreenRecorder (no broadcast extension required).
//

#if canImport(UIKit) && !SKIP
import UIKit
import ReplayKit
import WebRTC
import Combine

/// Manages screen capture coordination between ReplayKit and WebRTC.
@MainActor
final class ScreenCaptureManager: NSObject {
    static let shared = ScreenCaptureManager()

    // MARK: - Publishers
    let isCapturing = CurrentValueSubject<Bool, Never>(false)
    let captureError = PassthroughSubject<Error, Never>()

    // MARK: - Properties
    private let recorder = RPScreenRecorder.shared()
    private weak var webRTCClient: WebRTCClient?

    // MARK: - Public Methods

    /// Start screen capture with WebRTC integration
    func startCapture(webRTCClient: WebRTCClient) async throws {
        guard recorder.isAvailable else {
            throw ScreenCaptureError.recordingNotAvailable
        }

        if recorder.isRecording {
            self.webRTCClient = webRTCClient
            isCapturing.send(true)
            return
        }

        self.webRTCClient = webRTCClient

        try await withCheckedThrowingContinuation { continuation in
            recorder.startCapture { [weak self] sampleBuffer, bufferType, error in
                if let error = error {
                    self?.captureError.send(error)
                    return
                }

                guard bufferType == .video,
                      let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
                    return
                }

                let timestamp = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
                let timeStampNs = Int64(timestamp * 1_000_000_000)
                let rtcPixelBuffer = RTCCVPixelBuffer(pixelBuffer: pixelBuffer)
                let frame = RTCVideoFrame(buffer: rtcPixelBuffer, rotation: ._0, timeStampNs: timeStampNs)

                DispatchQueue.main.async {
                    self?.webRTCClient?.feedScreenFrame(frame)
                }
            } completionHandler: { [weak self] error in
                if let error = error {
                    self?.captureError.send(error)
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }

        isCapturing.send(true)
    }

    /// Stop screen capture
    func stopCapture() async {
        guard recorder.isRecording else { return }

        await withCheckedContinuation { continuation in
            recorder.stopCapture { [weak self] error in
                if let error = error {
                    self?.captureError.send(error)
                }
                continuation.resume()
            }
        }

        webRTCClient = nil
        isCapturing.send(false)
    }
}

// MARK: - Errors
enum ScreenCaptureError: Error, LocalizedError {
    case recordingNotAvailable

    var errorDescription: String? {
        switch self {
        case .recordingNotAvailable:
            return "Screen recording is not available on this device"
        }
    }
}

#endif
