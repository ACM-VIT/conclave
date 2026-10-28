import Foundation
import Observation

// S20 SL14 Debug stage fixture (STG-1, STG-4): `CONCLAVE_STAGE_FIXTURE=<state>` (iOS launch environment) and the
// intent extra `conclave.stageFixture` (Android, Debug only, FLAG_DEBUGGABLE checked like `conclave.hostingPreview`).
// It builds a standalone S1 shell and stage presenter with scripted rosters, speakers, events and reactions; slots
// render `RendererProbe` (PS 7.5, 8.9) with a static or live test pattern, both counted by `RendererIdentityLedger`.
// No WebRTC, audio, capture or network. The script is shared (transpiled) so both platforms and both test hosts read
// the same states. Later slices add states here through requests (keep one state enum, per-feature scripts).

/// The probe's drawing (SL14): none (the WP1 strip), a static test pattern drawn once and then no frames (the idle
/// cells), or a live pattern that keeps updating the renderer surface (the renderer-driven frame cells).
enum RendererProbePattern: String, CaseIterable, Equatable {
    case none
    case staticPattern = "static"
    case livePattern = "live"
}

/// Fixture states. Raw values are the launch values.
enum StageFixtureState: String, CaseIterable, Equatable {
    case soloCameraOff = "solo-cameraOff"
    case soloCameraOn = "solo-cameraOn"
    case soloUnconfirmed = "solo-unconfirmed"
    case oneOnOne = "oneOnOne"
    case grid3 = "grid-3"
    case grid4 = "grid-4"
    case grid6 = "grid-6"
    case grid8 = "grid-8"
    case grid12 = "grid-12"
    case grid16 = "grid-16"
    case grid6LockedCaptions = "grid-6-locked-captions"
    case audioOnly = "audio-only"
    case spotlight = "spotlight"
    case presentation = "presentation"
    case pinned = "pinned"
    case rolesSweep = "roles-sweep"
    case recovering = "recovering"
    case handRaising = "hand-raising"
    case handRaised = "hand-raised"
    case nowPlaying = "now-playing"
    case liveNotesPaused = "liveNotes-paused"
    case liveNotesAttention = "liveNotes-attention"
    case reactionsBurst25 = "reactions-burst-25"
    case reactionsBurst40 = "reactions-burst-40"
    case hideTiles = "hide-tiles"
    // STG-5 notice lanes (S20 10 l) and TRN-1 captions (S60 5 l). The notice states keep the grid-4 stage.
    case knock1 = "knock-1"
    case knock2 = "knock-2"
    case offline = "offline"
    case captivePortal = "captive-portal"
    case reconnecting2 = "reconnecting-2"
    case reconnectingInFlight = "reconnecting-inflight"
    case serverRestart = "server-restart"
    case onHold = "on-hold"
    case audioPaused = "audio-paused"
    case shareStalled = "share-stalled"
    case hostNotice = "host-notice"
    case hostNoticeLong = "host-notice-long"
    case liveNotes = "live-notes"
    case catchUp = "catch-up"
    case veryPoor = "very-poor"
    case permissionMicrophone = "permission-mic"
    case notificationsOff = "notifications-off"
    case toastJoins = "toast-joins"
    case toastHand = "toast-hand"
    case toastFailure = "toast-failure"
    case toastChat = "toast-chat"
    case toastRoute = "toast-route"
    /// SYS-6 (S70 6 g, S20 10 f toast row; HD request B6-T6 R8): the R70-1 "video quality is lower" toast.
    case toastQualityLowered = "toast-quality-lowered"
    case captionsLive = "captions-live"
    case captionsPartial = "captions-partial"
    case captionsQuiet = "captions-quiet"
    case captionsAttendee = "captions-attendee"
    // STG-2 (S20 3 l, 4 l)
    case oneOnOneCameraOff = "oneOnOne-cameraOff"
    case grid3CameraOn = "grid-3-cameraOn"
    case spotlightPinnedSelf = "spotlight-pinned-self"
    case spotlightPinned9 = "spotlight-pinned-9"
    case presentationPinned = "presentation-pinned"
    case sidebar14 = "sidebar-14"
    case tileReconnecting = "tile-reconnecting"
    // STG-9, ACT-1, ACT-2 (S20 11 l, S60 7 l, 8 l): raw values equal `ActivityFixtureState` raw values.
    case gameTrivia6 = "game-trivia-6"
    case appAndGame = "app-and-game"
    case gameLobbyHost = "game-lobby-host"
    case gameLobbyHostUnseated = "game-lobby-host-unseated"
    case gameLobbyImposter2 = "game-lobby-imposter-2"
    case gameSpectator = "game-spectator"
    case gameResults = "game-results"
    case gameUnsupported = "game-unsupported"
    case gamePrivateLoading = "game-private-loading"
    case appOpening = "app-opening"
    case appFailed = "app-failed"
    case activitiesHostIdle = "activities-host-idle"
    case activitiesParticipantIdle = "activities-participant-idle"
    case activitiesVote = "activities-vote"
    case activitiesVoteZero = "activities-vote-zero"
    case activitiesGameLive = "activities-game-live"
    case activitiesRecovering = "activities-recovering"
    // ACT-3 (S60 9 l): raw values equal `PromptGameFixtureState` raw values (Games/Native/Scenes/PromptGameFixtures.swift).
    case gameTriviaAnswered = "game-trivia-answered"
    case gameTriviaReveal = "game-trivia-reveal"
    case gameBluffWrite = "game-bluff-write"
    case gameBluffChoose = "game-bluff-choose"
    case gameBluffReveal = "game-bluff-reveal"
    case gameWyrChoose = "game-wyr-choose"
    case gameWyrReveal = "game-wyr-reveal"
    case gameMltVote = "game-mlt-vote"
    case gameMltRevealTie = "game-mlt-reveal-tie"
    case gameReactionArming = "game-reaction-arming"
    case gameReactionGo = "game-reaction-go"
    case gameReactionReveal = "game-reaction-reveal"
    case gameImposterCrew = "game-imposter-crew"
    case gameImposterImposter = "game-imposter-imposter"
    case gameImposterSpectator = "game-imposter-spectator"
    case gameImposterVote = "game-imposter-vote"
    case gameImposterResult = "game-imposter-result"
    // ACT-4 (S60 10 l): raw values equal `WordleFixtureState` raw values (end of Activities/GameStagePresenter.swift).
    case gameWordleGuess = "game-wordle-guess"
    case gameWordleSolved = "game-wordle-solved"
    case gameWordleOutOfTries = "game-wordle-out-of-tries"
    case gameWordleSetWord = "game-wordle-set-word"
    case gameWordleWaitingWord = "game-wordle-waiting-word"
    case gameWordleSetterWatching = "game-wordle-setter-watching"
    case gameWordleRoundResults = "game-wordle-round-results"
    case gameWordleTimeout = "game-wordle-timeout"
    case gameWordleFinal = "game-wordle-final"
    case gameWordleSpectator = "game-wordle-spectator"
    case gameWordleReconnecting = "game-wordle-reconnecting"
    // ACT-7 (S60 13 l): raw values equal `AppHostFixtureState` raw values (Activities/AppHostPresenter.swift).
    case appWhiteboardReady = "app-whiteboard-ready"
    case appWhiteboardViewOnly = "app-whiteboard-view-only"
    case appWhiteboardLockedHost = "app-whiteboard-locked-host"
    case appWhiteboardReconnecting = "app-whiteboard-reconnecting"
    case appVersionMismatch = "app-version-mismatch"
    case appRendererGone = "app-renderer-gone"
    // STG-6 Meeting Details (S20 15 l): each opens the panel from the capsule on start.
    case meetingInfoHost = "meetingInfo-host"
    case meetingInfoGuest = "meetingInfo-guest"
    case meetingInfoRecovering = "meetingInfo-recovering"
    case meetingInfoTenant = "meetingInfo-tenant"
    case meetingInfoAttendee = "meetingInfo-attendee"
    // STG-8 webinar attendee viewer (S20 12 l).
    case attendeeWaiting128 = "attendee-waiting-128"
    case attendeeLive = "attendee-live"
    case attendeeLiveShare = "attendee-live-share"
    case attendeeQaUnseen2 = "attendee-qa-unseen-2"
    // STG-3 share viewing and the self view (S20 5 l, 6 l).
    case presentationRemote = "presentation-remote"
    case presentationPending = "presentation-pending"
    case presentationLocal = "presentation-local"
    case selfMinimized = "self-minimized"
    case selfCameraPaused = "self-camera-paused"
    case selfFlipInFlight = "self-flip-inflight"
    // CHT-8 chat previews on the stage (S40 8 l), chat closed; the grid-4 stage with you as a host.
    case chatPreviewsSameSender3 = "chat-previews-same-sender-3"
    case chatPreviewsMixed3 = "chat-previews-mixed-3"
    case chatPreviewsPrivate = "chat-previews-private"
    case chatPreviewsPhoto = "chat-previews-photo"
    case chatPreviewsOff = "chat-previews-off"
    case chatPreviewsAttendee = "chat-previews-attendee"
    // SET-5 (S60 3 l, L6-12 `layout-*`): the Layout panel opens over the stage; the scripted core applies each change.
    case layoutGrid6 = "layout-grid-6"
    case layoutFloating = "layout-floating"
    case layoutAudioOnly = "layout-audio-only"
    // SET-6 (S60 4 l, L6-12 `effects-*`): the Effects panel over the stage on the fake WP10 engine; `effects-hidden`
    // installs no engine, so nothing publishes the panel (4 l1).
    case effectsCameraOn = "effects-camera-on"
    case effectsCameraOff = "effects-camera-off"
    case effectsAudioOnly = "effects-audio-only"
    case effectsHostDisabled = "effects-host-disabled"
    case effectsBlocked = "effects-blocked"
    case effectsInterrupted = "effects-interrupted"
    case effectsPortrait = "effects-portrait"
    case effectsCenterStage = "effects-center-stage"
    case effectsStudioLight = "effects-studio-light"
    case effectsPreparing = "effects-preparing"
    case effectsHidden = "effects-hidden"
}

/// Pure scripts per state, shared by the fixture roots and both test hosts.
enum StageFixtureScript {
    static let roomLabel = "abc-defg-hij"
    static let localUserId = "you"
    static let meetingLink = "https://conclave.acmvit.in/abc-defg-hij"
    /// Fixed and long past (2023-11-14 UTC), so the recent-join hold never delays the auto-hide cells.
    static let joinedAtMillis = 1700000000000.0
    static let names = ["Avery", "Ben", "Cai", "Dev", "Eli", "Fen", "Gia", "Hal", "Ivo", "Jun", "Kai", "Lia", "Mo", "Nia",
                        "Oli", "Pax", "Quin", "Rae", "Sol", "Tao"]

    static func state(named raw: String) -> StageFixtureState? {
        StageFixtureState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func pattern(named raw: String?) -> RendererProbePattern {
        guard let raw = raw else { return RendererProbePattern.staticPattern }
        return RendererProbePattern(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines)) ?? RendererProbePattern.staticPattern
    }

    static func remoteId(_ index: Int) -> String {
        "r" + String(index + 1)
    }

    static func remoteName(_ index: Int) -> String {
        if index < names.count { return names[index] }
        return "Guest " + String(index + 1)
    }

    /// `count` people including you: you first in the array (order never matters to the stage), then remotes with join
    /// serials 1...count-1. Remote cameras are on unless `remoteCamerasOn` is false.
    static func roster(count: Int, remoteCamerasOn: Bool = true, localCameraOn: Bool = false, localMuted: Bool = true,
                       localHandRaised: Bool = false) -> [StageParticipantInput] {
        var result: [StageParticipantInput] = []
        result.append(StageParticipantInput.make(userId: localUserId, displayName: "You", isLocal: true, isMuted: localMuted,
                                                 isCameraOff: !localCameraOn, isHandRaised: localHandRaised, joinSerial: 0,
                                                 videoKey: localCameraOn ? "probe:" + localUserId : ""))
        var index = 0
        while index < count - 1 {
            let id = remoteId(index)
            result.append(StageParticipantInput.make(userId: id, displayName: remoteName(index), isMuted: index % 3 == 1,
                                                     isCameraOff: !remoteCamerasOn, joinSerial: index + 1,
                                                     videoKey: remoteCamerasOn ? "probe:" + id : ""))
            index += 1
        }
        return result
    }

    static func base(count: Int, remoteCamerasOn: Bool = true, localCameraOn: Bool = false) -> StageInputs {
        StageInputs.make(callSession: 1, isInCall: true, localUserId: localUserId, roomLabel: roomLabel, meetingLink: meetingLink,
                         participants: roster(count: count, remoteCamerasOn: remoteCamerasOn, localCameraOn: localCameraOn),
                         isAloneConfirmed: count == 1, canFlipCamera: true, routeKind: "speaker", routeName: "Speaker",
                         joinedAtMillis: joinedAtMillis)
    }

    // swiftlint:disable:next cyclomatic_complexity
    static func inputs(for state: StageFixtureState) -> StageInputs {
        switch state {
        case .soloCameraOff:
            return base(count: 1)
        case .soloCameraOn:
            return base(count: 1, localCameraOn: true)
        case .soloUnconfirmed:
            return copy(base(count: 1), isAloneConfirmed: false)
        case .oneOnOne:
            return base(count: 2, localCameraOn: true)
        case .grid3:
            return base(count: 3)
        case .grid4:
            return base(count: 4)
        case .grid6:
            return base(count: 6)
        case .grid8:
            return base(count: 8)
        case .grid12:
            return base(count: 12)
        case .grid16:
            return base(count: 16)
        case .grid6LockedCaptions:
            return copy(base(count: 6), isRoomLocked: true, captionsOn: true)
        case .audioOnly:
            return base(count: 4, remoteCamerasOn: false)
        case .spotlight:
            return copy(base(count: 6), viewMode: "spotlight")
        case .presentation:
            var shared = roster(count: 4)
            shared[1] = StageParticipantInput.make(userId: remoteId(0), displayName: remoteName(0), isMuted: false,
                                                   isCameraOff: false, isScreenSharing: true, joinSerial: 1,
                                                   videoKey: "probe:" + remoteId(0), shareVideoKey: "probe:share:" + remoteId(0))
            return copy(base(count: 4), participants: shared, screenShareUserId: remoteId(0))
        case .pinned:
            return copy(base(count: 6), pinnedUserId: remoteId(1))
        case .rolesSweep:
            return rolesSweepStep(0)
        case .recovering:
            return copy(base(count: 4), isRecovering: true)
        case .handRaising:
            return copy(base(count: 4), handToggleInFlight: true)
        case .handRaised:
            return copy(base(count: 4), participants: roster(count: 4, localHandRaised: true), isHandRaised: true)
        case .nowPlaying:
            return copy(base(count: 4), isGameActive: true, gameName: "Trivia")
        case .liveNotesPaused:
            return copy(base(count: 4), liveNotes: LiveNotesState.paused)
        case .liveNotesAttention:
            return copy(base(count: 4), liveNotes: LiveNotesState.needsAttention)
        case .reactionsBurst25:
            return base(count: 6)
        case .reactionsBurst40:
            return base(count: 40)
        case .hideTiles:
            // r2 speaks with the camera off; hiding tiles without video must keep their tile and their audio (SC6).
            var rows = roster(count: 6)
            rows[2] = StageParticipantInput.make(userId: remoteId(1), displayName: remoteName(1), isMuted: false,
                                                 isCameraOff: true, joinSerial: 2)
            rows[3] = StageParticipantInput.make(userId: remoteId(2), displayName: remoteName(2), isMuted: false,
                                                 isCameraOff: true, joinSerial: 3)
            return copy(base(count: 6), participants: rows, hideTilesWithoutVideo: true)
        case .captionsLive, .captionsPartial, .captionsQuiet:
            return copy(base(count: 4), captionsOn: true, liveNotes: LiveNotesState.live)
        case .captionsAttendee:
            return copy(base(count: 4), captionsOn: true, liveNotes: LiveNotesState.live, isWebinarAttendee: true)
        case .liveNotes, .catchUp:
            return copy(base(count: 4), liveNotes: LiveNotesState.live)
        case .knock1, .knock2, .offline, .captivePortal, .reconnecting2, .reconnectingInFlight, .serverRestart, .onHold,
             .audioPaused, .shareStalled, .hostNotice,
             .hostNoticeLong, .veryPoor, .permissionMicrophone, .notificationsOff, .toastJoins, .toastHand, .toastFailure,
             .toastChat, .toastRoute, .toastQualityLowered:
            return base(count: 4)
        case .oneOnOneCameraOff:
            return base(count: 2, remoteCamerasOn: false, localCameraOn: true)
        case .grid3CameraOn:
            return copy(base(count: 3, localCameraOn: true), selfViewMode: "tile")
        case .spotlightPinnedSelf:
            return copy(base(count: 3, localCameraOn: true), selfViewMode: "tile", pinnedUserId: localUserId)
        case .spotlightPinned9:
            return copy(base(count: 9), pinnedUserId: remoteId(0))
        case .presentationPinned:
            return copy(inputs(for: .presentation), pinnedUserId: remoteId(1))
        case .sidebar14:
            return base(count: 14)
        case .tileReconnecting:
            return reconnectingStep(true)
        case .gameTrivia6, .appAndGame, .gameLobbyHost, .gameLobbyHostUnseated, .gameLobbyImposter2, .gameSpectator, .gameResults,
             .gameUnsupported, .gamePrivateLoading, .appOpening, .appFailed, .activitiesHostIdle, .activitiesParticipantIdle,
             .activitiesVote, .activitiesVoteZero, .activitiesGameLive, .activitiesRecovering,
             .gameTriviaAnswered, .gameTriviaReveal, .gameBluffWrite, .gameBluffChoose, .gameBluffReveal, .gameWyrChoose,
             .gameWyrReveal, .gameMltVote, .gameMltRevealTie, .gameReactionArming, .gameReactionGo, .gameReactionReveal,
             .gameImposterCrew, .gameImposterImposter, .gameImposterSpectator, .gameImposterVote, .gameImposterResult,
             .gameWordleGuess, .gameWordleSolved, .gameWordleOutOfTries, .gameWordleSetWord, .gameWordleWaitingWord,
             .gameWordleSetterWatching, .gameWordleRoundResults, .gameWordleTimeout, .gameWordleFinal, .gameWordleSpectator,
             .gameWordleReconnecting,
             .appWhiteboardReady, .appWhiteboardViewOnly, .appWhiteboardLockedHost, .appWhiteboardReconnecting,
             .appVersionMismatch, .appRendererGone:
            return ActivityFixtureScript.stageInputs(named: state.rawValue, base: base(count: 6))
        case .meetingInfoHost:
            return copy(base(count: 4), participants: hostRoster(count: 4), isRoomLocked: true, captionsOn: true,
                        liveNotes: LiveNotesState.live)
        case .meetingInfoGuest:
            return copy(base(count: 4), participants: hostRoster(count: 4, localIsHost: false))
        case .meetingInfoRecovering:
            return copy(base(count: 4), participants: hostRoster(count: 4), isRecovering: true)
        case .meetingInfoTenant:
            return copy(base(count: 4), participants: hostRoster(count: 4, localIsHost: false), meetingLink: tenantLink)
        case .meetingInfoAttendee, .attendeeWaiting128, .attendeeLive, .attendeeLiveShare, .attendeeQaUnseen2:
            return attendeeInputs(state)
        case .presentationRemote:
            // The 1920 x 1080 static test pattern share of Avery (r1) on the full-bleed share slot.
            return inputs(for: .presentation)
        case .presentationPending:
            // Avery shares but the share track is not bound yet: the placeholder "%@ is presenting" with the avatar.
            var pending = roster(count: 4)
            pending[1] = StageParticipantInput.make(userId: remoteId(0), displayName: remoteName(0), isMuted: false,
                                                    isCameraOff: false, isScreenSharing: true, joinSerial: 1,
                                                    videoKey: "probe:" + remoteId(0), shareVideoKey: "")
            return copy(base(count: 4), participants: pending, screenShareUserId: remoteId(0))
        case .presentationLocal:
            // You present: the share slot shows "You're presenting", the banner "You're sharing your screen" (R11 d).
            return copy(base(count: 4), screenShareUserId: localUserId, isLocalScreenSharing: true)
        case .selfMinimized:
            return copy(base(count: 2, localCameraOn: true), selfViewMode: "minimized")
        case .selfCameraPaused:
            return copy(base(count: 2, localCameraOn: true), isCameraPaused: true)
        case .selfFlipInFlight:
            return copy(base(count: 2, localCameraOn: true), isFlipInFlight: true)
        case .chatPreviewsSameSender3, .chatPreviewsMixed3, .chatPreviewsPrivate, .chatPreviewsPhoto, .chatPreviewsOff:
            return base(count: 4)
        case .chatPreviewsAttendee:
            return copy(base(count: 4), isWebinarAttendee: true)
        case .layoutGrid6, .layoutAudioOnly:
            return base(count: 6)
        case .layoutFloating:
            return copy(base(count: 4, localCameraOn: true), selfViewMode: "floating")
        case .effectsCameraOff, .effectsAudioOnly, .effectsHostDisabled, .effectsBlocked, .effectsHidden:
            // 1:1 with your camera off: the floating self view (Auto) is the one the iOS sheet lifts (R6-6).
            return base(count: 2)
        case .effectsInterrupted:
            return copy(base(count: 2, localCameraOn: true), isCameraPaused: true)
        case .effectsCameraOn, .effectsPortrait, .effectsCenterStage, .effectsStudioLight, .effectsPreparing:
            return base(count: 2, localCameraOn: true)
        }
    }

    // MARK: Layout and Effects panels (SET-5, SET-6; L6-12)

    /// The panel a Layout or Effects state opens once the stage is up (invoker call); nil for every other state.
    static func opensPanel(_ state: StageFixtureState) -> MeetingPanel? {
        switch state {
        case .layoutGrid6, .layoutFloating, .layoutAudioOnly:
            return MeetingPanel.layout
        case .effectsCameraOn, .effectsCameraOff, .effectsAudioOnly, .effectsHostDisabled, .effectsBlocked, .effectsInterrupted,
             .effectsPortrait, .effectsCenterStage, .effectsStudioLight, .effectsPreparing:
            return MeetingPanel.effects
        default:
            return nil
        }
    }

    /// The fake engine's scripted inputs per Effects state; nil leaves the engine uninstalled (the panel stays hidden).
    static func effectsState(_ state: StageFixtureState) -> EffectsFixtureState? {
        switch state {
        case .effectsCameraOn: return EffectsFixtureState.cameraOn
        case .effectsCameraOff: return EffectsFixtureState.cameraOff
        case .effectsAudioOnly: return EffectsFixtureState.audioOnly
        case .effectsHostDisabled: return EffectsFixtureState.hostDisabled
        case .effectsBlocked: return EffectsFixtureState.blocked
        case .effectsInterrupted: return EffectsFixtureState.interrupted
        case .effectsPortrait: return EffectsFixtureState.portrait
        case .effectsCenterStage: return EffectsFixtureState.centerStage
        case .effectsStudioLight: return EffectsFixtureState.studioLight
        case .effectsPreparing: return EffectsFixtureState.preparing
        default: return nil
        }
    }

    // MARK: Meeting Details and the attendee viewer (STG-6, STG-8)

    static let tenantClientId = "acme-events"
    /// The SC23 builder's custom-tenant link (RECONCILE R50): "?clientId=" rides along.
    static let tenantLink = MeetingLinkBuilder.url(roomCode: roomLabel, clientId: tenantClientId)
    static let webinarTitle = "Design Systems Week"
    static let webinarLink = "https://conclave.acmvit.in/w/design-systems-week"

    /// `count` people where r1 (Avery) is a host and you are one too unless `localIsHost` is false.
    static func hostRoster(count: Int, localIsHost: Bool = true) -> [StageParticipantInput] {
        var result: [StageParticipantInput] = []
        for participant in roster(count: count) {
            let isHost = participant.isLocal ? localIsHost : participant.userId == remoteId(0)
            result.append(StageParticipantInput.make(userId: participant.userId, displayName: participant.displayName,
                                                     isLocal: participant.isLocal, isMuted: participant.isMuted,
                                                     isCameraOff: participant.isCameraOff, isHost: isHost,
                                                     joinSerial: participant.joinSerial, videoKey: participant.videoKey))
        }
        return result
    }

    /// Attendee stages: you watch two panelists (r1 Avery, r2 Ben). Waiting has no speaker and every camera off; live
    /// features Avery's camera; live share shows Ben's screen with Ben's camera as the inset.
    static func attendeeInputs(_ state: StageFixtureState) -> StageInputs {
        let live = state == StageFixtureState.attendeeLive || state == StageFixtureState.attendeeQaUnseen2
        let sharing = state == StageFixtureState.attendeeLiveShare
        var rows: [StageParticipantInput] = []
        rows.append(StageParticipantInput.make(userId: localUserId, displayName: "You", isLocal: true))
        rows.append(StageParticipantInput.make(userId: remoteId(0), displayName: remoteName(0), isMuted: !live,
                                               isCameraOff: !live, isHost: true, joinSerial: 1,
                                               videoKey: live ? "probe:" + remoteId(0) : ""))
        rows.append(StageParticipantInput.make(userId: remoteId(1), displayName: remoteName(1), isMuted: !sharing,
                                               isCameraOff: !sharing, isScreenSharing: sharing, joinSerial: 2,
                                               videoKey: sharing ? "probe:" + remoteId(1) : "",
                                               shareVideoKey: sharing ? "probe:share:" + remoteId(1) : ""))
        let source = copy(base(count: 3), participants: rows, screenShareUserId: sharing ? remoteId(1) : "",
                          isAloneConfirmed: false, isWebinarAttendee: true)
        return copy(source, webinarSpeakerUserId: live ? remoteId(0) : "")
    }

    /// The Meeting Details and attendee inputs per state; nil for the stage-only states.
    static func detailsInputs(_ state: StageFixtureState) -> StageDetailsInputs? {
        switch state {
        case .meetingInfoHost:
            return StageDetailsInputs.make(callSession: 1, roomCode: roomLabel, requiresInviteCode: true, isWebinarEnabled: true,
                                           connectionQuality: ConnectionQuality.good, connectionHasSample: true)
        case .meetingInfoGuest:
            return StageDetailsInputs.make(callSession: 1, roomCode: roomLabel)
        case .meetingInfoRecovering:
            return StageDetailsInputs.make(callSession: 1, roomCode: roomLabel, isWebinarEnabled: true,
                                           webinarLinkURL: webinarLink, connectionQuality: ConnectionQuality.fair,
                                           connectionHasSample: true)
        case .meetingInfoTenant:
            return StageDetailsInputs.make(callSession: 1, roomCode: roomLabel, connectionQuality: ConnectionQuality.good,
                                           connectionHasSample: true)
        case .meetingInfoAttendee, .attendeeWaiting128, .attendeeLive, .attendeeLiveShare, .attendeeQaUnseen2:
            return StageDetailsInputs.make(callSession: 1, roomCode: roomLabel, isWebinarEnabled: true,
                                           isWebinarPublicAccess: true, webinarLinkURL: webinarLink, webinarTitle: webinarTitle,
                                           webinarAttendeeCount: state == StageFixtureState.attendeeWaiting128 ? 128 : 42,
                                           isWebinarQaEnabled: true,
                                           webinarQaUnseen: state == StageFixtureState.attendeeQaUnseen2 ? 2 : 0)
        default:
            return nil
        }
    }

    /// Meeting Details fixtures open the panel from the capsule (invoker call) once the stage is up.
    static func opensMeetingInfo(_ state: StageFixtureState) -> Bool {
        switch state {
        case .meetingInfoHost, .meetingInfoGuest, .meetingInfoRecovering, .meetingInfoTenant, .meetingInfoAttendee:
            return true
        default:
            return false
        }
    }

    /// S20 3 c: r2 reconnecting with the SFU's "ping timeout" reason, or back (the tile shows "Back Online" for 4.5 s).
    static func reconnectingStep(_ reconnecting: Bool) -> StageInputs {
        var rows = roster(count: 4)
        rows[2] = StageParticipantInput.make(userId: remoteId(1), displayName: remoteName(1), isMuted: false, isCameraOff: false,
                                             isReconnecting: reconnecting, reconnectReason: reconnecting ? "ping timeout" : "",
                                             joinSerial: 2, videoKey: "probe:" + remoteId(1))
        return copy(base(count: 4), participants: rows)
    }

    // MARK: Notices and captions (STG-5, TRN-1)

    static let hostNoticeText = "We start the demo in five minutes."
    static let hostNoticeLongText = "Please keep your microphone muted while the guest speaker presents, and use the raised "
        + "hand when you have a question so we can take them in order. The recording and the slides will be shared in the "
        + "chat after the session, together with the links mentioned during the talk."

    /// The notice inputs per state: you are a host in a room of four with the presence snapshot done; nil for the
    /// stage-only states (their notice lanes stay empty).
    static func noticeInputs(_ state: StageFixtureState) -> StageNoticeInputs? {
        switch state {
        case .knock1:
            return noticeBase(pendingUserIds: ["w1"], pendingFirstName: "Sam")
        case .knock2:
            return noticeBase(pendingUserIds: ["w1", "w2"], pendingFirstName: "Sam")
        case .offline:
            return noticeBase(isOffline: true, pendingUserIds: ["w1"], pendingFirstName: "Sam")
        case .captivePortal:
            return noticeBase(isOffline: true, isCaptivePortal: true)
        case .reconnecting2:
            return noticeBase(isRecovering: true, reconnectAttempt: 2)
        case .reconnectingInFlight:
            return noticeBase(isRecovering: true, reconnectAttempt: 2, isRecoveryAttemptInFlight: true)
        case .serverRestart:
            return noticeBase(hasServerRestartNotice: true)
        case .onHold:
            return noticeBase(isOnHold: true, pendingUserIds: ["w1"], pendingFirstName: "Sam")
        case .audioPaused:
            return noticeBase(isAudioPaused: true)
        case .shareStalled:
            return noticeBase(shareIssue: MeetingNoticePolicy.shareIssueNotSending)
        case .liveNotes:
            return noticeBase(liveNotes: LiveNotesState.live)
        case .catchUp:
            return noticeBase(liveNotes: LiveNotesState.live, catchUpMinutes: 7)
        case .veryPoor:
            return noticeBase(connectionQuality: ConnectionQuality.emergency)
        case .permissionMicrophone:
            return noticeBase(microphonePermissionRevoked: true)
        case .notificationsOff:
            return noticeBase(showsNotificationsPrime: true)
        case .hostNotice, .hostNoticeLong, .toastJoins, .toastHand, .toastFailure, .toastChat, .toastRoute, .toastQualityLowered,
             .captionsLive, .captionsPartial, .captionsQuiet, .captionsAttendee:
            return noticeBase()
        case .presentationLocal:
            // STG-3 (S20 5 l): your share's banner "You're sharing your screen".
            return noticeBase(isScreenSharing: true)
        case .chatPreviewsSameSender3, .chatPreviewsMixed3, .chatPreviewsPrivate, .chatPreviewsPhoto, .chatPreviewsOff:
            return noticeBase()
        case .chatPreviewsAttendee:
            return noticeBase(isAttendee: true)
        case .layoutAudioOnly, .effectsAudioOnly:
            // SET-5, SET-6: Audio Only is on (S20 banner present; Layout's switch on; Effects tiles disabled).
            return noticeBase(isAudioOnly: true)
        default:
            return nil
        }
    }

    static func noticeBase(isOffline: Bool = false, isCaptivePortal: Bool = false, isRecovering: Bool = false,
                           reconnectAttempt: Int = 0, isRecoveryAttemptInFlight: Bool = false,
                           hasServerRestartNotice: Bool = false, isOnHold: Bool = false, isAudioPaused: Bool = false,
                           pendingUserIds: [String] = [], pendingFirstName: String = "", shareIssue: String = "",
                           liveNotes: LiveNotesState = LiveNotesState.off, catchUpMinutes: Int = 0,
                           connectionQuality: ConnectionQuality = ConnectionQuality.good,
                           microphonePermissionRevoked: Bool = false, showsNotificationsPrime: Bool = false,
                           isScreenSharing: Bool = false, isAttendee: Bool = false,
                           isAudioOnly: Bool = false) -> StageNoticeInputs {
        StageNoticeInputs.make(callSession: 1, isAttendee: isAttendee, isHost: !isAttendee, localUserId: localUserId,
                               participantCount: 4, hasInitialPresenceSnapshot: true, isOffline: isOffline,
                               isCaptivePortal: isCaptivePortal,
                               isRecovering: isRecovering, reconnectAttempt: reconnectAttempt, reconnectAttemptLimit: 5,
                               isRecoveryAttemptInFlight: isRecoveryAttemptInFlight,
                               hasServerRestartNotice: hasServerRestartNotice, isOnHold: isOnHold, isAudioPaused: isAudioPaused,
                               pendingUserIds: pendingUserIds, pendingFirstName: pendingFirstName,
                               isScreenSharing: isScreenSharing, shareIssue: shareIssue,
                               shareIssueSerial: shareIssue.isEmpty ? 0 : 1, liveNotes: liveNotes,
                               catchUpMinutes: catchUpMinutes, isAudioOnly: isAudioOnly, connectionQuality: connectionQuality,
                               microphonePermissionRevoked: microphonePermissionRevoked,
                               showsNotificationsPrime: showsNotificationsPrime)
    }

    /// The scripted events per state, posted once after the notice inputs.
    static func noticeEvents(_ state: StageFixtureState) -> [StageEvent] {
        switch state {
        case .hostNotice:
            return [StageEvent.make(kind: StageEventKind.hostNotice, userId: "r1", name: remoteName(0), serverText: hostNoticeText,
                                    detail: "info")]
        case .hostNoticeLong:
            return [StageEvent.make(kind: StageEventKind.hostNotice, userId: "r1", name: remoteName(0),
                                    serverText: hostNoticeLongText, detail: "warning")]
        case .toastJoins:
            return joinBurst()
        case .toastHand:
            return [StageEvent.make(kind: StageEventKind.handRaised, userId: "r1", name: remoteName(0)),
                    StageEvent.make(kind: StageEventKind.handRaised, userId: "r2", name: remoteName(1))]
        case .toastFailure:
            return [StageEvent.make(kind: StageEventKind.actionFailed, detail: "hand")]
        case .toastChat:
            return [StageEvent.make(kind: StageEventKind.chatPreview, userId: "r1", name: remoteName(0), messageId: "m1",
                                    detail: "Can you share the deck?")]
        case .toastRoute:
            return [StageEvent.make(kind: StageEventKind.routeChanged, name: "AirPods Pro", detail: "bluetooth")]
        case .toastQualityLowered:
            return [StageEvent.make(kind: StageEventKind.qualityLowered)]
        case .chatPreviewsSameSender3, .chatPreviewsMixed3, .chatPreviewsPrivate, .chatPreviewsPhoto, .chatPreviewsOff,
             .chatPreviewsAttendee:
            return chatPreviewEvents(chatPreviewMessages(state))
        default:
            return []
        }
    }

    // MARK: Chat previews (CHT-8)

    /// The people behind the scripted chat messages (S40 8 b names the sender "Avery Lee"); ids are the stage's r1 to r3.
    static let chatPreviewNames = ["Avery Lee", "Ben Ortiz", "Cai Moreno"]
    static let chatPreviewPhotoURL = "file:///conclave-stage-fixture/whiteboard.jpg"

    /// One scripted remote chat message from r1 to r3 (the core's `ChatMessage`, so the real body policy runs).
    static func chatPreviewMessage(_ id: String, sender index: Int, _ content: String, isDirect: Bool = false,
                                   image: ChatImageAttachment? = nil) -> ChatMessage {
        ChatMessage(id: id, userId: remoteId(index), displayName: chatPreviewNames[index % chatPreviewNames.count],
                    content: content, timestamp: Date(timeIntervalSince1970: joinedAtMillis / 1000.0 + 600.0), image: image,
                    isDirect: isDirect, dmTargetUserId: isDirect ? localUserId : nil, dmTargetDisplayName: isDirect ? "You" : nil,
                    roomId: roomLabel)
    }

    /// The scripted messages per chat preview state (S40 0.9 `previews:sameSender3`, `previews:mixed3`): three from
    /// Avery Lee; Ben, Cai, then Avery Lee (so the title reads "Avery Lee and 2 others"); one private message; one photo
    /// with a caption (the body never shows the file name).
    static func chatPreviewMessages(_ state: StageFixtureState) -> [ChatMessage] {
        switch state {
        case .chatPreviewsSameSender3:
            return chatPreviewScript(named: "sameSender3")
        case .chatPreviewsMixed3:
            return chatPreviewScript(named: "mixed3")
        case .chatPreviewsPrivate:
            return [chatPreviewMessage("cp-private", sender: 0, "Are you free right after this?", isDirect: true)]
        case .chatPreviewsPhoto:
            let image = ChatImageAttachment(id: "img-1", url: chatPreviewPhotoURL, fileName: "IMG_2041.jpg", mimeType: "image/jpeg",
                                            size: 48_000)
            return [chatPreviewMessage("cp-photo", sender: 0, "Whiteboard from today", image: image)]
        case .chatPreviewsOff, .chatPreviewsAttendee:
            return [chatPreviewMessage("cp-1", sender: 0, "Can you share the deck?")]
        default:
            return []
        }
    }

    /// The named driver scripts (the stage fixture's "Chat Previews" controls, HD request B6-T5 R6).
    static func chatPreviewScript(named name: String) -> [ChatMessage] {
        if name == "mixed3" {
            return [chatPreviewMessage("cp-m1", sender: 1, "I can take notes today"),
                    chatPreviewMessage("cp-m2", sender: 2, "Same here, I have the agenda"),
                    chatPreviewMessage("cp-m3", sender: 0, "Can you share the deck?")]
        }
        return [chatPreviewMessage("cp-s1", sender: 0, "Can you share the deck?"),
                chatPreviewMessage("cp-s2", sender: 0, "The one from Tuesday"),
                chatPreviewMessage("cp-s3", sender: 0, "Thanks!")]
    }

    /// What the core posts for each message (`ChatPreviewPolicy.event`, R40-4); fixture ids are already canonical.
    static func chatPreviewEvents(_ messages: [ChatMessage]) -> [StageEvent] {
        var result: [StageEvent] = []
        for message in messages {
            result.append(ChatPreviewPolicy.event(message: message, canonicalSenderId: message.userId))
        }
        return result
    }

    /// The same messages as chat rows, so a tap on the preview opens Chat at a row that exists (S40 8 l1).
    static func chatPreviewInputs(_ messages: [ChatMessage]) -> ChatInputs {
        var rows: [ChatMessageInput] = []
        for message in messages {
            rows.append(ChatMessageInput.make(id: message.id, senderId: message.userId, senderName: message.displayName,
                                              content: message.content, timestampMillis: message.timestamp.timeIntervalSince1970 * 1000.0,
                                              isDirect: message.isDirect, dmTargetUserId: message.dmTargetUserId ?? "",
                                              dmTargetName: message.dmTargetDisplayName ?? "",
                                              imageURL: message.image?.url ?? "", imageFileName: message.image?.fileName ?? ""))
        }
        var roster: [ChatRosterEntry] = [ChatRosterEntry(userId: localUserId, name: "You", isPresent: true)]
        var index = 0
        while index < chatPreviewNames.count {
            roster.append(ChatRosterEntry(userId: remoteId(index), name: chatPreviewNames[index], isPresent: true))
            index += 1
        }
        return ChatInputs.make(callSession: 1, roomId: roomLabel, localUserId: localUserId, localName: "You", messages: rows,
                               gate: ChatSendGate.open, roster: roster)
    }

    /// Three people join in a row: one toast for the first, then "Ben and 1 other joined" coalesced (S20 10 f).
    static func joinBurst() -> [StageEvent] {
        [StageEvent.make(kind: StageEventKind.userJoined, userId: "j1", name: "Avery Lee"),
         StageEvent.make(kind: StageEventKind.userJoined, userId: "j2", name: "Ben"),
         StageEvent.make(kind: StageEventKind.userJoined, userId: "j3", name: "Cai")]
    }

    /// Caption screenshot states hold their line instead of hiding it after 6 s of silence.
    static func holdsCaption(_ state: StageFixtureState) -> Bool {
        state == StageFixtureState.captionsLive || state == StageFixtureState.captionsPartial
            || state == StageFixtureState.captionsAttendee
    }

    /// The scripted caption line per state (S60 5 b): a final line, a partial line, or none (the quiet placeholder).
    static func captionLine(_ state: StageFixtureState) -> CaptionLine? {
        switch state {
        case .captionsLive, .captionsAttendee:
            return CaptionLine(speakerName: remoteName(0), text: "so the deck is ready for review", isFinal: true,
                               updatedAtMillis: 0, isVisible: true)
        case .captionsPartial:
            return CaptionLine(speakerName: "Sam", text: "and then we probably need to dec", isFinal: false, updatedAtMillis: 0,
                               isVisible: true)
        default:
            return nil
        }
    }

    /// The roles sweep (S20 2 l4): one id (yours) moves through grid, rail, spotlight main, floating and minimized while
    /// its slot id and renderer stay the same.
    static let rolesSweepStepCount = 5

    static func rolesSweepStep(_ step: Int) -> StageInputs {
        switch step % rolesSweepStepCount {
        case 0:
            return copy(base(count: 3, localCameraOn: true), selfViewMode: "tile")
        case 1:
            return copy(base(count: 3, localCameraOn: true), viewMode: "spotlight", selfViewMode: "tile")
        case 2:
            return copy(base(count: 3, localCameraOn: true), viewMode: "spotlight", selfViewMode: "tile",
                        pinnedUserId: localUserId)
        case 3:
            return copy(base(count: 2, localCameraOn: true), selfViewMode: "floating")
        default:
            return copy(base(count: 2, localCameraOn: true), selfViewMode: "minimized")
        }
    }

    /// Who speaks in the fixture's speaker script: 20 changes over the visible remotes (S20 2 l3: zero layout changes
    /// while everyone fits).
    static func speakerScript(for state: StageFixtureState) -> [String] {
        let present = inputs(for: state).presentParticipants
        var remotes: [String] = []
        for participant in present {
            if !participant.isLocal { remotes.append(participant.userId) }
        }
        var result: [String] = []
        if remotes.isEmpty { return result }
        var index = 0
        while result.count < 20 {
            result.append(remotes[index % min(remotes.count, 4)])
            index += 1
        }
        return result
    }

    /// The last remote, hidden past the cap in grid-12 (the featured swap cell).
    static func hiddenSpeaker(for state: StageFixtureState) -> String {
        let count = inputs(for: state).presentParticipants.count
        return count > 1 ? remoteId(count - 2) : ""
    }

    /// `count` scripted reactions from alternating senders.
    static func reactions(count: Int) -> [StageReactionInput] {
        var result: [StageReactionInput] = []
        var index = 0
        while index < count {
            let emoji = MeetingReactionConstants.emojiOptions[index % MeetingReactionConstants.emojiOptions.count]
            result.append(StageReactionInput(sourceId: "fixture-" + String(index), senderName: index % 5 == 0 ? "" : remoteName(index),
                                             isLocal: index % 7 == 0, kind: "emoji", value: emoji, label: emoji))
            index += 1
        }
        return result
    }

    static func reactionCount(for state: StageFixtureState) -> Int {
        switch state {
        case .reactionsBurst25, .reactionsBurst40: return 25
        default: return 0
        }
    }

    /// One-field edits of fixture inputs (every field defaulted to the source's value).
    static func copy(_ source: StageInputs, participants: [StageParticipantInput]? = nil, viewMode: String? = nil,
                     hideTilesWithoutVideo: Bool? = nil, selfViewMode: String? = nil, pinnedUserId: String? = nil,
                     isGameActive: Bool? = nil, gameName: String? = nil, screenShareUserId: String? = nil,
                     isRoomLocked: Bool? = nil, captionsOn: Bool? = nil, liveNotes: LiveNotesState? = nil,
                     isAloneConfirmed: Bool? = nil, isHandRaised: Bool? = nil, handToggleInFlight: Bool? = nil,
                     isRecovering: Bool? = nil, isFrontCamera: Bool? = nil, isWebinarAttendee: Bool? = nil,
                     meetingLink: String? = nil, webinarSpeakerUserId: String? = nil, selfViewCorner: String? = nil,
                     isLocalScreenSharing: Bool? = nil, isFlipInFlight: Bool? = nil,
                     isCameraPaused: Bool? = nil, viewMaxTiles: Int? = nil) -> StageInputs {
        StageInputs.make(
            callSession: source.callSession, isInCall: source.isInCall, localUserId: source.localUserId,
            roomLabel: source.roomLabel, meetingLink: meetingLink ?? source.meetingLink,
            participants: participants ?? source.participants, viewMode: viewMode ?? source.viewMode,
            viewMaxTiles: viewMaxTiles ?? source.viewMaxTiles,
            hideTilesWithoutVideo: hideTilesWithoutVideo ?? source.hideTilesWithoutVideo,
            selfViewMode: selfViewMode ?? source.selfViewMode, selfViewCorner: selfViewCorner ?? source.selfViewCorner,
            pinnedUserId: pinnedUserId ?? source.pinnedUserId, activeAppId: source.activeAppId,
            activeAppName: source.activeAppName, isBrowserActive: source.isBrowserActive,
            isGameActive: isGameActive ?? source.isGameActive, gameName: gameName ?? source.gameName,
            screenShareUserId: screenShareUserId ?? source.screenShareUserId,
            isLocalScreenSharing: isLocalScreenSharing ?? source.isLocalScreenSharing,
            isWebinarAttendee: isWebinarAttendee ?? source.isWebinarAttendee,
            webinarSpeakerUserId: webinarSpeakerUserId ?? source.webinarSpeakerUserId,
            isRoomLocked: isRoomLocked ?? source.isRoomLocked,
            captionsOn: captionsOn ?? source.captionsOn, liveNotes: liveNotes ?? source.liveNotes,
            isAloneConfirmed: isAloneConfirmed ?? source.isAloneConfirmed, canFlipCamera: source.canFlipCamera,
            isFrontCamera: isFrontCamera ?? source.isFrontCamera, isFlipInFlight: isFlipInFlight ?? source.isFlipInFlight,
            isCameraPaused: isCameraPaused ?? source.isCameraPaused, routeKind: source.routeKind, routeName: source.routeName,
            isHandRaised: isHandRaised ?? source.isHandRaised,
            handToggleInFlight: handToggleInFlight ?? source.handToggleInFlight,
            isRecovering: isRecovering ?? source.isRecovering, isMediaPending: source.isMediaPending,
            joinedAtMillis: source.joinedAtMillis, alwaysShowControls: source.alwaysShowControls,
            isEffectsOpen: source.isEffectsOpen)
    }

    /// The S1 inputs that put the standalone shell in the call (or in recovery after admission). `unreadChatCount` is
    /// the scripted core's Chat badge count (CHT-8: the controls row a mounted bar reads).
    static func shellInputs(_ stage: StageInputs, isMuted: Bool, isCameraOff: Bool, unreadChatCount: Int = 0) -> MeetingShellInputs {
        MeetingShellInputs.make(
            identity: MeetingSessionIdentity(callSession: 1, attempt: 1, attemptToken: "stage-fixture"),
            connectionState: stage.isRecovering ? ConnectionState.reconnecting : ConnectionState.joined,
            isRecoveringConnection: stage.isRecovering,
            roomId: roomLabel,
            displayName: "You",
            // STG-6, STG-8: the host and attendee roles reach the S1 session too (Host Controls row, attendee bar).
            isAdmin: stage.participant(localUserId)?.isHost ?? false,
            isWebinarAttendee: stage.isWebinarAttendee,
            isMuted: isMuted,
            isCameraOff: isCameraOff,
            isHandRaised: stage.isHandRaised,
            unreadChatCount: unreadChatCount,
            handToggleInFlight: stage.handToggleInFlight
        )
    }
}

/// `stage.counters` (SL14). Plain, never observed: readouts refresh on demand so counting never perturbs the stage.
@MainActor
final class StageFixtureCounters {
    private(set) var toggleMicrophone = 0
    private(set) var minimize = 0
    private(set) var leave = 0
    private(set) var renderTargetResize = 0
    private(set) var generateWebinarLink = 0
    private(set) var commands: [String] = []
    /// STG-5: chimes that reached the fixture's recording output (never audio) and notice actions sent to the core.
    private(set) var chimes: [String] = []

    func recordMicrophone() { toggleMicrophone += 1 }
    func recordMinimize() { minimize += 1 }
    func recordLeave() { leave += 1 }
    func recordRenderTargetResize() { renderTargetResize += 1 }
    /// STG-6 (S20 15 l): every webinar link the fixture's stand-in for `HostControlsPresenter.ensureWebinarLink()` made.
    func recordGenerateWebinarLink() { generateWebinarLink += 1 }
    func recordChime(_ kind: String) { chimes.append(kind) }
    func recordCommand(_ name: String) {
        commands.append(name)
        if commands.count > 10 { commands.removeFirst() }
    }

    func summary(setViewport: Int) -> String {
        "toggleMicrophone=" + String(toggleMicrophone) + " minimize=" + String(minimize) + " leave=" + String(leave)
            + " setViewport=" + String(setViewport) + " renderTargetResize=" + String(renderTargetResize)
            + " generateWebinarLink=" + String(generateWebinarLink)
    }
}

/// One fixture run: the standalone presenters, the ledger and the scripted command handling, shared by the iOS and
/// Android fixture roots so both behave the same. Never touches `MeetingViewModel`.
@MainActor
final class StageFixtureSession {
    let state: StageFixtureState
    let pattern: RendererProbePattern
    let forceScreenReader: Bool
    let shell: MeetingShellPresenter
    let stage: StagePresenter
    /// STG-9, ACT-1, ACT-2: the fixture's activity presenters and the recording owner behind the `game.emits` readout.
    let activity: ActivitySession
    let activityOwner = ActivityFixtureOwner()
    /// SET-1 (L6-12, HD request B6-T2 R7): the Settings panel's fake media owner (`wp3.calls`), installed on the shell's
    /// Settings presenter with the host state.
    let settingsCore = SettingsRecordingCore()
    /// SET-6 (L6-12 `FakeEffectsEngine`): installed on the stage's Effects presenter for the `effects-*` states only, so
    /// every other state (and `effects-hidden`) keeps the panel and its entries hidden (OQ6 default A).
    let effectsEngine = FakeEffectsEngine()
    let renderers = RendererIdentityLedger()
    let counters = StageFixtureCounters()
    private(set) var inputs: StageInputs
    /// STG-6, STG-8: the scripted Meeting Details and attendee inputs (empty for the stage-only states).
    private(set) var details = StageDetailsInputs.make()
    private(set) var rolesSweepStep = 0
    /// CHT-8: the scripted core's Chat badge count (CH12 through `ChatPreviewPolicy.countsUnread`); 0 once Chat opens.
    private(set) var unreadChatCount = 0
    private var captionStep = 0
    private var isMuted = true
    private var isCameraOff = true
    /// SET-5: the scripted Audio Only switch (S60 3 l5), applied through the notice inputs like the core does.
    private(set) var isAudioOnly = false

    /// `initialInputs` replaces the state's scripted stage inputs (fixtures layered on the stage, such as People, pass
    /// their own roster); the notice, event and caption scripts still follow `state`.
    init(state: StageFixtureState, pattern: RendererProbePattern = RendererProbePattern.staticPattern,
         forceScreenReader: Bool = false, initialInputs: StageInputs? = nil) {
        self.state = state
        self.pattern = pattern
        self.forceScreenReader = forceScreenReader
        let owner = MeetingShellPresenter()
        shell = owner
        let stagePresenter = StagePresenter(shell: owner)
        stage = stagePresenter
        activity = ActivitySession(shell: owner, stage: stagePresenter)
        inputs = initialInputs ?? StageFixtureScript.inputs(for: state)
        let local = inputs.participant(StageFixtureScript.localUserId)
        isMuted = local?.isMuted ?? true
        isCameraOff = local?.isCameraOff ?? true
        shell.onCommand = { [weak self] command, ticket in
            self?.handle(command, ticket: ticket)
        }
        stage.onCommand = { [weak self] command in
            self?.handle(command)
        }
        shell.panels.onSnapshotChanged = { [weak self] in
            self?.stage.panelSnapshotChanged()
            self?.chatPanelSnapshotChanged()
        }
        settingsCore.install(on: shell.settings)
        shell.settings.apply(SettingsFixtureState.host.inputs())
        if StageFixtureScript.holdsCaption(state) {
            // Screenshot states keep their caption line; `captions-quiet` keeps the real 6 s silence rule.
            stage.captions.sleep = { _ in try? await Task.sleep(nanoseconds: 3_600_000_000_000) }
        }
        if inputs.isRecovering {
            // Admission first, so the recovery keeps the stage (S10 0.4).
            shell.apply(StageFixtureScript.shellInputs(StageFixtureScript.copy(inputs, isRecovering: false), isMuted: isMuted,
                                                       isCameraOff: isCameraOff))
        }
        shell.apply(StageFixtureScript.shellInputs(inputs, isMuted: isMuted, isCameraOff: isCameraOff))
        stage.apply(inputs)
        activity.bindStage()
        ActivityFixtureScript.apply(named: state.rawValue, session: activity, owner: activityOwner)
        if state == StageFixtureState.nowPlaying {
            stage.setShowsVideoOverActivity(true)
        }
        let reactionCount = StageFixtureScript.reactionCount(for: state)
        if reactionCount > 0 {
            stage.reactionsChanged(StageFixtureScript.reactions(count: reactionCount))
        }
        // STG-5: notice sounds reach a recording output only (no audio in any silent run); notice actions are counted.
        let counters = self.counters
        stage.sounds.output = { kind in counters.recordChime(kind) }
        stage.onNoticeCommand = { command in counters.recordCommand("notice:" + command.actionId) }
        // CHT-8: the device's "Show Chat Previews" never changes a fixture; `chat-previews-off` scripts it off.
        let previewsOn = state != StageFixtureState.chatPreviewsOff
        stage.chatPreviewsEnabled = { previewsOn }
        if let notices = StageFixtureScript.noticeInputs(state) {
            stage.applyNotices(notices)
        }
        let chatMessages = StageFixtureScript.chatPreviewMessages(state)
        if !chatMessages.isEmpty {
            shell.chat.apply(StageFixtureScript.chatPreviewInputs(chatMessages), change: ChatInputChange.messages)
        }
        for event in StageFixtureScript.noticeEvents(state) {
            stage.post(event)
        }
        countChatArrivals(chatMessages)
        if let line = StageFixtureScript.captionLine(state) {
            stage.captionChanged(line)
        }
        // STG-6, STG-8: the Meeting Details and attendee inputs, then the capsule tap for the Meeting Details states.
        if let details = StageFixtureScript.detailsInputs(state) {
            self.details = details
            stage.applyDetails(details)
        }
        if StageFixtureScript.opensMeetingInfo(state) {
            stage.openMeetingInfo()
        }
        // SET-5 (S60 3 l): the Layout panel's scripted core commits each change into the stage inputs, so selecting
        // Spotlight changes the fixture stage kind while the renderers stay (3 l2).
        isAudioOnly = StageFixtureScript.noticeInputs(state)?.isAudioOnly ?? false
        stage.layoutPanel.onCommand = { [weak self] command in
            self?.handleLayout(command)
        }
        // SET-6 (S60 4 l): the fake engine publishes the panel for the Effects states; Turn On for Everyone is one S1
        // camera intent through the shell (4 l4).
        if let effects = StageFixtureScript.effectsState(state) {
            effectsEngine.onTurnCameraOn = { [weak self] in
                _ = self?.shell.toggleCamera()
            }
            effectsEngine.install(on: stage.effects, isPreparing: effects.isPreparing)
            stage.effects.apply(effects.inputs())
        }
        if let panel = StageFixtureScript.opensPanel(state) {
            shell.panels.present(panel, from: PanelInvoker.call)
        }
    }

    // MARK: Layout and Effects scripts (SET-5, SET-6)

    /// `layout.calls`: the Layout presenter's dispatched intents, in order.
    func layoutCallsReadout() -> String { stage.layoutPanel.callsReadout() }

    /// `wp10.calls` and `wp3.calls` of the fake engine (L6-12).
    func effectsCallsReadout() -> String {
        "wp10=" + effectsEngine.callsReadout() + " wp3=" + effectsEngine.mediaCallsReadout()
    }

    /// The Layout panel's scripted core: each intent edits the stage inputs (or the notice inputs for Audio Only).
    private func handleLayout(_ command: LayoutPanelCommand) {
        counters.recordCommand("layout:" + command.kind.rawValue)
        switch command.kind {
        case .setViewMode:
            inputs = StageFixtureScript.copy(inputs, viewMode: command.value)
            stage.apply(inputs)
        case .setViewMaxTiles:
            inputs = StageFixtureScript.copy(inputs, viewMaxTiles: command.number)
            stage.apply(inputs)
        case .setHideTilesWithoutVideo:
            inputs = StageFixtureScript.copy(inputs, hideTilesWithoutVideo: command.flag)
            stage.apply(inputs)
        case .setSelfViewMode:
            inputs = StageFixtureScript.copy(inputs, selfViewMode: command.value)
            stage.apply(inputs)
        case .setSelfViewCorner:
            inputs = StageFixtureScript.copy(inputs, selfViewCorner: command.value)
            stage.apply(inputs)
        case .setAudioOnly:
            // Turning Audio Only off never turns the camera back on (S60 3 l5); turning it on turns it off.
            isAudioOnly = command.flag
            if command.flag && !isCameraOff {
                isCameraOff = true
                replaceLocal()
            }
            stage.applyNotices(StageFixtureScript.noticeBase(isAudioOnly: isAudioOnly))
            stage.effects.apply(stage.effects.inputs.withAudioOnly(isAudioOnly))
        }
    }

    // MARK: Meeting Details scripts (STG-6)

    /// The fixture's stand-in for the S50 `HostControlsPresenter.ensureWebinarLink()` (RECONCILE R34): counts each
    /// generation (`generateWebinarLink` in `stage.counters`), publishes the link like the server ack would, and returns
    /// an existing link without generating again. The fixture roots pass it to `CallRoot` (HD request B5-T2 R4).
    func ensureWebinarLink() async -> String? {
        if !details.webinarLinkURL.isEmpty { return details.webinarLinkURL }
        counters.recordGenerateWebinarLink()
        details = StageDetailsInputs.make(callSession: details.callSession, roomCode: details.roomCode,
                                          requiresInviteCode: details.requiresInviteCode,
                                          isWebinarEnabled: details.isWebinarEnabled,
                                          isWebinarPublicAccess: details.isWebinarPublicAccess,
                                          webinarLinkURL: StageFixtureScript.webinarLink, webinarTitle: details.webinarTitle,
                                          webinarAttendeeCount: details.webinarAttendeeCount,
                                          isWebinarQaEnabled: details.isWebinarQaEnabled, webinarQaUnseen: details.webinarQaUnseen,
                                          attendeeCanRaiseHand: details.attendeeCanRaiseHand,
                                          connectionQuality: details.connectionQuality,
                                          connectionHasSample: details.connectionHasSample,
                                          connectionStatsFailed: details.connectionStatsFailed)
        stage.applyDetails(details)
        return StageFixtureScript.webinarLink
    }

    /// The "scripted lock while open" cell (S20 15 l): toggles the room lock; Meeting Details shows it at once.
    func toggleRoomLock() {
        inputs = StageFixtureScript.copy(inputs, isRoomLocked: !inputs.isRoomLocked)
        stage.apply(inputs)
    }

    /// The `meetingInfo` readout: the row ids in order plus the connection label, or "none" while the panel is closed.
    func meetingInfoReadout() -> String {
        guard let info = stage.meetingInfo else { return "none" }
        return "rows=" + MeetingInfoPolicy.rowIds(info).joined(separator: ",") + " connection=" + info.connection.rawValue
    }

    /// The `attendee` readout: the state, the feed and inset, the waiting count and the Q&A badge.
    func attendeeReadout() -> String {
        guard let viewer = stage.attendee else { return "none" }
        return "state=" + viewer.state + " feed=" + viewer.feedUserId + (viewer.isShareFeed ? ":share" : "") + " inset="
            + viewer.insetUserId + " waiting=" + String(viewer.waitingCount) + " qa=" + String(viewer.webinarQaUnseen)
    }

    // MARK: Notice scripts (STG-5, TRN-1)

    /// Posts the three-join burst (coalescing cell).
    func postJoinBurst() {
        for event in StageFixtureScript.joinBurst() {
            stage.post(event)
        }
    }

    /// What the toast host does when the shown toast leaves.
    func dismissCurrentToast() {
        if let current = stage.toast {
            stage.dismissNotice(id: current.id)
        }
    }

    /// Opens or closes the compact sheet suspension (RECONCILE R3 cell) without a real panel.
    func toggleToastSuspension() {
        stage.setToastLaneSuspended(!stage.notices.isToastLaneSuspended)
    }

    /// A new caption line (cycles final and partial text).
    func nextCaption() {
        captionStep += 1
        let partial = captionStep % 2 == 1
        stage.captionChanged(CaptionLine(speakerName: StageFixtureScript.remoteName(captionStep % 4),
                                         text: partial ? "and then we probably need to" : "so the deck is ready for review",
                                         isFinal: !partial, updatedAtMillis: 0, isVisible: true))
    }

    func noticesReadout() -> String { stage.noticesReadout() }

    // MARK: Chat preview scripts (CHT-8)

    /// `previews:sameSender3` and `previews:mixed3` (S40 0.9): three remote messages arrive together; the chat rows
    /// are added first, so the preview's tap opens Chat at a row that exists.
    func postChatPreviewScript(named name: String) {
        let messages = StageFixtureScript.chatPreviewScript(named: name)
        var all: [ChatMessage] = StageFixtureScript.chatPreviewMessages(state)
        for message in messages {
            var known = false
            for existing in all {
                if existing.id == message.id { known = true }
            }
            if !known { all.append(message) }
        }
        shell.chat.apply(StageFixtureScript.chatPreviewInputs(all), change: ChatInputChange.messages)
        for event in StageFixtureScript.chatPreviewEvents(messages) {
            stage.post(event)
        }
        countChatArrivals(messages)
    }

    /// `chat.preview`: the shown preview plus the scripted badge count.
    func chatPreviewReadout() -> String {
        stage.chatPreviewReadout() + " unread=" + String(unreadChatCount) + " dropped=" + String(stage.notices.droppedToasts)
    }

    // MARK: Settings readouts (SET-1, L6-12; HD request B6-T2 R7)

    /// `wp3.calls`: the fake media owner's recorded commands, in order ("none" before the first).
    func settingsCallsReadout() -> String {
        settingsCore.calls.isEmpty ? "none" : settingsCore.calls.joined(separator: ",")
    }

    /// `stats.polls` (SET-3, S60 2 l3; HD request B7-T3 R7): the Connection details' polls while the page is visible.
    func statsPollsReadout() -> String { String(shell.settings.stats.pollCount) }

    /// `wp3.ceiling` (SET-3, S60 2 l4; HD request B7-T3 R7): the last publish ceiling the fake media owner received.
    func publishCeilingReadout() -> String {
        guard let ceiling = settingsCore.lastPublishCeiling else { return "none" }
        return String(ceiling.width) + "x" + String(ceiling.height) + "@" + String(ceiling.frameRate) + "/"
            + String(ceiling.maxBitrateBps)
    }

    /// `speakerTest.count`: test tones the Settings presenter asked for.
    func speakerTestReadout() -> String { String(shell.settings.speakerTestCount) }

    /// `voicePreview.count`: voice previews the Settings presenter started.
    func voicePreviewReadout() -> String { String(shell.settings.voicePreviewCount) }

    /// CH12 for the scripted arrivals: what the core adds to the badge (Chat current or an attendee adds nothing).
    private func countChatArrivals(_ messages: [ChatMessage]) {
        if messages.isEmpty { return }
        let chatCurrent = shell.panels.snapshot.current?.panel == MeetingPanel.chat
        var added = 0
        for message in messages {
            if ChatPreviewPolicy.countsUnread(isOwn: message.userId == StageFixtureScript.localUserId, isHiddenSender: false,
                                              isEmptyAssistantStart: false, isChatCurrent: chatCurrent,
                                              isAttendee: inputs.isWebinarAttendee) {
                added += 1
            }
        }
        if added == 0 { return }
        unreadChatCount += added
        applyShell()
    }

    /// The scripted core's CC5: opening Chat resets the badge (the notice center already drops the previews).
    private func chatPanelSnapshotChanged() {
        if shell.panels.snapshot.current?.panel != MeetingPanel.chat || unreadChatCount == 0 { return }
        unreadChatCount = 0
        applyShell()
    }

    private func applyShell() {
        shell.apply(StageFixtureScript.shellInputs(inputs, isMuted: isMuted, isCameraOff: isCameraOff,
                                                   unreadChatCount: unreadChatCount))
    }

    func captionsReadout() -> String {
        let line = stage.captions.line
        return "active=" + (stage.captionsActive ? "1" : "0") + " visible=" + (line.isVisible ? "1" : "0") + " final="
            + (line.isFinal ? "1" : "0") + " updates=" + String(stage.captions.publishCount)
    }

    /// The Magic Tap closure and its fixture button (S20 1 l4): exactly the same call.
    func magicTap() {
        shell.toggleMicrophone()
    }

    /// Android Back with no panel (S20 1 l3): counted, never a leave.
    func minimize() {
        counters.recordMinimize()
    }

    /// 20 scripted speaker changes over the visible remotes at the injected clock.
    func runSpeakerScript() {
        var at = stage.now()
        for id in StageFixtureScript.speakerScript(for: state) {
            stage.speakerChanged(id, atMillis: at)
            at += 300.0
        }
    }

    /// The featured-swap cell: a hidden participant starts speaking now; the promotion task decides in real time.
    func speakHiddenParticipant() {
        stage.speakerChanged(StageFixtureScript.hiddenSpeaker(for: state), atMillis: stage.now())
    }

    func nextRolesSweepStep() {
        rolesSweepStep += 1
        inputs = StageFixtureScript.rolesSweepStep(rolesSweepStep)
        stage.apply(inputs)
    }

    func replayReactions() {
        stage.reactionsChanged([])
        stage.reactionsChanged(StageFixtureScript.reactions(count: max(1, StageFixtureScript.reactionCount(for: state))))
    }

    /// `stage.fixture.reconnect`: toggles r2 between reconnecting and back (S20 3 c "Back Online").
    func toggleReconnecting() {
        let reconnecting = !(inputs.participant(StageFixtureScript.remoteId(1))?.isReconnecting ?? false)
        inputs = StageFixtureScript.reconnectingStep(reconnecting)
        stage.apply(inputs)
    }

    /// `game.emits`: the game shell's emits and the launcher's commands, recorded by the fixture owner.
    func activityReadout() -> String {
        "game.emits=" + activityOwner.emitsReadout() + " activities=" + activityOwner.commandsReadout()
    }

    // MARK: Readouts (outside the stage subtree, PS 7.6)

    func renderersReadout() -> String { renderers.summary() }

    func layoutReadout() -> String { stage.layoutReadout() }

    func countersReadout() -> String { counters.summary(setViewport: stage.viewportChangeCount) }

    func announcementsReadout() -> String {
        stage.announcementLog.isEmpty ? "none" : stage.announcementLog.joined(separator: " | ")
    }

    func panelReadout() -> String {
        guard let current = shell.panels.snapshot.current else { return "none" }
        return "panel=" + current.panel.rawValue + " invoker=" + current.invoker.rawValue + " destination=" + current.destination.rawValue
    }

    func recomposeReadout() -> String { renderers.compositionSummary() }

    func chromeReadout() -> String {
        "blocker=" + stage.autoHideBlocker.rawValue + " transient=" + stage.transientChromeSummary
    }

    // MARK: Scripted core

    private func handle(_ command: MeetingShellCommand, ticket: MeetingActionTicket?) {
        switch command {
        case .toggleMicrophone:
            counters.recordMicrophone()
            isMuted = !isMuted
            replaceLocal()
        case .toggleCamera:
            isCameraOff = !isCameraOff
            replaceLocal()
        case .toggleHand:
            let raised = !inputs.isHandRaised
            inputs = StageFixtureScript.copy(inputs, isHandRaised: raised, handToggleInFlight: false)
            replaceLocal()
            if let ticket = ticket {
                _ = shell.finish(ticket, MeetingActionResult.completed)
            }
        case .leave:
            counters.recordLeave()
        default:
            counters.recordCommand(command.rawValue)
        }
    }

    private func handle(_ command: StageCommand) {
        counters.recordCommand(command.kind.rawValue)
        switch command.kind {
        case .togglePin:
            let next = inputs.pinnedUserId == command.userId ? "" : command.userId
            inputs = StageFixtureScript.copy(inputs, pinnedUserId: next)
            stage.apply(inputs)
        case .clearPin:
            inputs = StageFixtureScript.copy(inputs, pinnedUserId: "")
            stage.apply(inputs)
        case .setSelfViewMode:
            inputs = StageFixtureScript.copy(inputs, selfViewMode: command.value)
            stage.apply(inputs)
        case .moveSelfView:
            counters.recordCommand("corner:" + command.value)
            // STG-3: the scripted core commits the corner like the view model, so the drag snap and Move run here.
            inputs = StageFixtureScript.copy(inputs, selfViewCorner: command.value)
            stage.apply(inputs)
        case .flipCamera:
            inputs = StageFixtureScript.copy(inputs, isFrontCamera: !inputs.isFrontCamera)
            stage.apply(inputs)
        }
    }

    /// Rewrites your roster row from the scripted mic, camera and hand, then pushes both presenters.
    private func replaceLocal() {
        var roster: [StageParticipantInput] = []
        for participant in inputs.participants {
            if participant.isLocal {
                roster.append(StageParticipantInput.make(userId: participant.userId, displayName: participant.displayName,
                                                         isLocal: true, isMuted: isMuted, isCameraOff: isCameraOff,
                                                         isHandRaised: inputs.isHandRaised, joinSerial: participant.joinSerial,
                                                         videoKey: isCameraOff ? "" : "probe:" + participant.userId))
            } else {
                roster.append(participant)
            }
        }
        inputs = StageFixtureScript.copy(inputs, participants: roster)
        applyShell()
        stage.apply(inputs)
    }
}
