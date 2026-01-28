import Foundation

final class ScreenShareSocketConnection {
  private let socketPath: String
  private var outputStream: OutputStream?
  private var socketHandle: Int32 = -1

  init?(appGroupIdentifier: String) {
    guard let containerURL =
      FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)
    else {
      return nil
    }

    socketPath = containerURL.appendingPathComponent("rtc_SSFD").path
  }

  func open() -> Bool {
    socketHandle = socket(AF_UNIX, SOCK_STREAM, 0)
    if socketHandle < 0 {
      return false
    }

    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)

    let pathMaxLength = Int(MemoryLayout.size(ofValue: addr.sun_path))
    let pathBytes = Array(socketPath.utf8CString)
    if pathBytes.count >= pathMaxLength {
      Darwin.close(socketHandle)
      socketHandle = -1
      return false
    }

    withUnsafeMutablePointer(to: &addr.sun_path.0) { pointer in
      pathBytes.withUnsafeBytes { bytes in
        guard let baseAddress = bytes.bindMemory(to: Int8.self).baseAddress else { return }
        strncpy(pointer, baseAddress, pathMaxLength - 1)
      }
    }

    let addrSize = socklen_t(MemoryLayout<sockaddr_un>.size)
    let connected = withUnsafePointer(to: &addr) { pointer -> Bool in
      return pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { addrPtr in
        connect(socketHandle, addrPtr, addrSize) == 0
      }
    }

    if !connected {
      Darwin.close(socketHandle)
      socketHandle = -1
      return false
    }

    var readStream: Unmanaged<CFReadStream>?
    var writeStream: Unmanaged<CFWriteStream>?
    CFStreamCreatePairWithSocket(kCFAllocatorDefault, socketHandle, &readStream, &writeStream)

    guard let writeStream = writeStream?.takeRetainedValue() else {
      Darwin.close(socketHandle)
      socketHandle = -1
      return false
    }

    outputStream = writeStream
    outputStream?.setProperty(true as CFBoolean, forKey: Stream.PropertyKey(kCFStreamPropertyShouldCloseNativeSocket as String))
    outputStream?.open()
    return true
  }

  func close() {
    outputStream?.close()
    outputStream = nil
    if socketHandle >= 0 {
      Darwin.close(socketHandle)
      socketHandle = -1
    }
  }

  func write(_ data: Data) {
    guard let outputStream else { return }
    data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
      guard let pointer = buffer.bindMemory(to: UInt8.self).baseAddress else {
        return
      }

      var remaining = data.count
      var offset = 0

      while remaining > 0 {
        let written = outputStream.write(pointer.advanced(by: offset), maxLength: remaining)
        if written <= 0 { break }
        remaining -= written
        offset += written
      }
    }
  }
}
