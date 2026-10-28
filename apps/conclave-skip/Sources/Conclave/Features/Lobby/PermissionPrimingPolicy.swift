import Foundation

// ENT-4 (S10 7 a to l; 0.8 C12 is already in Darwin/Info.plist and Darwin/InfoPlist.xcstrings since SYS-14): permission
// priming in context. Camera and microphone are asked for only when the person turns them on in the lobby; a denial is
// explained calmly where it matters (the microphone in a row under the card, the camera inside the card) with a direct
// way to Settings; Android explains first and asks again while the system still allows it. These are the pure rules both
// platforms draw from; the presenter publishes the facts in `LobbyMediaSnapshot` and the views ask these rules what to
// show. Transpiled: String raw-value enums and scalar structs only.

// MARK: - What a permission shows (S10 7 f)

/// What the lobby shows for one capture device's permission.
enum PermissionPrimingKind: String, CaseIterable, Equatable {
    /// Nothing: granted, not asked yet (the first toggle tap asks, the lobby is the context), or no hardware (the card
    /// caption says the camera isn't available, S10 6 f).
    case none
    /// Android only: refused once and the system would ask again. Explain, then Allow or Not now (S10 7 d).
    case rationale
    /// Refused with no prompt left (iOS always; Android after a permanent denial): the body and Open Settings.
    case openSettings
    /// Blocked by device policy: the body only, no button (S10 7 c "restricted").
    case restricted
}

/// Where it shows: a row in the list under the card, or the overlay inside the dark card's video area (camera only).
enum PermissionPrimingPlacement: String, CaseIterable, Equatable {
    case none, row, card
}

struct PermissionPrimingModel: Equatable {
    let kind: LobbyMediaKind
    let priming: PermissionPrimingKind
    let placement: PermissionPrimingPlacement
}

enum PermissionPrimingPolicy {
    /// Android asks again after a first refusal (with a rationale); iOS never does (S10 7 g "iOS has no rationale flow").
    static var platformSupportsRationale: Bool {
        #if SKIP
        return true
        #else
        return false
        #endif
    }

    /// The priming for one device. `canAskAgain` is the provider's answer (iOS: only while undetermined; Android: before
    /// the first request, while the system wants a rationale, or after a dismissed first prompt). `rationaleDismissed` is
    /// the Android row's Not now for this lobby.
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

    /// The microphone always explains in a row. The camera explains inside the card (S10 7 c "PermissionOverlay"; 7 d
    /// "camera denial also shows the in-card overlay"), except the Android rationale, which asks again from a row under
    /// the card so the card keeps the avatar instead of a Settings prompt that is not needed yet.
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

    /// The card overlay (camera denied with no prompt left, or restricted). `LobbySnapshotPolicy.media` publishes the
    /// preview as `blocked` exactly when this is true, so both cards read one field.
    static func showsCameraOverlay(permission: MediaPermissionState, canAskAgain: Bool, supportsRationale: Bool) -> Bool {
        model(kind: .camera, permission: permission, canAskAgain: canAskAgain, supportsRationale: supportsRationale,
              rationaleDismissed: false).placement == .card
    }

    /// The rows under the card, microphone first (S10 7 b wireframes; the focus order of LobbyControlsColumn).
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

    /// The toggle's drawn state (S10 7 f "toggle Off"): the intent while the system can still grant it (granted,
    /// undetermined while the prompt is up, or an Android ask-again), Off otherwise. A lobby with intent on and access
    /// revoked reads Off, and the kept intent starts the preview once Settings grants access (7 f "granted later").
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

    /// Why a toggle reads Off although a tap cannot turn it on, for the iOS accessibility hint and the Android state
    /// description (S10 7 i): `openSettings` ("access is off in Settings") or `restricted`; `none` otherwise (a tap can
    /// still ask).
    static func toggleReason(permission: MediaPermissionState, canAskAgain: Bool, supportsRationale: Bool) -> PermissionPrimingKind {
        let value = PermissionPrimingPolicy.priming(permission: permission, canAskAgain: canAskAgain,
                                                    supportsRationale: supportsRationale, rationaleDismissed: false)
        return value == .rationale ? PermissionPrimingKind.none : value
    }
}

// MARK: - Stale answers and cleanup (S10 7 j; invariant 7)

/// One generation per device (JoinView's `JoinAsyncPermissionPolicy`): a request records the generation it started in
/// and its answer is applied only while that is still current, so a camera request never invalidates a microphone
/// answer. Leaving the lobby (anything but the hand-off) bumps both.
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
    /// S10 7 j (JoinView's `JoinPermissionCleanupPolicy`): a lobby that disappears for any reason other than the hand-off
    /// into the meeting cancels its pending requests, so no prompt surfaces later on Home or over another lobby (7 l3).
    /// Connecting, waiting and the call root keep them (the join may still need the answer).
    static func cancelsRequests(mode: LobbyMode, isCallRoot: Bool, handedOff: Bool) -> Bool {
        guard !handedOff, !isCallRoot else { return false }
        return mode == .editing || mode == .failed
    }
}

// MARK: - L9 fixture states (S10 7 l; PLAN-screens ENT-4 "notDetermined shown from the fixture only")

/// The permissions a lobby fixture injects. The fixture's hooks never request anything, so no system prompt can appear
/// (silent runs never accept one).
struct PermissionPrimingFixturePermissions: Equatable {
    let microphone: MediaPermissionState
    let camera: MediaPermissionState
    let canAskAgainMicrophone: Bool
    let canAskAgainCamera: Bool
}

enum PermissionPrimingFixture {
    /// Both undetermined: no row, no overlay; a toggle tap shows its intent (the fixture has no prompt to show).
    static let undetermined = "lobby-permissions-undetermined"
    /// Microphone refused once with a prompt left: Android rationale row (Allow, Not now); iOS Open Settings row.
    static let microphoneRationale = "lobby-mic-rationale"
    /// Camera refused once with a prompt left: Android rationale row under the card; iOS card overlay.
    static let cameraRationale = "lobby-camera-rationale"
    /// Both refused with no prompt left: the card overlay and the microphone row, both with Open Settings.
    static let denied = "lobby-permissions-denied"
    /// Both restricted: the same places without a button.
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
