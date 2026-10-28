import Foundation

enum LocalCameraFacing: String, Equatable {
    case front
    case back

    static func resolvedPreviewFacing(rawValue: String) -> LocalCameraFacing {
        rawValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "back" ? .back : .front
    }

    static func from(isFront: Bool) -> LocalCameraFacing {
        isFront ? .front : .back
    }

    var isFront: Bool {
        self == .front
    }

    var shouldMirrorLocalVideo: Bool {
        self == .front
    }

    var label: String {
        switch self {
        case .front:
            return "Front camera"
        case .back:
            return "Rear camera"
        }
    }

    var next: LocalCameraFacing {
        switch self {
        case .front:
            return .back
        case .back:
            return .front
        }
    }
}

enum LocalCameraPublication {

    static func publishes(current: LocalCameraFacing, reported: LocalCameraFacing) -> Bool {
        current != reported
    }

    static func isPaused(_ interruption: PreviewInterruption) -> Bool {
        interruption != PreviewInterruption.none
    }

    static func showsPaused(interruption: PreviewInterruption, isCameraOff: Bool) -> Bool {
        !isCameraOff && isPaused(interruption)
    }
}
