import Foundation
import Observation
#if canImport(ReplayKit)
import ReplayKit
#endif

enum MeetingEntryAction: Equatable {
    case new
    case join
}

enum MeetingEntryOverlayPolicy {
    static let safetyTimeoutSeconds: TimeInterval = 12.0
    static let safetyTimeoutNanoseconds = UInt64(12_000_000_000)

    static func canCover(connectionState: ConnectionState) -> Bool {
        switch connectionState {
        case .connecting, .connected, .joining, .joined:
            return true
        case .disconnected, .reconnecting, .waiting, .error:
            return false
        }
    }

    static func shouldClearMeetingEntry(on connectionState: ConnectionState) -> Bool {
        !canCover(connectionState: connectionState)
    }

    static func shouldShow(
        isEnteringMeeting: Bool,
        startedAt: Date?,
        now: Date,
        connectionState: ConnectionState
    ) -> Bool {
        guard isEnteringMeeting,
              canCover(connectionState: connectionState),
              let startedAt else {
            return false
        }
        return now.timeIntervalSince(startedAt) < safetyTimeoutSeconds
    }
}

struct MeetingGridSnapshot {
    let userIds: [String]
    let hiddenParticipantCount: Int
    let includesLocalParticipant: Bool
    let shouldShowDetachedSelfView: Bool

    var tileCount: Int {
        max(1, userIds.count)
    }
}

struct MeetingTileStripSnapshot {
    let shouldShowSelfTile: Bool
    let participants: [Participant]
}

struct MeetingSpotlightSnapshot {
    let pinnedUserId: String
    let railUserIds: [String]
    let usesSidebarRail: Bool

    var hasRailTiles: Bool {
        !railUserIds.isEmpty
    }
}

struct PendingUserRow: Identifiable, Equatable {
    let id: String
    let displayName: String
}

enum PendingUserRowsPolicy {
    static func sortedRows(from users: [String: String]) -> [PendingUserRow] {
        users
            .map { PendingUserRow(id: $0.key, displayName: $0.value) }
            .sorted { lhs, rhs in
                let leftName = lhs.displayName.lowercased()
                let rightName = rhs.displayName.lowercased()

                if leftName == rightName {
                    return lhs.id < rhs.id
                }

                return leftName < rightName
            }
    }
}

@MainActor
@Observable
final class MeetingState {
    /// WP2-S1 E2: the view model's single shell hook. Every field the shell presenter and `CallPresence` read
    /// (contract-wp2-first-slice 3.2 inputs table) calls it from its `didSet`; chat arrays, the active speaker,
    /// connection quality and other high-frequency fields never do. The view model installs exactly one closure and
    /// rebinds it when `state` is replaced.
    @ObservationIgnored var onShellInputChanged: (() -> Void)? = nil
    /// S20 SC1 E1: the stage's own refresh hooks, separate from S1, so an S1-only change never builds stage inputs
    /// and a stage-only change is never missed. The view model installs one closure each (`bindStageInputs()`).
    @ObservationIgnored var onStageInputChanged: (() -> Void)? = nil
    /// S30 CC1 (CTL-1): the controls refresh path's own hook, called only from fields S1 does not hook (S1-hooked fields
    /// reach the controls through the shell refresh). The view model binds it to `requestControlsRefresh()`.
    @ObservationIgnored var onControlsInputChanged: (() -> Void)? = nil
    /// S50 PH1: People's own refresh hook, separate from S1, the stage and the controls, so a People-only change never
    /// builds stage inputs and a speaker change, an audio level or a reaction never builds People inputs. The view
    /// model installs one closure (`bindPeopleInputs()`). Connection fields refresh People through the S1 publish.
    @ObservationIgnored var onPeopleInputChanged: (() -> Void)? = nil
    /// S50 PH1 (PPL-4): the Host Controls path (policies, access lists, webinar config), separate from People rows, so
    /// a policy or list change never rebuilds People and a roster change never rebuilds Host Controls. The view model
    /// binds it to `requestHostControlsRefresh()`.
    @ObservationIgnored var onHostInputChanged: (() -> Void)? = nil
    /// SC1 E5: the active or TTS speaker changed (hot; writes only the speaking store and the order policy).
    @ObservationIgnored var onStageSpeakerChanged: (() -> Void)? = nil
    /// Hot: the active reactions changed (writes only the reaction layer).
    @ObservationIgnored var onStageReactionsChanged: (() -> Void)? = nil
    /// SC1 E4: a game push; the view model refreshes the stage only when presence changes.
    @ObservationIgnored var onStageGameChanged: (() -> Void)? = nil
    /// S60 7 (ACT-1): the launcher's own refresh hook (catalog, vote, apps, browser, role, connection), separate from
    /// S1, the stage and chat. The view model installs one closure (`bindActivityInputs()`).
    @ObservationIgnored var onActivityInputChanged: (() -> Void)? = nil
    /// S60 8 (ACT-2): a game push or identity change for the game shell (parsed once per push).
    @ObservationIgnored var onActivityGameChanged: (() -> Void)? = nil
    /// S50 PH7 (PPL-6): the Q&A presenter's own refresh hook (entries, Q&A state, the unseen counters), separate from
    /// People rows, so a vote never rebuilds People and a roster change never rebuilds Q&A. The view model binds it to
    /// `requestQaRefresh()`.
    @ObservationIgnored var onQaInputChanged: (() -> Void)? = nil
    /// S40 CH13: the chat presenter's own refresh hook, separate from S1 and the stage, with a change hint so changes
    /// that touch no messages skip the message diff. The view model installs one closure (`bindChatInputs()`).
    @ObservationIgnored var onChatInputChanged: ((ChatInputChange) -> Void)? = nil
    /// S40 0.5: bumped by every `chatMessages` and `systemMessages` write (diagnostics; never observed).
    @ObservationIgnored private(set) var chatRevision = 0

    // Connection State
    var connectionState: ConnectionState = .disconnected {
        didSet {
            PerformanceDiagnostics.state("connectionState", old: "\(oldValue)", new: "\(connectionState)")
            onShellInputChanged?()
            onChatInputChanged?(ChatInputChange.gate)
            onActivityInputChanged?()
            onActivityGameChanged?()
        }
    }
    /// True from the first established-call interruption until replacement
    /// transports and media are ready. Unlike `connectionState`, this remains
    /// true while a reconnect-driven join is in `.joining`, so the UI does not
    /// lose its notice or disable local media intent halfway through recovery.
    var isRecoveringConnection: Bool = false {
        didSet {
            guard oldValue != isRecoveringConnection else { return }
            PerformanceDiagnostics.state(
                "isRecoveringConnection",
                old: "\(oldValue)",
                new: "\(isRecoveringConnection)"
            )
            onShellInputChanged?()
            onStageInputChanged?()
            onChatInputChanged?(ChatInputChange.gate)
            onActivityInputChanged?()
            onActivityGameChanged?()
        }
    }
    /// True while a connected call is moving through an expected app
    /// background/foreground transition. Transport recovery may briefly run,
    /// but it should not be presented as a user-facing outage.
    var isResumingFromBackground: Bool = false {
        didSet { onShellInputChanged?(); onStageInputChanged?() }
    }
    var errorMessage: String?
    var joinFormErrorMessage: String? = nil {
        didSet { onShellInputChanged?() }
    }
    var meetingEndedNoticeMessage: String? = nil {
        didSet { onShellInputChanged?() }
    }
    var serverRestartNotice: String? = nil {
        didSet { onShellInputChanged?(); onStageInputChanged?() }
    }
    var adminNoticeMessage: String? {
        didSet { onStageInputChanged?() }
    }
    var adminNoticeLevel: AdminNoticeLevel = .info {
        didSet { onStageInputChanged?() }
    }
    var isNetworkOffline: Bool = false {
        didSet { onShellInputChanged?(); onStageInputChanged?(); onChatInputChanged?(ChatInputChange.gate) }
    }
    /// SYS-6 (S70 SY22, 6 d; S20 10 f banner 2): Android only. The active network reports a captive portal and is not
    /// validated, so the banner lane shows "This Wi-Fi network needs you to sign in." instead of offline. iOS has no
    /// such signal and never sets it.
    var isCaptivePortal: Bool = false {
        didSet { if oldValue != isCaptivePortal { onStageInputChanged?() } }
    }
    var waitingMessage: String? = nil {
        didSet { onShellInputChanged?() }
    }
    /// WP2-S1 E1: the typed terminal outcome of the current call session, recorded before each terminal phase write
    /// (the legacy `errorMessage` and notice strings are unchanged).
    var terminalOutcome: MeetingTerminalOutcome? = nil {
        didSet { onShellInputChanged?() }
    }

    // Meeting-entry takeover: a branded Lottie overlay that covers connect →
    // join → media-settle so the user never sees the raw join spinner or the
    // post-join device-init hiccups. Set true on New/Join, cleared only once the
    // meeting is fully ready (see MeetingViewModel.scheduleMeetingEntryReveal).
    var isEnteringMeeting: Bool = false {
        didSet {
            PerformanceDiagnostics.state("isEnteringMeeting", old: "\(oldValue)", new: "\(isEnteringMeeting)")
            onShellInputChanged?()
        }
    }
    var meetingEntryAction: MeetingEntryAction? = nil {
        didSet { onShellInputChanged?() }
    }
    var meetingEntryStartedAt: Date?
    var meetingEntryGeneration: Int = 0

    // Room State
    var roomId: String = "" {
        didSet { onShellInputChanged?(); onStageInputChanged?(); onPeopleInputChanged?() }
    }
    var isRoomLocked: Bool = false {
        didSet { onStageInputChanged?(); onControlsInputChanged?(); onPeopleInputChanged?(); onHostInputChanged?() }
    }
    var isChatLocked: Bool = false {
        didSet { onChatInputChanged?(ChatInputChange.policy); onHostInputChanged?() }
    }
    var isNoGuests: Bool = false {
        didSet { onPeopleInputChanged?(); onHostInputChanged?() }
    }
    /// S50 3 f: Send Private Message follows it, so People refreshes too.
    var isDmEnabled: Bool = true {
        didSet { onChatInputChanged?(ChatInputChange.policy); onPeopleInputChanged?(); onHostInputChanged?() }
    }
    var isImageAttachmentsEnabled: Bool = true {
        didSet { onChatInputChanged?(ChatInputChange.policy); onHostInputChanged?() }
    }
    /// S50 PH5 (`participantMediaPermissionsChanged`): non-hosts may unmute or turn on video; the bar reads them as
    /// `isMicDisabledByHost` / `isCameraDisabledByHost` (S30 CC10).
    var isParticipantUnmuteAllowed: Bool = true {
        didSet { onControlsInputChanged?(); onHostInputChanged?() }
    }
    var isParticipantVideoAllowed: Bool = true {
        didSet { onControlsInputChanged?(); onHostInputChanged?() }
    }
    // True while a picked chat image is uploading to the asset store.
    var isChatImageUploading: Bool = false
    /// S40 CH6 (CHT-4): the native composer's photo (prepare, upload, ready, failed); only the chat presenter reads it.
    var chatAttachment: ChatAttachmentState = ChatAttachmentState.none {
        didSet {
            if oldValue != chatAttachment { onChatInputChanged?(ChatInputChange.attachment) }
        }
    }
    var isTtsDisabled: Bool = false {
        didSet { onChatInputChanged?(ChatInputChange.policy); onHostInputChanged?() }
    }
    var isReactionsDisabled: Bool = false {
        didSet { onShellInputChanged?(); onChatInputChanged?(ChatInputChange.policy); onHostInputChanged?() }
    }
    var meetingRequiresInviteCode: Bool = false {
        didSet { onStageInputChanged?(); onHostInputChanged?() }
    }
    var adminAllowedUserKeys: [String] = [] {
        didSet { onHostInputChanged?() }
    }
    var adminLockedAllowedUserKeys: [String] = [] {
        didSet { onHostInputChanged?() }
    }
    var adminBlockedUserKeys: [String] = [] {
        didSet { onHostInputChanged?() }
    }
    var isAdminAccessListRefreshing: Bool = false {
        didSet { onHostInputChanged?() }
    }

    // Webinar State
    /// S50 PH9: mutable after the join (a promotion or demotion rejoins with the new role).
    var webinarRole: String? = nil {
        didSet {
            onShellInputChanged?(); onStageInputChanged?(); onChatInputChanged?(ChatInputChange.gate); onPeopleInputChanged?()
            onQaInputChanged?()
        }
    }
    var isWebinarEnabled: Bool = false {
        didSet { onStageInputChanged?(); onControlsInputChanged?(); onPeopleInputChanged?(); onHostInputChanged?(); onQaInputChanged?() }
    }
    var isWebinarPublicAccess: Bool = false {
        didSet { onStageInputChanged?(); onPeopleInputChanged?(); onHostInputChanged?() }
    }
    var isWebinarLocked: Bool = false {
        didSet { onHostInputChanged?() }
    }
    var webinarRequiresInviteCode: Bool = false {
        didSet { onHostInputChanged?() }
    }
    var webinarAttendeeCount: Int = 0 {
        didSet { onStageInputChanged?(); onPeopleInputChanged?(); onHostInputChanged?() }
    }
    var webinarMaxAttendees: Int = 500 {
        didSet { onHostInputChanged?() }
    }
    var webinarLinkSlug: String? {
        didSet { onHostInputChanged?() }
    }
    var webinarLinkURL: String? {
        didSet { onStageInputChanged?(); onPeopleInputChanged?(); onHostInputChanged?() }
    }
    var webinarFeedMode: String = "active-speaker" {
        didSet { onStageInputChanged?() }
    }
    /// S50 PH10 (PPL-5): Attendee Q&A, from the join ack and `webinar:configChanged`; the host toggles it in Webinar
    /// Settings. People (the Q&A row), Host Controls (the switch), the stage (the attendee badge), the controls (the
    /// attendee Q&A control) and Q&A read it.
    var isWebinarQaEnabled: Bool = false {
        didSet {
            onStageInputChanged?(); onControlsInputChanged?(); onPeopleInputChanged?(); onHostInputChanged?()
            onQaInputChanged?()
        }
    }
    /// S50 PH8 (PPL-5): the attendee hand queue as the SFU last sent it to admins (the whole queue per change,
    /// webinarNotifications.ts:166-174), and whether one arrived this call session (false for a host promoted
    /// mid-webinar until the next change, S50 10 f).
    var webinarHandQueue: [WebinarHandQueueEntry] = [] {
        didSet { onPeopleInputChanged?() }
    }
    var webinarHandQueueReceived: Bool = false {
        didSet { onPeopleInputChanged?() }
    }
    /// S50 PH9 interim (Q15): attendees invited on stage from this device in this call session, queue userId to name.
    var webinarStageInvites: [String: String] = [:] {
        didSet { onPeopleInputChanged?() }
    }
    /// S50 PH7 (PPL-6): Q&A entries by id (the presenter orders them), the first-snapshot flag, the viewer's own votes
    /// (change events carry no per-viewer vote, webinarNotifications.ts) and the two unseen counters (RECONCILE R18:
    /// attendees count questions newly answering or answered, hosts new pending questions, since the last close).
    var webinarQaEntries: [String: WebinarQaEntry] = [:] {
        didSet { onQaInputChanged?() }
    }
    var isWebinarQaSnapshotReceived: Bool = false {
        didSet { onQaInputChanged?() }
    }
    var webinarQaVotes: [String: Bool] = [:] {
        didSet { onQaInputChanged?() }
    }
    var webinarQaUnseenAttendee: Int = 0 {
        didSet { onQaInputChanged?(); onStageInputChanged?(); onControlsInputChanged?() }
    }
    var webinarQaUnseenHost: Int = 0 {
        didSet { onQaInputChanged?(); onControlsInputChanged?() }
    }
    var webinarSpeakerUserId: String? {
        didSet { onStageInputChanged?() }
    }
    /// S20 SC22 (WP7, STG-8): the webinar landing title for the attendee capsule and Webinar Details; empty selects
    /// the "Webinar" fallback. Set by the webinar landing before the join (HD request B5-T2 R3); cleared only by
    /// `cleanup()` (a join's live snapshot reset keeps it).
    var webinarTitle: String = "" {
        didSet { onStageInputChanged?() }
    }

    // User State
    var userId: String {
        didSet { onStageInputChanged?(); onChatInputChanged?(ChatInputChange.roster); onPeopleInputChanged?() }
    }
    var sfuUserId: String? {
        didSet { onStageInputChanged?(); onChatInputChanged?(ChatInputChange.roster); onPeopleInputChanged?() }
    }
    var sessionId: String
    var displayName: String = "" {
        didSet { onShellInputChanged?(); onStageInputChanged?(); onChatInputChanged?(ChatInputChange.roster); onPeopleInputChanged?() }
    }
    var isAdmin: Bool = false {
        didSet {
            onQaInputChanged?()
            onShellInputChanged?(); onStageInputChanged?(); onChatInputChanged?(ChatInputChange.gate); onPeopleInputChanged?()
            // S60 7, 8 (ACT-1, ACT-2): the launcher's and the game shell's host flag.
            onActivityInputChanged?(); onActivityGameChanged?()
            // S50 PH11 (INM D5): waiting requests, access lists, the attendee hand queue and the interim stage invites
            // (PH8, PH9) go with the host role, so no stale waiting badge (Participants control, More row) and no stale
            // list remains after losing host. The host Q&A counter goes too (RECONCILE R18).
            if oldValue && !isAdmin { clearHostOnlyState() }
        }
    }

    private func clearHostOnlyState() {
        if !pendingUsers.isEmpty { pendingUsers = [:] }
        if !adminAllowedUserKeys.isEmpty { adminAllowedUserKeys = [] }
        if !adminLockedAllowedUserKeys.isEmpty { adminLockedAllowedUserKeys = [] }
        if !adminBlockedUserKeys.isEmpty { adminBlockedUserKeys = [] }
        if !webinarHandQueue.isEmpty { webinarHandQueue = [] }
        if webinarHandQueueReceived { webinarHandQueueReceived = false }
        if !webinarStageInvites.isEmpty { webinarStageInvites = [:] }
        if webinarQaUnseenHost != 0 { webinarQaUnseenHost = 0 }
    }

    /// S50 PH7, PH8, PH9: the webinar role, Q&A and hand queue state of one call session, cleared together on a fresh
    /// join and on cleanup (the counters and invites never carry into another session).
    func resetWebinarInteractionState() {
        if !webinarHandQueue.isEmpty { webinarHandQueue = [] }
        if webinarHandQueueReceived { webinarHandQueueReceived = false }
        if !webinarStageInvites.isEmpty { webinarStageInvites = [:] }
        if !webinarQaEntries.isEmpty { webinarQaEntries = [:] }
        if isWebinarQaSnapshotReceived { isWebinarQaSnapshotReceived = false }
        if !webinarQaVotes.isEmpty { webinarQaVotes = [:] }
        if webinarQaUnseenAttendee != 0 { webinarQaUnseenAttendee = 0 }
        if webinarQaUnseenHost != 0 { webinarQaUnseenHost = 0 }
    }
    var hostUserId: String? {
        didSet { onPeopleInputChanged?() }
    }
    var hostUserIds: [String] = [] {
        didSet { onStageInputChanged?(); onPeopleInputChanged?() }
    }

    // Participants
    var participants: [String: Participant] = [:] {
        didSet {
            if oldValue.count != participants.count {
                PerformanceDiagnostics.state("participants.count", old: "\(oldValue.count)", new: "\(participants.count)")
            }
            onShellInputChanged?()
            onStageInputChanged?()
            // The view model rebuilds the derived chat roster and applies only when ids or names changed (CH13), so a
            // mute, camera or hand update refreshes no chat.
            onChatInputChanged?(ChatInputChange.roster)
            onPeopleInputChanged?()
        }
    }
    /// S50 PH19 (RECONCILE R20): join order keyed by canonical id, assigned at first presence, kept across recovery
    /// rejoins, reset per call session and on leave; read by the stage (`makeStageInputs()`) and People. The stage
    /// assigns no serials of its own.
    var participantJoinSerials: [String: Int] = [:]
    private var nextParticipantJoinSerial = 0

    /// Assigns the next serial the first time `canonicalId` is present; later calls keep it.
    func assignParticipantJoinSerial(_ canonicalId: String) {
        guard !canonicalId.isEmpty, participantJoinSerials[canonicalId] == nil else { return }
        nextParticipantJoinSerial += 1
        participantJoinSerials[canonicalId] = nextParticipantJoinSerial
    }

    func resetParticipantJoinSerials() {
        participantJoinSerials = [:]
        nextParticipantJoinSerial = 0
    }

    /// S50 PH13: user keys by participant id from the admin snapshot (`AdminRoomParticipantSnapshot.userKey`), so
    /// "Remove and Block" blocks the right key; `userKey(for:)` is the fallback. Reset per call session.
    var participantUserKeys: [String: String] = [:] {
        didSet { onPeopleInputChanged?() }
    }

    /// PH13: the key the SFU blocks by for `id`: the admin snapshot's key, else the part before "#".
    func userKey(for id: String) -> String {
        let normalized = id.trimmingCharacters(in: .whitespacesAndNewlines)
        if let known = participantUserKeys[normalized], !known.isEmpty { return known }
        return Self.userKeyPart(for: normalized)
    }
    var displayNames: [String: String] = [:] {
        didSet { onStageInputChanged?(); onChatInputChanged?(ChatInputChange.roster); onPeopleInputChanged?() }
    }
    var pendingUsers: [String: String] = [:] {
        didSet {
            pendingUserRows = PendingUserRowsPolicy.sortedRows(from: pendingUsers)
            onShellInputChanged?()
            onStageInputChanged?()
            onPeopleInputChanged?()
        }
    }
    private(set) var pendingUserRows: [PendingUserRow] = []
    var hasInitialPresenceSnapshot: Bool = false {
        didSet { onStageInputChanged?(); onPeopleInputChanged?() }
    }

    // Media State
    var isMuted: Bool = true {
        didSet { onShellInputChanged?(); onStageInputChanged?(); onPeopleInputChanged?() }
    }
    var isCameraOff: Bool = true {
        didSet { onShellInputChanged?(); onStageInputChanged?(); onPeopleInputChanged?() }
    }
    /// S20 SC8, S60 C6-2 (STG-3): your camera facing, owned by `LocalPreviewController` and mirrored here once per change.
    var localCameraFacing: LocalCameraFacing = .front {
        didSet { onStageInputChanged?() }
    }
    /// S20 6 f (STG-3): the system holds your camera right now (`LocalPreviewController.callCameraInterruption`).
    var isLocalCameraPaused: Bool = false {
        didSet { onStageInputChanged?() }
    }
    /// S10 0.8 C1 (ENT-3): the lobby's media intent while the join is in flight; `.joined` reconciles it once.
    var pendingEntryMediaIntent: EntryMediaIntent? = nil
    var isAudioOnlyMode: Bool = false {
        didSet { onShellInputChanged?(); onStageInputChanged?() }
    }
    var isScreenSharing: Bool = false {
        didSet { onShellInputChanged?(); onStageInputChanged?(); onPeopleInputChanged?() }
    }
    var isHandRaised: Bool = false {
        didSet { onShellInputChanged?(); onStageInputChanged?(); onPeopleInputChanged?() }
    }
    var videoQuality: VideoQuality = .standard
    var connectionQuality: ConnectionQuality = .unknown {
        didSet { onStageInputChanged?() }
    }
    // Selected audio routes (mic input / speaker output). nil = follow the
    // platform default. Mirrors the web client's device pickers.
    var selectedAudioInputId: String?
    var selectedAudioOutputId: String?
    /// S10 0.8 C2 (ENT-3): the lobby's route intent (an AudioRouteKind raw value and an input id), kept for display;
    /// the routing owner applies it once when call audio starts.
    var prejoinAudioOutputKind = ""
    var prejoinAudioInputId = ""

    // Shared Browser
    var isBrowserActive: Bool = false {
        didSet { onStageInputChanged?(); onControlsInputChanged?(); onActivityInputChanged?() }
    }
    var isBrowserLaunching: Bool = false {
        didSet { onActivityInputChanged?() }
    }
    var hasBrowserAudio: Bool = false {
        didSet { onActivityInputChanged?() }
    }
    var isBrowserAudioMuted: Bool = false {
        didSet { onActivityInputChanged?() }
    }
    var browserURL: String? {
        didSet { onActivityInputChanged?() }
    }
    var browserNoVncURL: String?
    var browserControllerUserId: String? {
        didSet { onActivityInputChanged?() }
    }
    var isBrowserNavigating: Bool = false {
        didSet { onActivityInputChanged?() }
    }
    var browserProvider: String? {
        didSet { onActivityInputChanged?() }
    }

    // Apps Runtime
    var activeAppId: String? {
        didSet { onStageInputChanged?(); onControlsInputChanged?(); onActivityInputChanged?() }
    }
    var isAppsLocked: Bool = false {
        didSet { onActivityInputChanged?() }
    }
    var isAppsActionInFlight: Bool = false {
        didSet { onActivityInputChanged?() }
    }
    /// S60 0.8 C6-18 (ACT-7): Yjs and awareness bytes live in the non-observable `ActiveAppSession`, never here (a
    /// cursor flood publishes nothing). This coarse flag flips at most once per app session, when room data first
    /// arrives, for the legacy placeholder's "Synced with room" line (HD request B7-T1 R3).
    var activeAppHasRoomData: Bool = false

    // Games
    var gameCatalog: [GameCatalogEntry] = [] {
        didSet { onActivityInputChanged?() }
    }
    var gamePublicState: GamePublicState? {
        didSet { onStageGameChanged?() }
    }
    var gamePlayerView: GamePlayerViewNotification? {
        didSet { onActivityGameChanged?() }
    }
    var gameVote: GameVoteState? {
        didSet { onControlsInputChanged?(); onActivityInputChanged?() }
    }
    /// The server's canonical id for you from `game:snapshot` / `game:getState` (`selfId`, C6-15); nil until sent.
    var gameSelfId: String? = nil {
        didSet { onActivityGameChanged?() }
    }
    var isGameActionInFlight: Bool = false
    var gameErrorMessage: String?
    // End-game arming lives in meeting state, not view @State: the stage
    // chrome can be rebuilt by game pushes mid-arm, which would silently
    // swallow the confirmation tap.
    var isGameEndArmed: Bool = false

    // Active States
    var activeScreenShareUserId: String? = nil {
        didSet { onShellInputChanged?(); onStageInputChanged?() }
    }
    var activeSpeakerId: String? {
        didSet {
            PerformanceDiagnostics.state("activeSpeakerId", old: oldValue ?? "nil", new: activeSpeakerId ?? "nil")
            onStageSpeakerChanged?()
        }
    }
    var ttsSpeakerId: String? {
        didSet { onStageSpeakerChanged?() }
    }
    /// S40 CH4: the message id the speaker is playing ("" when idle); only the chat's voice rows read it (CHT-6).
    var activeTtsMessageId: String = "" {
        didSet {
            if oldValue != activeTtsMessageId { onChatInputChanged?(ChatInputChange.playback) }
        }
    }
    // Locally-pinned participant → spotlight stage (not synced; mirrors web's
    // per-tile pin). nil = grid.
    /// S50 3 f: People offers Pin or Unpin from it.
    var pinnedUserId: String? {
        didSet { onStageInputChanged?(); onPeopleInputChanged?() }
    }
    var viewMode: MeetingViewMode = .auto {
        didSet { onStageInputChanged?(); onControlsInputChanged?() }
    }
    var viewMaxTiles: Int = MeetingViewConstants.defaultMaxTiles {
        didSet { onStageInputChanged?() }
    }
    var hideTilesWithoutVideo: Bool = false {
        didSet { onStageInputChanged?() }
    }
    var selfViewMode: MeetingSelfViewMode = .auto {
        didSet { onStageInputChanged?() }
    }
    var selfViewCorner: MeetingSelfViewCorner = .bottomRight {
        didSet { onStageInputChanged?() }
    }

    // Chat
    var chatMessages: [ChatMessage] = [] {
        didSet {
            if oldValue.count != chatMessages.count {
                PerformanceDiagnostics.state("chatMessages.count", old: "\(oldValue.count)", new: "\(chatMessages.count)")
            }
            chatRevision += 1
            onChatInputChanged?(ChatInputChange.messages)
        }
    }
    var chatOverlayMessages: [ChatMessage] = [] {
        didSet {
            if oldValue.count != chatOverlayMessages.count {
                PerformanceDiagnostics.state("chatOverlayMessages.count", old: "\(oldValue.count)", new: "\(chatOverlayMessages.count)")
            }
        }
    }
    var systemMessages: [SystemMessage] = [] {
        didSet {
            if oldValue.count != systemMessages.count {
                PerformanceDiagnostics.state("systemMessages.count", old: "\(oldValue.count)", new: "\(systemMessages.count)")
            }
            chatRevision += 1
            onChatInputChanged?(ChatInputChange.messages)
        }
    }
    var unreadChatCount: Int = 0 {
        didSet { onShellInputChanged?() }
    }
    var isChatOpen: Bool = false {
        didSet {
            PerformanceDiagnostics.state("isChatOpen", old: "\(oldValue)", new: "\(isChatOpen)")
            onShellInputChanged?()
        }
    }
    var isTranscriptOpen: Bool = false {
        didSet {
            PerformanceDiagnostics.state("isTranscriptOpen", old: "\(oldValue)", new: "\(isTranscriptOpen)")
        }
    }

    // Reactions
    var activeReactions: [Reaction] = [] {
        didSet {
            if oldValue.count != activeReactions.count {
                PerformanceDiagnostics.state("activeReactions.count", old: "\(oldValue.count)", new: "\(activeReactions.count)")
            }
            onStageReactionsChanged?()
        }
    }

    init(userId: String = UUID().uuidString, sessionId: String = UUID().uuidString) {
        self.userId = userId
        self.sessionId = sessionId
    }

    static let browserAudioUserIdPrefix = "shared-browser:"
    static let browserVideoUserIdPrefix = "shared-browser-video:"
    static let voiceAgentUserIdPrefix = "voice-agent-"
    static let voiceAgentEmailSuffix = "@agent.conclave"
    static let overflowTileId = "__conclave_overflow__"

    static func isBrowserAudioUserId(_ userId: String) -> Bool {
        userId.hasPrefix(browserAudioUserIdPrefix)
    }

    static func isBrowserVideoUserId(_ userId: String) -> Bool {
        userId.hasPrefix(browserVideoUserIdPrefix)
    }

    static func isVoiceAgentUserId(_ userId: String) -> Bool {
        let normalized = userId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized.hasPrefix(voiceAgentUserIdPrefix) ||
            normalized.contains(voiceAgentEmailSuffix)
    }

    static func isConclaveAssistantUserId(_ userId: String) -> Bool {
        userId.trimmingCharacters(in: .whitespacesAndNewlines) == ConclaveAssistantChatIdentity.userId
    }

    static func isSystemUserId(_ userId: String) -> Bool {
        isBrowserAudioUserId(userId) || isBrowserVideoUserId(userId)
    }

    static func isSyntheticRosterUserId(_ userId: String) -> Bool {
        isSystemUserId(userId) || isVoiceAgentUserId(userId) || isConclaveAssistantUserId(userId)
    }

    static func systemDisplayName(for userId: String) -> String? {
        if isConclaveAssistantUserId(userId) {
            return ConclaveAssistantChatIdentity.displayName
        }
        if isVoiceAgentUserId(userId) {
            return "Voice Agent"
        }
        if isBrowserVideoUserId(userId) {
            return "Shared Browser"
        }
        if isBrowserAudioUserId(userId) {
            return "Shared Browser Audio"
        }
        return nil
    }

    func isLocalParticipantUserId(_ id: String) -> Bool {
        isLocalIdentityUserId(id)
    }

    func isLocalIdentityUserId(_ id: String) -> Bool {
        let normalized = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return false }
        if normalized == userId || normalized == sfuUserId {
            return true
        }
        guard !Self.hasSessionSuffix(normalized) else { return false }
        let localKeys = [userId, sfuUserId].compactMap { $0 }.map { Self.userKeyPart(for: $0) }
        let normalizedKey = Self.userKeyPart(for: normalized)
        return localKeys.contains(normalizedKey)
    }

    func hasLocalGamePlayer(in players: [GamePlayer]) -> Bool {
        players.contains { isLocalIdentityUserId($0.id) }
    }

    func localGameVoteId(in vote: GameVoteState) -> String? {
        for (userId, gameId) in vote.votes where isLocalIdentityUserId(userId) {
            return gameId
        }
        return nil
    }

    func isRemoteParticipantUserId(_ id: String) -> Bool {
        let normalized = id.trimmingCharacters(in: .whitespacesAndNewlines)
        return !normalized.isEmpty
            && !isLocalIdentityUserId(normalized)
            && !Self.isSyntheticRosterUserId(normalized)
            && normalized != Self.overflowTileId
    }

    var sortedParticipants: [Participant] {
        let speakerParticipantId = resolvedRemoteParticipantId(for: effectiveActiveSpeakerId)
        return uniqueRemoteParticipants
            .sorted { left, right in
                let leftIsSpeaker = participant(left, matches: speakerParticipantId)
                let rightIsSpeaker = participant(right, matches: speakerParticipantId)
                if leftIsSpeaker != rightIsSpeaker {
                    return leftIsSpeaker
                }

                let leftMediaPriority = participantMediaPriority(left)
                let rightMediaPriority = participantMediaPriority(right)
                if leftMediaPriority != rightMediaPriority {
                    return leftMediaPriority > rightMediaPriority
                }

                if left.isHandRaised != right.isHandRaised {
                    return left.isHandRaised
                }

                return left.id < right.id
            }
    }

    private var uniqueRemoteParticipants: [Participant] {
        var remotes: [Participant] = []
        for participant in participants.values.sorted(by: { $0.id < $1.id })
            where isRemoteParticipantUserId(participant.id) {
            guard let index = remotes.firstIndex(where: { Self.userIdsMatch($0.id, participant.id) }) else {
                remotes.append(participant)
                continue
            }
            remotes[index] = Self.mergedRemoteParticipant(remotes[index], participant)
        }
        return remotes
    }

    private nonisolated static func mergedRemoteParticipant(_ left: Participant, _ right: Participant) -> Participant {
        let preferredId = preferredRemoteParticipantId(left.id, right.id)
        let primary = preferredId == right.id ? right : left
        let secondary = preferredId == right.id ? left : right
        return Participant(
            id: preferredId,
            displayName: preferredDisplayName(primary.displayName, secondary.displayName),
            isMuted: left.isMuted && right.isMuted,
            isCameraOff: left.isCameraOff && right.isCameraOff,
            isHandRaised: left.isHandRaised || right.isHandRaised,
            isWebinarAttendee: left.isWebinarAttendee || right.isWebinarAttendee,
            isLeaving: left.isLeaving && right.isLeaving,
            isScreenSharing: left.isScreenSharing || right.isScreenSharing,
            connectionStatus: primary.connectionStatus ?? secondary.connectionStatus
        )
    }

    private nonisolated static func preferredRemoteParticipantId(_ left: String, _ right: String) -> String {
        let leftHasSession = hasSessionSuffix(left)
        let rightHasSession = hasSessionSuffix(right)
        if leftHasSession != rightHasSession {
            return leftHasSession ? left : right
        }
        return left <= right ? left : right
    }

    private nonisolated static func preferredDisplayName(_ first: String?, _ second: String?) -> String? {
        let firstName = normalizedDisplayName(first)
        let secondName = normalizedDisplayName(second)
        if let firstName, !isGenericGuestDisplayName(firstName) {
            return firstName
        }
        if let secondName, !isGenericGuestDisplayName(secondName) {
            return secondName
        }
        return firstName ?? secondName
    }

    private func participantMediaPriority(_ participant: Participant) -> Int {
        if participant.isScreenSharing || !participant.isCameraOff {
            return 2
        }
        if !participant.isMuted {
            return 1
        }
        return 0
    }

    var presentParticipants: [Participant] {
        visibilityContext().presentParticipants
    }

    var participantCount: Int {
        var count = 1
        for participant in uniqueRemoteParticipants where !participant.isLeaving {
            count += 1
        }
        return count
    }

    var visibleTileParticipants: [Participant] {
        visibilityContext().visibleTileParticipants
    }

    private struct ParticipantVisibilityContext {
        let presentParticipants: [Participant]
        let visibleTileParticipants: [Participant]
        let resolvedSelfViewMode: MeetingSelfViewMode
        let shouldShowSelfTile: Bool
    }

    private func visibilityContext() -> ParticipantVisibilityContext {
        let present = sortedParticipants.filter { !$0.isLeaving }
        let visible = visibleTileParticipants(from: present)
        let canDetachSelfView = !present.isEmpty || hasPresentationSurface
        let resolvedSelfViewMode: MeetingSelfViewMode
        if !canDetachSelfView {
            resolvedSelfViewMode = .tile
        } else if selfViewMode != .auto {
            resolvedSelfViewMode = selfViewMode
        } else if viewMode == .auto && present.count == 1 && !hasPresentationSurface {
            resolvedSelfViewMode = .floating
        } else {
            resolvedSelfViewMode = .tile
        }
        let shouldShowSelfTile = resolvedSelfViewMode == .tile || pinnedUserId.map(isLocalIdentityUserId) == true
        return ParticipantVisibilityContext(
            presentParticipants: present,
            visibleTileParticipants: visible,
            resolvedSelfViewMode: resolvedSelfViewMode,
            shouldShowSelfTile: shouldShowSelfTile
        )
    }

    private func visibleTileParticipants(from present: [Participant]) -> [Participant] {
        let speakerParticipantId = resolvedRemoteParticipantId(for: effectiveActiveSpeakerId)
        let pinnedParticipantId = resolvedRemoteParticipantId(for: pinnedUserId)
        let visible = present.filter { participant in
            guard hideTilesWithoutVideo else { return true }
            return !participant.isCameraOff ||
                participant.isScreenSharing ||
                self.participant(participant, matches: speakerParticipantId) ||
                self.participant(participant, matches: pinnedParticipantId)
        }
        if visible.isEmpty, let firstRemote = present.first {
            return [firstRemote]
        }
        return visible
    }

    var canDetachSelfView: Bool {
        let context = visibilityContext()
        return !context.presentParticipants.isEmpty || hasPresentationSurface
    }

    var resolvedSelfViewMode: MeetingSelfViewMode {
        visibilityContext().resolvedSelfViewMode
    }

    var shouldShowSelfTile: Bool {
        visibilityContext().shouldShowSelfTile
    }

    var shouldShowDetachedSelfView: Bool {
        resolvedSelfViewMode == .floating || resolvedSelfViewMode == .minimized
    }

    var visibleGridUserIds: [String] {
        visibleGridSnapshot().userIds
    }

    func visibleGridSnapshot() -> MeetingGridSnapshot {
        let context = visibilityContext()
        var ids: [String] = []
        if context.shouldShowSelfTile {
            ids.append(userId)
        }

        let capacity = MeetingViewConstants.clampTiles(viewMaxTiles)
        let remoteCapacity = max(0, capacity - ids.count)
        let visibleParticipants = context.visibleTileParticipants
        if visibleParticipants.count <= remoteCapacity {
            for participant in visibleParticipants {
                ids.append(participant.id)
            }
        } else if remoteCapacity == 1 {
            if let participant = visibleParticipants.first {
                ids.append(participant.id)
            }
        } else {
            let visibleRemoteCount = max(0, remoteCapacity - 1)
            for participant in visibleParticipants.prefix(visibleRemoteCount) {
                ids.append(participant.id)
            }
            ids.append(Self.overflowTileId)
        }
        if ids.isEmpty {
            ids.append(userId)
        }
        let clippedIds = Array(ids.prefix(capacity))
        let hiddenParticipantCount: Int
        if visibleParticipants.count > remoteCapacity {
            if remoteCapacity > 1 {
                hiddenParticipantCount = visibleParticipants.count - max(0, remoteCapacity - 1)
            } else {
                hiddenParticipantCount = max(0, visibleParticipants.count - remoteCapacity)
            }
        } else {
            hiddenParticipantCount = 0
        }
        return MeetingGridSnapshot(
            userIds: clippedIds,
            hiddenParticipantCount: hiddenParticipantCount,
            includesLocalParticipant: clippedIds.contains { isLocalIdentityUserId($0) },
            shouldShowDetachedSelfView: context.resolvedSelfViewMode == .floating ||
                context.resolvedSelfViewMode == .minimized
        )
    }

    var visibleGridIncludesLocalParticipant: Bool {
        visibleGridSnapshot().includesLocalParticipant
    }

    func participant(for id: String) -> Participant? {
        let normalized = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return nil }
        guard isRemoteParticipantUserId(normalized) else {
            return nil
        }

        if let participant = uniqueRemoteParticipants.first(where: { Self.userIdsMatch($0.id, normalized) }) {
            return participant
        }
        return participants[normalized]
    }

    private func resolvedRemoteParticipantId(for id: String?) -> String? {
        let normalized = id?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !normalized.isEmpty,
              !isLocalIdentityUserId(normalized) else { return nil }
        if let participant = participant(for: normalized) {
            return participant.id
        }
        return normalized
    }

    func presentRemoteParticipantId(for id: String?) -> String? {
        let normalized = id?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !normalized.isEmpty,
              !isLocalIdentityUserId(normalized),
              let participant = participant(for: normalized),
              isRemoteParticipantUserId(participant.id),
              !participant.isLeaving else { return nil }
        return participant.id
    }

    /// S20 SC1 E6 (0.5 identity rule): every id the stage receives is canonical. A local identity (`userId` or
    /// `sfuUserId`, with or without a session suffix) maps to `userId`; a remote id maps through
    /// `presentRemoteParticipantId(for:)` (suffixed and SFU ids resolve to the participant id); anything else is
    /// dropped, so slot ids, the tile stores and the visibility report always agree.
    func canonicalStageUserId(_ raw: String?) -> String? {
        let normalized = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !normalized.isEmpty else { return nil }
        if isLocalIdentityUserId(normalized) { return userId }
        if let remote = presentRemoteParticipantId(for: normalized) { return remote }
        if Self.hasSessionSuffix(normalized) {
            let localKeys = [userId, sfuUserId].compactMap { $0 }.map { Self.userKeyPart(for: $0) }
            if localKeys.contains(Self.userKeyPart(for: normalized)) { return userId }
        }
        return nil
    }

    private func participant(_ participant: Participant, matches resolvedId: String?) -> Bool {
        guard let resolvedId else { return false }
        return Self.userIdsMatch(participant.id, resolvedId)
    }

    var visibleGridTileCount: Int {
        visibleGridSnapshot().tileCount
    }

    var hiddenGridParticipantsCount: Int {
        visibleGridSnapshot().hiddenParticipantCount
    }

    /// `forceSelfTile` folds the local user into the strip regardless of the
    /// self-view mode. The game stage uses it so the self view never floats
    /// over a game's controls - during a game you're a player in the strip
    /// like everyone else.
    func tileStripSnapshot(forceSelfTile: Bool = false) -> MeetingTileStripSnapshot {
        let context = visibilityContext()
        let showSelfTile = context.shouldShowSelfTile || forceSelfTile
        let capacity = MeetingViewConstants.clampTiles(viewMaxTiles)
        let remoteLimit = max(0, capacity - (showSelfTile ? 1 : 0))
        return MeetingTileStripSnapshot(
            shouldShowSelfTile: showSelfTile,
            participants: Array(context.visibleTileParticipants.prefix(remoteLimit))
        )
    }

    func spotlightSnapshot() -> MeetingSpotlightSnapshot {
        let context = visibilityContext()
        let pinnedId = spotlightUserId ?? userId
        let usesSidebar = usesSidebarLayout
        let tileLimit = usesSidebar
            ? MeetingViewConstants.clampStageRailTiles(viewMaxTiles)
            : MeetingViewConstants.clampTiles(viewMaxTiles)
        var ids: [String] = []
        if !isLocalParticipantUserId(pinnedId) && context.shouldShowSelfTile {
            ids.append(userId)
        }
        for participant in context.visibleTileParticipants where participant.id != pinnedId {
            ids.append(participant.id)
        }
        return MeetingSpotlightSnapshot(
            pinnedUserId: pinnedId,
            railUserIds: Array(ids.prefix(max(0, tileLimit - 1))),
            usesSidebarRail: usesSidebar
        )
    }

    var resolvedViewMode: MeetingResolvedViewMode {
        if isWebinarAttendee {
            return renderableStageUserId(webinarSpeakerUserId) == nil ? .tiled : .spotlight
        }
        // S20 SC2: the pin is transient and no longer writes `viewMode`, so a renderable pin wins in every mode.
        if hasRenderablePinnedUser {
            return .spotlight
        }

        switch viewMode {
        case .auto:
            if hasRenderablePinnedUser || participantCount == 2 {
                return .spotlight
            }
            if participantCount <= MeetingViewConstants.autoTiledThreshold {
                return .tiled
            }
            return .sidebar
        case .tiled:
            return .tiled
        case .spotlight:
            return .spotlight
        case .sidebar:
            return .sidebar
        }
    }

    var usesSidebarLayout: Bool {
        resolvedViewMode == .sidebar
    }

    private var hasRenderablePinnedUser: Bool {
        renderableStageUserId(pinnedUserId) != nil
    }

    var pendingUsersCount: Int {
        pendingUsers.count
    }

    var hasActiveScreenShare: Bool {
        renderableScreenShareUserId != nil
    }

    var hasActiveRemoteScreenShare: Bool {
        hasActiveScreenShare && !isScreenSharing
    }

    var presentationScreenShareUserId: String? {
        renderableScreenShareUserId
    }

    var hasPresentationSurface: Bool {
        hasActiveScreenShare || activeAppId != nil || isBrowserActive
    }

    var isScreenShareSupported: Bool {
        #if os(iOS) && canImport(ReplayKit) && !SKIP
        return RPScreenRecorder.shared().isAvailable
        #elseif SKIP
        // Android: screen capture via MediaProjection (API 21+).
        return true
        #else
        return false
        #endif
    }

    var isWebinarAttendee: Bool {
        webinarRole == "attendee"
    }

    var mediaPublishingDisabled: Bool {
        isWebinarAttendee
    }

    var isWhiteboardActive: Bool {
        activeAppId == "whiteboard"
    }

    var activeAppName: String? {
        guard let activeAppId else { return nil }
        if activeAppId == "whiteboard" {
            return "Whiteboard"
        }
        if activeAppId == "dev-playground" {
            return "Dev playground"
        }
        return Self.fallbackAppName(for: activeAppId)
    }

    private nonisolated static func fallbackAppName(for appId: String) -> String {
        var words: [String] = []
        var currentWord = ""
        for character in appId {
            let value = String(character)
            if value == "-" || value == "_" || character.isWhitespace || character.isNewline {
                if !currentWord.isEmpty {
                    words.append(currentWord)
                    currentWord = ""
                }
            } else {
                currentWord += value
            }
        }
        if !currentWord.isEmpty {
            words.append(currentWord)
        }
        guard !words.isEmpty else { return appId }

        return words
            .map { word in
                let lowercased = word.lowercased()
                return lowercased.prefix(1).uppercased() + lowercased.dropFirst()
            }
            .joined(separator: " ")
    }

    var spotlightUserId: String? {
        if isWebinarAttendee, let webinarSpeakerUserId = renderableStageUserId(webinarSpeakerUserId) {
            return webinarSpeakerUserId
        }
        if let pinnedUserId = renderableStageUserId(pinnedUserId) {
            return pinnedUserId
        }
        guard resolvedViewMode != .tiled else { return nil }
        return preferredStageUserId
    }

    private func renderableStageUserId(_ userId: String?) -> String? {
        let normalized = userId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !normalized.isEmpty else { return nil }
        if isLocalParticipantUserId(normalized) {
            return self.userId
        }
        guard let participant = participant(for: normalized),
              isRemoteParticipantUserId(participant.id),
              !participant.isLeaving else { return nil }
        return participant.id
    }

    private var renderableScreenShareUserId: String? {
        let normalized = activeScreenShareUserId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !normalized.isEmpty else { return nil }
        if isLocalIdentityUserId(normalized) {
            return isScreenSharing ? userId : nil
        }
        guard let participant = participant(for: normalized),
              isRemoteParticipantUserId(participant.id),
              !participant.isLeaving,
              participant.isScreenSharing else { return nil }
        return participant.id
    }

    var usesSpotlightLayout: Bool {
        resolvedViewMode != .tiled
    }

    private var preferredStageUserId: String {
        if let speakerId = effectiveActiveSpeakerId {
            if isLocalParticipantUserId(speakerId), !isCameraOff {
                return userId
            }
            if let participant = participant(for: speakerId),
               isRemoteParticipantUserId(participant.id),
               !participant.isLeaving,
               !participant.isCameraOff {
                return participant.id
            }
        }
        return visibleTileParticipants.first?.id ?? presentParticipants.first?.id ?? userId
    }

    var effectiveActiveSpeakerId: String? {
        ttsSpeakerId ?? activeSpeakerId
    }

    func isEffectiveActiveSpeaker(_ id: String) -> Bool {
        let normalized = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty,
              let speakerId = effectiveActiveSpeakerId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !speakerId.isEmpty else {
            return false
        }

        if isLocalIdentityUserId(normalized) || isLocalIdentityUserId(speakerId) {
            return isLocalIdentityUserId(normalized) && isLocalIdentityUserId(speakerId)
        }

        if let participant = participant(for: speakerId) {
            return Self.userIdsMatch(participant.id, normalized)
        }

        return Self.userIdsMatch(speakerId, normalized)
    }

    func isPinnedParticipant(_ id: String) -> Bool {
        let normalized = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty,
              let pinnedUserId = pinnedUserId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !pinnedUserId.isEmpty else {
            return false
        }

        if isLocalIdentityUserId(normalized) || isLocalIdentityUserId(pinnedUserId) {
            return isLocalIdentityUserId(normalized) && isLocalIdentityUserId(pinnedUserId)
        }

        if let participant = participant(for: pinnedUserId) {
            return Self.userIdsMatch(participant.id, normalized)
        }

        return Self.userIdsMatch(pinnedUserId, normalized)
    }

    /// The join's SFU client id (VM `joinRoom`); "" or the default tenant writes no `?clientId=` (ENT-8, RECONCILE R50).
    var meetingClientId = ""

    var meetingLink: String {
        Self.meetingLink(for: roomId, clientId: meetingClientId)
    }

    static func meetingLink(for roomId: String) -> String {
        MeetingLinkBuilder.url(roomCode: roomId, clientId: nil)
    }

    static func meetingLink(for roomId: String, clientId: String?) -> String {
        MeetingLinkBuilder.url(roomCode: roomId, clientId: clientId)
    }

    func displayName(for id: String) -> String {
        MeetingDisplayNamePresentation.formatted(rawDisplayName(for: id))
    }

    /// S40 3 f: the full name for chat headers, labels and reactors (never cut to two words; the header truncates
    /// at one line with the full name in the accessibility label).
    func chatDisplayName(for id: String) -> String {
        rawDisplayName(for: id).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// S50 2 j: remote participants with duplicate sessions merged (muted only if every session is, hand if any, the
    /// `mergedRemoteParticipant` rules), for `makePeopleInputs()`. People's full names use `chatDisplayName(for:)`
    /// (the same full-name rule, HD request B4-T7 R1e).
    var mergedRemoteParticipants: [Participant] {
        uniqueRemoteParticipants
    }

    private func rawDisplayName(for id: String) -> String {
        let normalized = id.trimmingCharacters(in: .whitespacesAndNewlines)
        if isLocalIdentityUserId(normalized) {
            return displayName.isEmpty ? "You" : displayName
        }
        if let systemName = Self.systemDisplayName(for: normalized) {
            return systemName
        }
        let exactSnapshotName = Self.normalizedDisplayName(displayNames[normalized])
        if let displayName = exactSnapshotName,
           !Self.isGenericGuestDisplayName(displayName) {
            return displayName
        }
        let exactParticipantName = Self.normalizedDisplayName(participants[normalized]?.displayName)
        if let displayName = exactParticipantName,
           !Self.isGenericGuestDisplayName(displayName) {
            return displayName
        }
        let aliasName = aliasedDisplayName(for: normalized)
        if let displayName = aliasName,
           !Self.isGenericGuestDisplayName(displayName) {
            return displayName
        }
        let fallbackName = Self.fallbackDisplayName(for: normalized)
        if let displayName = exactSnapshotName {
            return Self.shouldUseGenericDisplayName(displayName)
                ? displayName
                : fallbackName
        }
        if let displayName = exactParticipantName {
            return Self.shouldUseGenericDisplayName(displayName)
                ? displayName
                : fallbackName
        }
        if let displayName = aliasName {
            return Self.shouldUseGenericDisplayName(displayName)
                ? displayName
                : fallbackName
        }
        return fallbackName
    }

    private func aliasedDisplayName(for userId: String) -> String? {
        let userKey = Self.userKeyPart(for: userId)
        guard !userKey.isEmpty else { return nil }
        var fallbackName: String?
        for (candidateId, name) in displayNames {
            guard Self.userKeyPart(for: candidateId) == userKey else { continue }
            guard let displayName = Self.normalizedDisplayName(name) else { continue }
            if !Self.isGenericGuestDisplayName(displayName) {
                return displayName
            }
            fallbackName = fallbackName ?? displayName
        }
        for (candidateId, participant) in participants {
            guard Self.userKeyPart(for: candidateId) == userKey else { continue }
            guard let displayName = Self.normalizedDisplayName(participant.displayName) else { continue }
            if !Self.isGenericGuestDisplayName(displayName) {
                return displayName
            }
            fallbackName = fallbackName ?? displayName
        }
        return fallbackName
    }

    private nonisolated static func normalizedDisplayName(_ value: String?) -> String? {
        let displayName = NativeDisplayNameNormalizer.normalize(value)
        return displayName.isEmpty ? nil : displayName
    }

    private nonisolated static func isGenericGuestDisplayName(_ value: String) -> Bool {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else { return true }
        if normalized == "guest" ||
            normalized == "unknown" ||
            normalized == "participant" ||
            normalized == "anonymous" {
            return true
        }
        if normalized.hasPrefix("guest ") {
            let suffix = normalized.dropFirst("guest ".count).trimmingCharacters(in: .whitespacesAndNewlines)
            if let first = suffix.first, "0123456789".contains(first) {
                return true
            }
        }
        if normalized.hasPrefix("guest-") {
            return true
        }
        return normalized.hasSuffix("@guest.conclave") || normalized.hasSuffix("@guest.com")
    }

    private nonisolated static func shouldUseGenericDisplayName(_ value: String) -> Bool {
        !isGenericGuestDisplayName(value)
    }

    nonisolated static func mediaFallbackDisplayName(_ displayName: String?, userId: String) -> String {
        let normalizedName = normalizedDisplayName(displayName)
        if let normalizedName,
           !isGenericGuestDisplayName(normalizedName) {
            return normalizedName
        }

        let normalizedUserId = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        let trackOwnerId = normalizedUserId.hasSuffix("-screen")
            ? String(normalizedUserId.dropLast("-screen".count))
            : normalizedUserId
        let fallbackName = fallbackDisplayName(for: trackOwnerId)
        return fallbackName
    }

    nonisolated static func fallbackDisplayName(for userId: String) -> String {
        let normalized = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return "Guest" }

        let withoutInstanceSuffix = userKeyPart(for: normalized)
        if withoutInstanceSuffix.hasPrefix("guest-") {
            return "Guest"
        }
        let handle = withoutInstanceSuffix.components(separatedBy: "@").first ?? withoutInstanceSuffix
        let allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        var rawWords: [String] = []
        var currentWord = ""
        for character in handle {
            if allowed.contains(character) {
                currentWord += String(character)
            } else if !currentWord.isEmpty {
                rawWords.append(currentWord)
                currentWord = ""
                if rawWords.count >= 2 { break }
            }
        }
        if rawWords.count < 2, !currentWord.isEmpty {
            rawWords.append(currentWord)
        }
        if !rawWords.isEmpty {
            var formattedWords: [String] = []
            for word in rawWords.prefix(2) {
                formattedWords.append(word.prefix(1).uppercased() + word.dropFirst().lowercased())
            }
            return formattedWords.joined(separator: " ")
        }

        return handle.isEmpty ? normalized : handle
    }

    private nonisolated static func userKeyPart(for userId: String) -> String {
        let normalized = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.components(separatedBy: "#").first ?? normalized
    }

    private nonisolated static func hasSessionSuffix(_ userId: String) -> Bool {
        userId.contains("#")
    }

    private nonisolated static func userIdsMatch(_ lhs: String, _ rhs: String) -> Bool {
        let left = lhs.trimmingCharacters(in: .whitespacesAndNewlines)
        let right = rhs.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !left.isEmpty, !right.isEmpty else { return false }
        if left == right { return true }
        guard userKeyPart(for: left) == userKeyPart(for: right) else { return false }
        return !left.contains("#") || !right.contains("#")
    }

    func isHostUser(_ id: String) -> Bool {
        let normalized = id.trimmingCharacters(in: .whitespacesAndNewlines)
        let localIds = [userId, sfuUserId].compactMap { $0 }
        let isLocalIdentity = isLocalIdentityUserId(normalized)
        if !hostUserIds.isEmpty {
            return hostUserIds.contains { Self.userIdsMatch($0, normalized) }
                || (isLocalIdentity && localIds.contains { localId in
                    hostUserIds.contains { Self.userIdsMatch($0, localId) }
                })
        }
        if let hostUserId {
            return Self.userIdsMatch(hostUserId, normalized)
                || (isLocalIdentity && localIds.contains { Self.userIdsMatch(hostUserId, $0) })
        }
        return isAdmin && isLocalIdentity
    }

    func canPromoteHost(userId: String) -> Bool {
        let normalized = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isAdmin,
              !isWebinarAttendee,
              !normalized.isEmpty,
              !isHostUser(normalized) else {
            return false
        }
        guard let participant = participant(for: normalized) else {
            return true
        }
        return !participant.isWebinarAttendee
    }
}
