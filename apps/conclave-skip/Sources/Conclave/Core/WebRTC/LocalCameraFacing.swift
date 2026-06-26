import Foundation

enum LocalCameraFacing: String, Equatable {
    case front
    case back

    static func resolvedPreviewFacing(rawValue: String) -> LocalCameraFacing {
        rawValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "back" ? .back : .front
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
