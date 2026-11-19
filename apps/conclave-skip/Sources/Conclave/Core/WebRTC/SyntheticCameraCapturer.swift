#if DEBUG && os(iOS) && targetEnvironment(simulator) && !SKIP && canImport(WebRTC)
import CoreGraphics
import CoreVideo
import Foundation
import WebRTC

final class SyntheticCameraCapturer: RTCCameraVideoCapturer {
    private var frames: DispatchSourceTimer?
    private var frameIndex = 0

    private static let iPhone11FrontFormats = [
        CameraFormatCandidate(width: 192, height: 144),
        CameraFormatCandidate(width: 352, height: 288),
        CameraFormatCandidate(width: 480, height: 360),
        CameraFormatCandidate(width: 640, height: 480),
        CameraFormatCandidate(width: 960, height: 540),
        CameraFormatCandidate(width: 1280, height: 720),
        CameraFormatCandidate(width: 1920, height: 1080),
        CameraFormatCandidate(width: 1920, height: 1440),
    ]

    func start(width: Int, height: Int, fps: Double) {
        let format = Self.iPhone11FrontFormats[
            CameraFormatSelectionPolicy.selectIndex(Self.iPhone11FrontFormats, targetWidth: width, targetHeight: height) ?? 0
        ]
        let width = format.width
        let height = format.height
        frames?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: .nanoseconds(Int(1_000_000_000 / fps)))
        timer.setEventHandler { [weak self] in
            self?.sendFrame(width: width, height: height)
        }
        frames = timer
        timer.resume()
    }

    override func stopCapture(completionHandler: (() -> Void)? = nil) {
        frames?.cancel()
        frames = nil
        completionHandler?()
    }

    deinit {
        frames?.cancel()
    }

    private func sendFrame(width: Int, height: Int) {
        var pixels: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, nil, &pixels
        )
        guard status == kCVReturnSuccess, let pixels else { return }

        CVPixelBufferLockBaseAddress(pixels, [])
        let context = CGContext(
            data: CVPixelBufferGetBaseAddress(pixels),
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(pixels),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        )
        if let context {
            context.setFillColor(red: 0.12, green: 0.22, blue: 0.72, alpha: 1)
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            context.setFillColor(red: 1, green: 0.36, blue: 0.28, alpha: 1)
            let stripe = max(1, width / 8)
            let stripeX = frameIndex * 8 % (width - stripe + 1)
            context.fill(CGRect(x: stripeX, y: 0, width: stripe, height: height))
            frameIndex += 1
        }
        CVPixelBufferUnlockBaseAddress(pixels, [])
        guard context != nil else { return }

        let frame = RTCVideoFrame(
            buffer: RTCCVPixelBuffer(pixelBuffer: pixels),
            rotation: ._0,
            timeStampNs: Int64(bitPattern: DispatchTime.now().uptimeNanoseconds)
        )
        delegate?.capturer(self, didCapture: frame)
    }
}
#endif
