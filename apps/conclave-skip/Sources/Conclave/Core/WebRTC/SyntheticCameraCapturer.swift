#if DEBUG && os(iOS) && targetEnvironment(simulator) && !SKIP && canImport(WebRTC)
import CoreGraphics
import CoreVideo
import Foundation
import WebRTC

final class SyntheticCameraCapturer: RTCCameraVideoCapturer {
    private var frames: DispatchSourceTimer?
    private var frameIndex = 0

    func start(width: Int, height: Int, fps: Double) {
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
