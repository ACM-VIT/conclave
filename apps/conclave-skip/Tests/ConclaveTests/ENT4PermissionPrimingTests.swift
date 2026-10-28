#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// ENT-4 (S10 7 a to l, 0.8 C12; S70 14 c): permission priming in context. The one MediaPermissionState mapping in
/// EntryPolicies (iOS authorization answers, the Android facts and the permanent-denial rule), the priming policy (what
/// shows where, the drawn toggle state, the toggle reason), the stale-answer generations and the cleanup rule, the
/// presenter paths through the lobby hooks, the production request wiring on the macOS host, the L9 fixture
/// permissions, and source scans of both platforms' priming views, PermissionHelper and the purpose strings. Nothing
/// here can show a system prompt: the macOS host stubs every request.
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

    // MARK: The one mapping (S10 7 j; EntryPolicies)

    @Test func everyPlatformAnswerMapsToOneLobbyState() {
        #expect(EntryPolicies.mediaPermissionState(authorization: .authorized, hasDevice: true) == .granted)
        #expect(EntryPolicies.mediaPermissionState(authorization: .notDetermined, hasDevice: true) == .notDetermined)
        #expect(EntryPolicies.mediaPermissionState(authorization: .denied, hasDevice: true) == .denied)
        #expect(EntryPolicies.mediaPermissionState(authorization: .restricted, hasDevice: true) == .restricted)
        for authorization in PlatformCaptureAuthorization.allCases {
            // No camera hardware wins over any answer: the card explains instead of asking (S10 6 f, 7 f).
            #expect(EntryPolicies.mediaPermissionState(authorization: authorization, hasDevice: false) == .unavailable)
        }
        // iOS asks exactly once.
        #expect(EntryPolicies.iosCanAskAgain(.notDetermined))
        for state in [MediaPermissionState.granted, .denied, .restricted, .unavailable] {
            #expect(!EntryPolicies.iosCanAskAgain(state), "\(state)")
        }
        // Android: granted, then the remembered launch decides between notDetermined and denied.
        #expect(EntryPolicies.androidMediaPermissionState(hasDevice: true, isGranted: true, wasRequested: true) == .granted)
        #expect(EntryPolicies.androidMediaPermissionState(hasDevice: true, isGranted: false, wasRequested: false) == .notDetermined)
        #expect(EntryPolicies.androidMediaPermissionState(hasDevice: true, isGranted: false, wasRequested: true) == .denied)
        #expect(EntryPolicies.androidMediaPermissionState(hasDevice: false, isGranted: true, wasRequested: true) == .unavailable)
    }

    @Test func androidAsksAgainUntilADenialIsPermanent() {
        // Before the first request, while the system wants a rationale, after a dismissed first prompt.
        #expect(EntryPolicies.androidCanAskAgain(isGranted: false, wasRequested: false, showsRationale: false, isBlocked: true))
        #expect(EntryPolicies.androidCanAskAgain(isGranted: false, wasRequested: true, showsRationale: true, isBlocked: true))
        #expect(EntryPolicies.androidCanAskAgain(isGranted: false, wasRequested: true, showsRationale: false, isBlocked: false))
        #expect(EntryPolicies.androidCanAskAgain(isGranted: true, wasRequested: true, showsRationale: false, isBlocked: true))
        // Permanently denied: Open settings instead (S10 7 d).
        #expect(!EntryPolicies.androidCanAskAgain(isGranted: false, wasRequested: true, showsRationale: false, isBlocked: true))
        // "Request returns denied and rationale false": permanent after a request that had a rationale, or a repeat.
        #expect(!EntryPolicies.androidDenialBlocks(rationaleBefore: false, rationaleAfter: true, previousDenials: 0), "denied once")
        #expect(!EntryPolicies.androidDenialBlocks(rationaleBefore: true, rationaleAfter: true, previousDenials: 3))
        #expect(EntryPolicies.androidDenialBlocks(rationaleBefore: true, rationaleAfter: false, previousDenials: 1), "second refusal")
        #expect(!EntryPolicies.androidDenialBlocks(rationaleBefore: false, rationaleAfter: false, previousDenials: 0),
                "a dismissed first prompt may be asked once more")
        #expect(EntryPolicies.androidDenialBlocks(rationaleBefore: false, rationaleAfter: false, previousDenials: 1),
                "a prompt that no longer shows")
    }

    // MARK: The priming policy (S10 7 c, d, f)

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
        // iOS has no rationale flow: a denial routes to Settings even if a prompt were left.
        #expect(PermissionPrimingPolicy.priming(permission: .denied, canAskAgain: true, supportsRationale: false,
                                                rationaleDismissed: false) == .openSettings)
        // Android: explain and ask again; Not now hides it.
        #expect(PermissionPrimingPolicy.priming(permission: .denied, canAskAgain: true, supportsRationale: true,
                                                rationaleDismissed: false) == .rationale)
        #expect(PermissionPrimingPolicy.priming(permission: .denied, canAskAgain: true, supportsRationale: true,
                                                rationaleDismissed: true) == .none)
        // Placement: the microphone in a row; the camera in the card except the Android rationale.
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
        // The intent shows while the system can still grant it: granted, the prompt up, an Android ask-again.
        #expect(PermissionPrimingPolicy.displaysOn(intentOn: true, permission: .granted, canAskAgain: false))
        #expect(PermissionPrimingPolicy.displaysOn(intentOn: true, permission: .notDetermined, canAskAgain: true))
        #expect(PermissionPrimingPolicy.displaysOn(intentOn: true, permission: .denied, canAskAgain: true))
        // Intent on with access revoked reads Off (S10 7 f); no intent never reads On.
        #expect(!PermissionPrimingPolicy.displaysOn(intentOn: true, permission: .denied, canAskAgain: false))
        #expect(!PermissionPrimingPolicy.displaysOn(intentOn: true, permission: .restricted, canAskAgain: false))
        #expect(!PermissionPrimingPolicy.displaysOn(intentOn: true, permission: .unavailable, canAskAgain: false))
        #expect(!PermissionPrimingPolicy.displaysOn(intentOn: false, permission: .granted, canAskAgain: true))
        // The reason is the Settings or restricted explanation, never the rationale (a tap still asks then).
        #expect(PermissionPrimingPolicy.toggleReason(permission: .denied, canAskAgain: false, supportsRationale: false) == .openSettings)
        #expect(PermissionPrimingPolicy.toggleReason(permission: .denied, canAskAgain: true, supportsRationale: true) == .none)
        #expect(PermissionPrimingPolicy.toggleReason(permission: .restricted, canAskAgain: false, supportsRationale: true) == .restricted)
        #expect(PermissionPrimingPolicy.toggleReason(permission: .granted, canAskAgain: false, supportsRationale: true) == .none)
    }

    @Test func rowsListTheMicrophoneFirstAndKeepTheCameraInTheCard() {
        // iOS: a denied microphone is a Settings row; a denied camera is the card overlay only.
        let iosDenied = media(micPermission: .denied, cameraPermission: .denied)
        #expect(PermissionPrimingPolicy.rows(media: iosDenied, supportsRationale: false, microphoneRationaleDismissed: false,
                                             cameraRationaleDismissed: false)
                == [PermissionPrimingModel(kind: .microphone, priming: .openSettings, placement: .row)])
        #expect(iosDenied.preview == .blocked)
        // Android, both refused once: two rationale rows, microphone first; the card keeps the avatar.
        let once = media(micPermission: .denied, cameraPermission: .denied, canAskAgainMicrophone: true, canAskAgainCamera: true)
        #expect(PermissionPrimingPolicy.rows(media: once, supportsRationale: true, microphoneRationaleDismissed: false,
                                             cameraRationaleDismissed: false)
                == [PermissionPrimingModel(kind: .microphone, priming: .rationale, placement: .row),
                    PermissionPrimingModel(kind: .camera, priming: .rationale, placement: .row)])
        #expect(!PermissionPrimingPolicy.showsCameraOverlay(permission: .denied, canAskAgain: true, supportsRationale: true))
        // Not now hides only its own row.
        #expect(PermissionPrimingPolicy.rows(media: once, supportsRationale: true, microphoneRationaleDismissed: true,
                                             cameraRationaleDismissed: false)
                == [PermissionPrimingModel(kind: .camera, priming: .rationale, placement: .row)])
        // Restricted: a microphone row without a button and the camera in the card.
        let restricted = media(micPermission: .restricted, cameraPermission: .restricted)
        #expect(PermissionPrimingPolicy.rows(media: restricted, supportsRationale: true, microphoneRationaleDismissed: false,
                                             cameraRationaleDismissed: false)
                == [PermissionPrimingModel(kind: .microphone, priming: .restricted, placement: .row)])
        #expect(restricted.preview == .blocked)
        // Granted and undetermined: nothing (the lobby is the context; the first tap asks).
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

    // MARK: Stale answers and cleanup (S10 7 j; invariant 7)

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

    // MARK: Presenter paths (S10 7 c, d, f, l3)

    @Test func onlyAToggleTapAsksAndARefusalFailsClosedOnce() {
        let hooks = ENT4HookRecorder()
        let presenter = presenter(hooks: hooks)
        let routeId = openLobby(presenter)
        presenter.applyPermissions(microphone: .notDetermined, camera: .notDetermined, canAskAgainMicrophone: true,
                                   canAskAgainCamera: true)
        presenter.lobbyDidAppear(routeId: routeId)
        // 7 l3: opening the lobby asks for nothing.
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
        // iOS after the refusal: the overlay explains; a tap asks nothing and changes nothing.
        #expect(presenter.lobbyMedia?.preview == .blocked)
        presenter.setCameraIntent(true)
        #expect(hooks.permissionRequests == ["camera"] && hooks.intents.count == 2)
        // Android refused once: the tap (or Allow) asks again and shows the intent.
        presenter.applyPermissions(microphone: .denied, camera: .denied, canAskAgainMicrophone: true, canAskAgainCamera: false)
        presenter.setMicIntent(true)
        #expect(hooks.permissionRequests == ["camera", "microphone"])
        #expect(hooks.intents.last == "true:false")
        // Restricted: nothing at all.
        presenter.applyPermissions(microphone: .restricted, camera: .restricted, canAskAgainMicrophone: false,
                                   canAskAgainCamera: false)
        presenter.apply(PremeetingInputs.make(accountName: "Avery"))
        let before = hooks.intents.count
        presenter.setMicIntent(true)
        presenter.setCameraIntent(true)
        #expect(hooks.intents.count == before && hooks.permissionRequests.count == 2)
        // Open Settings reaches the provider hook only.
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
        // Back from Settings with access granted: the kept intent starts the preview (S10 7 f "granted later").
        presenter.applyPermissions(microphone: .granted, camera: .granted, canAskAgainMicrophone: false, canAskAgainCamera: false)
        #expect(hooks.previewCalls == ["start:front"])
        #expect(presenter.lobbyMedia?.preview != .blocked)
    }

    // MARK: Production request wiring on the macOS host (no prompt exists here)

    #if os(macOS)
    @Test func theRequestStartsAfterTheIntentAndAStaleOneIsDropped() async {
        let presenter = presenter()
        let routeId = openLobby(presenter)
        presenter.lobbyDidAppear(routeId: routeId)
        presenter.applyPermissions(microphone: .notDetermined, camera: .notDetermined, canAskAgainMicrophone: true,
                                   canAskAgainCamera: true)
        // Deferred by one main-actor turn: nothing is read synchronously.
        LobbyProductionHooks.request("microphone", presenter: presenter)
        #expect(presenter.currentDeviceInputs.micPermission == .notDetermined)
        // The host stub grants the microphone and reports no camera; the status push follows the answer.
        #expect(await ent4Settle { presenter.currentDeviceInputs.micPermission == .granted })
        #expect(presenter.currentDeviceInputs.cameraPermission == .unavailable)
        // A request the lobby cancelled before it started never runs (S10 7 j).
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

    // MARK: L9 fixtures (S10 7 l; notDetermined from the fixture only)

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

    // MARK: Source scans (both platforms)

    static let iosFiles = [
        "Sources/Conclave/Features/Lobby/PermissionPrimingRow+iOS.swift",
        "Sources/Conclave/Features/Lobby/LobbyView+iOS.swift",
        "Sources/Conclave/Features/Lobby/LobbyPreviewCard+iOS.swift"
    ]
    static let kotlinFiles = [
        "Sources/Conclave/Skip/ui/lobby/PermissionPrimingRow.kt",
        "Sources/Conclave/Skip/ui/lobby/LobbyScreen.kt",
        "Sources/Conclave/Skip/ui/lobby/LobbyPreviewCard.kt",
        "Sources/Conclave/Skip/ui/lobby/LobbyUiCache.kt"
    ]
    static let sharedFiles = [
        "Sources/Conclave/Features/Lobby/PermissionPrimingPolicy.swift",
        "Sources/Conclave/Features/Join/EntryPolicies.swift",
        "Sources/Conclave/Features/Lobby/LobbyContracts.swift",
        "Sources/Conclave/Features/Lobby/LobbyPolicies.swift",
        "Sources/Conclave/Features/Lobby/LobbyDeviceServices.swift"
    ]

    @Test func primingFilesStayFlatQuietAndTranspilable() throws {
        for file in Self.iosFiles + Self.kotlinFiles + Self.sharedFiles + ["Sources/Conclave/Skip/PermissionHelper.kt"] {
            let text = try ent4Source(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) has an en or em dash")
            #expect(!text.lowercased().contains("gradient"), "\(file)")
            #expect(ent4Matches(#"(UIColor|Color)\(\s*(red:|\.sRGB|0x|hue:|white:)"#, in: text).isEmpty, "\(file)")
            #expect(!text.contains("Color.white") && !text.contains("Color.black") && !text.contains(".tint(.white)"), "\(file)")
        }
        for file in Self.iosFiles {
            let text = try ent4Source(file)
            #expect(text.hasPrefix("#if os(iOS) && !SKIP\n"), "\(file)")
            for pattern in ["glassEffect", "GlassEffectContainer", "Material", ".preferredColorScheme(", "Image(systemName: \""] {
                #expect(!text.contains(pattern), "\(file) uses \(pattern)")
            }
            #expect(ent4Matches(#"(?:Text|Button|Label|navigationTitle|Section|LabeledContent|Picker|TextField)\(\s*""#, in: text).isEmpty,
                    "\(file) has a literal label")
        }
        // S10 7 h: no animation and no haptic for priming.
        let row = try ent4Source("Sources/Conclave/Features/Lobby/PermissionPrimingRow+iOS.swift")
        for pattern in ["withAnimation", ".animation(", ".transition(", "sensoryFeedback", "HapticManager", "onAppear"] {
            #expect(!row.contains(pattern), "the iOS priming row uses \(pattern)")
        }
        for file in Self.kotlinFiles {
            let text = try ent4Source(file)
            #expect(ent4Matches(#"Text\(\s*""#, in: text).isEmpty, "\(file) has a literal Text")
            #expect(!text.contains("performHapticFeedback") && !text.contains("LocalHapticFeedback") && !text.contains("Vibrator"), "\(file)")
            #expect(!text.contains("fontFamily") && !text.contains("ConclaveSystemBars("), "\(file)")
        }
        for file in ["Sources/Conclave/Features/Lobby/PermissionPrimingPolicy.swift", "Sources/Conclave/Features/Join/EntryPolicies.swift"] {
            let text = try ent4Source(file)
            #expect(!text.contains("import SwiftUI") && !text.contains("import AVFoundation"), "\(file)")
            #expect(ent4Matches(#"\.(?:map|compactMap|flatMap)\(\s*[A-Za-z_][A-Za-z0-9_.]*\s*\)"#, in: text).isEmpty, "\(file)")
            #expect(!text.contains(".isLetter"), "\(file)")
        }
    }

    @Test func iosShowsTheRowTheOverlayAndTheHints() throws {
        let row = ent4Flat(try ent4Source("Sources/Conclave/Features/Lobby/PermissionPrimingRow+iOS.swift"))
        #expect(row.contains(".buttonStyle(.borderless) .tint(HostingTheme.coralText)"), "the row's Open Settings is coralText")
        #expect(row.contains(".buttonStyle(.bordered) .tint(HostingTheme.token(DesignTokens.iosInCallText))"),
                "the overlay's Open Settings is neutral, never coral")
        #expect(row.contains(".foregroundStyle(HostingTheme.statusWarning)"))
        #expect(row.contains("AccessibilityNotification.Announcement(PermissionPrimingCopy.title(model.kind)).post()"))
        #expect(row.contains(".task(id: model.priming)") && row.contains(".task(id: priming)"), "announced once when it appears")
        #expect(row.contains(".accessibilityElement(children: .contain)"))
        let lobby = ent4Flat(try ent4Source("Sources/Conclave/Features/Lobby/LobbyView+iOS.swift"))
        #expect(lobby.contains("LobbyIssueSection(premeeting: premeeting) PermissionPrimingSection(premeeting: premeeting)"))
        #expect(!lobby.contains("LobbyMicrophonePermissionSection"))
        let card = ent4Flat(try ent4Source("Sources/Conclave/Features/Lobby/LobbyPreviewCard+iOS.swift"))
        #expect(card.contains("PermissionPrimingCardOverlay("))
        #expect(!card.contains("LobbyCameraPermissionOverlay"))
        #expect(card.contains(".accessibilityHint(hint(.microphone))") && card.contains(".accessibilityHint(hint(.camera))"))
        #expect(card.contains("premeeting.setMicIntent(!micOn)") && card.contains("premeeting.setCameraIntent(!cameraOn)"))
        // The Settings route (S10 7 c): the system URL, through the provider only.
        let services = try ent4Source("Sources/Conclave/Features/Lobby/LobbyDeviceServices.swift")
        #expect(services.contains("UIApplication.openSettingsURLString"))
    }

    @Test func androidShowsTheRationaleTheSettingsRowAndTheOverlay() throws {
        let row = ent4Flat(try ent4Source("Sources/Conclave/Skip/ui/lobby/PermissionPrimingRow.kt"))
        #expect(row.contains("kind = ConclaveBannerKind.Warning"))
        for name in ["\"pm_mic_rationale\"", "\"pm_camera_rationale\"", "\"pm_allow\"", "\"ds_not_now\"", "\"ds_open_settings\"",
                     "\"pm_mic_access_off_reason\"", "\"pm_camera_access_off_reason\""] {
            #expect(row.contains(name), "PermissionPrimingRow.kt lacks \(name)")
        }
        #expect(row.contains("onAllow = { if (camera) premeeting.setCameraIntent(true) else premeeting.setMicIntent(true) }"),
                "Allow asks again through the toggle intent")
        #expect(row.contains("var microphoneDismissed by remember(routeId) { mutableStateOf(false) }"), "Not now is per lobby")
        #expect(row.contains("FilledTonalButton(onClick = onOpenSettings"))
        #expect(row.contains("Lifecycle.Event.ON_RESUME && paused") && row.contains("premeeting.lobbyDidAppear(routeId = routeId)"))
        #expect(row.contains("liveRegion = LiveRegionMode.Polite"))
        let screen = ent4Flat(try ent4Source("Sources/Conclave/Skip/ui/lobby/LobbyScreen.kt"))
        #expect(screen.contains("LobbyIssueBanner(premeeting, routeId)"))
        #expect(screen.contains("PermissionPrimingRows(premeeting, routeId)") && screen.contains("PermissionPrimingResumeEffect(premeeting, routeId)"))
        #expect(!screen.contains("LobbyMicrophonePermissionBanner"))
        let card = ent4Flat(try ent4Source("Sources/Conclave/Skip/ui/lobby/LobbyPreviewCard.kt"))
        #expect(card.contains("PermissionPrimingCardOverlay(card.cameraPriming, onOpenSettings, Modifier.align(Alignment.Center))"))
        #expect(card.contains("stateReason = permissionReasonText(LobbyMediaKind.microphone, card.micReason)"))
        #expect(!card.contains("LobbyCameraPermissionOverlay"))
        let cache = ent4Flat(try ent4Source("Sources/Conclave/Skip/ui/lobby/LobbyUiCache.kt"))
        #expect(cache.contains("micOn = PermissionPrimingPolicy.displaysOn(intentOn = media.micIntentOn"))
        #expect(cache.contains("get() = preview == PreviewState.blocked"))
    }

    @Test func permissionHelperRemembersRationalesAndOpensTheAppPage() throws {
        let raw = try ent4Source("Sources/Conclave/Skip/PermissionHelper.kt")
        let helper = ent4Flat(raw)
        #expect(helper.contains("Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts(\"package\", packageName, null))"))
        #expect(helper.contains("NativeExternalHandoff.openSettings(appSettingsIntent(context.packageName))"))
        #expect(helper.contains("ActivityCompat.shouldShowRequestPermissionRationale(activity, mediaManifestPermission(kind))"))
        #expect(helper.contains("EntryPolicies.androidMediaPermissionState("))
        #expect(helper.contains("EntryPolicies.androidCanAskAgain("))
        #expect(helper.contains("EntryPolicies.androidDenialBlocks("))
        // The launch is noted right before the system dialog, inside the one serialized queue (invariant 18).
        let note = try #require(raw.range(of: "noteMediaPermissionLaunch(requestCode, activity)"))
        let launch = try #require(raw.range(of: "ActivityCompat.requestPermissions(", range: note.upperBound..<raw.endIndex))
        #expect(note.lowerBound < launch.lowerBound)
        #expect(helper.contains("if (permissions.isNotEmpty()) recordMediaPermissionAnswer(MEDIA_KIND_MICROPHONE, granted)"))
        #expect(helper.contains("if (permissions.isNotEmpty()) recordMediaPermissionAnswer(MEDIA_KIND_CAMERA, granted)"))
        // Pins other slices rely on stay (notifications, the permission dialog suppression, the queue).
        #expect(helper.contains("answered = permissions.isNotEmpty()"))
        #expect(helper.contains("finishNotificationsPermission(false, answered = false)"))
        #expect(helper.contains("PipManager.suppressForExternalHandoff(ExternalHandoffKind.permissionDialog)"))
        #expect(helper.contains("NOTIFICATIONS_REQUEST_CODE -> notificationsPermissionWaiters"))
        #expect(!raw.contains("rememberLauncherForActivityResult"), "one prompt owner: the serialized queue")
        // The lobby's Swift side no longer marks a request before it is launched.
        let services = try ent4Source("Sources/Conclave/Features/Lobby/LobbyDeviceServices.swift")
        #expect(!services.contains("markMediaPermissionRequested"))
        #expect(services.contains("EntryPolicies.mediaPermissionState(authorization: cameraAuthorization()"))
        #expect(services.contains("permissionGenerations.accepts(generation, kind: kind)"))
        #expect(services.contains("PermissionHelper.cancelPendingCallPermissionRequests()"))
    }

    @Test func noPromptOutsideTheLobbyToggles() throws {
        // S10 7 l3: launch, Home and the Join sheet never ask; notifications are never asked in the lobby (7 d).
        let quiet = [
            "Sources/Conclave/Features/Home/HomeView+iOS.swift",
            "Sources/Conclave/Features/Home/PremeetingRoot+iOS.swift",
            "Sources/Conclave/Features/Home/PremeetingAppWiring.swift",
            "Sources/Conclave/Features/Join/JoinCodeSheet+iOS.swift",
            "Sources/Conclave/Skip/ui/home/HomeScreen.kt",
            "Sources/Conclave/Skip/ui/home/PremeetingHost.kt",
            "Sources/Conclave/Skip/ui/join/JoinCodeSheet.kt"
        ] + Self.iosFiles + Self.kotlinFiles
        for file in quiet {
            let text = try ent4Source(file)
            for pattern in ["requestAccess(", "requestRecordPermission", "requestCameraPermission", "requestRecordAudioPermission",
                            "requestNotificationsPermission", "requestPermissions(", "requestAuthorization("] {
                #expect(!text.contains(pattern), "\(file) asks through \(pattern)")
            }
        }
        // The production refresh reads status only.
        let services = try ent4Source("Sources/Conclave/Features/Lobby/LobbyDeviceServices.swift")
        let start = try #require(services.range(of: "hooks.refreshDevices = {"))
        let end = try #require(services.range(of: "hooks.fetchPresence", range: start.upperBound..<services.endIndex))
        #expect(!services[start.lowerBound..<end.lowerBound].contains("request"))
    }

    @Test func thePurposeStringsAreTheHonestCopy() throws {
        // S10 7 c and 0.8 C12 (landed with SYS-14; S70 14 c: the catalog is the single source). 7 l4 audit.
        let camera = "Conclave uses your camera so people in your meeting can see you."
        let microphone = "Conclave uses your microphone so people in your meeting can hear you."
        let plist = try ent4Source("Darwin/Info.plist")
        #expect(plist.contains("<key>NSCameraUsageDescription</key>\n\t<string>\(camera)</string>"))
        #expect(plist.contains("<key>NSMicrophoneUsageDescription</key>\n\t<string>\(microphone)</string>"))
        for unrelated in ["NSPhotoLibraryUsageDescription", "NSBluetoothAlwaysUsageDescription", "NSContactsUsageDescription",
                          "NSLocationWhenInUseUsageDescription", "NSUserNotificationsUsageDescription"] {
            #expect(!plist.contains(unrelated), "Info.plist keeps \(unrelated)")
        }
        let data = try #require(try ent4Source("Darwin/InfoPlist.xcstrings").data(using: .utf8))
        let catalog = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        #expect(ent4CatalogValue(strings, "NSCameraUsageDescription") == camera)
        #expect(ent4CatalogValue(strings, "NSMicrophoneUsageDescription") == microphone)
    }

    @Test func everyPrimingStringResolves() throws {
        // Passes after the batch 7 strings merge (HD/strings/B7-T8.json).
        let data = try #require(try ent4Source("Sources/Conclave/Resources/Localizable.xcstrings").data(using: .utf8))
        let catalog = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let keys = Set((try #require(catalog["strings"] as? [String: Any])).keys)
        let row = try ent4Source("Sources/Conclave/Features/Lobby/PermissionPrimingRow+iOS.swift")
        for match in ent4Matches(#"ConclaveStrings\.text\("[^"]+"\)"#, in: row) {
            let key = String(match.dropFirst("ConclaveStrings.text(\"".count).dropLast(2))
                .replacingOccurrences(of: "\\u{2019}", with: "\u{2019}")
            #expect(keys.contains(key), "missing iOS key \(key)")
        }
        let resources = try ent4Source("Android/app/src/main/res/values/strings.xml")
        let kotlin = try ent4Source("Sources/Conclave/Skip/ui/lobby/PermissionPrimingRow.kt")
            + (try ent4Source("Sources/Conclave/Skip/ui/lobby/LobbyPreviewCard.kt"))
        for match in ent4Matches(#"conclaveString\("[a-z0-9_]+"\)"#, in: kotlin) {
            let name = String(match.dropFirst("conclaveString(\"".count).dropLast(2))
            #expect(resources.contains("name=\"\(name)\""), "missing Android resource \(name)")
        }
    }

    // MARK: Integrator requests (HD/requests/B7-T8.md; fail until applied)

    @Test func requestedHooksAreApplied() throws {
        // R1: the presenter cancels pending requests when the lobby leaves outside the hand-off.
        let presenterSource = ent4Flat(try ent4Source("Sources/Conclave/Features/Home/PremeetingPresenter.swift"))
        #expect(presenterSource.contains("LobbyPermissionCleanupPolicy.cancelsRequests("))
        #expect(presenterSource.contains("lobbyHooks?.cancelPermissionRequests?()"))
        // R2: the labelled toggle's state description adds the reason; the caption stays the plain state.
        let control = ent4Flat(try ent4Source("Sources/Conclave/Skip/ui/components/ConclaveCallControl.kt"))
        #expect(control.contains("stateReason: String = \"\""))
        #expect(control.contains("stateText = if (stateReason.isEmpty()) stateText else \"$stateText, $stateReason\""))
        // R3: the five priming fixture states run through the L9 session.
        for raw in PermissionPrimingFixture.states {
            #expect(PremeetingFixtureScript.state(named: raw) != nil, "fixture state \(raw)")
        }
        // R4: the overlay's text pair is in the gallery catalog.
        let pairs = Dictionary(uniqueKeysWithValues: ComponentGalleryCatalog.contrastPairs.map { ($0.id, $0) })
        let pair = pairs["contrast.inCallText.tile"]
        #expect(pair != nil && abs((pair?.ratio ?? 0) - 17.767) < 0.001)
    }

    #if os(macOS)
    @Test func theFixtureStatesShowTheirPermissionsWithoutAPrompt() {
        // Needs R3. The fixture's hooks have no request, so a tap only shows the intent.
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

/// Records every hook the presenter calls (no media, no network, no prompt).
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

private func ent4Source(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

/// Whitespace collapsed to single spaces, so a pin fails only when the code changes.
private func ent4Flat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func ent4Matches(_ pattern: String, in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        Range(match.range, in: text).map { String(text[$0]) }
    }
}

/// The English value of an InfoPlist catalog key (`localizations.en.stringUnit.value`).
private func ent4CatalogValue(_ strings: [String: Any], _ key: String) -> String? {
    guard let entry = strings[key] as? [String: Any],
          let localizations = entry["localizations"] as? [String: Any],
          let english = localizations["en"] as? [String: Any],
          let unit = english["stringUnit"] as? [String: Any] else { return nil }
    return unit["value"] as? String
}
#endif
