#if os(iOS) && !SKIP
import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import UIKit
#if canImport(WebRTC)
import WebRTC
#endif

// S70 3 c (SYS-4, SY6; SX4; RECONCILE R28): the content of the iOS video-call PiP window. `AVSampleBufferDisplayLayer`
// is the documented video-call PiP source on the iOS 17 floor (the iOS 18 `MTKView` path is an optimization only), so
// the PiP target's decoded WebRTC frames are turned into `CMSampleBuffer`s marked
// `kCMSampleAttachmentKey_DisplayImmediately` and enqueued through the layer's `sampleBufferRenderer` (iOS 17), which is
// safe to feed from the decode thread. `RTCCVPixelBuffer` frames go in directly; I420 frames are copied into NV12
// buffers from a `CVPixelBufferPool`. The renderer is attached to a track only while PiP is possible or showing
// (PipLifetimeMachine: the scene resigned during a live call, detached when PiP stops or the app is active), and it is
// added to and removed from tracks on the main thread by `PipVideoTrackSink` (VideoView.swift), never inside a frame
// callback (`apps/conclave-skip/AGENTS.md` media invariants). It never reports frame sizes: the stage renderer of the
// same slot already does (R70-10).

/// The view inside `AVPictureInPictureVideoCallViewController`: a display layer that fills its bounds, turned by the
/// frames' rotation (the layer itself does not rotate). Created once per process, never per target (S70 3 c).
final class SampleBufferVideoCallView: UIView {
    let displayLayer = AVSampleBufferDisplayLayer()
    private var rotationDegrees = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        accessibilityIgnoresInvertColors = true
        clipsToBounds = true
        displayLayer.videoGravity = .resizeAspectFill
        layer.addSublayer(displayLayer)
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        isUserInteractionEnabled = false
        clipsToBounds = true
        displayLayer.videoGravity = .resizeAspectFill
        layer.addSublayer(displayLayer)
    }

    /// A camera fills the window; a share is shown whole (S70 3 f).
    func setFitsWholeFrame(_ fits: Bool) {
        let gravity: AVLayerVideoGravity = fits ? .resizeAspect : .resizeAspectFill
        if displayLayer.videoGravity != gravity { displayLayer.videoGravity = gravity }
    }

    /// 0, 90, 180 or 270 from the frame; main thread.
    func apply(rotationDegrees degrees: Int) {
        if degrees == rotationDegrees { return }
        rotationDegrees = degrees
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let quarterTurned = rotationDegrees == 90 || rotationDegrees == 270
        let size = quarterTurned ? CGSize(width: bounds.height, height: bounds.width) : bounds.size
        displayLayer.bounds = CGRect(origin: .zero, size: size)
        displayLayer.position = CGPoint(x: bounds.midX, y: bounds.midY)
        displayLayer.setAffineTransform(CGAffineTransform(rotationAngle: CGFloat(rotationDegrees) * .pi / 180.0))
        CATransaction.commit()
    }

    /// Drops what is queued and the shown image (the sink detached or swapped to another person).
    func clear() {
        displayLayer.sampleBufferRenderer.flush(removingDisplayedImage: true, completionHandler: nil)
    }
}

#if canImport(WebRTC)
/// An `RTCVideoRenderer` that enqueues the target's frames on a `SampleBufferVideoCallView`. Frames arrive on the
/// WebRTC decode thread; all conversion state sits behind one lock, and the only main-thread hop is a rotation change.
final class PipSampleBufferRenderer: NSObject, RTCVideoRenderer {
    private let videoRenderer: AVSampleBufferVideoRenderer
    private weak var view: SampleBufferVideoCallView?
    private let lock = NSLock()
    private var pool: CVPixelBufferPool?
    private var poolWidth = 0
    private var poolHeight = 0
    private var format: CMVideoFormatDescription?
    private var rotationDegrees = 0
    private var renderedCount = 0
    private var droppedCount = 0

    @MainActor
    init(view: SampleBufferVideoCallView) {
        self.view = view
        videoRenderer = view.displayLayer.sampleBufferRenderer
        super.init()
    }

    /// Frames shown and frames dropped since the process started (the `sys.pip` diagnostics; never observed).
    var counts: (rendered: Int, dropped: Int) {
        lock.lock()
        defer { lock.unlock() }
        return (renderedCount, droppedCount)
    }

    func setSize(_ size: CGSize) {
        // The stage renderer of the same slot reports the decoded size (R70-10); nothing to do here.
    }

    func renderFrame(_ frame: RTCVideoFrame?) {
        guard let frame else { return }
        lock.lock()
        defer { lock.unlock() }
        guard let pixelBuffer = pixelBuffer(from: frame.buffer), let sample = sampleBuffer(for: pixelBuffer) else {
            droppedCount += 1
            return
        }
        // A decoder interruption (the app was suspended) fails the renderer until it is flushed.
        if videoRenderer.status == .failed {
            videoRenderer.flush()
        }
        videoRenderer.enqueue(sample)
        renderedCount += 1
        let degrees = Self.degrees(frame.rotation)
        if degrees != rotationDegrees {
            rotationDegrees = degrees
            let target = view
            DispatchQueue.main.async { [weak target] in
                MainActor.assumeIsolated { target?.apply(rotationDegrees: degrees) }
            }
        }
    }

    // MARK: Conversion (decode thread, under `lock`)

    private func pixelBuffer(from buffer: RTCVideoFrameBuffer) -> CVPixelBuffer? {
        if let native = buffer as? RTCCVPixelBuffer, !native.requiresCropping() {
            return native.pixelBuffer
        }
        return nv12(from: buffer.toI420())
    }

    /// `toI420()` returns the I420 protocol, which Swift imports as `RTCI420BufferProtocol` because the class
    /// `RTCI420Buffer` (RTCNativeI420Buffer.h) shares its name; the planar protocol it inherits has no such clash.
    private func nv12(from source: RTCYUVPlanarBuffer) -> CVPixelBuffer? {
        let width = Int(source.width)
        let height = Int(source.height)
        guard width > 0, height > 0, let pool = pixelBufferPool(width: width, height: height) else { return nil }
        var created: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &created) == kCVReturnSuccess,
              let target = created else { return nil }
        CVPixelBufferLockBaseAddress(target, [])
        defer { CVPixelBufferUnlockBaseAddress(target, []) }
        guard let lumaBase = CVPixelBufferGetBaseAddressOfPlane(target, 0),
              let chromaBase = CVPixelBufferGetBaseAddressOfPlane(target, 1) else { return nil }
        let lumaStride = CVPixelBufferGetBytesPerRowOfPlane(target, 0)
        let chromaStride = CVPixelBufferGetBytesPerRowOfPlane(target, 1)
        let luma = lumaBase.assumingMemoryBound(to: UInt8.self)
        let chroma = chromaBase.assumingMemoryBound(to: UInt8.self)
        let sourceLumaStride = Int(source.strideY)
        for row in 0..<height {
            memcpy(luma + row * lumaStride, source.dataY + row * sourceLumaStride, width)
        }
        let chromaWidth = Int(source.chromaWidth)
        let chromaHeight = Int(source.chromaHeight)
        let strideU = Int(source.strideU)
        let strideV = Int(source.strideV)
        for row in 0..<chromaHeight {
            let u = source.dataU + row * strideU
            let v = source.dataV + row * strideV
            let line = chroma + row * chromaStride
            for column in 0..<chromaWidth {
                line[2 * column] = u[column]
                line[2 * column + 1] = v[column]
            }
        }
        return target
    }

    private func pixelBufferPool(width: Int, height: Int) -> CVPixelBufferPool? {
        if let pool, poolWidth == width, poolHeight == height { return pool }
        let attributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any]()
        ]
        var created: CVPixelBufferPool?
        guard CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attributes as CFDictionary, &created) == kCVReturnSuccess else {
            return nil
        }
        pool = created
        poolWidth = width
        poolHeight = height
        format = nil
        return created
    }

    private func sampleBuffer(for pixelBuffer: CVPixelBuffer) -> CMSampleBuffer? {
        if let current = format, CMVideoFormatDescriptionMatchesImageBuffer(current, imageBuffer: pixelBuffer) {
            // Reuse the description while the buffers keep their format.
        } else {
            var description: CMVideoFormatDescription?
            guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixelBuffer,
                                                               formatDescriptionOut: &description) == noErr else { return nil }
            format = description
        }
        guard let description = format else { return nil }
        var timing = CMSampleTimingInfo(duration: .invalid,
                                        presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()),
                                        decodeTimeStamp: .invalid)
        var created: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixelBuffer,
                                                       formatDescription: description, sampleTiming: &timing,
                                                       sampleBufferOut: &created) == noErr,
              let sample = created else { return nil }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true),
           CFArrayGetCount(attachments) > 0 {
            let dictionary = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(dictionary,
                                 Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                                 Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        }
        return sample
    }

    private static func degrees(_ rotation: RTCVideoRotation) -> Int {
        switch rotation {
        case ._90: return 90
        case ._180: return 180
        case ._270: return 270
        default: return 0
        }
    }
}
#endif
#endif
