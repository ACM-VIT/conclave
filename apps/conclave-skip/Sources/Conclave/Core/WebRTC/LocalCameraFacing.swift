import Foundation

/// The local camera facing (S20 SC8, S60 C6-2; RECONCILE R22). One value for the lobby preview, the call camera and
/// Settings: `LocalPreviewController` owns it (it adopts what the call's camera reports after a flip or a start) and the
/// core mirrors it into `MeetingState` once, so the stage's mirror and flip value and the Settings facing control
/// change in one publish. Shared (transpiled): the Kotlin `LocalPreviewController` reads the same enum.
enum LocalCameraFacing: String, Equatable {
    case front
    case back

    static func resolvedPreviewFacing(rawValue: String) -> LocalCameraFacing {
        rawValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "back" ? .back : .front
    }

    /// The stage chrome carries the facing as `isFrontCamera` (S20 0.5 `StageChromeSnapshot`).
    static func from(isFront: Bool) -> LocalCameraFacing {
        isFront ? .front : .back
    }

    var isFront: Bool {
        self == .front
    }

    /// Only the front camera mirrors your own video (S20 6 c); a share never mirrors.
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

/// What the call's camera reports to the one camera owner (STG-3; S20 6 f, SC8): the facing it resolved and whether the
/// system holds it (another app, multitasking or the background on iOS; a camera disconnect or error on Android). Pure,
/// so both controllers and the host tests apply the same rules.
enum LocalCameraPublication {
    /// A reported facing is published only when it differs from the owned one (no churn on an equal report).
    static func publishes(current: LocalCameraFacing, reported: LocalCameraFacing) -> Bool {
        current != reported
    }

    /// The call's camera counts as paused while the system holds it ("Camera paused" on your tile, S20 6 f).
    static func isPaused(_ interruption: PreviewInterruption) -> Bool {
        interruption != PreviewInterruption.none
    }

    /// The stage shows the pause only while your camera is meant to be on; a camera that is off has nothing to pause.
    static func showsPaused(interruption: PreviewInterruption, isCameraOff: Bool) -> Bool {
        !isCameraOff && isPaused(interruption)
    }
}
