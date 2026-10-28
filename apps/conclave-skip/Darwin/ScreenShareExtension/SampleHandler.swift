

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
      CIContextOption.useSoftwareRenderer: false,
      CIContextOption.cacheIntermediates: false,
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
  private var minFrameInterval: TimeInterval = 1.0 / 24.0
  private var publishMaxWidth = 3_840
  private var publishMaxHeight = 2_160
  private var publishMaxBitrateBps = 2_500_000
  private var publishContentHint = "detail"
  private var jpegCompressionQuality = 0.68
  private let publishFrameRateKey = "conclave.screenShare.maxFrameRate"
  private let publishMaxWidthKey = "conclave.screenShare.maxWidth"
  private let publishMaxHeightKey = "conclave.screenShare.maxHeight"
  private let publishMaxBitrateKey = "conclave.screenShare.maxBitrateBps"
  private let publishContentHintKey = "conclave.screenShare.contentHint"
  private let lifecycleStateKey = "conclave.screenShare.lifecycle.state"
  private let lifecycleUpdatedAtKey = "conclave.screenShare.lifecycle.updatedAt"
  private let stopRequestedAtKey = "conclave.screenShare.lifecycle.stopRequestedAt"

  private let stopReasonKey = "conclave.screenShare.lifecycle.stopReason"
  private var broadcastStartedAt: TimeInterval = 0

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
    broadcastStartedAt = Date().timeIntervalSince1970
    publishLifecycleState("starting")
    reloadPublishConfiguration()
    socketConnection = ScreenShareSocketConnection(appGroupIdentifier: appGroupIdentifier)
    if socketConnection == nil {
      log("Failed to initialize socket connection", ["reason": "container URL unavailable"])
    }
    isConnected = socketConnection?.open() ?? false
    hasConnectedAtLeastOnce = isConnected
    disconnectedSince = isConnected ? nil : Date().timeIntervalSince1970
    lastConnectionAttempt = Date().timeIntervalSince1970
    publishLifecycleState(isConnected ? "active" : "reconnecting")
  }

  override func broadcastFinished() {
    publishLifecycleState("stopped")
    socketConnection?.close()
    socketConnection = nil
    isConnected = false
    hasConnectedAtLeastOnce = false
    disconnectedSince = nil
    didFinishBroadcast = true
    lastConnectionAttempt = 0
    broadcastStartedAt = 0
  }

  override func processSampleBuffer(
    _ sampleBuffer: CMSampleBuffer,
    with sampleBufferType: RPSampleBufferType
  ) {
    guard !didFinishBroadcast else { return }

    guard sampleBufferType == .video else { return }
    if wasStopRequestedByMainApp() {
      finishBroadcast(stopReasonRequestedByMainApp())
      return
    }
    videoSampleCount += 1
    if videoSampleCount % 30 == 0 {
      reloadPublishConfiguration()
    }

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
          publishLifecycleState("active")
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
          finishBroadcast(hasConnectedAtLeastOnce ? .connectionLost : .neverConnected)
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

      guard let encodedFrame = makeJPEGData(
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
        imageData: encodedFrame.data,
        width: encodedFrame.width,
        height: encodedFrame.height,
        orientation: orientation
      ) else {
        log("Dropped frame: message wrapping failed", [
          "width": width,
          "height": height,
          "orientation": orientation,
          "jpegBytes": encodedFrame.data.count,
        ])
        return
      }

      guard socketConnection?.write(messageData) == true else {
        log("Socket write failed", [
          "messageBytes": messageData.count,
          "jpegBytes": encodedFrame.data.count,
          "width": encodedFrame.width,
          "height": encodedFrame.height,
          "orientation": orientation,
          "videoSampleCount": videoSampleCount,
          "sentFrameCount": sentFrameCount,
          "hasConnectedAtLeastOnce": hasConnectedAtLeastOnce,
        ])
        socketConnection?.close()
        socketConnection = nil
        isConnected = false
        if disconnectedSince == nil {
          disconnectedSince = Date().timeIntervalSince1970
        }
        publishLifecycleState("reconnecting")
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

  private enum FinishReason {

    case stoppedByApp

    case startTimeout

    case connectionLost

    case neverConnected
  }

  private func finishBroadcast(_ reason: FinishReason) {
    if didFinishBroadcast { return }
    didFinishBroadcast = true
    socketConnection?.close()
    socketConnection = nil
    isConnected = false
    publishLifecycleState("stopped")

    let intentional = reason == .stoppedByApp
    if intentional {
      log("Intentional stop - finishing broadcast gracefully")
    } else {
      log("Finishing broadcast with error", ["reason": String(describing: reason)])
    }
    let error = NSError(
      domain: "com.acmvit.conclave.screenshare",
      code: intentional ? 0 : -1,
      userInfo: [NSLocalizedDescriptionKey: SampleHandler.alertMessage(for: reason)]
    )
    DispatchQueue.main.async { [weak self] in
      self?.finishBroadcastWithError(error)
    }
  }

  private static func alertMessage(for reason: FinishReason) -> String {
    switch reason {
    case .stoppedByApp:
      return NSLocalizedString(
        "Screen sharing stopped.",
        comment: "System alert after the person stopped screen sharing from Conclave (S70 10 g)"
      )
    case .connectionLost:
      return NSLocalizedString(
        "Screen sharing stopped because Conclave lost the connection.",
        comment: "System alert when the broadcast lost its connection to Conclave while sharing (S70 10 g)"
      )
    case .startTimeout, .neverConnected:
      return NSLocalizedString(
        "Couldn’t start screen sharing. Try again.",
        comment: "System alert when a screen share broadcast never connected to Conclave (S70 10 g)"
      )
    }
  }

  private func stopReasonRequestedByMainApp() -> FinishReason {
    let raw = UserDefaults(suiteName: appGroupIdentifier)?.string(forKey: stopReasonKey)
    return raw == "startTimeout" ? .startTimeout : .stoppedByApp
  }

  private func reloadPublishConfiguration() {
    guard let defaults = UserDefaults(suiteName: appGroupIdentifier) else { return }
    let configuredFrameRate = defaults.double(forKey: publishFrameRateKey)
    let frameRate = configuredFrameRate > 0 ? min(60.0, max(1.0, configuredFrameRate)) : 24.0
    minFrameInterval = 1.0 / frameRate

    let configuredWidth = defaults.integer(forKey: publishMaxWidthKey)
    let configuredHeight = defaults.integer(forKey: publishMaxHeightKey)
    let configuredBitrate = defaults.integer(forKey: publishMaxBitrateKey)
    publishMaxWidth = configuredWidth > 0 ? min(3_840, max(320, configuredWidth)) : 3_840
    publishMaxHeight = configuredHeight > 0 ? min(2_160, max(180, configuredHeight)) : 2_160
    publishMaxBitrateBps = configuredBitrate > 0
      ? min(15_000_000, max(150_000, configuredBitrate))
      : 2_500_000
    publishContentHint = defaults.string(forKey: publishContentHintKey) ?? "detail"

    if publishContentHint == "text" {
      jpegCompressionQuality = 0.82
    } else if publishContentHint == "motion" {
      jpegCompressionQuality = 0.62
    } else {
      jpegCompressionQuality = publishMaxBitrateBps >= 3_500_000 ? 0.74 : 0.68
    }
  }

  private func wasStopRequestedByMainApp() -> Bool {
    guard broadcastStartedAt > 0,
      let defaults = UserDefaults(suiteName: appGroupIdentifier)
    else { return false }
    return defaults.double(forKey: stopRequestedAtKey) >= broadcastStartedAt
  }

  private func publishLifecycleState(_ state: String) {
    guard let defaults = UserDefaults(suiteName: appGroupIdentifier) else { return }
    defaults.set(state, forKey: lifecycleStateKey)
    defaults.set(Date().timeIntervalSince1970, forKey: lifecycleUpdatedAtKey)
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
  func makeJPEGData(
    from imageBuffer: CVImageBuffer,
    orientation: Int
  ) -> (data: Data, width: Int, height: Int)? {
    let ciImage = CIImage(
      cvPixelBuffer: imageBuffer,
      options: [CIImageOption.colorSpace: outputColorSpace]
    )
    let sourceWidth = max(1.0, ciImage.extent.width)
    let sourceHeight = max(1.0, ciImage.extent.height)
    let scale = max(
      1.0,
      sourceWidth / CGFloat(publishMaxWidth),
      sourceHeight / CGFloat(publishMaxHeight)
    )
    let targetWidth = evenDimension(Int((sourceWidth / scale).rounded(.down)))
    let targetHeight = evenDimension(Int((sourceHeight / scale).rounded(.down)))
    let preparedImage: CIImage
    if scale > 1.0 {
      preparedImage = ciImage
        .transformed(by: CGAffineTransform(scaleX: 1.0 / scale, y: 1.0 / scale))
        .cropped(to: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
    } else {
      preparedImage = ciImage
    }
    let compressionOptions: [CIImageRepresentationOption: Any] = [
      kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: jpegCompressionQuality
    ]

    if let imageData = imageContext.jpegRepresentation(
      of: preparedImage,
      colorSpace: outputColorSpace,
      options: compressionOptions
    ) {
      return (imageData, targetWidth, targetHeight)
    }

    log("jpegRepresentation failed; falling back to CGImageDestination", [
      "orientation": orientation,
    ])

    guard let cgImage = imageContext.createCGImage(preparedImage, from: preparedImage.extent)
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
      kCGImageDestinationLossyCompressionQuality: jpegCompressionQuality
    ]
    CGImageDestinationAddImage(destination, cgImage, destinationOptions as CFDictionary)
    guard CGImageDestinationFinalize(destination) else {
      log("Dropped frame: CGImageDestinationFinalize failed", [
        "orientation": orientation,
      ])
      return nil
    }

    return (data as Data, targetWidth, targetHeight)
  }

  func evenDimension(_ value: Int) -> Int {
    let dimension = max(2, value)
    return dimension % 2 == 0 ? dimension : dimension - 1
  }
}
