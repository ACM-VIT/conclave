import Foundation

enum PermissionPrimingKind: String, CaseIterable, Equatable {

    case none

    case rationale

    case openSettings

    case restricted
}

enum PermissionPrimingPlacement: String, CaseIterable, Equatable {
    case none, row, card
}

struct PermissionPrimingModel: Equatable {
    let kind: LobbyMediaKind
    let priming: PermissionPrimingKind
    let placement: PermissionPrimingPlacement
}

enum PermissionPrimingPolicy {

    static var platformSupportsRationale: Bool {
        #if SKIP
        return true
        #else
        return false
        #endif
    }

    static func priming(permission: MediaPermissionState, canAskAgain: Bool, supportsRationale: Bool,
                        rationaleDismissed: Bool) -> PermissionPrimingKind {
        switch permission {
        case .granted, .notDetermined, .unavailable:
            return .none
        case .restricted:
            return .restricted
        case .denied:
            if supportsRationale && canAskAgain {
                return rationaleDismissed ? PermissionPrimingKind.none : PermissionPrimingKind.rationale
            }
            return .openSettings
        }
    }

    static func placement(kind: LobbyMediaKind, priming: PermissionPrimingKind) -> PermissionPrimingPlacement {
        if priming == .none { return .none }
        if kind == .camera && priming != .rationale { return .card }
        return .row
    }

    static func model(kind: LobbyMediaKind, permission: MediaPermissionState, canAskAgain: Bool, supportsRationale: Bool,
                      rationaleDismissed: Bool) -> PermissionPrimingModel {
        let value = PermissionPrimingPolicy.priming(permission: permission, canAskAgain: canAskAgain,
                                                    supportsRationale: supportsRationale,
                                                    rationaleDismissed: rationaleDismissed)
        return PermissionPrimingModel(kind: kind, priming: value,
                                      placement: PermissionPrimingPolicy.placement(kind: kind, priming: value))
    }

    static func showsCameraOverlay(permission: MediaPermissionState, canAskAgain: Bool, supportsRationale: Bool) -> Bool {
        model(kind: .camera, permission: permission, canAskAgain: canAskAgain, supportsRationale: supportsRationale,
              rationaleDismissed: false).placement == .card
    }

    static func rows(media: LobbyMediaSnapshot, supportsRationale: Bool, microphoneRationaleDismissed: Bool,
                     cameraRationaleDismissed: Bool) -> [PermissionPrimingModel] {
        var rows: [PermissionPrimingModel] = []
        let microphone = model(kind: .microphone, permission: media.micPermission,
                               canAskAgain: media.canAskAgainMicrophone, supportsRationale: supportsRationale,
                               rationaleDismissed: microphoneRationaleDismissed)
        if microphone.placement == .row {
            rows.append(microphone)
        }
        let camera = model(kind: .camera, permission: media.cameraPermission, canAskAgain: media.canAskAgainCamera,
                           supportsRationale: supportsRationale, rationaleDismissed: cameraRationaleDismissed)
        if camera.placement == .row {
            rows.append(camera)
        }
        return rows
    }

    static func displaysOn(intentOn: Bool, permission: MediaPermissionState, canAskAgain: Bool) -> Bool {
        guard intentOn else { return false }
        switch permission {
        case .granted, .notDetermined:
            return true
        case .denied:
            return canAskAgain
        case .restricted, .unavailable:
            return false
        }
    }

    static func toggleReason(permission: MediaPermissionState, canAskAgain: Bool, supportsRationale: Bool) -> PermissionPrimingKind {
        let value = PermissionPrimingPolicy.priming(permission: permission, canAskAgain: canAskAgain,
                                                    supportsRationale: supportsRationale, rationaleDismissed: false)
        return value == .rationale ? PermissionPrimingKind.none : value
    }
}

struct LobbyPermissionGenerations: Equatable {
    let microphone: Int
    let camera: Int

    static let initial = LobbyPermissionGenerations(microphone: 0, camera: 0)

    func current(_ kind: LobbyMediaKind) -> Int {
        kind == .camera ? camera : microphone
    }

    func begun(_ kind: LobbyMediaKind) -> LobbyPermissionGenerations {
        if kind == .camera {
            return LobbyPermissionGenerations(microphone: microphone, camera: camera + 1)
        }
        return LobbyPermissionGenerations(microphone: microphone + 1, camera: camera)
    }

    func cancelled() -> LobbyPermissionGenerations {
        LobbyPermissionGenerations(microphone: microphone + 1, camera: camera + 1)
    }

    func accepts(_ generation: Int, kind: LobbyMediaKind) -> Bool {
        JoinAsyncPermissionPolicy.shouldApply(generation: generation, currentGeneration: current(kind))
    }
}

enum LobbyPermissionCleanupPolicy {

    static func cancelsRequests(mode: LobbyMode, isCallRoot: Bool, handedOff: Bool) -> Bool {
        guard !handedOff, !isCallRoot else { return false }
        return mode == .editing || mode == .failed
    }
}

struct PermissionPrimingFixturePermissions: Equatable {
    let microphone: MediaPermissionState
    let camera: MediaPermissionState
    let canAskAgainMicrophone: Bool
    let canAskAgainCamera: Bool
}

enum PermissionPrimingFixture {

    static let undetermined = "lobby-permissions-undetermined"

    static let microphoneRationale = "lobby-mic-rationale"

    static let cameraRationale = "lobby-camera-rationale"

    static let denied = "lobby-permissions-denied"

    static let restricted = "lobby-permissions-restricted"

    static let states: [String] = [undetermined, microphoneRationale, cameraRationale, denied, restricted]

    static func permissions(forState raw: String) -> PermissionPrimingFixturePermissions? {
        if raw == undetermined {
            return PermissionPrimingFixturePermissions(microphone: .notDetermined, camera: .notDetermined,
                                                       canAskAgainMicrophone: true, canAskAgainCamera: true)
        }
        if raw == microphoneRationale {
            return PermissionPrimingFixturePermissions(microphone: .denied, camera: .notDetermined,
                                                       canAskAgainMicrophone: true, canAskAgainCamera: true)
        }
        if raw == cameraRationale {
            return PermissionPrimingFixturePermissions(microphone: .notDetermined, camera: .denied,
                                                       canAskAgainMicrophone: true, canAskAgainCamera: true)
        }
        if raw == denied {
            return PermissionPrimingFixturePermissions(microphone: .denied, camera: .denied,
                                                       canAskAgainMicrophone: false, canAskAgainCamera: false)
        }
        if raw == restricted {
            return PermissionPrimingFixturePermissions(microphone: .restricted, camera: .restricted,
                                                       canAskAgainMicrophone: false, canAskAgainCamera: false)
        }
        return nil
    }
}
