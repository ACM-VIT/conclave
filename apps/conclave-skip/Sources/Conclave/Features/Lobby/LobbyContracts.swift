import Foundation

enum MediaPermissionState: String, CaseIterable, Equatable {
    case notDetermined, granted, denied, restricted, unavailable
}

enum PreviewState: String, CaseIterable, Equatable {
    case off, starting, live, published, interrupted, unavailable, blocked
}

enum PreviewInterruption: String, CaseIterable, Equatable {
    case none, inUseByAnotherClient, multipleForegroundApps, background, cameraError
}

enum PresenceKind: String, CaseIterable, Equatable {
    case hidden, checking, empty, count
}

enum LobbyMediaKind: String, CaseIterable, Equatable {
    case microphone, camera
}

enum LobbyPrimaryReason: String, CaseIterable, Equatable {
    case none, nameMissingJoin, nameMissingStart, offline, updateRequired
}

struct LobbyMediaSnapshot: Equatable {
    let routeId: Int
    let micIntentOn: Bool
    let cameraIntentOn: Bool
    let micPermission: MediaPermissionState
    let cameraPermission: MediaPermissionState
    let canAskAgainAndroid: Bool
    let preview: PreviewState
    let previewSessionId: Int
    let isFrontCamera: Bool

    let showsEffects: Bool
    let effectsActive: Bool
    let avatarName: String
    let avatarSeed: String
    let interruption: PreviewInterruption

    let canAskAgainMicrophone: Bool
    let canAskAgainCamera: Bool
}

struct LobbyPresenceSnapshot: Equatable {
    let routeId: Int
    let kind: PresenceKind
    let count: Int
}

struct LobbyIdentitySnapshot: Equatable {
    let routeId: Int
    let isSignedIn: Bool
    let accountName: String
    let accountSeed: String
    let guestName: String
    let nameLimit: Int
    let needsInviteCode: Bool

    let inviteCodeInvalid: Bool
}

struct LobbyLinkSnapshot: Equatable {
    let routeId: Int
    let roomId: String
    let roomLabel: String
    let meetingLink: String
    let canShare: Bool
}

struct LobbyAudioSnapshot: Equatable {
    let routeId: Int
    let routeName: String
    let routeKind: String
    let showsInputRow: Bool
    let inputName: String
    let outputs: [AudioRouteOption]
    let currentOutputId: String
    let inputs: [AudioRouteOption]
    let currentInputId: String
}

enum DisplayNamePolicy {
    static let limit = 40
    static let counterThreshold = 30

    static func isCounterVisible(count: Int) -> Bool {
        count >= counterThreshold
    }

    static func capped(_ raw: String) -> String {
        raw.count > limit ? String(raw.prefix(limit)) : raw
    }

    static func normalized(_ raw: String) -> String {
        NativeDisplayNameNormalizer.normalize(raw)
    }
}

struct LobbyDeviceInputs: Equatable {
    let micPermission: MediaPermissionState
    let cameraPermission: MediaPermissionState
    let canAskAgainMicrophone: Bool
    let canAskAgainCamera: Bool
    let previewState: PreviewState
    let previewSessionId: Int
    let isFrontCamera: Bool
    let interruption: PreviewInterruption
    let effectsAvailable: Bool
    let effectsActive: Bool
    let outputs: [AudioRouteOption]
    let currentOutputId: String
    let inputs: [AudioRouteOption]
    let currentInputId: String

    static let initial = LobbyDeviceInputs(
        micPermission: .notDetermined, cameraPermission: .notDetermined, canAskAgainMicrophone: true,
        canAskAgainCamera: true, previewState: .off, previewSessionId: 0, isFrontCamera: true,
        interruption: .none, effectsAvailable: false, effectsActive: false, outputs: [], currentOutputId: "",
        inputs: [], currentInputId: ""
    )

    func withPermissions(microphone: MediaPermissionState, camera: MediaPermissionState,
                         canAskAgainMicrophone: Bool, canAskAgainCamera: Bool) -> LobbyDeviceInputs {
        LobbyDeviceInputs(
            micPermission: microphone, cameraPermission: camera, canAskAgainMicrophone: canAskAgainMicrophone,
            canAskAgainCamera: canAskAgainCamera, previewState: previewState, previewSessionId: previewSessionId,
            isFrontCamera: isFrontCamera, interruption: interruption, effectsAvailable: effectsAvailable,
            effectsActive: effectsActive, outputs: outputs, currentOutputId: currentOutputId, inputs: inputs,
            currentInputId: currentInputId
        )
    }

    func withPreview(state: PreviewState, sessionId: Int, isFrontCamera: Bool,
                     interruption: PreviewInterruption) -> LobbyDeviceInputs {
        LobbyDeviceInputs(
            micPermission: micPermission, cameraPermission: cameraPermission,
            canAskAgainMicrophone: canAskAgainMicrophone, canAskAgainCamera: canAskAgainCamera, previewState: state,
            previewSessionId: sessionId, isFrontCamera: isFrontCamera, interruption: interruption,
            effectsAvailable: effectsAvailable, effectsActive: effectsActive, outputs: outputs,
            currentOutputId: currentOutputId, inputs: inputs, currentInputId: currentInputId
        )
    }

    func withRoutes(outputs: [AudioRouteOption], currentOutputId: String, inputs: [AudioRouteOption],
                    currentInputId: String) -> LobbyDeviceInputs {
        LobbyDeviceInputs(
            micPermission: micPermission, cameraPermission: cameraPermission,
            canAskAgainMicrophone: canAskAgainMicrophone, canAskAgainCamera: canAskAgainCamera,
            previewState: previewState, previewSessionId: previewSessionId, isFrontCamera: isFrontCamera,
            interruption: interruption, effectsAvailable: effectsAvailable, effectsActive: effectsActive,
            outputs: outputs, currentOutputId: currentOutputId, inputs: inputs, currentInputId: currentInputId
        )
    }

    func withEffects(available: Bool, active: Bool) -> LobbyDeviceInputs {
        LobbyDeviceInputs(
            micPermission: micPermission, cameraPermission: cameraPermission,
            canAskAgainMicrophone: canAskAgainMicrophone, canAskAgainCamera: canAskAgainCamera,
            previewState: previewState, previewSessionId: previewSessionId, isFrontCamera: isFrontCamera,
            interruption: interruption, effectsAvailable: available, effectsActive: active, outputs: outputs,
            currentOutputId: currentOutputId, inputs: inputs, currentInputId: currentInputId
        )
    }
}

struct EntryMediaIntent: Equatable {
    let mic: Bool
    let camera: Bool
    let generation: Int
}

enum EntryMediaIntentPolicy {

    static func route(phase: MeetingPhaseKind, hasBeenAdmittedThisSession: Bool) -> String {
        switch phase {
        case .entering:
            return "pending"
        case .home, .waiting, .outcome:
            return "flags"
        case .recovering:
            return hasBeenAdmittedThisSession ? "toggles" : "flags"
        case .inCall, .leaving:
            return "toggles"
        }
    }

    static func reconcilable(_ intent: EntryMediaIntent?, currentGeneration: Int) -> EntryMediaIntent? {
        guard let intent, intent.generation == currentGeneration else { return nil }
        return intent
    }
}

struct LobbyJoinRequest: Equatable {
    let routeId: Int
    let roomId: String
    let displayName: String

    let socketDisplayName: String?
    let isGuest: Bool
    let isHost: Bool
    let joinMode: JoinMode
    let meetingInviteCode: String?
    let webinarInviteCode: String?
    let clientId: String?
    let allowRoomCreation: Bool

    let cameraFacing: LocalCameraFacing
}

@MainActor
final class LobbyCoreHooks {

    var join: ((LobbyJoinRequest) -> Void)? = nil

    var setEntryMediaIntent: ((Bool, Bool) -> Void)? = nil

    var setPrejoinAudioRouteIntent: ((String, String) -> Void)? = nil

    var startPreview: ((LocalCameraFacing) -> Void)? = nil
    var stopPreview: (() -> Void)? = nil
    var flipPreview: (() -> Void)? = nil

    var handOffPreview: (() -> Void)? = nil

    var resetPreviewLatch: (() -> Void)? = nil

    var requestPermission: ((String) -> Void)? = nil
    var openSystemSettings: (() -> Void)? = nil

    var refreshDevices: (() -> Void)? = nil

    var fetchPresence: ((String, String) async -> Int?)? = nil

    var resolvedClientId: (() -> String)? = nil

    var openEffects: (() -> Void)? = nil

    var cancelPermissionRequests: (() -> Void)? = nil

    init() {
    }
}
