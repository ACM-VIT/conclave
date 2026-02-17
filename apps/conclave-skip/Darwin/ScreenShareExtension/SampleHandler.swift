//
//  SampleHandler.swift
//  ScreenShareExtension
//
//  Broadcast Upload Extension for screen capture
//

#if canImport(UIKit)
import ReplayKit
import CoreVideo
import CoreMedia

class SampleHandler: RPBroadcastSampleHandler {
    
    private let appGroupIdentifier = "group.com.acmvit.conclave"
    
    override func broadcastStarted(withSetupInfo setupInfo: [String : NSObject]?) {
        // User has requested to start the broadcast
        debugLog("[ScreenShareExtension] Broadcast started")
        
        // Setup socket connection to main app
        do {
            try ScreenShareSocket.shared.connect()
        } catch {
            debugLog("[ScreenShareExtension] Failed to connect: \(error)")
        }
    }
    
    override func broadcastPaused() {
        // User has requested to pause the broadcast
        debugLog("[ScreenShareExtension] Broadcast paused")
    }
    
    override func broadcastResumed() {
        // User has requested to resume the broadcast
        debugLog("[ScreenShareExtension] Broadcast resumed")
    }
    
    override func broadcastFinished() {
        // User has requested to finish the broadcast
        debugLog("[ScreenShareExtension] Broadcast finished")
        ScreenShareSocket.shared.stop()
    }
    
    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        switch sampleBufferType {
        case RPSampleBufferType.video:
            // Handle video sample buffer
            handleVideoSampleBuffer(sampleBuffer)
        case RPSampleBufferType.audioApp:
            // Handle audio app sample buffer
            handleAudioSampleBuffer(sampleBuffer, isAppAudio: true)
        case RPSampleBufferType.audioMic:
            // Handle audio mic sample buffer
            handleAudioSampleBuffer(sampleBuffer, isAppAudio: false)
        @unknown default:
            break
        }
    }
    
    // MARK: - Private Methods
    
    private func handleVideoSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
        // Convert sample buffer to data and send to main app
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        
        // Get timestamp
        let timestamp = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        
        // Send to main app via socket
        do {
            try ScreenShareSocket.shared.sendFrame(pixelBuffer, timestamp: timestamp)
        } catch {
            debugLog("[ScreenShareExtension] Failed to send frame: \(error)")
        }
    }
    
    private func handleAudioSampleBuffer(_ sampleBuffer: CMSampleBuffer, isAppAudio: Bool) {
        // Audio not supported via frame buffer - only video frames are sent
        // This is intentional as the modular socket system is designed for video
    }
    
    private func debugLog(_ message: String) {
        #if DEBUG
        print(message)
        #endif
    }
}
#endif
