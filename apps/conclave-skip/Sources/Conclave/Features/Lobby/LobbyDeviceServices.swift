import Foundation
#if os(iOS) && !SKIP
import AVFoundation
import UIKit
#endif

// ENT-3 (S10 0.5 inputs table, 6 j, 7 c, d, j; Q14; RECONCILE R22, R23): the WP3 device services the native lobby
// reads, and the one production wiring of the lobby hooks. Nothing here runs for the L9 fixture or in tests: the
// premeeting presenter reaches media, permissions, routes and the network only through `LobbyCoreHooks`, which only
// `LobbyProductionHooks.install` fills.

// MARK: - Permission status (S10 7 j: MediaPermissionStatusProvider)

@MainActor
enum MediaPermissionStatusProvider {
    /// Synchronous and cheap (S10 7 k): re-read on lobby appearance, on foreground and after a request.
    static func status(_ kind: LobbyMediaKind) -> MediaPermissionState {
        #if os(iOS) && !SKIP
        switch kind {
        case .camera:
            guard AVCaptureDevice.default(for: .video) != nil else { return .unavailable }
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized:
                return .granted
            case .notDetermined:
                return .notDetermined
            case .restricted:
                return .restricted
            case .denied:
                return .denied
            @unknown default:
                return .denied
            }
        case .microphone:
            switch AVAudioApplication.shared.recordPermission {
            case .granted:
                return .granted
            case .undetermined:
                return .notDetermined
            case .denied:
                return .denied
            @unknown default:
                return .denied
            }
        }
        #elseif SKIP
        let raw = PermissionHelper.mediaPermissionState(kind: kind.rawValue)
        return MediaPermissionState(rawValue: raw) ?? MediaPermissionState.notDetermined
        #else
        return kind == .camera ? MediaPermissionState.unavailable : MediaPermissionState.granted
        #endif
    }

    /// iOS asks once; Android may ask again while the system wants a rationale (S10 7 d).
    static func canAskAgain(_ kind: LobbyMediaKind) -> Bool {
        #if SKIP
        return PermissionHelper.canAskMediaPermissionAgain(kind: kind.rawValue)
        #else
        return status(kind) == .notDetermined
        #endif
    }

    /// The system prompt (iOS) or the serialized Android queue (`PermissionHelper`, one prompt at a time, invariant
    /// 18). The completion runs on the main actor with the result.
    static func request(_ kind: LobbyMediaKind, completion: @escaping (Bool) -> Void) {
        #if os(iOS) && !SKIP
        switch kind {
        case .camera:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async { completion(granted) }
            }
        case .microphone:
            AVAudioApplication.requestRecordPermission { granted in
                DispatchQueue.main.async { completion(granted) }
            }
        }
        #elseif SKIP
        PermissionHelper.markMediaPermissionRequested(kind: kind.rawValue)
        if kind == LobbyMediaKind.camera {
            PermissionHelper.requestCameraPermission { granted in
                completion(granted)
            }
        } else {
            PermissionHelper.requestRecordAudioPermission { granted in
                completion(granted)
            }
        }
        #else
        completion(kind == .microphone)
        #endif
    }

    /// iOS `openSettingsURLString`; Android `ACTION_APPLICATION_DETAILS_SETTINGS` (S10 7 c, d).
    static func openSystemSettings() {
        #if os(iOS) && !SKIP
        if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
        #elseif SKIP
        _ = PermissionHelper.openAppSettings()
        #endif
    }
}

// MARK: - Routes before the call (S10 6 c, d; Q14; RECONCILE R23)

struct LobbyAudioRoutes: Equatable {
    let outputs: [AudioRouteOption]
    let currentOutputId: String
    let inputs: [AudioRouteOption]
    let currentInputId: String

    static let empty = LobbyAudioRoutes(outputs: [], currentOutputId: "", inputs: [], currentInputId: "")
}

@MainActor
enum LobbyAudioRoutesReader {
    /// The S30 route owner's snapshot when it lists routes; before the call audio exists it is usually empty, so the
    /// platform's pre-call list is read instead, without activating the audio session (Q14) and without the Android
    /// nearby-devices request (R24).
    static func read() -> LobbyAudioRoutes {
        let route = AudioRouteOwner.shared.route
        var ownerOutputs: [AudioRouteOption] = []
        for option in route.options where option.id != AudioRouteOwner.bluetoothAccessOptionId {
            ownerOutputs.append(option)
        }
        if !ownerOutputs.isEmpty {
            return LobbyAudioRoutes(outputs: ownerOutputs, currentOutputId: route.currentId, inputs: route.inputs,
                                    currentInputId: route.currentInputId)
        }
        return platformRoutes()
    }

    private static func platformRoutes() -> LobbyAudioRoutes {
        #if os(iOS) && !SKIP
        let session = AVAudioSession.sharedInstance()
        var outputs: [AudioRouteOption] = []
        var currentOutputId = ""
        for port in session.currentRoute.outputs {
            let option = AudioRouteOption(id: port.uid, kind: kind(port.portType), name: port.portName, isConnecting: false)
            outputs.append(option)
            if currentOutputId.isEmpty {
                currentOutputId = option.id
            }
        }
        var inputs: [AudioRouteOption] = []
        for port in session.availableInputs ?? [] {
            inputs.append(AudioRouteOption(id: port.uid, kind: kind(port.portType), name: port.portName, isConnecting: false))
        }
        let currentInputId = session.currentRoute.inputs.first?.uid ?? ""
        return LobbyAudioRoutes(outputs: outputs, currentOutputId: currentOutputId, inputs: inputs,
                                currentInputId: currentInputId)
        #elseif SKIP
        return LobbyAudioRoutes(outputs: LobbyAudioDevices.outputs(), currentOutputId: LobbyAudioDevices.currentOutputId(),
                                inputs: [], currentInputId: "")
        #else
        return LobbyAudioRoutes.empty
        #endif
    }

    #if os(iOS) && !SKIP
    private static func kind(_ port: AVAudioSession.Port) -> AudioRouteKind {
        switch port {
        case .builtInReceiver, .builtInMic:
            return .receiver
        case .builtInSpeaker:
            return .speaker
        case .headphones, .headsetMic, .lineOut, .lineIn:
            return .wired
        case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE:
            return .bluetooth
        case .usbAudio:
            return .usb
        default:
            return .unknown
        }
    }
    #endif
}

// MARK: - Production wiring of the lobby hooks

/// Fills the premeeting presenter's `LobbyCoreHooks` once, from `PremeetingAppWiring.install` (production native
/// route only): the view model's join and the two intent members (S10 0.8 C1, C2), the one `LocalPreviewController`,
/// the permission provider, the route reader and the presence request.
@MainActor
enum LobbyProductionHooks {
    private static var installed = false

    static func install(presenter: PremeetingPresenter, viewModel: MeetingViewModel, appState: AppState) {
        guard !installed else { return }
        installed = true
        let hooks = LobbyCoreHooks()
        hooks.join = { request in
            LobbyProductionHooks.join(request, viewModel: viewModel, appState: appState)
        }
        // S10 0.8 C1 and C2 (HD requests B4-T2 R1, R2): intent only; the core applies it by phase.
        hooks.setEntryMediaIntent = { mic, camera in
            viewModel.setEntryMediaIntent(mic: mic, camera: camera)
        }
        hooks.setPrejoinAudioRouteIntent = { outputKind, inputId in
            viewModel.setPrejoinAudioRouteIntent(outputKind: outputKind, inputId: inputId)
        }
        let preview = LocalPreviewController.shared
        preview.onChange = { [weak presenter] in
            presenter?.applyPreview(state: preview.state, sessionId: preview.sessionId,
                                    isFrontCamera: preview.facing == LocalCameraFacing.front,
                                    interruption: preview.interruption)
        }
        hooks.startPreview = { facing in
            preview.start(facing: facing)
        }
        hooks.stopPreview = {
            preview.stop()
        }
        hooks.flipPreview = {
            preview.flip()
        }
        hooks.handOffPreview = {
            preview.handOffToCall()
        }
        hooks.resetPreviewLatch = {
            preview.resetLatch()
        }
        hooks.requestPermission = { [weak presenter] rawKind in
            let kind = LobbyMediaKind(rawValue: rawKind) ?? LobbyMediaKind.camera
            MediaPermissionStatusProvider.request(kind) { granted in
                presenter?.permissionRequestFinished(kind: rawKind, granted: granted)
                LobbyProductionHooks.pushPermissions(presenter)
            }
        }
        hooks.openSystemSettings = {
            MediaPermissionStatusProvider.openSystemSettings()
        }
        hooks.refreshDevices = { [weak presenter] in
            LobbyProductionHooks.pushPermissions(presenter)
            let routes = LobbyAudioRoutesReader.read()
            presenter?.applyAudioRoutes(outputs: routes.outputs, currentOutputId: routes.currentOutputId,
                                        inputOptions: routes.inputs, currentInputId: routes.currentInputId)
        }
        hooks.fetchPresence = { roomId, clientId in
            await RoomPresenceService.fetchUserCount(roomId: roomId, clientId: clientId)
        }
        hooks.resolvedClientId = {
            SfuJoinService.resolveClientId()
        }
        presenter.lobbyHooks = hooks
    }

    static func pushPermissions(_ presenter: PremeetingPresenter?) {
        guard let presenter else { return }
        presenter.applyPermissions(
            microphone: MediaPermissionStatusProvider.status(LobbyMediaKind.microphone),
            camera: MediaPermissionStatusProvider.status(LobbyMediaKind.camera),
            canAskAgainMicrophone: MediaPermissionStatusProvider.canAskAgain(LobbyMediaKind.microphone),
            canAskAgainCamera: MediaPermissionStatusProvider.canAskAgain(LobbyMediaKind.camera)
        )
    }

    /// The JoinView handleCreateRoom and handleJoinRoom effects without the view writes: the guest record, the
    /// preview's facing, then `joinRoom(...)` (the entry overlay is never armed, S10 0.5 "Join" row; no `isAdmin` view write).
    private static func join(_ request: LobbyJoinRequest, viewModel: MeetingViewModel, appState: AppState) {
        if request.isGuest {
            appState.setGuestUser(LobbyJoinCoordinator.guestUser(name: request.displayName, existing: appState.currentUser))
        }
        let displayName = request.isGuest
            ? request.displayName
            : LobbyJoinCoordinator.accountDisplayName(appState.currentUser, fallback: request.displayName)
        let socketDisplayName: String? = request.socketDisplayName == nil ? nil : displayName
        viewModel.setPreferredLocalCameraFacing(request.cameraFacing)
        viewModel.joinRoom(
            roomId: request.roomId,
            displayName: displayName,
            socketDisplayName: socketDisplayName,
            user: LobbyJoinCoordinator.sfuUser(currentUser: appState.currentUser, displayName: displayName),
            isHost: request.isHost,
            joinMode: request.joinMode,
            meetingInviteCode: request.meetingInviteCode,
            webinarInviteCode: request.webinarInviteCode,
            clientId: request.clientId,
            allowRoomCreation: request.allowRoomCreation
        )
    }
}
