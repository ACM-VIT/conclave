import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import ReplayKit

final class SampleHandler: RPBroadcastSampleHandler {
  private let appGroupIdentifier: String = {
    if let value = Bundle.main.infoDictionary?["RTCAppGroupIdentifier"] as? String,
      !value.isEmpty
    {
      return value
    }
    return "group.com.acmvit.conclave.screenshare"
  }()
  private let outputColorSpace = CGColorSpaceCreateDeviceRGB()
  private lazy var imageContext: CIContext = {
    return CIContext(options: [
      CIContextOption.workingColorSpace: outputColorSpace,
      CIContextOption.outputColorSpace: outputColorSpace,
      CIContextOption.useSoftwareRenderer: true,
    ])
  }()
  private var socketConnection: ScreenShareSocketConnection?
  private var isConnected = false
  private var hasConnectedAtLeastOnce = false
  private var disconnectedSince: TimeInterval?
  private var didFinishBroadcast = false
  private var lastConnectionAttempt: TimeInterval = 0
  private let connectionRetryInterval: TimeInterval = 0.75
  private let initialConnectionTimeout: TimeInterval = 12
  private let reconnectTimeout: TimeInterval = 6
  private var videoSampleCount: Int = 0
  private var sentFrameCount: Int = 0
  private var droppedFrameCount: Int = 0
  private var lastFrameSentAt: TimeInterval = 0
  private let minFrameInterval: TimeInterval = 1.0 / 12.0

  private func log(_ message: String, _ metadata: [String: Any] = [:]) {
    if metadata.isEmpty {
      NSLog("[ScreenShareExtension] %@", message)
      return
    }
    if let data = try? JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys]),
      let json = String(data: data, encoding: .utf8)
    {
      NSLog("[ScreenShareExtension] %@ %@", message, json)
      return
    }
    NSLog("[ScreenShareExtension] %@ %@", message, String(describing: metadata))
  }

  override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
    log("broadcastStarted", [
      "hasSetupInfo": setupInfo != nil,
      "appGroupIdentifier": appGroupIdentifier,
    ])
    didFinishBroadcast = false
    videoSampleCount = 0
    sentFrameCount = 0
    droppedFrameCount = 0
    lastFrameSentAt = 0
    socketConnection = ScreenShareSocketConnection(appGroupIdentifier: appGroupIdentifier)
    if socketConnection == nil {
      log("Failed to initialize socket connection", ["reason": "container URL unavailable"])
    }
    isConnected = socketConnection?.open() ?? false
    hasConnectedAtLeastOnce = isConnected
    disconnectedSince = isConnected ? nil : Date().timeIntervalSince1970
    lastConnectionAttempt = Date().timeIntervalSince1970
  }

  override func broadcastFinished() {
    socketConnection?.close()
    socketConnection = nil
    isConnected = false
    hasConnectedAtLeastOnce = false
    disconnectedSince = nil
    didFinishBroadcast = false
    lastConnectionAttempt = 0
  }

  override func processSampleBuffer(
    _ sampleBuffer: CMSampleBuffer,
    with sampleBufferType: RPSampleBufferType
  ) {
    guard !didFinishBroadcast else { return }
    guard sampleBufferType == .video else { return }
    videoSampleCount += 1

    let now = Date().timeIntervalSince1970
    if lastFrameSentAt > 0 && now - lastFrameSentAt < minFrameInterval {
      droppedFrameCount += 1
      return
    }

    if !isConnected {
      if disconnectedSince == nil {
        disconnectedSince = now
        log("Socket marked disconnected", [
          "videoSampleCount": videoSampleCount,
          "hasConnectedAtLeastOnce": hasConnectedAtLeastOnce,
        ])
      }
      if now - lastConnectionAttempt >= connectionRetryInterval {
        lastConnectionAttempt = now
        if socketConnection == nil {
          log("Recreating socket connection")
          socketConnection = ScreenShareSocketConnection(appGroupIdentifier: appGroupIdentifier)
        }
        isConnected = socketConnection?.open() ?? false
        log("Socket reconnect attempt", [
          "isConnected": isConnected,
          "videoSampleCount": videoSampleCount,
          "secondsDisconnected": disconnectedSince.map { now - $0 } as Any,
        ])
        if isConnected {
          hasConnectedAtLeastOnce = true
          disconnectedSince = nil
          log("Socket reconnected", ["videoSampleCount": videoSampleCount])
        }
      }

      if let disconnectedSince {
        let timeout = hasConnectedAtLeastOnce ? reconnectTimeout : initialConnectionTimeout
        if now - disconnectedSince >= timeout {
          log("Connection timeout reached", [
            "timeout": timeout,
            "secondsDisconnected": now - disconnectedSince,
            "hasConnectedAtLeastOnce": hasConnectedAtLeastOnce,
            "videoSampleCount": videoSampleCount,
          ])
          finishDueToConnectionLoss(
            message: hasConnectedAtLeastOnce
              ? "Screen sharing stopped."
              : "Unable to start screen sharing. Please try again."
          )
          return
        }
      }
    }
    guard isConnected else { return }
    autoreleasepool {
      guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
        log("Dropped sample: missing image buffer", ["videoSampleCount": videoSampleCount])
        return
      }

      let width = CVPixelBufferGetWidth(imageBuffer)
      let height = CVPixelBufferGetHeight(imageBuffer)
      let orientation = SampleHandler.extractOrientation(from: sampleBuffer)

      guard let imageData = makeJPEGData(
        from: imageBuffer,
        orientation: orientation
      ) else {
        log("Dropped frame: jpegRepresentation failed", [
          "width": width,
          "height": height,
          "orientation": orientation,
          "videoSampleCount": videoSampleCount,
        ])
        return
      }

      guard let messageData = SampleHandler.wrap(
        imageData: imageData,
        width: width,
        height: height,
        orientation: orientation
      ) else {
        log("Dropped frame: message wrapping failed", [
          "width": width,
          "height": height,
          "orientation": orientation,
          "jpegBytes": imageData.count,
        ])
        return
      }

      guard socketConnection?.write(messageData) == true else {
        log("Socket write failed", [
          "messageBytes": messageData.count,
          "jpegBytes": imageData.count,
          "width": width,
          "height": height,
          "orientation": orientation,
          "videoSampleCount": videoSampleCount,
          "sentFrameCount": sentFrameCount,
          "hasConnectedAtLeastOnce": hasConnectedAtLeastOnce,
        ])
        socketConnection?.close()
        socketConnection = nil
        isConnected = false

        if hasConnectedAtLeastOnce {
          log("Main app closed connection — finishing broadcast gracefully")
          finishDueToConnectionLoss(message: "Screen sharing stopped.", intentional: true)
          return
        }

        if disconnectedSince == nil {
          disconnectedSince = Date().timeIntervalSince1970
        }
        log("Will retry socket reconnect after write failure", [
          "reconnectTimeout": reconnectTimeout,
          "initialConnectionTimeout": initialConnectionTimeout,
        ])
        return
      }

      lastFrameSentAt = now
      sentFrameCount += 1

      disconnectedSince = nil
    }
  }

  private func finishDueToConnectionLoss(message: String, intentional: Bool = false) {
    if didFinishBroadcast { return }
    didFinishBroadcast = true
    socketConnection?.close()
    socketConnection = nil
    isConnected = false

    if intentional {
      log("Intentional stop — finishing broadcast gracefully")
    } else {
      log("Connection loss — finishing broadcast with error")
    }
    let error = NSError(
      domain: "com.acmvit.conclave.screenshare",
      code: intentional ? 0 : -1,
      userInfo: [NSLocalizedDescriptionKey: intentional ? "user stopped the screen share" : message]
    )
    DispatchQueue.main.async { [weak self] in
      self?.finishBroadcastWithError(error)
    }
  }
}

private extension SampleHandler {
  static func wrap(
    imageData: Data,
    width: Int,
    height: Int,
    orientation: Int
  ) -> Data? {
    let response = CFHTTPMessageCreateResponse(
      kCFAllocatorDefault,
      200,
      nil,
      kCFHTTPVersion1_1
    ).takeRetainedValue()

    CFHTTPMessageSetHeaderFieldValue(
      response,
      "Content-Length" as CFString,
      "\(imageData.count)" as CFString
    )
    CFHTTPMessageSetHeaderFieldValue(
      response,
      "Buffer-Width" as CFString,
      "\(width)" as CFString
    )
    CFHTTPMessageSetHeaderFieldValue(
      response,
      "Buffer-Height" as CFString,
      "\(height)" as CFString
    )
    CFHTTPMessageSetHeaderFieldValue(
      response,
      "Buffer-Orientation" as CFString,
      "\(orientation)" as CFString
    )
    CFHTTPMessageSetBody(response, imageData as CFData)

    guard let serialized =
      CFHTTPMessageCopySerializedMessage(response)?.takeRetainedValue() as Data?
    else {
      return nil
    }

    return serialized
  }

  static func extractOrientation(from sampleBuffer: CMSampleBuffer) -> Int {
    guard let attachments =
      CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[AnyHashable: Any]],
      let attachment = attachments.first,
      let orientation = attachment[RPVideoSampleOrientationKey] as? NSNumber
    else {
      return 0
    }

    return orientation.intValue
  }
}

private extension SampleHandler {
  func makeJPEGData(from imageBuffer: CVImageBuffer, orientation: Int) -> Data? {
    let ciImage = CIImage(
      cvPixelBuffer: imageBuffer,
      options: [CIImageOption.colorSpace: outputColorSpace]
    )
    let compressionOptions: [CIImageRepresentationOption: Any] = [
      kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.45
    ]

    if let imageData = imageContext.jpegRepresentation(
      of: ciImage,
      colorSpace: outputColorSpace,
      options: compressionOptions
    ) {
      return imageData
    }

    log("jpegRepresentation failed; falling back to CGImageDestination", [
      "orientation": orientation,
    ])

    guard let cgImage = imageContext.createCGImage(ciImage, from: ciImage.extent)
    else {
      log("Dropped frame: createCGImage failed", [
        "orientation": orientation,
      ])
      return nil
    }

    let data = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        data,
        "public.jpeg" as CFString,
        1,
        nil
      )
    else {
      log("Dropped frame: CGImageDestinationCreateWithData failed", [
        "orientation": orientation,
      ])
      return nil
    }

    let destinationOptions: [CFString: Any] = [
      kCGImageDestinationLossyCompressionQuality: 0.45
    ]
    CGImageDestinationAddImage(destination, cgImage, destinationOptions as CFDictionary)
    guard CGImageDestinationFinalize(destination) else {
      log("Dropped frame: CGImageDestinationFinalize failed", [
        "orientation": orientation,
      ])
      return nil
    }

    return data as Data
  }
}
