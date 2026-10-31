

#if os(iOS) && !SKIP
import Foundation
import Darwin
import CoreVideo
import CoreGraphics
import ImageIO
import WebRTC

struct ScreenFrameBox: @unchecked Sendable {
    let frame: RTCVideoFrame
}

final class ScreenShareSocketServer: @unchecked Sendable {
    private let socketPath: String

    private let lock = NSLock()
    private var listenHandle: Int32 = -1
    private var clientHandle: Int32 = -1
    private var isRunning = false
    private var decodeMaxWidth = 3_840
    private var decodeMaxHeight = 2_160

    private var onFrame: (@Sendable (ScreenFrameBox) -> Void)?

    private var shouldDecodeFrame: (@Sendable () -> Bool)?

    private var onClientConnect: (@Sendable () -> Void)?

    private var onClientDisconnect: (@Sendable () -> Void)?

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

        if client >= 0 {
            shutdown(client, SHUT_RDWR)
            Darwin.close(client)
        }

        if listen >= 0 {
            wakeAccept()
            Darwin.close(listen)
        }
        unlink(socketPath)
    }

    func updateMaxResolution(width: Int, height: Int) {
        lock.lock()
        decodeMaxWidth = max(320, min(width, 3_840))
        decodeMaxHeight = max(180, min(height, 2_160))
        lock.unlock()
    }

    private func maxResolution() -> (width: Int, height: Int) {
        lock.lock()
        defer { lock.unlock() }
        return (decodeMaxWidth, decodeMaxHeight)
    }

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

    private func acceptLoop(listenFD: Int32) {
        while running() {
            let client = accept(listenFD, nil, nil)
            if client < 0 {
                if running() { continue }
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

            if stillRunning {
                onClientDisconnect?()
            }
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

                return
            }

            autoreleasepool {
                buffer.withUnsafeBytes { ptr in
                    if let base = ptr.baseAddress {
                        appendBytes(base.assumingMemoryBound(to: UInt8.self), count: n)
                    }
                }
            }
        }
    }

    private func appendBytes(_ bytes: UnsafePointer<UInt8>, count: Int) {
        if message == nil {
            message = CFHTTPMessageCreateEmpty(kCFAllocatorDefault, false).takeRetainedValue()
        }
        guard let msg = message else { return }
        CFHTTPMessageAppendBytes(msg, bytes, count)
        drainCompleteFrames()
    }

    private func drainCompleteFrames() {
        while let msg = message, CFHTTPMessageIsHeaderComplete(msg) {
            guard let contentLength = intHeader(msg, "Content-Length"), contentLength > 0 else {

                message = nil
                return
            }
            let body = (CFHTTPMessageCopyBody(msg)?.takeRetainedValue() as Data?) ?? Data()
            if body.count < contentLength {

                return
            }

            let frameData = body.prefix(contentLength)
            let width = intHeader(msg, "Buffer-Width") ?? 0
            let height = intHeader(msg, "Buffer-Height") ?? 0
            let orientation = intHeader(msg, "Buffer-Orientation") ?? 0
            if shouldDecodeFrame?() ?? true {
                emitFrame(jpeg: Data(frameData), width: width, height: height, orientation: orientation)
            }

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

    private func emitFrame(jpeg: Data, width: Int, height: Int, orientation: Int) {
        let resolution = maxResolution()
        guard let pixelBuffer = Self.pixelBuffer(
            fromJPEG: jpeg,
            maxWidth: resolution.width,
            maxHeight: resolution.height
        ) else {

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

        let frame = RTCVideoFrame(
            buffer: rtcBuffer,
            rotation: Self.rotation(for: orientation),
            timeStampNs: Int64(bitPattern: DispatchTime.now().uptimeNanoseconds)
        )
        onFrame?(ScreenFrameBox(frame: frame))
    }

    private static func rotation(for orientation: Int) -> RTCVideoRotation {

        switch orientation {
        case 8: return ._90
        case 3: return ._180
        case 6: return ._270
        default: return ._0
        }
    }

    private static func pixelBuffer(
        fromJPEG data: Data,
        maxWidth: Int,
        maxHeight: Int
    ) -> CVPixelBuffer? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            return nil
        }
        let sourceWidth = cgImage.width
        let sourceHeight = cgImage.height
        if sourceWidth <= 0 || sourceHeight <= 0 { return nil }
        let scale = max(
            1.0,
            Double(sourceWidth) / Double(max(1, maxWidth)),
            Double(sourceHeight) / Double(max(1, maxHeight))
        )
        let width = evenDimension(Int((Double(sourceWidth) / scale).rounded(.down)))
        let height = evenDimension(Int((Double(sourceHeight) / scale).rounded(.down)))

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

    private static func evenDimension(_ value: Int) -> Int {
        let dimension = max(2, value)
        return dimension % 2 == 0 ? dimension : dimension - 1
    }
}
#endif
