#if os(iOS) && !SKIP
import SwiftUI

enum PermissionPrimingCopy {
    static func title(_ kind: LobbyMediaKind) -> String {
        kind == .camera ? ConclaveStrings.text("Camera Access Is Off") : ConclaveStrings.text("Microphone Access Is Off")
    }

    static func body(_ kind: LobbyMediaKind, priming: PermissionPrimingKind) -> String {
        switch priming {
        case .restricted:
            return kind == .camera
                ? ConclaveStrings.text("Camera access is restricted on this device.")
                : ConclaveStrings.text("Microphone access is restricted on this device.")
        case .none, .rationale, .openSettings:
            return kind == .camera
                ? ConclaveStrings.text("Allow camera access in Settings to use video in meetings.")
                : ConclaveStrings.text("Allow microphone access in Settings so people can hear you.")
        }
    }

    static func hint(_ kind: LobbyMediaKind, reason: PermissionPrimingKind) -> String {
        switch reason {
        case .openSettings:
            return kind == .camera
                ? ConclaveStrings.text("Camera access is off in Settings.")
                : ConclaveStrings.text("Microphone access is off in Settings.")
        case .restricted:
            return kind == .camera
                ? ConclaveStrings.text("Camera access is restricted on this device.")
                : ConclaveStrings.text("Microphone access is restricted on this device.")
        case .none, .rationale:
            return ""
        }
    }

    static func symbol(_ kind: LobbyMediaKind) -> String {
        kind == .camera ? ConclaveSymbols.videoSlash : ConclaveSymbols.micSlash
    }

    static func identifier(_ kind: LobbyMediaKind) -> String {
        kind == .camera ? "lobby.camera.permission" : "lobby.microphone.denied"
    }
}
#endif
