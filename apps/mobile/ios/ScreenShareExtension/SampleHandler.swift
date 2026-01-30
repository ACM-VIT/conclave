import CoreImage
import ImageIO
import ReplayKit

final class SampleHandler: RPBroadcastSampleHandler {
  private let appGroupIdentifier = "group.com.acmvit.conclave.screenshare"
  private let imageContext = CIContext()
  private var socketConnection: ScreenShareSocketConnection?
  private var isConnected = false
  private var lastConnectionAttempt: TimeInterval = 0
  private let connectionRetryInterval: TimeInterval = 0.75

  override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
    socketConnection = ScreenShareSocketConnection(appGroupIdentifier: appGroupIdentifier)
    isConnected = socketConnection?.open() ?? false
    lastConnectionAttempt = Date().timeIntervalSince1970
  }

  override func broadcastFinished() {
    socketConnection?.close()
    socketConnection = nil
    isConnected = false
    lastConnectionAttempt = 0
  }

  override func processSampleBuffer(
    _ sampleBuffer: CMSampleBuffer,
    with sampleBufferType: RPSampleBufferType
  ) {
    guard sampleBufferType == .video else { return }
    if !isConnected {
      let now = Date().timeIntervalSince1970
      if now - lastConnectionAttempt >= connectionRetryInterval {
        lastConnectionAttempt = now
        if socketConnection == nil {
          socketConnection = ScreenShareSocketConnection(appGroupIdentifier: appGroupIdentifier)
        }
        isConnected = socketConnection?.open() ?? false
      }
    }
    guard isConnected else { return }
    guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

    let width = CVPixelBufferGetWidth(imageBuffer)
    let height = CVPixelBufferGetHeight(imageBuffer)
    let orientation = SampleHandler.extractOrientation(from: sampleBuffer)

    let ciImage = CIImage(cvPixelBuffer: imageBuffer)
    guard let imageData = imageContext.jpegRepresentation(
      of: ciImage,
      colorSpace: CGColorSpaceCreateDeviceRGB(),
      options: [
        kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.6
      ]
    ) else {
      return
    }

    guard let messageData = SampleHandler.wrap(
      imageData: imageData,
      width: width,
      height: height,
      orientation: orientation
    ) else {
      return
    }

    socketConnection?.write(messageData)
  }
}

private extension SampleHandler {
  static func wrap(
    imageData: Data,
    width: Int,
    height: Int,
    orientation: Int
  ) -> Data? {
    let request = CFHTTPMessageCreateRequest(
      kCFAllocatorDefault,
      "POST" as CFString,
      URL(string: "http://localhost")! as CFURL,
      kCFHTTPVersion1_1
    ).takeRetainedValue()

    CFHTTPMessageSetHeaderFieldValue(
      request,
      "Content-Length" as CFString,
      "\(imageData.count)" as CFString
    )
    CFHTTPMessageSetHeaderFieldValue(
      request,
      "Buffer-Width" as CFString,
      "\(width)" as CFString
    )
    CFHTTPMessageSetHeaderFieldValue(
      request,
      "Buffer-Height" as CFString,
      "\(height)" as CFString
    )
    CFHTTPMessageSetHeaderFieldValue(
      request,
      "Buffer-Orientation" as CFString,
      "\(orientation)" as CFString
    )
    CFHTTPMessageSetBody(request, imageData as CFData)

    guard let serialized =
      CFHTTPMessageCopySerializedMessage(request)?.takeRetainedValue() as Data?
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
