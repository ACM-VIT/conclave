#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct ENT4PermissionPrimingTests {
    private static let link = "https://conclave.acmvit.in/rose-sora-luffy"

    private func presenter(hooks: ENT4HookRecorder? = nil) -> PremeetingPresenter {
        let presenter = PremeetingPresenter()
        presenter.nowMillis = { 1793102400000.0 }
        presenter.presenceIntervalMillis = 5
        presenter.apply(PremeetingInputs.make(accountName: "Avery"))
        if let hooks {
            presenter.lobbyHooks = hooks.hooks
        }
        return presenter
    }

    private func openLobby(_ presenter: PremeetingPresenter) -> Int {
        presenter.handleIncomingURL(Self.link)
        return presenter.path.last?.id ?? -1
    }

    private func media(micPermission: MediaPermissionState = .granted, cameraPermission: MediaPermissionState = .granted,
                       canAskAgainMicrophone: Bool = false, canAskAgainCamera: Bool = false,
                       micIntentOn: Bool = false, cameraIntentOn: Bool = false) -> LobbyMediaSnapshot {
        let device = LobbyDeviceInputs.initial.withPermissions(microphone: micPermission, camera: cameraPermission,
                                                               canAskAgainMicrophone: canAskAgainMicrophone,
                                                               canAskAgainCamera: canAskAgainCamera)
        return LobbySnapshotPolicy.media(routeId: 1, micIntentOn: micIntentOn, cameraIntentOn: cameraIntentOn,
                                         device: device, avatarName: "Avery", avatarSeed: "")
    }

    @Test func everyPlatformAnswerMapsToOneLobbyState() {
        #expect(EntryPolicies.mediaPermissionState(authorization: .authorized, hasDevice: true) == .granted)
        #expect(EntryPolicies.mediaPermissionState(authorization: .notDetermined, hasDevice: true) == .notDetermined)
        #expect(EntryPolicies.mediaPermissionState(authorization: .denied, hasDevice: true) == .denied)
        #expect(EntryPolicies.mediaPermissionState(authorization: .restricted, hasDevice: true) == .restricted)
        for authorization in PlatformCaptureAuthorization.allCases {

            #expect(EntryPolicies.mediaPermissionState(authorization: authorization, hasDevice: false) == .unavailable)
        }

        #expect(EntryPolicies.iosCanAskAgain(.notDetermined))
        for state in [MediaPermissionState.granted, .denied, .restricted, .unavailable] {
            #expect(!EntryPolicies.iosCanAskAgain(state), "\(state)")
        }

        #expect(EntryPolicies.androidMediaPermissionState(hasDevice: true, isGranted: true, wasRequested: true) == .granted)
        #expect(EntryPolicies.androidMediaPermissionState(hasDevice: true, isGranted: false, wasRequested: false) == .notDetermined)
        #expect(EntryPolicies.androidMediaPermissionState(hasDevice: true, isGranted: false, wasRequested: true) == .denied)
        #expect(EntryPolicies.androidMediaPermissionState(hasDevice: false, isGranted: true, wasRequested: true) == .unavailable)
    }

    @Test func androidAsksAgainUntilADenialIsPermanent() {

        #expect(EntryPolicies.androidCanAskAgain(isGranted: false, wasRequested: false, showsRationale: false, isBlocked: true))
        #expect(EntryPolicies.androidCanAskAgain(isGranted: false, wasRequested: true, showsRationale: true, isBlocked: true))
        #expect(EntryPolicies.androidCanAskAgain(isGranted: false, wasRequested: true, showsRationale: false, isBlocked: false))
        #expect(EntryPolicies.androidCanAskAgain(isGranted: true, wasRequested: true, showsRationale: false, isBlocked: true))

        #expect(!EntryPolicies.androidCanAskAgain(isGranted: false, wasRequested: true, showsRationale: false, isBlocked: true))

        #expect(!EntryPolicies.androidDenialBlocks(rationaleBefore: false, rationaleAfter: true, previousDenials: 0), "denied once")
        #expect(!EntryPolicies.androidDenialBlocks(rationaleBefore: true, rationaleAfter: true, previousDenials: 3))
        #expect(EntryPolicies.androidDenialBlocks(rationaleBefore: true, rationaleAfter: false, previousDenials: 1), "second refusal")
        #expect(!EntryPolicies.androidDenialBlocks(rationaleBefore: false, rationaleAfter: false, previousDenials: 0),
                "a dismissed first prompt may be asked once more")
        #expect(EntryPolicies.androidDenialBlocks(rationaleBefore: false, rationaleAfter: false, previousDenials: 1),
                "a prompt that no longer shows")
    }

    @Test func primingFollowsTheStatesTable() {
        for supports in [false, true] {
            for permission in [MediaPermissionState.granted, .notDetermined, .unavailable] {
                #expect(PermissionPrimingPolicy.priming(permission: permission, canAskAgain: true, supportsRationale: supports,
                                                        rationaleDismissed: false) == .none, "\(permission)")
            }
            #expect(PermissionPrimingPolicy.priming(permission: .restricted, canAskAgain: false, supportsRationale: supports,
                                                    rationaleDismissed: false) == .restricted)
            #expect(PermissionPrimingPolicy.priming(permission: .denied, canAskAgain: false, supportsRationale: supports,
                                                    rationaleDismissed: false) == .openSettings)
        }

        #expect(PermissionPrimingPolicy.priming(permission: .denied, canAskAgain: true, supportsRationale: false,
                                                rationaleDismissed: false) == .openSettings)

        #expect(PermissionPrimingPolicy.priming(permission: .denied, canAskAgain: true, supportsRationale: true,
                                                rationaleDismissed: false) == .rationale)
        #expect(PermissionPrimingPolicy.priming(permission: .denied, canAskAgain: true, supportsRationale: true,
                                                rationaleDismissed: true) == .none)

        #expect(PermissionPrimingPolicy.placement(kind: .microphone, priming: .openSettings) == .row)
        #expect(PermissionPrimingPolicy.placement(kind: .microphone, priming: .restricted) == .row)
        #expect(PermissionPrimingPolicy.placement(kind: .microphone, priming: .rationale) == .row)
        #expect(PermissionPrimingPolicy.placement(kind: .camera, priming: .openSettings) == .card)
        #expect(PermissionPrimingPolicy.placement(kind: .camera, priming: .restricted) == .card)
        #expect(PermissionPrimingPolicy.placement(kind: .camera, priming: .rationale) == .row)
        #expect(PermissionPrimingPolicy.placement(kind: .camera, priming: .none) == .none)
        #expect(!PermissionPrimingPolicy.platformSupportsRationale, "the host build is the iOS rule")
    }

    @Test func togglesDrawOffWhileATapCannotGrantThemAndSayWhy() {

        #expect(PermissionPrimingPolicy.displaysOn(intentOn: true, permission: .granted, canAskAgain: false))
        #expect(PermissionPrimingPolicy.displaysOn(intentOn: true, permission: .notDetermined, canAskAgain: true))
        #expect(PermissionPrimingPolicy.displaysOn(intentOn: true, permission: .denied, canAskAgain: true))

        #expect(!PermissionPrimingPolicy.displaysOn(intentOn: true, permission: .denied, canAskAgain: false))
        #expect(!PermissionPrimingPolicy.displaysOn(intentOn: true, permission: .restricted, canAskAgain: false))
        #expect(!PermissionPrimingPolicy.displaysOn(intentOn: true, permission: .unavailable, canAskAgain: false))
        #expect(!PermissionPrimingPolicy.displaysOn(intentOn: false, permission: .granted, canAskAgain: true))

        #expect(PermissionPrimingPolicy.toggleReason(permission: .denied, canAskAgain: false, supportsRationale: false) == .openSettings)
        #expect(PermissionPrimingPolicy.toggleReason(permission: .denied, canAskAgain: true, supportsRationale: true) == .none)
        #expect(PermissionPrimingPolicy.toggleReason(permission: .restricted, canAskAgain: false, supportsRationale: true) == .restricted)
        #expect(PermissionPrimingPolicy.toggleReason(permission: .granted, canAskAgain: false, supportsRationale: true) == .none)
    }

    @Test func rowsListTheMicrophoneFirstAndKeepTheCameraInTheCard() {

        let iosDenied = media(micPermission: .denied, cameraPermission: .denied)
        #expect(PermissionPrimingPolicy.rows(media: iosDenied, supportsRationale: false, microphoneRationaleDismissed: false,
                                             cameraRationaleDismissed: false)
                == [PermissionPrimingModel(kind: .microphone, priming: .openSettings, placement: .row)])
        #expect(iosDenied.preview == .blocked)

        let once = media(micPermission: .denied, cameraPermission: .denied, canAskAgainMicrophone: true, canAskAgainCamera: true)
        #expect(PermissionPrimingPolicy.rows(media: once, supportsRationale: true, microphoneRationaleDismissed: false,
                                             cameraRationaleDismissed: false)
                == [PermissionPrimingModel(kind: .microphone, priming: .rationale, placement: .row),
                    PermissionPrimingModel(kind: .camera, priming: .rationale, placement: .row)])
        #expect(!PermissionPrimingPolicy.showsCameraOverlay(permission: .denied, canAskAgain: true, supportsRationale: true))

        #expect(PermissionPrimingPolicy.rows(media: once, supportsRationale: true, microphoneRationaleDismissed: true,
                                             cameraRationaleDismissed: false)
                == [PermissionPrimingModel(kind: .camera, priming: .rationale, placement: .row)])

        let restricted = media(micPermission: .restricted, cameraPermission: .restricted)
        #expect(PermissionPrimingPolicy.rows(media: restricted, supportsRationale: true, microphoneRationaleDismissed: false,
                                             cameraRationaleDismissed: false)
                == [PermissionPrimingModel(kind: .microphone, priming: .restricted, placement: .row)])
        #expect(restricted.preview == .blocked)

        #expect(PermissionPrimingPolicy.rows(media: media(micPermission: .notDetermined, cameraPermission: .notDetermined),
                                             supportsRationale: true, microphoneRationaleDismissed: false,
                                             cameraRationaleDismissed: false).isEmpty)
    }

    @Test func theCardSnapshotIsBlockedExactlyWhileTheOverlayExplains() {
        #expect(media(cameraPermission: .denied).preview == .blocked)
        #expect(media(cameraPermission: .denied, canAskAgainCamera: true).preview == .blocked, "iOS rule on the host")
        #expect(media(cameraPermission: .restricted).preview == .blocked)
        #expect(media(cameraPermission: .unavailable).preview == .unavailable)
        #expect(media(cameraPermission: .notDetermined).preview == .off)
        let snapshot = media(micPermission: .denied, cameraPermission: .granted, canAskAgainMicrophone: true, canAskAgainCamera: false)
        #expect(snapshot.canAskAgainMicrophone && !snapshot.canAskAgainCamera, "each device's ask-again is published")
        #expect(!snapshot.canAskAgainAndroid, "the combined flag stays both together")
    }

    @Test func generationsDropStaleAnswersPerDevice() {
        var generations = LobbyPermissionGenerations.initial
        generations = generations.begun(.microphone)
        let microphone = generations.current(.microphone)
        generations = generations.begun(.camera)
        #expect(generations.accepts(microphone, kind: .microphone), "a camera request never invalidates a microphone answer")
        generations = generations.begun(.microphone)
        #expect(!generations.accepts(microphone, kind: .microphone), "a newer microphone request wins")
        let camera = generations.current(.camera)
        generations = generations.cancelled()
        #expect(!generations.accepts(camera, kind: .camera) && !generations.accepts(generations.current(.microphone) - 1, kind: .microphone))
        #expect(generations.accepts(generations.current(.camera), kind: .camera))
    }

    @Test func leavingTheLobbyCancelsOnlyOutsideTheHandOff() {
        #expect(LobbyPermissionCleanupPolicy.cancelsRequests(mode: .editing, isCallRoot: false, handedOff: false))
        #expect(LobbyPermissionCleanupPolicy.cancelsRequests(mode: .failed, isCallRoot: false, handedOff: false))
        #expect(!LobbyPermissionCleanupPolicy.cancelsRequests(mode: .connecting, isCallRoot: false, handedOff: false))
        #expect(!LobbyPermissionCleanupPolicy.cancelsRequests(mode: .waiting, isCallRoot: false, handedOff: false))
        #expect(!LobbyPermissionCleanupPolicy.cancelsRequests(mode: .editing, isCallRoot: true, handedOff: false))
        #expect(!LobbyPermissionCleanupPolicy.cancelsRequests(mode: .editing, isCallRoot: false, handedOff: true))
    }

    @Test func onlyAToggleTapAsksAndARefusalFailsClosedOnce() {
        let hooks = ENT4HookRecorder()
        let presenter = presenter(hooks: hooks)
        let routeId = openLobby(presenter)
        presenter.applyPermissions(microphone: .notDetermined, camera: .notDetermined, canAskAgainMicrophone: true,
                                   canAskAgainCamera: true)
        presenter.lobbyDidAppear(routeId: routeId)

        #expect(hooks.permissionRequests.isEmpty)
        presenter.setCameraIntent(true)
        #expect(hooks.permissionRequests == ["camera"])
        #expect(hooks.intents == ["false:true"], "the intended state shows while the prompt is up")
        presenter.apply(PremeetingInputs.make(accountName: "Avery", cameraIntentOn: true))
        presenter.permissionRequestFinished(kind: "camera", granted: false)
        #expect(hooks.intents == ["false:true", "false:false"])
        presenter.apply(PremeetingInputs.make(accountName: "Avery"))
        presenter.applyPermissions(microphone: .notDetermined, camera: .denied, canAskAgainMicrophone: true,
                                   canAskAgainCamera: false)

        #expect(presenter.lobbyMedia?.preview == .blocked)
        presenter.setCameraIntent(true)
        #expect(hooks.permissionRequests == ["camera"] && hooks.intents.count == 2)

        presenter.applyPermissions(microphone: .denied, camera: .denied, canAskAgainMicrophone: true, canAskAgainCamera: false)
        presenter.setMicIntent(true)
        #expect(hooks.permissionRequests == ["camera", "microphone"])
        #expect(hooks.intents.last == "true:false")

        presenter.applyPermissions(microphone: .restricted, camera: .restricted, canAskAgainMicrophone: false,
                                   canAskAgainCamera: false)
        presenter.apply(PremeetingInputs.make(accountName: "Avery"))
        let before = hooks.intents.count
        presenter.setMicIntent(true)
        presenter.setCameraIntent(true)
        #expect(hooks.intents.count == before && hooks.permissionRequests.count == 2)

        presenter.openSystemSettings()
        #expect(hooks.settingsOpened == 1)
    }

    @Test func aRevokedCameraKeepsTheIntentAndStartsThePreviewOnceGranted() {
        let hooks = ENT4HookRecorder()
        let presenter = presenter(hooks: hooks)
        let routeId = openLobby(presenter)
        presenter.applyPermissions(microphone: .granted, camera: .denied, canAskAgainMicrophone: false, canAskAgainCamera: false)
        presenter.apply(PremeetingInputs.make(accountName: "Avery", cameraIntentOn: true))
        presenter.lobbyDidAppear(routeId: routeId)
        let snapshot = presenter.lobbyMedia
        #expect(snapshot?.cameraIntentOn == true && snapshot?.preview == .blocked)
        #expect(!PermissionPrimingPolicy.displaysOn(intentOn: snapshot?.cameraIntentOn ?? false,
                                                    permission: snapshot?.cameraPermission ?? .denied,
                                                    canAskAgain: snapshot?.canAskAgainCamera ?? false), "reads Off")
        #expect(hooks.previewCalls.isEmpty)

        presenter.applyPermissions(microphone: .granted, camera: .granted, canAskAgainMicrophone: false, canAskAgainCamera: false)
        #expect(hooks.previewCalls == ["start:front"])
        #expect(presenter.lobbyMedia?.preview != .blocked)
    }

    #if os(macOS)
    @Test func theRequestStartsAfterTheIntentAndAStaleOneIsDropped() async {
        let presenter = presenter()
        let routeId = openLobby(presenter)
        presenter.lobbyDidAppear(routeId: routeId)
        presenter.applyPermissions(microphone: .notDetermined, camera: .notDetermined, canAskAgainMicrophone: true,
                                   canAskAgainCamera: true)

        LobbyProductionHooks.request("microphone", presenter: presenter)
        #expect(presenter.currentDeviceInputs.micPermission == .notDetermined)

        #expect(await ent4Settle { presenter.currentDeviceInputs.micPermission == .granted })
        #expect(presenter.currentDeviceInputs.cameraPermission == .unavailable)

        presenter.applyPermissions(microphone: .notDetermined, camera: .notDetermined, canAskAgainMicrophone: true,
                                   canAskAgainCamera: true)
        let before = LobbyProductionHooks.permissionGenerations
        LobbyProductionHooks.request("camera", presenter: presenter)
        LobbyProductionHooks.cancelPermissionRequests()
        #expect(LobbyProductionHooks.permissionGenerations.camera == before.camera + 2)
        #expect(LobbyProductionHooks.permissionGenerations.microphone == before.microphone + 1)
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(presenter.currentDeviceInputs.cameraPermission == .notDetermined, "the cancelled request never pushed")
    }
    #endif

    @Test func theFixturePermissionsCoverEveryPrimingState() {
        #expect(PermissionPrimingFixture.states.count == 5)
        #expect(PermissionPrimingFixture.permissions(forState: "lobby") == nil)
        for state in PermissionPrimingFixture.states {
            #expect(state.hasPrefix("lobby-") && PermissionPrimingFixture.permissions(forState: state) != nil, "\(state)")
        }
        func rows(_ state: String, android: Bool) -> [PermissionPrimingKind] {
            guard let value = PermissionPrimingFixture.permissions(forState: state) else { return [] }
            let snapshot = media(micPermission: value.microphone, cameraPermission: value.camera,
                                 canAskAgainMicrophone: value.canAskAgainMicrophone, canAskAgainCamera: value.canAskAgainCamera)
            var kinds: [PermissionPrimingKind] = []
            for row in PermissionPrimingPolicy.rows(media: snapshot, supportsRationale: android,
                                                    microphoneRationaleDismissed: false, cameraRationaleDismissed: false) {
                kinds.append(row.priming)
            }
            return kinds
        }
        #expect(rows(PermissionPrimingFixture.undetermined, android: true).isEmpty)
        #expect(rows(PermissionPrimingFixture.microphoneRationale, android: true) == [.rationale])
        #expect(rows(PermissionPrimingFixture.microphoneRationale, android: false) == [.openSettings])
        #expect(rows(PermissionPrimingFixture.cameraRationale, android: true) == [.rationale])
        #expect(rows(PermissionPrimingFixture.cameraRationale, android: false).isEmpty, "iOS: the card overlay")
        #expect(rows(PermissionPrimingFixture.denied, android: true) == [.openSettings])
        #expect(rows(PermissionPrimingFixture.restricted, android: false) == [.restricted])
    }

    static let iosFiles = [
        "Sources/Conclave/Features/Lobby/PermissionPrimingRow+iOS.swift",
        "Sources/Conclave/Features/Lobby/LobbyStatusRow+iOS.swift",
        "Sources/Conclave/Features/Lobby/LobbyView+iOS.swift",
        "Sources/Conclave/Features/Lobby/LobbyPreviewCard+iOS.swift"
    ]
    static let kotlinFiles = [
        "Sources/Conclave/Skip/ui/lobby/PermissionPrimingRow.kt",
        "Sources/Conclave/Skip/ui/lobby/LobbyScreen.kt",
        "Sources/Conclave/Skip/ui/lobby/LobbyPreviewCard.kt",
        "Sources/Conclave/Skip/ui/lobby/LobbyUiCache.kt",
        "Sources/Conclave/Skip/ui/lobby/LobbyStatusRow.kt"
    ]
    static let sharedFiles = [
        "Sources/Conclave/Features/Lobby/PermissionPrimingPolicy.swift",
        "Sources/Conclave/Features/Lobby/LobbyStatusPolicy.swift",
        "Sources/Conclave/Features/Join/EntryPolicies.swift",
        "Sources/Conclave/Features/Lobby/LobbyContracts.swift",
        "Sources/Conclave/Features/Lobby/LobbyPolicies.swift",
        "Sources/Conclave/Features/Lobby/LobbyDeviceServices.swift"
    ]

    @Test func requestedHooksAreApplied() throws {
        for raw in PermissionPrimingFixture.states {
            #expect(PremeetingFixtureScript.state(named: raw) != nil, "fixture state \(raw)")
        }

        let pair = ComponentGalleryCatalog.contrastPairs.first { $0.id == "contrast.inCallText.tile" }
        #expect(pair != nil && abs((pair?.ratio ?? 0) - 17.767) < 0.001)
    }

    #if os(macOS)
    @Test func theFixtureStatesShowTheirPermissionsWithoutAPrompt() {

        for raw in PermissionPrimingFixture.states {
            guard let state = PremeetingFixtureScript.state(named: raw),
                  let expected = PermissionPrimingFixture.permissions(forState: raw) else {
                Issue.record("fixture state \(raw) is missing (HD request B7-T8 R3)")
                continue
            }
            let session = PremeetingFixtureSession(state: state)
            session.start()
            defer { session.stop() }
            let media = session.premeeting.lobbyMedia
            #expect(media?.micPermission == expected.microphone && media?.cameraPermission == expected.camera, "\(raw)")
            #expect(media?.canAskAgainMicrophone == expected.canAskAgainMicrophone, "\(raw)")
            #expect(session.premeeting.lobbyStatus?.mode == .editing, "\(raw)")
        }
    }
    #endif
}

@MainActor
private final class ENT4HookRecorder {
    let hooks = LobbyCoreHooks()
    var intents: [String] = []
    var permissionRequests: [String] = []
    var previewCalls: [String] = []
    var settingsOpened = 0

    init() {
        hooks.setEntryMediaIntent = { [weak self] mic, camera in
            self?.intents.append("\(mic):\(camera)")
        }
        hooks.requestPermission = { [weak self] kind in
            self?.permissionRequests.append(kind)
        }
        hooks.openSystemSettings = { [weak self] in
            self?.settingsOpened += 1
        }
        hooks.startPreview = { [weak self] facing in
            self?.previewCalls.append("start:" + facing.rawValue)
        }
        hooks.stopPreview = { [weak self] in
            self?.previewCalls.append("stop")
        }
        hooks.resolvedClientId = { "conclave" }
    }
}

@MainActor
private func ent4Settle(_ condition: () -> Bool) async -> Bool {
    for _ in 0..<1000 {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 2_000_000)
    }
    return condition()
}
#endif
