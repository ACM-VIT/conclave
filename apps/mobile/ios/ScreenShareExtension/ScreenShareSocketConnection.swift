import Darwin
import Foundation

final class ScreenShareSocketConnection {
  private let socketPath: String
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
    close()

    socketHandle = socket(AF_UNIX, SOCK_STREAM, 0)
    if socketHandle < 0 {
      return false
    }

    var noSigPipe: Int32 = 1
    _ = withUnsafePointer(to: &noSigPipe) { pointer in
      setsockopt(
        socketHandle,
        SOL_SOCKET,
        SO_NOSIGPIPE,
        pointer,
        socklen_t(MemoryLayout<Int32>.size)
      )
    }

    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)

    let pathMaxLength = Int(MemoryLayout.size(ofValue: addr.sun_path))
    let pathBytes = Array(socketPath.utf8CString)
    if pathBytes.count >= pathMaxLength {
      close()
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
      close()
      return false
    }
    return true
  }

  func close() {
    if socketHandle >= 0 {
      Darwin.close(socketHandle)
      socketHandle = -1
    }
  }

  func write(_ data: Data) -> Bool {
    guard socketHandle >= 0 else { return false }
    return data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
      guard let pointer = buffer.bindMemory(to: UInt8.self).baseAddress else {
        return false
      }

      var remaining = data.count
      var offset = 0

      while remaining > 0 {
        let sent = send(socketHandle, pointer.advanced(by: offset), remaining, 0)
        if sent <= 0 {
          return false
        }
        remaining -= sent
        offset += sent
      }

      return true
    }
  }
}
