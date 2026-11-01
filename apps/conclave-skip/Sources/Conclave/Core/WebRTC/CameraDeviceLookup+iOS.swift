#if os(iOS) && !SKIP
import AVFoundation

enum CameraDeviceLookup {

    static func discoveryDevices() -> [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .builtInDualCamera, .builtInTrueDepthCamera, .external, .continuityCamera],
            mediaType: .video,
            position: .unspecified
        ).devices
    }

    static func candidate(_ device: AVCaptureDevice) -> CameraCandidate {
        let kind: CameraCandidateKind
        switch device.deviceType {
        case .builtInWideAngleCamera: kind = .builtInWide
        case .builtInDualCamera, .builtInTrueDepthCamera, .builtInUltraWideCamera, .builtInTelephotoCamera,
             .builtInDualWideCamera, .builtInTripleCamera:
            kind = .builtIn
        case .external: kind = .attached
        case .continuityCamera: kind = .continuity
        default: kind = .other
        }
        return CameraCandidate(id: device.uniqueID, position: candidatePosition(device.position), kind: kind)
    }

    static func candidatePosition(_ position: AVCaptureDevice.Position) -> CameraCandidatePosition {
        switch position {
        case .front: return .front
        case .back: return .back
        default: return .unspecified
        }
    }

    static var systemPreferredId: String {
        AVCaptureDevice.systemPreferredCamera?.uniqueID ?? ""
    }

    static func device(position: AVCaptureDevice.Position) -> AVCaptureDevice? {
        let devices = discoveryDevices()
        let chosen = CameraDeviceSelectionPolicy.select(devices.map { candidate($0) }, wanted: candidatePosition(position),
                                                        systemPreferredId: systemPreferredId)
        guard let chosen else { return nil }
        return devices.first { $0.uniqueID == chosen.id }
    }

    static func canSwitch() -> Bool {
        CameraDeviceSelectionPolicy.canSwitch(discoveryDevices().map { candidate($0) }, systemPreferredId: systemPreferredId)
    }
}
#endif
