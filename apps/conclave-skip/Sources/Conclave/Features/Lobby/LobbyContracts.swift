import Foundation

// ENT-3 (S10 0.5 "lobby snapshots", 6 j; RECONCILE R22, R23, R31, R38): the lobby half of the premeeting contract.
// Transpiled Swift: String raw-value enums, scalar structs and arrays of structs, no associated values, no tuples
// (S1C 3.6). The six lobby snapshots are published separately by the premeeting presenter (card, status, presence,
// identity, link, audio), so a presence result or a route name never re-evaluates the preview card (F00 P2, P3; 6 k).
// `LobbyStatusSnapshot` stays in PremeetingContracts.swift (ENT-1 published it first); the other five live here.

// MARK: - Shared enums

/// What the system grants for one capture device (S10 0.5; read by `MediaPermissionStatusProvider`).
enum MediaPermissionState: String, CaseIterable, Equatable {
    case notDetermined, granted, denied, restricted, unavailable
}

/// The one preview state of the WP3 `LocalPreviewController` (RECONCILE R22; canonical type S10 0.5), shared by the
/// lobby card, the S60 Settings LivePreviewCard and the promotion lobby. `published` means the call owns the camera
/// now (the publish latch is closed); `blocked` means a permission stops it.
enum PreviewState: String, CaseIterable, Equatable {
    case off, starting, live, published, interrupted, unavailable, blocked
}

/// Why a running preview stopped by itself (S60 C6-8): the iOS `AVCaptureSession` interruption reasons and the
/// Android camera disconnect or `ERROR_CAMERA_IN_USE`.
enum PreviewInterruption: String, CaseIterable, Equatable {
    case none, inUseByAnotherClient, multipleForegroundApps, background, cameraError
}

enum PresenceKind: String, CaseIterable, Equatable {
    case hidden, checking, empty, count
}

/// The capture devices the lobby asks about; raw values are the `requestPermission(_:)` arguments (S10 0.5).
enum LobbyMediaKind: String, CaseIterable, Equatable {
    case microphone, camera
}

/// Why the lobby primary is disabled. `LobbyStatusSnapshot.primaryReason` carries the raw value ("" for none); each
/// platform maps it to its copy (S10 6 g "Disabled reasons").
enum LobbyPrimaryReason: String, CaseIterable, Equatable {
    case none, nameMissingJoin, nameMissingStart, offline, updateRequired
}

// MARK: - The five lobby snapshots beside LobbyStatusSnapshot

/// The preview card and its toggles only (S10 0.5). `micIntentOn` and `cameraIntentOn` are core inputs (the view
/// model flags and `pendingEntryMediaIntent`, S10 0.8 C1), never stored by the presenter. `avatarName` and
/// `avatarSeed` draw the camera-off avatar (additive to S10 0.5: the card shows the person's avatar).
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
    /// S60 `EffectsAvailability == .panel` (RECONCILE R31); false today, so the Effects slot stays hidden.
    let showsEffects: Bool
    let effectsActive: Bool
    let avatarName: String
    let avatarSeed: String
    let interruption: PreviewInterruption
    /// ENT-4 (S10 7 d, j): whether each device's system prompt can still show (Android rationale handling; on iOS only
    /// while undetermined). `canAskAgainAndroid` above is both together, kept for the existing readers.
    let canAskAgainMicrophone: Bool
    let canAskAgainCamera: Bool
}

/// The subtitle under the title (S10 6 f "Presence"); hidden for `newMeeting`, `promotion` and failed requests.
struct LobbyPresenceSnapshot: Equatable {
    let routeId: Int
    let kind: PresenceKind
    let count: Int
}

/// The name row or the Joining as row, and the invite code field (S10 6 c). `guestName` is the presenter's draft
/// (capped at `nameLimit`); the field keeps its own text and seeds from it.
struct LobbyIdentitySnapshot: Equatable {
    let routeId: Int
    let isSignedIn: Bool
    let accountName: String
    let accountSeed: String
    let guestName: String
    let nameLimit: Int
    let needsInviteCode: Bool
    /// The last join said the entered invite code was wrong (S10 6 g invite error).
    let inviteCodeInvalid: Bool
}

/// The title and the Meeting Link row (S10 6 c, 11). `meetingLink` comes from the shared `MeetingLinkBuilder`
/// (RECONCILE R50); `canShare` is false for `newMeeting` before Start (S10 Q1) and for `promotion` (R30).
struct LobbyLinkSnapshot: Equatable {
    let routeId: Int
    let roomId: String
    let roomLabel: String
    let meetingLink: String
    let canShare: Bool
}

/// The Audio row and the iOS Microphone row (S10 6 c, d). `routeKind` is an S30 `AudioRouteKind` raw value
/// (RECONCILE R23); `routeName` is "" when the platform gives no name (the view shows the kind's name). The option
/// lists feed the Android route dialog and the iOS 17 to 25 input picker (additive to S10 0.5).
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

// MARK: - Display names (RECONCILE R38)

/// The one display-name rule for the lobby, Account, the webinar landing, S50 Change Name and the S60 Name field
/// (canonical in S10 0.5). The cap matches `NativeDisplayNameNormalizer` and the SFU.
enum DisplayNamePolicy {
    static let limit = 40
    static let counterThreshold = 30

    static func isCounterVisible(count: Int) -> Bool {
        count >= counterThreshold
    }

    /// Typing stops at the limit (S10 6 f "Name at limit"); the text is otherwise kept as typed.
    static func capped(_ raw: String) -> String {
        raw.count > limit ? String(raw.prefix(limit)) : raw
    }

    /// The name a join sends: trimmed, inner whitespace collapsed, capped.
    static func normalized(_ raw: String) -> String {
        NativeDisplayNameNormalizer.normalize(raw)
    }
}

// MARK: - Device inputs (WP3 services push them; S10 0.5 inputs table)

/// The lobby's device facts: permissions (`MediaPermissionStatusProvider`), the preview (`LocalPreviewController`),
/// routes (the S30 `AudioRouteSnapshot` of the CC4 owner, or the platform's pre-call list) and Effects availability.
/// Pushed through the presenter's `apply...` members, each equality-guarded.
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

// MARK: - Entry media intent (S10 0.8 C1; the core stores it, HD request B4-T2 R1)

/// The lobby's mic and camera intent while the join is in flight (phase `entering`), with the attempt it belongs to.
/// The view model reconciles it exactly once on `.joined` through the existing toggles (so send-transport creation and
/// the producer generation guards apply) and drops it when the attempt changes.
struct EntryMediaIntent: Equatable {
    let mic: Bool
    let camera: Bool
    let generation: Int
}

enum EntryMediaIntentPolicy {
    /// Where a lobby intent goes for a phase: `pending` while entering (the transport decision may already be made),
    /// `flags` at home, while waiting and while reconnecting before the first admission (the next join reads them),
    /// `toggles` once in call (the S1 toggles apply).
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

    /// The pending intent to apply on `.joined`, or nil when it is stale (another attempt) or absent.
    static func reconcilable(_ intent: EntryMediaIntent?, currentGeneration: Int) -> EntryMediaIntent? {
        guard let intent, intent.generation == currentGeneration else { return nil }
        return intent
    }
}

// MARK: - Join (the LobbyJoinCoordinator's output, S10 6 j)

/// One join the lobby asks for. The production hook adds the SFU user payload from the identity it owns and calls
/// `joinRoom(...)` with these values and never arms the legacy entry overlay (S10 0.5 "Join" row).
struct LobbyJoinRequest: Equatable {
    let routeId: Int
    let roomId: String
    let displayName: String
    /// `socketDisplayNameForJoin` parity: the name for meeting hosts only.
    let socketDisplayName: String?
    let isGuest: Bool
    let isHost: Bool
    let joinMode: JoinMode
    let meetingInviteCode: String?
    let webinarInviteCode: String?
    let clientId: String?
    let allowRoomCreation: Bool
    /// The preview's facing carries into the call (`setPreferredLocalCameraFacing`, S10 0.5 "Camera facing").
    let cameraFacing: LocalCameraFacing
}

// MARK: - Core and WP3 hooks

/// What the lobby drives outside the presenter. Production wiring (`PremeetingAppWiring`) installs the view model,
/// the `LocalPreviewController`, the permission provider and the presence service; the L9 fixture installs scripted
/// answers; tests install recorders. Every member is optional, so a presenter without hooks reaches no media, no
/// network and no call (S10 L9).
@MainActor
final class LobbyCoreHooks {
    /// The view model's `joinRoom(...)` (with `setPreferredLocalCameraFacing`); the legacy entry overlay stays off.
    var join: ((LobbyJoinRequest) -> Void)? = nil
    /// S10 0.8 C1: `MeetingViewModel.setEntryMediaIntent(mic:camera:)`, the only lobby path for media intent.
    var setEntryMediaIntent: ((Bool, Bool) -> Void)? = nil
    /// S10 0.8 C2: `MeetingViewModel.setPrejoinAudioRouteIntent(outputKind:inputId:)`; never `setAudioOutput`.
    var setPrejoinAudioRouteIntent: ((String, String) -> Void)? = nil
    /// The WP3 preview owner (RECONCILE R22).
    var startPreview: ((LocalCameraFacing) -> Void)? = nil
    var stopPreview: (() -> Void)? = nil
    var flipPreview: (() -> Void)? = nil
    /// The publish latch: the call owns the camera from now on; the preview keeps its last frame as a still (Q16 B).
    var handOffPreview: (() -> Void)? = nil
    /// A new lobby after the call ended reopens the latch.
    var resetPreviewLatch: (() -> Void)? = nil
    /// `LobbyMediaKind` raw value; the provider pushes the new state through `applyPermissions`.
    var requestPermission: ((String) -> Void)? = nil
    var openSystemSettings: (() -> Void)? = nil
    /// Re-read permissions and routes (lobby appearance, foreground, the route picker closing).
    var refreshDevices: (() -> Void)? = nil
    /// `GET /api/sfu/rooms/<room>`: the user count, or nil when the request failed (presence hidden).
    var fetchPresence: ((String, String) async -> Int?)? = nil
    /// The app's SFU client id (`SfuJoinService.resolveClientId()`); nil means the default tenant.
    var resolvedClientId: (() -> String)? = nil
    /// RECONCILE R31: presents the S60 Effects content over the lobby once an engine publishes `.panel`.
    var openEffects: (() -> Void)? = nil
    /// ENT-4 (S10 7 j): the lobby left for anything but the hand-off into the meeting
    /// (`LobbyPermissionCleanupPolicy`): pending answers become stale and queued Android prompts are dropped.
    var cancelPermissionRequests: (() -> Void)? = nil

    init() {
    }
}
