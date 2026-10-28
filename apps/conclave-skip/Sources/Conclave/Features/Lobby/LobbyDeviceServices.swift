import Foundation
#if os(iOS) && !SKIP
import AVFoundation
import UIKit
#endif

@MainActor
enum MediaPermissionStatusProvider {

    static func status(_ kind: LobbyMediaKind) -> MediaPermissionState {
        #if os(iOS) && !SKIP
        switch kind {
        case .camera:
            return EntryPolicies.mediaPermissionState(authorization: cameraAuthorization(),
                                                      hasDevice: AVCaptureDevice.default(for: .video) != nil)
        case .microphone:
            return EntryPolicies.mediaPermissionState(authorization: microphoneAuthorization(), hasDevice: true)
        }
        #elseif SKIP

        let raw = PermissionHelper.mediaPermissionState(kind: kind.rawValue)
        return MediaPermissionState(rawValue: raw) ?? MediaPermissionState.notDetermined
        #else
        return kind == .camera ? MediaPermissionState.unavailable : MediaPermissionState.granted
        #endif
    }

    static func canAskAgain(_ kind: LobbyMediaKind) -> Bool {
        #if SKIP
        return PermissionHelper.canAskMediaPermissionAgain(kind: kind.rawValue)
        #else
        return EntryPolicies.iosCanAskAgain(status(kind))
        #endif
    }

    #if os(iOS) && !SKIP
    private static func cameraAuthorization() -> PlatformCaptureAuthorization {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            return .authorized
        case .notDetermined:
            return .notDetermined
        case .restricted:
            return .restricted
        case .denied:
            return .denied
        @unknown default:
            return .denied
        }
    }

    private static func microphoneAuthorization() -> PlatformCaptureAuthorization {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return .authorized
        case .undetermined:
            return .notDetermined
        case .denied:
            return .denied
        @unknown default:
            return .denied
        }
    }
    #endif

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

    static func openSystemSettings() {
        #if os(iOS) && !SKIP
        if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
        #elseif SKIP
        _ = PermissionHelper.openAppSettings()

        return
        #endif
    }
}

struct LobbyAudioRoutes: Equatable {
    let outputs: [AudioRouteOption]
    let currentOutputId: String
    let inputs: [AudioRouteOption]
    let currentInputId: String

    static let empty = LobbyAudioRoutes(outputs: [], currentOutputId: "", inputs: [], currentInputId: "")
}

@MainActor
enum LobbyAudioRoutesReader {

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

@MainActor
enum LobbyProductionHooks {
    private static var installed = false

    static var permissionGenerations = LobbyPermissionGenerations.initial

    static func install(presenter: PremeetingPresenter, viewModel: MeetingViewModel, appState: AppState) {
        guard !installed else { return }
        installed = true
        let hooks = LobbyCoreHooks()
        hooks.join = { request in
            LobbyProductionHooks.join(request, viewModel: viewModel, appState: appState)
        }

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
            LobbyProductionHooks.request(rawKind, presenter: presenter)
        }
        hooks.cancelPermissionRequests = {
            LobbyProductionHooks.cancelPermissionRequests()
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

        presenter.applyEffects(available: EffectsAvailabilityPolicy.showsPanelEntry(
            EffectsAvailabilityPolicy.production(canShowSystemVideoEffects: false)), active: false)
    }

    static func request(_ rawKind: String, presenter: PremeetingPresenter?) {
        let kind = LobbyMediaKind(rawValue: rawKind) ?? LobbyMediaKind.camera
        permissionGenerations = permissionGenerations.begun(kind)
        let generation = permissionGenerations.current(kind)
        Task { @MainActor in
            guard LobbyProductionHooks.permissionGenerations.accepts(generation, kind: kind) else { return }
            MediaPermissionStatusProvider.request(kind) { granted in
                if LobbyProductionHooks.permissionGenerations.accepts(generation, kind: kind) {
                    presenter?.permissionRequestFinished(kind: rawKind, granted: granted)
                }
                LobbyProductionHooks.pushPermissions(presenter)
            }
        }
    }

    static func cancelPermissionRequests() {
        permissionGenerations = permissionGenerations.cancelled()
        #if SKIP
        PermissionHelper.cancelPendingCallPermissionRequests()
        #endif
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
