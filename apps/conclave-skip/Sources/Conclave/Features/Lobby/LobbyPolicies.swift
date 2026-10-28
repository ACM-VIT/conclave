import Foundation

// ENT-3 (S10 6 f, j, k; 0.8 C17; S60 C6-8; RECONCILE R22, R23, R30, R31, R49): the pure lobby rules. Transpiled and
// host-tested; the presenter and both platform preview controllers call them, so the rules exist once.

// MARK: - Issues (S10 6 f form errors; Q8 one classifier)

/// One classified join form error: the issue row, and whether the invite field shows (and in its error state).
struct LobbyFormIssue: Equatable {
    let issue: LobbyIssue
    let needsInviteCode: Bool
    let inviteCodeInvalid: Bool

    static let none = LobbyFormIssue(issue: .none, needsInviteCode: false, inviteCodeInvalid: false)
}

enum LobbyIssuePolicy {
    /// The S1 `formError` notice text (the view model's recoverable join failure) through the one classifier
    /// (`MeetingErrorClassifier`, S70 7 c) plus the legacy invite-code substring rule. `enteredInviteCode` tells a
    /// wrong code from a missing one.
    static func classify(formError: String, enteredInviteCode: String) -> LobbyFormIssue {
        let message = formError.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return LobbyFormIssue.none }
        let lowered = message.lowercased()
        if lowered.contains("paused conclave") {
            // JoinView's system suspension copy (PRE 4.5): the Android app-suspended row.
            return LobbyFormIssue(issue: .appSuspended, needsInviteCode: false, inviteCodeInvalid: false)
        }
        let hasEnteredCode = !enteredInviteCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let classified = MeetingErrorClassifier.classify(serverMessage: message, context: .join)
        switch classified.category {
        case .roomNotFound:
            return LobbyFormIssue(issue: .roomNotFound, needsInviteCode: false, inviteCodeInvalid: false)
        case .inviteCodeInvalid:
            return LobbyFormIssue(issue: .inviteCodeInvalid, needsInviteCode: true, inviteCodeInvalid: true)
        case .inviteCodeRequired:
            return LobbyFormIssue(issue: hasEnteredCode ? LobbyIssue.inviteCodeInvalid : LobbyIssue.inviteCodeRequired,
                                  needsInviteCode: true, inviteCodeInvalid: hasEnteredCode)
        case .signInRequired:
            return LobbyFormIssue(issue: .signInRequired, needsInviteCode: false, inviteCodeInvalid: false)
        case .offline:
            return LobbyFormIssue(issue: .offline, needsInviteCode: false, inviteCodeInvalid: false)
        default:
            break
        }
        if JoinFormErrorPolicy.isInviteCodeError(message) {
            return LobbyFormIssue(issue: hasEnteredCode ? LobbyIssue.inviteCodeInvalid : LobbyIssue.inviteCodeRequired,
                                  needsInviteCode: true, inviteCodeInvalid: hasEnteredCode)
        }
        if JoinFormErrorPolicy.requiresSignIn(message) {
            return LobbyFormIssue(issue: .signInRequired, needsInviteCode: false, inviteCodeInvalid: false)
        }
        return LobbyFormIssue(issue: .failedServerText, needsInviteCode: false, inviteCodeInvalid: false)
    }
}

// MARK: - Primary (S10 6 f, g)

enum LobbyPrimaryPolicy {
    /// Why the primary is disabled in `editing` (one reason, in this order).
    static func reason(intent: LobbyIntent, isSignedIn: Bool, guestName: String, isOffline: Bool,
                       updateRequired: Bool) -> LobbyPrimaryReason {
        if updateRequired { return .updateRequired }
        if isOffline { return .offline }
        if !isSignedIn && DisplayNamePolicy.normalized(guestName).isEmpty {
            return intent == .newMeeting ? LobbyPrimaryReason.nameMissingStart : LobbyPrimaryReason.nameMissingJoin
        }
        return .none
    }

    /// The primary acts only in `editing`, with no reason and no start in flight (the collision check, C17).
    static func isEnabled(mode: LobbyMode, reason: LobbyPrimaryReason, isStarting: Bool) -> Bool {
        mode == .editing && reason == .none && !isStarting
    }

    /// The raw value the status snapshot carries ("" for none).
    static func snapshotValue(_ reason: LobbyPrimaryReason) -> String {
        reason == .none ? "" : reason.rawValue
    }
}

// MARK: - Toggle feedback (S10 6 c L2, h; F00 C04 e)

enum LobbyToggleFeedbackPolicy {
    /// The gesture kind a toggle tap plays: only when the tap changes the intent. Turning off always does; turning on
    /// needs a permission that is granted or can still be asked (Android's ask-again included through `canAskAgain`).
    static func kind(isOn: Bool, permission: MediaPermissionState, onKind: FeedbackKind, offKind: FeedbackKind,
                     canAskAgain: Bool = false) -> FeedbackKind? {
        if isOn { return offKind }
        switch permission {
        case .granted, .notDetermined:
            return onKind
        case .denied:
            return canAskAgain ? onKind : nil
        case .restricted, .unavailable:
            return nil
        }
    }
}

// MARK: - Presence (S10 6 f; 0.5 task table; Q5)

enum LobbyPresencePolicy {
    static let pollIntervalMillis = 10000.0

    /// Whether the room is polled at all: never for a fresh code (silent check only, C17) or the promotion lobby.
    static func showsPresence(intent: LobbyIntent) -> Bool {
        intent != .newMeeting && intent != .promotion
    }

    /// The 10 s poll runs only while the lobby is visible, the app is active and the mode is `editing`.
    static func polls(intent: LobbyIntent, mode: LobbyMode, isVisible: Bool, isAppActive: Bool, roomId: String) -> Bool {
        showsPresence(intent: intent) && mode == .editing && isVisible && isAppActive
            && !roomId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// `hasResult` false means no answer yet (checking); a nil count is a failed request (hidden).
    static func kind(hasResult: Bool, count: Int?, intent: LobbyIntent, mode: LobbyMode) -> PresenceKind {
        guard showsPresence(intent: intent), mode != .waiting else { return .hidden }
        guard hasResult else { return .checking }
        guard let count else { return .hidden }
        return count > 0 ? PresenceKind.count : PresenceKind.empty
    }
}

// MARK: - Audio (S10 6 c, d; Q14; RECONCILE R23)

enum LobbyAudioPolicy {
    /// The Audio and Microphone rows from the route owner's options and the stored prejoin intent. A chosen output
    /// kind shows at once (it is applied at join, C2); its name comes from the matching option, or "" so the view
    /// names the kind. The Microphone row shows only when more than one input is listed (Q14).
    static func snapshot(routeId: Int, device: LobbyDeviceInputs, chosenOutputKind: String,
                         chosenInputId: String) -> LobbyAudioSnapshot {
        var kind = AudioRouteKind.unknown.rawValue
        var name = ""
        var currentOutputId = device.currentOutputId
        if !chosenOutputKind.isEmpty {
            kind = chosenOutputKind
            for option in device.outputs where option.kind.rawValue == chosenOutputKind {
                name = option.name
                currentOutputId = option.id
                break
            }
        } else {
            for option in device.outputs where option.id == device.currentOutputId {
                kind = option.kind.rawValue
                name = option.name
            }
        }
        let inputId = chosenInputId.isEmpty ? device.currentInputId : chosenInputId
        var inputName = ""
        for option in device.inputs where option.id == inputId {
            inputName = option.name
        }
        return LobbyAudioSnapshot(
            routeId: routeId,
            routeName: name,
            routeKind: kind,
            showsInputRow: device.inputs.count > 1,
            inputName: inputName,
            outputs: device.outputs,
            currentOutputId: currentOutputId,
            inputs: device.inputs,
            currentInputId: inputId
        )
    }
}

// MARK: - Snapshots (S10 0.5)

enum LobbySnapshotPolicy {
    /// The card snapshot. The preview shows `blocked` exactly while the card overlay explains the camera permission
    /// (denied with no prompt left, or restricted; ENT-4 `PermissionPrimingPolicy.showsCameraOverlay`), `off` while
    /// Android can still ask again (the rationale row under the card explains it), and `unavailable` when there is no
    /// camera, whatever the controller reports.
    static func media(routeId: Int, micIntentOn: Bool, cameraIntentOn: Bool, device: LobbyDeviceInputs,
                      avatarName: String, avatarSeed: String) -> LobbyMediaSnapshot {
        var preview = device.previewState
        if PermissionPrimingPolicy.showsCameraOverlay(permission: device.cameraPermission,
                                                      canAskAgain: device.canAskAgainCamera,
                                                      supportsRationale: PermissionPrimingPolicy.platformSupportsRationale) {
            preview = .blocked
        } else if device.cameraPermission == .denied {
            preview = .off
        } else if device.cameraPermission == .unavailable {
            preview = .unavailable
        } else if !cameraIntentOn && preview != .published {
            preview = .off
        }
        return LobbyMediaSnapshot(
            routeId: routeId,
            micIntentOn: micIntentOn,
            cameraIntentOn: cameraIntentOn,
            micPermission: device.micPermission,
            cameraPermission: device.cameraPermission,
            canAskAgainAndroid: device.canAskAgainMicrophone && device.canAskAgainCamera,
            preview: preview,
            previewSessionId: device.previewSessionId,
            isFrontCamera: device.isFrontCamera,
            showsEffects: device.effectsAvailable,
            effectsActive: device.effectsActive,
            avatarName: avatarName,
            avatarSeed: avatarSeed,
            interruption: preview == .interrupted ? device.interruption : PreviewInterruption.none,
            canAskAgainMicrophone: device.canAskAgainMicrophone,
            canAskAgainCamera: device.canAskAgainCamera
        )
    }

    /// The title, link and Share. `newMeeting` shows no link and no Share before Start (Q1); `promotion` has no Share
    /// (R30). The link carries the target's client id only for a non-default tenant (R50).
    static func link(routeId: Int, intent: LobbyIntent, roomId: String, title: String, clientId: String?) -> LobbyLinkSnapshot {
        let room = roomId.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let shareable = intent != .newMeeting && intent != .promotion
        return LobbyLinkSnapshot(
            routeId: routeId,
            roomId: room,
            roomLabel: label.isEmpty ? room : label,
            meetingLink: shareable ? MeetingLinkBuilder.url(roomCode: room, clientId: clientId) : "",
            canShare: shareable && !room.isEmpty
        )
    }

    static func identity(routeId: Int, isSignedIn: Bool, accountName: String, accountSeed: String, guestName: String,
                         formIssue: LobbyFormIssue) -> LobbyIdentitySnapshot {
        LobbyIdentitySnapshot(
            routeId: routeId,
            isSignedIn: isSignedIn,
            accountName: accountName,
            accountSeed: accountSeed,
            guestName: DisplayNamePolicy.capped(guestName),
            nameLimit: DisplayNamePolicy.limit,
            needsInviteCode: formIssue.needsInviteCode,
            inviteCodeInvalid: formIssue.inviteCodeInvalid
        )
    }

    /// The name the card's avatar and chip use: the account name, else the typed guest name.
    static func avatarName(isSignedIn: Bool, accountName: String, guestName: String) -> String {
        isSignedIn ? accountName : DisplayNamePolicy.normalized(guestName)
    }
}

// MARK: - The one preview owner (S60 C6-8; RECONCILE R22; S10 Q16)

/// What happens to the preview. Both platform controllers feed these events and publish the result.
enum LocalPreviewEvent: String, CaseIterable, Equatable {
    /// The lobby asked for the camera (intent on, permission granted, lobby visible).
    case start
    /// The capture is bound and frames flow to the preview surface (never to a producer).
    case bound
    /// No camera, or binding failed.
    case failed
    case permissionDenied
    case interrupted
    case interruptionEnded
    case stop
    /// The publish latch closes: the call owns the camera; the preview stops and keeps its last frame (Q16 B).
    case handOff
    /// Android: the WebRTC client released the CameraX preview before its own capture (the same latch).
    case releasedByCall
    /// A new lobby after the call: the latch reopens.
    case resetLatch
}

struct LocalPreviewMachine: Equatable {
    let state: PreviewState
    let sessionId: Int
    let isLatched: Bool
    let interruption: PreviewInterruption

    static let initial = LocalPreviewMachine(state: .off, sessionId: 0, isLatched: false, interruption: .none)
}

enum LocalPreviewPolicy {
    /// The preview state machine with the publish latch: while latched nothing starts a capture, so a preview frame
    /// can never reach a producer or compete with the call's capturer (one capture owner, R22).
    static func next(_ machine: LocalPreviewMachine, event: LocalPreviewEvent,
                     interruption: PreviewInterruption = .none) -> LocalPreviewMachine {
        switch event {
        case .start:
            if machine.isLatched { return machine }
            if machine.state == .starting || machine.state == .live || machine.state == .interrupted {
                return machine
            }
            return LocalPreviewMachine(state: .starting, sessionId: machine.sessionId + 1, isLatched: false, interruption: .none)
        case .bound:
            guard machine.state == .starting || machine.state == .interrupted, !machine.isLatched else { return machine }
            return LocalPreviewMachine(state: .live, sessionId: machine.sessionId, isLatched: false, interruption: .none)
        case .failed:
            guard machine.state == .starting || machine.state == .live || machine.state == .interrupted, !machine.isLatched else {
                return machine
            }
            return LocalPreviewMachine(state: .unavailable, sessionId: machine.sessionId, isLatched: false, interruption: .none)
        case .permissionDenied:
            if machine.isLatched { return machine }
            return LocalPreviewMachine(state: .blocked, sessionId: machine.sessionId, isLatched: false, interruption: .none)
        case .interrupted:
            guard machine.state == .live || machine.state == .starting, !machine.isLatched else { return machine }
            return LocalPreviewMachine(state: .interrupted, sessionId: machine.sessionId, isLatched: false, interruption: interruption)
        case .interruptionEnded:
            guard machine.state == .interrupted else { return machine }
            return LocalPreviewMachine(state: .live, sessionId: machine.sessionId, isLatched: false, interruption: .none)
        case .stop:
            if machine.isLatched { return machine }
            return LocalPreviewMachine(state: .off, sessionId: machine.sessionId, isLatched: false, interruption: .none)
        case .handOff, .releasedByCall:
            return LocalPreviewMachine(state: .published, sessionId: machine.sessionId, isLatched: true, interruption: .none)
        case .resetLatch:
            guard machine.isLatched else { return machine }
            return LocalPreviewMachine(state: .off, sessionId: machine.sessionId, isLatched: false, interruption: .none)
        }
    }

    /// Whether the controller may run a capture now: only while starting, live or interrupted and never latched.
    static func mayCapture(_ machine: LocalPreviewMachine) -> Bool {
        !machine.isLatched && (machine.state == .starting || machine.state == .live || machine.state == .interrupted)
    }

    /// Whether the lobby wants the preview running (S10 6 k: intent on, permission granted, lobby visible, before the
    /// call owns the camera).
    static func isWanted(cameraIntentOn: Bool, permission: MediaPermissionState, isLobbyVisible: Bool,
                         isCallOwningCamera: Bool) -> Bool {
        cameraIntentOn && permission == .granted && isLobbyVisible && !isCallOwningCamera
    }
}
