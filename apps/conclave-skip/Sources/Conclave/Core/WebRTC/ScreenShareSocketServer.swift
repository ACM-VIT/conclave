//
//  ScreenShareSocketServer.swift
//  Conclave
//
//  App-side counterpart to the ReplayKit broadcast-upload extension.
//
//  The extension (SampleHandler) captures the whole device screen, JPEG-encodes
//  each frame and writes it - framed as a serialized CFHTTPMessage with
//  Content-Length / Buffer-Width / Buffer-Height / Buffer-Orientation headers -
//  over an AF_UNIX stream socket living in the shared App Group container
//  (`<group>/rtc_SSFD`). This server binds + listens on that socket, parses the
//  framed stream (handling coalesced / partial frames), decodes each JPEG back
//  to a CVPixelBuffer, and emits an RTCVideoFrame the WebRTCClient feeds into
//  the screen-share producer.
//
//  The wire format matches the ReplayKit/WebRTC broadcast pipeline used by the
//  mobile stack, but the socket reader is owned here so the main app controls
//  frame backpressure and teardown.
//

#if os(iOS) && !SKIP
import Foundation
import Darwin
import CoreVideo
import CoreGraphics
import ImageIO
import WebRTC

/// Carries an already-constructed RTCVideoFrame across the background read
/// queue → MainActor boundary. RTCVideoFrame is an Obj-C type that isn't
/// `Sendable`; the frame is produced and consumed single-threaded (built on the
/// read queue, immediately handed to the WebRTC source), so the unchecked
/// conformance is safe.
struct ScreenFrameBox: @unchecked Sendable {
    let frame: RTCVideoFrame
}

/// Listens on the App-Group AF_UNIX socket the broadcast extension connects to,
/// reassembles JPEG frames, and emits decoded `RTCVideoFrame`s.
final class ScreenShareSocketServer: @unchecked Sendable {
    private let socketPath: String

    // fd lifecycle is guarded by `lock`; the accept/read loop runs on a global
    // queue so stop() (called from the main actor) can tear it down without
    // deadlocking - recv() is woken by shutdown(), accept() by a self-connect
    // (see wakeAccept()), since close() alone doesn't reliably interrupt
    // either on Darwin.
    private let lock = NSLock()
    private var listenHandle: Int32 = -1
    private var clientHandle: Int32 = -1
    private var isRunning = false

    /// Called on the read queue with each decoded frame.
    private var onFrame: (@Sendable (ScreenFrameBox) -> Void)?
    /// Called before JPEG decode so constrained links can skip excess frames
    /// without spending CPU on frames that WebRTC will drop anyway.
    private var shouldDecodeFrame: (@Sendable () -> Bool)?
    /// Called on the read queue when the extension actually connects (the
    /// broadcast went live) - lets the app distinguish a real share from a
    /// picker the user cancelled.
    private var onClientConnect: (@Sendable () -> Void)?
    /// Called on the read queue when the extension disconnects (broadcast ended,
    /// e.g. the user stopped it from Control Center).
    private var onClientDisconnect: (@Sendable () -> Void)?

    // CFHTTPMessage streaming-parser accumulator + decode-log throttle
    // (read-queue only).
    private var message: CFHTTPMessage?
    private var lastDecodeFailureLogAt: TimeInterval = 0

    init?(appGroupIdentifier: String) {
        guard let containerURL = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)
        else {
            return nil
        }
        socketPath = containerURL.appendingPathComponent("rtc_SSFD").path
    }

    /// Bind + listen, then accept the extension's connection on a background
    /// queue. `onFrame` fires per decoded frame; `onDisconnect` when the
    /// extension closes the connection.
    func start(
        onFrame: @escaping @Sendable (ScreenFrameBox) -> Void,
        shouldDecodeFrame: @escaping @Sendable () -> Bool = { true },
        onConnect: @escaping @Sendable () -> Void,
        onDisconnect: @escaping @Sendable () -> Void
    ) -> Bool {
        self.onFrame = onFrame
        self.shouldDecodeFrame = shouldDecodeFrame
        self.onClientConnect = onConnect
        self.onClientDisconnect = onDisconnect

        // A stale socket file from a crashed prior session would block bind().
        unlink(socketPath)

        let handle = socket(AF_UNIX, SOCK_STREAM, 0)
        if handle < 0 { return false }

        var noSigPipe: Int32 = 1
        _ = withUnsafePointer(to: &noSigPipe) { pointer in
            setsockopt(handle, SOL_SOCKET, SO_NOSIGPIPE, pointer,
                       socklen_t(MemoryLayout<Int32>.size))
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathMaxLength = Int(MemoryLayout.size(ofValue: addr.sun_path))
        let pathBytes = Array(socketPath.utf8CString)
        if pathBytes.count >= pathMaxLength {
            Darwin.close(handle)
            return false
        }
        withUnsafeMutablePointer(to: &addr.sun_path.0) { pointer in
            pathBytes.withUnsafeBytes { bytes in
                guard let base = bytes.bindMemory(to: Int8.self).baseAddress else { return }
                strncpy(pointer, base, pathMaxLength - 1)
            }
        }

        let addrSize = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) { pointer -> Bool in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { addrPtr in
                bind(handle, addrPtr, addrSize) == 0
            }
        }
        if !bound {
            Darwin.close(handle)
            return false
        }
        if listen(handle, 1) != 0 {
            Darwin.close(handle)
            unlink(socketPath)
            return false
        }

        lock.lock()
        listenHandle = handle
        isRunning = true
        lock.unlock()

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.acceptLoop(listenFD: handle)
        }
        return true
    }

    func stop() {
        lock.lock()
        isRunning = false
        let client = clientHandle
        let listen = listenHandle
        clientHandle = -1
        listenHandle = -1
        lock.unlock()

        // shutdown() wakes a thread blocked in recv() on the client fd.
        if client >= 0 {
            shutdown(client, SHUT_RDWR)
            Darwin.close(client)
        }
        // close() alone does NOT reliably interrupt a thread blocked in
        // accept() on Darwin, which would leak the accept-loop thread (e.g. if
        // the user cancelled the broadcast picker before any client connected).
        // Self-connect to satisfy the pending accept() so the loop unblocks,
        // sees !isRunning, and exits. Must run BEFORE closing the listen fd.
        if listen >= 0 {
            wakeAccept()
            Darwin.close(listen)
        }
        unlink(socketPath)
    }

    /// Best-effort: connect a throwaway client to the listening socket so a
    /// blocked accept() returns.
    private func wakeAccept() {
        let waker = socket(AF_UNIX, SOCK_STREAM, 0)
        if waker < 0 { return }
        defer { Darwin.close(waker) }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathMaxLength = Int(MemoryLayout.size(ofValue: addr.sun_path))
        let pathBytes = Array(socketPath.utf8CString)
        if pathBytes.count >= pathMaxLength { return }
        withUnsafeMutablePointer(to: &addr.sun_path.0) { pointer in
            pathBytes.withUnsafeBytes { bytes in
                guard let base = bytes.bindMemory(to: Int8.self).baseAddress else { return }
                strncpy(pointer, base, pathMaxLength - 1)
            }
        }
        let addrSize = socklen_t(MemoryLayout<sockaddr_un>.size)
        _ = withUnsafePointer(to: &addr) { pointer -> Int32 in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { addrPtr in
                connect(waker, addrPtr, addrSize)
            }
        }
    }

    private func running() -> Bool {
        lock.lock(); defer { lock.unlock() }
        return isRunning
    }

    // MARK: - Read loop

    private func acceptLoop(listenFD: Int32) {
        let client = accept(listenFD, nil, nil)
        if client < 0 {
            return
        }
        if !running() {
            Darwin.close(client)
            return
        }

        var noSigPipe: Int32 = 1
        _ = withUnsafePointer(to: &noSigPipe) { pointer in
            setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, pointer,
                       socklen_t(MemoryLayout<Int32>.size))
        }

        lock.lock()
        clientHandle = client
        lock.unlock()
        message = nil

        // The extension is live - let the app flip from "starting" to "sharing"
        // and cancel its start-timeout.
        onClientConnect?()

        readLoop(client)

        lock.lock()
        let stillRunning = isRunning
        if clientHandle == client {
            Darwin.close(client)
            clientHandle = -1
        }
        lock.unlock()
        message = nil

        // Distinguish an app-initiated stop (isRunning already false) from the
        // extension closing the connection (broadcast ended externally).
        if stillRunning {
            onClientDisconnect?()
        }
    }

    private func readLoop(_ client: Int32) {
        let bufferSize = 64 * 1024
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while running() {
            let n = buffer.withUnsafeMutableBytes { ptr -> Int in
                recv(client, ptr.baseAddress, bufferSize, 0)
            }
            if n <= 0 {
                // 0 = orderly shutdown (extension closed), <0 = error/interrupt.
                return
            }
            buffer.withUnsafeBytes { ptr in
                if let base = ptr.baseAddress {
                    appendBytes(base.assumingMemoryBound(to: UInt8.self), count: n)
                }
            }
        }
    }

    // MARK: - CFHTTPMessage streaming parser

    private func appendBytes(_ bytes: UnsafePointer<UInt8>, count: Int) {
        if message == nil {
            message = CFHTTPMessageCreateEmpty(kCFAllocatorDefault, false).takeRetainedValue()
        }
        guard let msg = message else { return }
        CFHTTPMessageAppendBytes(msg, bytes, count)
        drainCompleteFrames()
    }

    /// A single recv() may carry several whole frames, a partial frame, or a
    /// frame split across reads. Loop while the accumulated message has a
    /// complete header AND a body of at least Content-Length bytes; slice off
    /// each frame and re-seed the parser with whatever bytes belong to the next
    /// frame.
    private func drainCompleteFrames() {
        while let msg = message, CFHTTPMessageIsHeaderComplete(msg) {
            guard let contentLength = intHeader(msg, "Content-Length"), contentLength > 0 else {
                // Header complete but no/invalid Content-Length - unrecoverable;
                // reset to resync on the next bytes.
                message = nil
                return
            }
            let body = (CFHTTPMessageCopyBody(msg)?.takeRetainedValue() as Data?) ?? Data()
            if body.count < contentLength {
                // Need more bytes for this frame; keep accumulating.
                return
            }

            let frameData = body.prefix(contentLength)
            let width = intHeader(msg, "Buffer-Width") ?? 0
            let height = intHeader(msg, "Buffer-Height") ?? 0
            let orientation = intHeader(msg, "Buffer-Orientation") ?? 0
            if shouldDecodeFrame?() ?? true {
                emitFrame(jpeg: Data(frameData), width: width, height: height, orientation: orientation)
            }

            // Bytes beyond Content-Length are the start of the next frame(s).
            let leftover = body.count > contentLength
                ? Data(body.suffix(from: contentLength))
                : Data()
            message = CFHTTPMessageCreateEmpty(kCFAllocatorDefault, false).takeRetainedValue()
            if leftover.isEmpty {
                return
            }
            leftover.withUnsafeBytes { ptr in
                if let base = ptr.baseAddress, let m = message {
                    CFHTTPMessageAppendBytes(m, base.assumingMemoryBound(to: UInt8.self), leftover.count)
                }
            }
        }
    }

    private func intHeader(_ msg: CFHTTPMessage, _ field: String) -> Int? {
        guard let value = CFHTTPMessageCopyHeaderFieldValue(msg, field as CFString)?
            .takeRetainedValue() as String?
        else {
            return nil
        }
        return Int(value.trimmingCharacters(in: .whitespaces))
    }

    // MARK: - Decode → RTCVideoFrame

    private func emitFrame(jpeg: Data, width: Int, height: Int, orientation: Int) {
        guard let pixelBuffer = Self.pixelBuffer(fromJPEG: jpeg) else {
            // Device-only feature with no CI coverage - a silent decode failure
            // leaves a black/frozen share undebuggable. Throttled to ~1/s.
            let now = Date().timeIntervalSince1970
            if now - lastDecodeFailureLogAt >= 1.0 {
                lastDecodeFailureLogAt = now
                debugLog(
                    "[ScreenShare] decode failed: jpegBytes=\(jpeg.count) w=\(width) h=\(height) orient=\(orientation)"
                )
            }
            return
        }
        let rtcBuffer = RTCCVPixelBuffer(pixelBuffer: pixelBuffer)
        // Monotonic clock: wall-clock Date() can step backwards (NTP) and make a
        // later frame carry an earlier timestamp, confusing the encoder.
        let frame = RTCVideoFrame(
            buffer: rtcBuffer,
            rotation: Self.rotation(for: orientation),
            timeStampNs: Int64(bitPattern: DispatchTime.now().uptimeNanoseconds)
        )
        onFrame?(ScreenFrameBox(frame: frame))
    }

    private static func rotation(for orientation: Int) -> RTCVideoRotation {
        // RPVideoSampleOrientationKey carries CGImagePropertyOrientation raw
        // values: .up(1) .down(3) .right(6) .left(8). The extension passes this
        // through unmodified (no .oriented() bake), so WebRTC applies the
        // rotation from RTCVideoFrame.rotation. Mapping matches the working
        // react-native-webrtc ScreenCapturer reader: Left(8)→90, Down(3)→180,
        // Right(6)→270. (The two landscape cases are the easy ones to invert.)
        switch orientation {
        case 8: return ._90    // .left
        case 3: return ._180   // .down
        case 6: return ._270   // .right
        default: return ._0    // .up (1) / absent (0)
        }
    }

    private static func pixelBuffer(fromJPEG data: Data) -> CVPixelBuffer? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            return nil
        }
        let width = cgImage.width
        let height = cgImage.height
        if width <= 0 || height <= 0 { return nil }

        let attrs: [CFString: Any] = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
        ]
        var pixelBuffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault, width, height,
            kCVPixelFormatType_32BGRA, attrs as CFDictionary, &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pb = pixelBuffer else { return nil }

        CVPixelBufferLockBaseAddress(pb, [])
        defer { CVPixelBufferUnlockBaseAddress(pb, []) }

        guard let context = CGContext(
            data: CVPixelBufferGetBaseAddress(pb),
            width: width, height: height,
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(pb),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
                | CGBitmapInfo.byteOrder32Little.rawValue
        ) else {
            return nil
        }
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        return pb
    }
}
#endif
