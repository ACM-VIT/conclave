import Foundation
import Observation

/// What a pushed premeeting page opens: the parsed or generated target, kept by route id so a lobby, a webinar
/// landing and a retry keep the link's invite codes, client id and room creation rule (S10 invariant 3). Recents
/// never store invite codes (Q4), so targets built from a recent row carry none.
struct PremeetingRouteTarget: Equatable {
    let routeId: Int
    let kind: PremeetingRouteKind
    let intent: LobbyIntent
    let roomId: String
    let title: String
    let joinMode: JoinMode
    let meetingInviteCode: String?
    let webinarInviteCode: String?
    let clientId: String?
    let allowRoomCreation: Bool

    var route: PremeetingRoute { PremeetingRoute(id: routeId, kind: kind, roomId: roomId) }
}

/// ENT-1 and ENT-2: the one app-scoped premeeting presenter (S10 0.5). Owned by the app container (the view model,
/// so it survives calls) or built standalone by the L9 fixture; the roots take it as a parameter and never read a
/// static presenter. Fed by pushed inputs exactly like the S1 shell (`apply(_:)`, equality-guarded publishing, no
/// self-observation: SkipModel has no `withObservationTracking`). Mute and camera intent are never stored here.
///
/// Published separately so a leaf observes only what it draws: `path` and the sheet flags (the root), `home` (Home),
/// `root` (the 0.4 call branch), the six lobby snapshots (ENT-3: `lobbyMedia` for the card, `lobbyStatus` for the
/// bottom block, `lobbyPresence`, `lobbyIdentity`, `lobbyLink`, `lobbyAudio`), `outcome`, `switchPrompt` and
/// `feedbackState`. The lobby reaches the core, media and the network only through `lobbyHooks`.
@MainActor
@Observable
final class PremeetingPresenter {
    private(set) var path: [PremeetingRoute] = []
    private(set) var home: HomeSnapshot = HomeSnapshot.empty
    private(set) var root: PremeetingRootDecision = PremeetingRootDecision.home
    private(set) var lobbyStatus: LobbyStatusSnapshot? = nil
    /// ENT-3 (S10 0.5): the other five lobby snapshots, each observed by one leaf.
    private(set) var lobbyMedia: LobbyMediaSnapshot? = nil
    private(set) var lobbyPresence: LobbyPresenceSnapshot? = nil
    private(set) var lobbyIdentity: LobbyIdentitySnapshot? = nil
    private(set) var lobbyLink: LobbyLinkSnapshot? = nil
    private(set) var lobbyAudio: LobbyAudioSnapshot? = nil
    private(set) var outcome: OutcomeModel? = nil
    /// ENT-9 (S10 12 j): the webinar landing on top, observed by the landing alone; nil when no landing is on top.
    private(set) var webinar: WebinarLandingSnapshot? = nil
    /// iOS sheet; Android pushes `.account` instead (S10 5).
    private(set) var isJoinSheetPresented = false
    private(set) var isAccountSheetPresented = false
    /// R51: New Meeting, Join, Rejoin and links open the "Update Conclave" explanation instead of the lobby.
    private(set) var isUpdatePromptPresented = false
    private(set) var switchPrompt: RoomSwitchPrompt? = nil
    /// ENT-5 (S10 9 d, Android only): Back while waiting asks "Stop asking to join?" instead of cancelling at once.
    private(set) var isStopAskingPresented = false
    /// S50 PH20 (PPL-7, RECONCILE R30): the `LobbyIntent.promotion` lobby the call root presents over the attendee
    /// viewer (iOS a large-detent sheet, Android a full-window overlay); nil when none. Never part of `path`.
    private(set) var promotionRoute: PremeetingRoute? = nil
    /// Premeeting async outcomes as tokens (F00 8; S10 0.5): `validationFailed` on a rejected join submit. The root
    /// consumer reads it beside the shell's stream and plays only `DeliveredTokenKinds`.
    private(set) var feedbackState = MeetingShellFeedbackState(session: 0, token: FeedbackToken.baseline)
    /// ENT-7 (S10 5): the Account presenter, app-scoped with this presenter (the L9 fixture gets a standalone one).
    let account = AccountPresenter()

    /// Core only: the view model forwards commands to the S1 shell. Nil in the L9 fixture and in tests.
    @ObservationIgnored var onCommand: ((PremeetingCommand) -> Void)? = nil
    /// The device store; nil keeps recents in memory (fixture, tests).
    @ObservationIgnored var store: RecentMeetingsStore? = nil
    @ObservationIgnored var nowMillis: () -> Double = { Date().timeIntervalSince1970 * 1000.0 }
    /// ENT-3: the core, preview, permission, route and presence hooks (production wiring only; nil in the L9 fixture
    /// unless it scripts them, and in tests unless they record them).
    @ObservationIgnored var lobbyHooks: LobbyCoreHooks? = nil
    /// The New Meeting code generator (tests inject a sequence; C17 regenerates through it).
    @ObservationIgnored var generateRoomCode: () -> String = { EntryPolicies.generateRoomCode() }
    /// The presence poll interval (S10 0.5 task table: 10 s; tests shorten it).
    @ObservationIgnored var presenceIntervalMillis: Double = LobbyPresencePolicy.pollIntervalMillis
    /// ENT-5: the slow notice delay (S10 0.5 task table: one-shot 8 s; tests shorten it).
    @ObservationIgnored var slowNoticeDelayMillis: Double = EntrySlowNoticePolicy.delayMillis
    /// ENT-9 (S10 12): the landing's lookup and attendee join (production wiring; the L9 fixture scripts them; nil in
    /// tests unless they record them).
    @ObservationIgnored var webinarHooks: WebinarLandingHooks? = nil
    /// ENT-9: the refetch interval (S10 0.5 task table: 20 s; tests shorten it).
    @ObservationIgnored var webinarRefetchIntervalMillis: Double = WebinarLandingPolicy.refetchIntervalMillis
    /// ENT-9 (S10 12 l7, Android): the L9 fixture flag that makes Add to calendar behave as if no calendar app resolves.
    @ObservationIgnored var webinarCalendarResolverDisabled = false

    @ObservationIgnored private var inputs = PremeetingInputs.make()
    @ObservationIgnored private var records: [RecentMeetingRecord] = []
    @ObservationIgnored private var targets: [PremeetingRouteTarget] = []
    @ObservationIgnored private var nextRouteId = 1
    @ObservationIgnored private var pendingTarget: PremeetingRouteTarget? = nil
    @ObservationIgnored private var pendingSwitchTarget: NativeJoinLinkTarget? = nil
    @ObservationIgnored private var awaitingHomeTarget: NativeJoinLinkTarget? = nil
    @ObservationIgnored private var queuedLink = ""
    @ObservationIgnored private var nextPromptId = 1
    @ObservationIgnored private var localNotice: HomeNoticeKind = .none
    @ObservationIgnored private var dismissedSessionNoticeKey = ""
    @ObservationIgnored private var dismissedOutcomeId = 0
    @ObservationIgnored private var recordedCallSession = 0
    @ObservationIgnored private var recordedRecordId = ""
    @ObservationIgnored private var recordedOutcomeId = 0
    @ObservationIgnored private var sessionRoomId = ""
    @ObservationIgnored private var sessionRoomCallSession = 0
    @ObservationIgnored private var lastPreCallWasWaiting = false
    @ObservationIgnored private var rejoinExpiryTask: Task<Void, Never>? = nil
    @ObservationIgnored private var scheduledRejoinKey = ""
    @ObservationIgnored private var publishCount = 0
    // ENT-3 lobby state (per lobby route; reset when another lobby opens)
    @ObservationIgnored private var device = LobbyDeviceInputs.initial
    @ObservationIgnored private var lobbyRouteId = 0
    @ObservationIgnored private var visibleLobbyRouteId = 0
    @ObservationIgnored private var guestNameDraft = ""
    @ObservationIgnored private var inviteCodeDraft = ""
    @ObservationIgnored private var formIssue = LobbyFormIssue.none
    @ObservationIgnored private var formIssueBaselineKey = ""
    @ObservationIgnored private var appliedFormIssueKey = ""
    @ObservationIgnored private var chosenOutputKind = ""
    @ObservationIgnored private var chosenInputId = ""
    @ObservationIgnored private var presenceHasResult = false
    @ObservationIgnored private var presenceCount: Int? = nil
    @ObservationIgnored private var presenceRoomId = ""
    @ObservationIgnored private var presenceTask: Task<Void, Never>? = nil
    @ObservationIgnored private var collisionTask: Task<Void, Never>? = nil
    @ObservationIgnored private var isStarting = false
    @ObservationIgnored private var previewRequested = false
    @ObservationIgnored private var previewHandedOff = false
    @ObservationIgnored private var presenceFetches = 0
    @ObservationIgnored private var joinRequests = 0
    // ENT-5 slow notice (S10 8 c) and ENT-6 rejoin (S10 0.8 C3)
    @ObservationIgnored private var slowNoticeTask: Task<Void, Never>? = nil
    @ObservationIgnored private var slowNoticeShown = false
    @ObservationIgnored private var pendingRejoinRouteId = 0
    @ObservationIgnored private var rejoinCommands = 0
    /// PH20: the lobby state currently belongs to the promotion lobby (its preview may run while in a call).
    @ObservationIgnored private var lobbyRouteIsPromotion = false
    // ENT-9 webinar landing state (per landing route; reset when another landing opens)
    @ObservationIgnored private var webinarRouteId = 0
    @ObservationIgnored private var visibleWebinarRouteId = 0
    @ObservationIgnored private var webinarSceneActive = true
    @ObservationIgnored private var webinarAnswer: WebinarLookupAnswer? = nil
    @ObservationIgnored private var webinarNameDraft = ""
    @ObservationIgnored private var webinarInviteDraft = ""
    @ObservationIgnored private var webinarNeedsInviteCode = false
    @ObservationIgnored private var webinarInviteInvalid = false
    /// A non-invite form error after Start Watching ("No room found."): the landing says the webinar isn't available.
    @ObservationIgnored private var webinarFormUnavailable = false
    /// Start Watching (or a Rejoin card's connect) began a join from this landing: join failures and form errors
    /// after it belong to the landing. Cleared on Cancel, in the call and when another landing opens.
    @ObservationIgnored private var webinarAttempted = false
    /// The join hook ran and the session has not left `home` yet (the landing shows Getting You In meanwhile).
    @ObservationIgnored private var webinarJoinPending = false
    /// The S1 form error present when the attempt began (or already classified): only a newer one belongs to it.
    @ObservationIgnored private var webinarFormBaselineKey = ""
    /// The automatic retry from the wait for the host (S10 12 f): the landing keeps saying it waits until the call.
    @ObservationIgnored private var webinarSilentRetry = false
    @ObservationIgnored private var webinarRefetchTask: Task<Void, Never>? = nil
    @ObservationIgnored private var webinarOpenWakeTask: Task<Void, Never>? = nil
    @ObservationIgnored private var webinarWakeAtMillis: Double = 0.0
    @ObservationIgnored private var webinarLastFetchMillis: Double = 0.0
    @ObservationIgnored private var webinarRevision = 0
    @ObservationIgnored private var webinarLookups = 0
    @ObservationIgnored private var webinarJoinRequests = 0
    /// The landing's slug and title for the next attendee call, so its recents row reopens the landing by slug (the
    /// session's room id becomes the internal room after the join).
    @ObservationIgnored private var webinarSessionSlug = ""
    @ObservationIgnored private var webinarSessionTitle = ""

    init() {
        // ENT-7 (S10 5 e): the account's async outcomes (signInSucceeded, sessionExpired) join this token stream.
        account.onFeedback = { [weak self] kind in
            self?.advanceFeedback(kind)
        }
    }

    // MARK: - Diagnostics (tests, fixture self-check)

    var currentInputs: PremeetingInputs { inputs }
    /// Every assignment to a published value (the L9 self-check reads it).
    var snapshotPublishCount: Int { publishCount }
    /// Live presenter tasks (S1C 3.3 TEAR): the Rejoin wake-up while a card is published, the lobby presence poll while
    /// a lobby is visible in `editing`, and the C17 code check while a start is in flight.
    var liveTaskCount: Int {
        (rejoinExpiryTask == nil ? 0 : 1) + (presenceTask == nil ? 0 : 1) + (collisionTask == nil ? 0 : 1)
            + (slowNoticeTask == nil ? 0 : 1) + webinarTaskCount
    }
    /// ENT-9 (S10 0.5 task table): the landing's refetch while visible and the one open wake-up while early.
    var webinarTaskCount: Int {
        (webinarRefetchTask == nil ? 0 : 1) + (webinarOpenWakeTask == nil ? 0 : 1)
    }
    /// ENT-9 Debug counters (S10 12 l2: no join until Start Watching).
    var webinarLookupCount: Int { webinarLookups }
    var webinarJoinRequestCount: Int { webinarJoinRequests }
    /// ENT-9: the landing's typed name and invite code, so a field that comes back (after Cancel) reseeds from them.
    /// Not observed: the fields read them once when they appear.
    var webinarNameText: String { webinarNameDraft }
    var webinarInviteText: String { webinarInviteDraft }
    var recentRecords: [RecentMeetingRecord] { records }
    /// ENT-3 Debug counters (S10 6 l6: polling stops when the lobby is popped).
    var presenceFetchCount: Int { presenceFetches }
    var joinRequestCount: Int { joinRequests }
    var isStartInFlight: Bool { collisionTask != nil }
    var currentDeviceInputs: LobbyDeviceInputs { device }
    /// ENT-6 Debug counter (S10 10 l6): `rejoinLastMeeting` commands sent to the core.
    var rejoinCommandCount: Int { rejoinCommands }

    /// The target behind a pushed route (the lobby, ENT-3; tests).
    func target(forRoute id: Int) -> PremeetingRouteTarget? {
        for target in targets where target.routeId == id {
            return target
        }
        return nil
    }

    // MARK: - Core

    /// Synchronous, before the first frame (S10 1 c): identity and stored recents; no network.
    func bootstrap(user: AppState.User?, recents: [RecentMeetingRecord]) {
        var capped: [RecentMeetingRecord] = []
        for record in recents where capped.count < RecentMeetingsPolicy.cap {
            capped.append(record)
        }
        records = capped
        // Only the identity fields change: the session part stays as the core last pushed it.
        inputs = inputs.withIdentity(
            isSignedIn: PremeetingPresenter.isSignedIn(user),
            accountName: PremeetingPresenter.accountName(user),
            accountSeed: user?.id ?? ""
        )
        republishHome()
    }

    static func isSignedIn(_ user: AppState.User?) -> Bool {
        guard let user else { return false }
        return user.provider != AppState.AuthProvider.guest && user.provider != AppState.AuthProvider.none
    }

    static func accountName(_ user: AppState.User?) -> String {
        guard let user else { return "" }
        let name = (user.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty { return name }
        return (user.email ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Core only (the view model's `requestShellRefresh()`, the fixture). Never calls `onCommand`.
    func apply(_ next: PremeetingInputs) {
        guard next != inputs else { return }
        let previous = inputs
        inputs = next

        if previous.isSignedIn && !next.isSignedIn {
            // Q4: recents are cleared on sign-out and account deletion.
            records = []
            store?.clear()
        }
        if next.callSession != previous.callSession {
            lastPreCallWasWaiting = false
        }
        if next.phase == .waiting {
            lastPreCallWasWaiting = true
        } else if next.phase == .entering {
            lastPreCallWasWaiting = false
        }
        if next.phase != previous.phase || next.callSession != previous.callSession {
            // ENT-5 (S10 0.5 task table): any phase change cancels the slow notice; the next Connecting starts over.
            cancelSlowNotice()
            slowNoticeShown = false
        }
        trackSessionRoom(next)
        recordRecents(next)

        let previousRoot = root
        var decision = PremeetingRootPolicy.decide(
            phase: next.phase,
            hasBeenAdmittedThisSession: next.hasBeenAdmittedThisSession,
            outcomeKind: next.outcomeKind,
            entryOrigin: next.entryOrigin,
            lastPreCallWasWaiting: lastPreCallWasWaiting
        )
        if decision.showsOutcome && next.outcomeId != 0 && next.outcomeId == dismissedOutcomeId {
            decision = PremeetingRootDecision.home
        }
        setRoot(decision)
        refreshOutcome(next, decision: decision)
        if decision.root == .call && previousRoot.root != .call {
            // The publish latch (S60 C6-8, Q16 B): the call owns the camera from now on.
            handOffPreview()
        } else if previousRoot.root == .call && decision.root == .premeeting {
            previewHandedOff = false
            lobbyHooks?.resetPreviewLatch?()
        }

        if decision.showsOutcome {
            // S10 0.4: the outcome screen is the premeeting root content.
            setPathValue([])
        } else if previousRoot.root == .call && decision.root == .premeeting {
            // Reset to Home after a call (S10 0.4 `home` row); the path is kept after a cancelled join.
            setPathValue([])
        }
        if decision.pushesLobby {
            pushLobbyIfAbsent(next)
        }
        if let target = awaitingHomeTarget {
            if decision.showsOutcome {
                awaitingHomeTarget = nil
            } else if decision.root == .premeeting && !MeetingRoomSwitchPolicy.isBusy(phase: next.phase, lobby: .none) {
                // Leave and Join (S10 4 c): once Home is reached, the target's lobby opens in editing (no auto-join).
                awaitingHomeTarget = nil
                setPathValue([makeTarget(from: target, intent: .join).route])
            }
        }
        if !previous.isAppActive && next.isAppActive && visibleLobbyRouteId != 0 {
            // S10 7 c, d: permissions and routes are re-read on foreground.
            lobbyHooks?.refreshDevices?()
        }
        refreshLobby()

        let homeInputsChanged = previous.isSignedIn != next.isSignedIn
            || previous.accountName != next.accountName
            || previous.accountSeed != next.accountSeed
            || previous.updateRequired != next.updateRequired
            || previous.storeURL != next.storeURL
            || previous.phase != next.phase
            || previous.notice != next.notice
            || previous.noticeText != next.noticeText
            || previous.callSession != next.callSession
            || (!previous.isAppActive && next.isAppActive)
        if homeInputsChanged {
            republishHome()
        }
        if !previous.isAppActive && next.isAppActive {
            // ENT-7 (HD request B4-T3 R5): a stored sign-in is re-validated on foreground.
            account.appDidBecomeActive()
        }
        if previous.isSigningIn && !next.isSigningIn && !queuedLink.isEmpty {
            // Invariant 9: a link that arrived during sign-in applies after auth completes.
            let link = queuedLink
            queuedLink = ""
            handleIncomingURL(link)
        }
    }

    /// Core only: a Home notice the session does not publish (S10 2 f: sessionExpired from the session refresh,
    /// movedToAudience from a demotion without a webinar slug, R47).
    func showHomeNotice(_ kind: HomeNoticeKind) {
        localNotice = kind
        republishHome()
    }

    // MARK: - Navigation

    /// iOS `NavigationStack(path:)` and NavigationLink values, Android NavDisplay pops. A route appended by a recent
    /// row's NavigationLink is prepared exactly like `openRecent(id:)` (target from the record, no network).
    func setPath(_ routes: [PremeetingRoute]) {
        // ENT-9 (S10 12 f): read before the landing's state resets with its route.
        let landingRouteId = webinarRouteId
        let landingJoinInFlight = landingRouteId != 0 && isWebinarJoinInFlight()
        let landingFailureShowing = landingRouteId != 0 && isWebinarFailureShowing()
        var accepted: [PremeetingRoute] = []
        for route in routes {
            if target(forRoute: route.id) != nil {
                accepted.append(route)
            } else if let prepared = targetFromRecentRoute(route) {
                targets.append(prepared)
                accepted.append(prepared.route)
            }
        }
        setPathValue(accepted)
        refreshLobby()
        if landingRouteId != 0 && !PremeetingPresenter.routesContain(accepted, routeId: landingRouteId) {
            if landingJoinInFlight {
                // Back during the automatic retry from the wait for the host: the join never continues unseen.
                onCommand?(.leave)
            } else if landingFailureShowing {
                // Back or Back to Home from a failed attendee join: the S1 failure ends with the landing, so no later
                // input pushes a failed lobby for it (S10 0.4 initial `joinFailed` row).
                onCommand?(.dismissOutcome)
            }
        }
    }

    // MARK: - Home actions

    func newMeeting() {
        guard !blockedByUpdate() else { return }
        let code = EntryPolicies.generateRoomCode()
        openOrQueue(PremeetingRouteTarget(routeId: allocateRouteId(), kind: .lobby, intent: .newMeeting, roomId: code,
                                           title: code, joinMode: .meeting, meetingInviteCode: nil,
                                           webinarInviteCode: nil, clientId: nil, allowRoomCreation: true))
    }

    func openJoinSheet() {
        guard !blockedByUpdate() else { return }
        setJoinSheet(true)
    }

    /// The join sheet's submit (S10 3 j): keystrokes never reach the presenter. A parsed target becomes the pending
    /// route, pushed from `joinSheetDidDismiss()` once the sheet is gone (never while it is still dismissing).
    func submitJoinInput(_ raw: String) {
        let parsed = EntryPolicies.parseJoinInput(raw)
        guard !parsed.roomId.isEmpty else {
            advanceFeedback(.validationFailed)
            return
        }
        pendingTarget = makeTarget(from: parsed, intent: .join)
        setJoinSheet(false)
    }

    /// The sheet binding's setter (swipe, Cancel, Back, scrim): hides the sheet and keeps any pending route.
    func dismissJoinSheet() {
        setJoinSheet(false)
    }

    /// Called from the sheet's `onDismiss` (iOS) or when it leaves composition after hiding (Android).
    func joinSheetDidDismiss() {
        setJoinSheet(false)
        flushPendingTarget()
    }

    func dismissAccountSheet() {
        setAccountSheet(false)
    }

    func accountSheetDidDismiss() {
        setAccountSheet(false)
        // ENT-7 (HD request B4-T3 R3): Close cancels a sign-in still in flight; a completed one stays.
        account.didDismiss()
        flushPendingTarget()
    }

    func openRecent(id: String) {
        guard !blockedByUpdate() else { return }
        for record in records where record.id == id {
            openOrQueue(targetFromRecord(record, routeId: allocateRouteId(), intent: .join))
            return
        }
    }

    func removeRecent(id: String) {
        let next = RecentMeetingsPolicy.remove(records, id: id)
        guard next != records else { return }
        records = next
        store?.save(records)
        republishHome()
    }

    /// The Rejoin card (S10 2 j). The lobby opens with `rejoin` intent and, while the view model keeps this room's
    /// rejoin context (S10 0.8 C3), connects at once with the call's room, invite codes, client id and media intent
    /// (RECONCILE R4). Without a context (a relaunch) the lobby opens editable with Join. Behind a sheet the connect
    /// waits until the sheet is gone and the lobby is pushed.
    func rejoin() {
        guard !blockedByUpdate() else { return }
        guard let card = home.rejoin else { return }
        for record in records where record.id == card.recentId {
            let target = targetFromRecord(record, routeId: allocateRouteId(), intent: .rejoin)
            let connects = canRejoin(roomId: record.roomId)
            let queued = isJoinSheetPresented || isAccountSheetPresented
            openOrQueue(target)
            if connects {
                if queued {
                    pendingRejoinRouteId = target.routeId
                } else {
                    sendRejoin()
                }
            }
            return
        }
    }

    func dismissHomeNotice() {
        if localNotice != .none {
            localNotice = .none
        } else if PremeetingRootPolicy.homeNotice(inputs.notice) != .none {
            dismissedSessionNoticeKey = sessionNoticeKey(inputs)
            onCommand?(.dismissOutcome)
        }
        republishHome()
    }

    /// iOS presents the Account sheet; Android pushes the Account page (S10 5). The Account content is ENT-7.
    func openAccount() {
        // ENT-7 (HD request B4-T3 R2): a lobby that needs an account opens Account with that context (S10 5 a, f), and
        // the provider fetch runs once per presentation, never on Home (S10 5 k).
        if let status = lobbyStatus, status.issue == LobbyIssue.signInRequired {
            self.account.setContext(AccountContext.signInRequired)
        }
        self.account.didPresent()
        #if SKIP
        let accountTarget = PremeetingRouteTarget(routeId: allocateRouteId(), kind: .account, intent: .join, roomId: "",
                                                  title: "", joinMode: .meeting, meetingInviteCode: nil,
                                                  webinarInviteCode: nil, clientId: nil, allowRoomCreation: false)
        targets.append(accountTarget)
        setPathValue(path + [accountTarget.route])
        #else
        setAccountSheet(true)
        #endif
    }

    /// ENT-7 (S10 5 d): Android pushes the Privacy page above Account (`PrivacyKey`); iOS pushes it inside the Account
    /// sheet's own stack and never calls this.
    func openPrivacyPolicy() {
        let privacy = PremeetingRouteTarget(routeId: allocateRouteId(), kind: .privacyPolicy, intent: .join, roomId: "",
                                            title: "", joinMode: .meeting, meetingInviteCode: nil,
                                            webinarInviteCode: nil, clientId: nil, allowRoomCreation: false)
        targets.append(privacy)
        setPathValue(path + [privacy.route])
    }

    /// RECONCILE R26 (S10 5 d): Android pushes the app-scope Settings above Account (`SettingsKey`); iOS pushes it inside
    /// the Account sheet's own stack (`AccountRoute.settings`) and never calls this.
    func openAppSettings() {
        let settings = PremeetingRouteTarget(routeId: allocateRouteId(), kind: .settings, intent: .join, roomId: "",
                                             title: "", joinMode: .meeting, meetingInviteCode: nil,
                                             webinarInviteCode: nil, clientId: nil, allowRoomCreation: false)
        targets.append(settings)
        setPathValue(path + [settings.route])
    }

    func openStoreListing() {
        setUpdatePrompt(false)
    }

    func dismissUpdatePrompt() {
        setUpdatePrompt(false)
    }

    /// Cancel while connecting or waiting: `shell.leave()` (no haptic, Q11). On the webinar landing (Cancel in the
    /// iOS toolbar, the Android Close icon and Back while joining) the landing returns to its lookup state.
    func cancelJoin() {
        let onLanding = webinarRouteId != 0
        if onLanding {
            webinarJoinPending = false
            webinarSilentRetry = false
            webinarAttempted = false
        }
        onCommand?(.leave)
        if onLanding {
            refreshWebinar()
        }
    }

    // MARK: - Promotion lobby (S50 PH20, S10 6 promotion; RECONCILE R30)

    /// Core only: the accepted stage invitation opens the S10 lobby with `LobbyIntent.promotion` over the viewer. The
    /// toggles start off (the core's promotion intent), no presence row, no Share, no name (same identity).
    func openPromotionLobby(roomId: String, title: String) {
        let room = roomId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !room.isEmpty else { return }
        if let open = promotionRoute { removeTarget(routeId: open.id) }
        let target = PremeetingRouteTarget(routeId: allocateRouteId(), kind: .lobby, intent: LobbyIntent.promotion,
                                           roomId: room, title: title.isEmpty ? room : title, joinMode: JoinMode.meeting,
                                           meetingInviteCode: nil, webinarInviteCode: nil, clientId: nil,
                                           allowRoomCreation: false)
        targets.append(target)
        lobbyRouteIsPromotion = true
        promotionRoute = target.route
        publishCount += 1
        refreshLobby()
    }

    /// Core only: the promotion lobby closes (Join as a Speaker started the speaker join, or Cancel declined).
    func closePromotionLobby() {
        guard let open = promotionRoute else { return }
        promotionRoute = nil
        publishCount += 1
        removeTarget(routeId: open.id)
        if visibleLobbyRouteId == open.id { visibleLobbyRouteId = 0 }
        refreshLobby()
        lobbyRouteIsPromotion = false
        updatePreviewDemand()
    }

    /// Cancel, the iOS sheet's swipe down and Android Back in the promotion lobby (Back equals Cancel, R30).
    func cancelPromotion() {
        guard promotionRoute != nil else { return }
        onCommand?(.cancelPromotion)
    }

    private func removeTarget(routeId: Int) {
        var kept: [PremeetingRouteTarget] = []
        for target in targets where target.routeId != routeId {
            kept.append(target)
        }
        targets = kept
    }

    // MARK: - Lobby (ENT-3, S10 6 j)

    /// The lobby view appeared (iOS `.task(id:)`, Android composition): devices are re-read, the presence poll and the
    /// preview may start. Keyed by route, so a replaced lobby's late disappearance never stops the new one.
    func lobbyDidAppear(routeId: Int) {
        guard let target = topLobbyTarget(), target.routeId == routeId else { return }
        visibleLobbyRouteId = routeId
        lobbyHooks?.refreshDevices?()
        refreshLobby()
    }

    /// The lobby view left (popped, replaced, covered by a pushed page): presence stops and the preview stops unless
    /// the call took the camera (the hand-off).
    func lobbyDidDisappear(routeId: Int) {
        guard visibleLobbyRouteId == routeId else { return }
        visibleLobbyRouteId = 0
        stopPresencePolling()
        cancelSlowNotice()
        // ENT-4 (S10 7 j, HD request B7-T8 R1): leaving for anything but the hand-off cancels pending permission
        // requests, so a queued prompt never surfaces on Home (7 l3); connecting, waiting and the call keep them.
        if LobbyPermissionCleanupPolicy.cancelsRequests(mode: root.lobbyMode ?? LobbyMode.editing,
                                                        isCallRoot: root.root == .call, handedOff: previewHandedOff) {
            lobbyHooks?.cancelPermissionRequests?()
        }
        updatePreviewDemand()
    }

    /// S10 0.8 C1: the lobby's only media intent path (`setEntryMediaIntent`); never a state write. A first tap with
    /// the permission undetermined asks for it and shows the intended state meanwhile (S10 7 c); a denied permission
    /// keeps the toggle off (the issue row or card overlay explains it), except where Android may ask again.
    func setMicIntent(_ on: Bool) {
        guard lobbyStatus != nil else { return }
        if on && !mayTurnOn(LobbyMediaKind.microphone) {
            return
        }
        lobbyHooks?.setEntryMediaIntent?(on, inputs.cameraIntentOn)
    }

    func setCameraIntent(_ on: Bool) {
        guard lobbyStatus != nil else { return }
        if on && !mayTurnOn(LobbyMediaKind.camera) {
            return
        }
        lobbyHooks?.setEntryMediaIntent?(inputs.micIntentOn, on)
    }

    /// The camera facing for the preview and the call (S20 SC8 / S60 C6-2, one delta through the preview owner).
    func flipCamera() {
        lobbyHooks?.flipPreview?()
    }

    /// The guest name as typed, capped at 40 (DisplayNamePolicy); the field keeps its own text.
    func setGuestName(_ name: String) {
        let capped = DisplayNamePolicy.capped(name)
        guard capped != guestNameDraft else { return }
        guestNameDraft = capped
        refreshLobby()
    }

    func setInviteCode(_ code: String) {
        guard code != inviteCodeDraft else { return }
        inviteCodeDraft = code
        if formIssue.inviteCodeInvalid {
            formIssue = LobbyFormIssue(issue: .none, needsInviteCode: formIssue.needsInviteCode, inviteCodeInvalid: false)
            refreshLobby()
        }
    }

    /// Start Meeting or Join (S10 6 j, 8). `newMeeting` first runs the C17 code check (R49).
    func startOrJoin() {
        guard let target = topLobbyTarget(), let status = lobbyStatus, status.routeId == target.routeId else { return }
        guard status.mode == .editing || status.mode == .failed, !isStarting else { return }
        guard !blockedByUpdate() else { return }
        if target.intent == .promotion {
            // PH20: "Join as a Speaker" ends the attendee session silently and joins with the lobby's intents.
            guard !inputs.isNetworkOffline else { return }
            joinRequests += 1
            onCommand?(.joinAsSpeaker)
            refreshLobby()
            return
        }
        if target.intent == .rejoin && canRejoin(roomId: target.roomId) {
            // ENT-6 (S10 0.8 C3): a rejoin lobby joins with the view model's context, never the record's bare room.
            guard !inputs.isNetworkOffline else { return }
            joinRequests += 1
            sendRejoin()
            refreshLobby()
            return
        }
        guard primaryReason(for: target) == .none else { return }
        if target.intent == .newMeeting && lobbyHooks?.fetchPresence != nil {
            isStarting = true
            let routeId = target.routeId
            collisionTask = Task { @MainActor [weak self] in
                await self?.runCollisionCheck(routeId: routeId)
            }
            refreshLobby()
            return
        }
        submitJoin(target)
    }

    /// The inline failed block's Try Again (S10 0.4 initial `joinFailed`): the same join again with the kept input
    /// (invariant 11); a `rejoin` lobby asks the view model's rejoin context again.
    func retryJoin() {
        startOrJoin()
    }

    /// S10 9 d (Android): Back while waiting opens "Stop asking to join?"; iOS has no Back while waiting.
    func requestStopAsking() {
        guard let status = lobbyStatus, status.mode == .waiting else { return }
        setStopAsking(true)
    }

    /// Keep waiting, Back or a scrim tap: the phase stays, nothing reaches the core.
    func keepWaiting() {
        setStopAsking(false)
    }

    /// Stop asking: cancels at once (`shell.leave()`), the lobby returns to editing.
    func stopAsking() {
        guard isStopAskingPresented else { return }
        setStopAsking(false)
        cancelJoin()
    }

    /// `LobbyMediaKind` raw value (S10 7): the system prompt or the Android queue.
    func requestPermission(_ kind: String) {
        lobbyHooks?.requestPermission?(kind)
    }

    func openSystemSettings() {
        lobbyHooks?.openSystemSettings?()
    }

    /// RECONCILE R31: the S60 Effects content over the lobby (hidden until `EffectsAvailability == .panel`).
    func openEffects() {
        guard lobbyMedia?.showsEffects == true else { return }
        lobbyHooks?.openEffects?()
    }

    /// S10 0.8 C2: an intent stored for the routing owner to apply once at join; never `setAudioOutput`.
    func selectAudioOutput(kind: String) {
        guard lobbyStatus != nil else { return }
        chosenOutputKind = kind
        lobbyHooks?.setPrejoinAudioRouteIntent?(kind, chosenInputId)
        refreshAudioSnapshot()
    }

    /// S10 0.8 C2 for the iOS Microphone row; never `setAudioInput`.
    func selectAudioInput(id: String) {
        guard lobbyStatus != nil else { return }
        chosenInputId = id
        lobbyHooks?.setPrejoinAudioRouteIntent?(chosenOutputKind, id)
        refreshAudioSnapshot()
    }

    /// iOS: the system route picker closed. The new system route is read and recorded as the prejoin intent (S10 6 c).
    func routePickerDidDismiss() {
        let before = device.currentOutputId
        lobbyHooks?.refreshDevices?()
        guard device.currentOutputId != before else { return }
        for option in device.outputs where option.id == device.currentOutputId {
            selectAudioOutput(kind: option.kind.rawValue)
        }
    }

    // MARK: - Lobby device inputs (WP3 services; equality-guarded)

    func applyPreview(state: PreviewState, sessionId: Int, isFrontCamera: Bool, interruption: PreviewInterruption) {
        let next = device.withPreview(state: state, sessionId: sessionId, isFrontCamera: isFrontCamera,
                                      interruption: interruption)
        guard next != device else { return }
        device = next
        refreshMediaSnapshot()
    }

    func applyPermissions(microphone: MediaPermissionState, camera: MediaPermissionState,
                          canAskAgainMicrophone: Bool, canAskAgainCamera: Bool) {
        let next = device.withPermissions(microphone: microphone, camera: camera,
                                          canAskAgainMicrophone: canAskAgainMicrophone,
                                          canAskAgainCamera: canAskAgainCamera)
        guard next != device else { return }
        device = next
        refreshMediaSnapshot()
        updatePreviewDemand()
    }

    func applyAudioRoutes(outputs: [AudioRouteOption], currentOutputId: String, inputOptions: [AudioRouteOption],
                          currentInputId: String) {
        let next = device.withRoutes(outputs: outputs, currentOutputId: currentOutputId, inputs: inputOptions,
                                     currentInputId: currentInputId)
        guard next != device else { return }
        device = next
        refreshAudioSnapshot()
    }

    /// S60 `EffectsAvailability` (R31); nothing publishes `.panel` yet.
    func applyEffects(available: Bool, active: Bool) {
        let next = device.withEffects(available: available, active: active)
        guard next != device else { return }
        device = next
        refreshMediaSnapshot()
    }

    /// A permission request answered. A refusal returns the intent it was asked for to off (fail closed), with no
    /// second gesture (S10 7 c).
    func permissionRequestFinished(kind: String, granted: Bool) {
        guard !granted, lobbyStatus != nil else { return }
        if kind == LobbyMediaKind.microphone.rawValue && inputs.micIntentOn {
            lobbyHooks?.setEntryMediaIntent?(false, inputs.cameraIntentOn)
        } else if kind == LobbyMediaKind.camera.rawValue && inputs.cameraIntentOn {
            lobbyHooks?.setEntryMediaIntent?(inputs.micIntentOn, false)
        }
    }

    /// Whether a toggle may turn on now. Undetermined (or Android's ask-again) requests the permission and lets the
    /// intent show while the prompt is up; denied, restricted or no hardware keep it off.
    private func mayTurnOn(_ kind: LobbyMediaKind) -> Bool {
        let permission = kind == .camera ? device.cameraPermission : device.micPermission
        let canAskAgain = kind == .camera ? device.canAskAgainCamera : device.canAskAgainMicrophone
        switch permission {
        case .granted:
            return true
        case .notDetermined:
            lobbyHooks?.requestPermission?(kind.rawValue)
            return true
        case .denied:
            guard canAskAgain, lobbyHooks?.requestPermission != nil else { return false }
            lobbyHooks?.requestPermission?(kind.rawValue)
            return true
        case .restricted, .unavailable:
            return false
        }
    }

    // MARK: - Webinar landing (ENT-9, S10 12 j)

    /// The landing appeared (iOS `.task(id:)`, Android composition): the lookup and its 20 s refetch run while it stays
    /// visible. Keyed by route, so a replaced landing's late disappearance never stops the new one.
    func webinarDidAppear(routeId: Int) {
        guard let target = topWebinarTarget(), target.routeId == routeId else { return }
        visibleWebinarRouteId = routeId
        refreshWebinar()
    }

    /// The landing left (popped, replaced, covered by the call): the refetch and the open wake-up stop.
    func webinarDidDisappear(routeId: Int) {
        guard visibleWebinarRouteId == routeId else { return }
        visibleWebinarRouteId = 0
        refreshWebinar()
    }

    /// iOS `scenePhase`, Android ON_RESUME and ON_PAUSE. Becoming active re-runs the status policy at once, so an early
    /// landing that slept past the open time flips without waiting for the refetch (S10 12 c, l6); the refetch resumes
    /// and fetches at once when the last answer is older than the interval.
    func webinarSceneDidChange(isActive: Bool) {
        guard isActive != webinarSceneActive else { return }
        webinarSceneActive = isActive
        refreshWebinar()
    }

    /// The landing name as typed, capped at 40 (RECONCILE R41); the field keeps its own text.
    func setWebinarName(_ name: String) {
        let capped = DisplayNamePolicy.capped(name)
        guard capped != webinarNameDraft else { return }
        webinarNameDraft = capped
        refreshWebinar()
    }

    func setWebinarInviteCode(_ code: String) {
        guard code != webinarInviteDraft else { return }
        webinarInviteDraft = code
        webinarInviteInvalid = false
        refreshWebinar()
    }

    /// Start Watching (S10 12 j, Q7): the one deliberate tap that joins, as an attendee with the microphone and camera
    /// off. Nothing else on the landing ever joins.
    func startWatching() {
        guard let target = topWebinarTarget(), let snapshot = webinar, snapshot.routeId == target.routeId,
              snapshot.status == .open, snapshot.isPrimaryEnabled else { return }
        guard !blockedByUpdate() else { return }
        sendWebinarJoin(target, silent: false)
    }

    /// Try Again: a failed lookup looks up again; a failed join joins again with the kept name and code (one tap).
    func retryWebinar() {
        guard let target = topWebinarTarget(), let snapshot = webinar, snapshot.routeId == target.routeId,
              snapshot.status == .failed else { return }
        if snapshot.failure == .join {
            guard !blockedByUpdate() else { return }
            sendWebinarJoin(target, silent: false)
            return
        }
        webinarAnswer = nil
        webinarLastFetchMillis = 0.0
        stopWebinarRefetch()
        refreshWebinar()
    }

    /// Back to Home from an end or error state: the stack becomes `[Home]` (a failed attempt's S1 failure ends with the
    /// landing, see `setPath(_:)`).
    func webinarBackHome() {
        setPath([])
    }

    // MARK: - Outcome

    /// S10 10 j: Back to Home dismisses (`shell.dismissOutcome()`); Rejoin and Try Again push `lobby(rejoin)` and ask
    /// the view model's rejoin context (`rejoinLastMeeting()`, S10 0.8 C3), so the lobby opens connecting. Without a
    /// context (the model never offers them then) they fall back to Back to Home.
    func performOutcomeAction(_ action: OutcomeAction) {
        switch action {
        case .backHome, .none:
            dismissOutcome()
        case .rejoin, .tryAgain:
            let room = inputs.rejoinRoomId
            guard !room.isEmpty else {
                dismissOutcome()
                return
            }
            guard !blockedByUpdate() else { return }
            if inputs.outcomeId != 0 {
                dismissedOutcomeId = inputs.outcomeId
            }
            setOutcome(nil)
            if root.showsOutcome {
                setRoot(PremeetingRootDecision.home)
            }
            let target = PremeetingRouteTarget(routeId: allocateRouteId(), kind: .lobby, intent: .rejoin, roomId: room,
                                               title: room, joinMode: inputs.currentJoinMode, meetingInviteCode: nil,
                                               webinarInviteCode: nil, clientId: nil, allowRoomCreation: false)
            targets.append(target)
            setPathValue([target.route])
            refreshLobby()
            sendRejoin()
        }
    }

    func dismissOutcome() {
        if inputs.outcomeId != 0 {
            dismissedOutcomeId = inputs.outcomeId
        }
        setOutcome(nil)
        if root.showsOutcome {
            setRoot(PremeetingRootDecision.home)
        }
        setPathValue([])
        refreshLobby()
        onCommand?(.dismissOutcome)
    }

    // MARK: - Links (S10 4, 0.8 C9)

    /// The native root's link intake. Parses once (`NativeJoinLinkParser`), then routes through
    /// `MeetingRoomSwitchPolicy` to a lobby, the webinar landing, the switch prompt, the sign-in queue or the
    /// invalid-link notice. Web pages and other URLs never reach here (the delegate opens or ignores them).
    func handleIncomingURL(_ raw: String) {
        let kind = NativeJoinLinkParser.classify(raw)
        switch kind {
        case .notConclave, .webOnly:
            return
        case .invalidConclave:
            reportInvalidLink()
            return
        case .meeting, .webinar:
            break
        }
        let parsed = NativeJoinLinkParser.parse(raw, allowRoomCreationForURLs: true)
        guard !parsed.roomId.isEmpty else {
            reportInvalidLink()
            return
        }
        let lobbyTarget = topLobbyTarget()
        let lobby = EntryPolicies.switchLobby(isLobbyOnTop: lobbyTarget != nil, mode: lobbyStatus?.mode ?? LobbyMode.editing)
        let busy = MeetingRoomSwitchPolicy.isBusy(phase: inputs.phase, lobby: lobby)
        var isSameRoom = false
        var currentJoinMode = inputs.currentJoinMode
        if busy {
            let currentRoom = inputs.currentRoomId.isEmpty ? inputs.roomLabel : inputs.currentRoomId
            isSameRoom = MeetingRoomSwitchPolicy.isSameRoom(currentRoomId: currentRoom, aliases: inputs.roomAliases,
                                                            targetRoomId: parsed.roomId)
        } else if let lobbyTarget {
            isSameRoom = MeetingRoomSwitchPolicy.isSameRoom(currentRoomId: lobbyTarget.roomId, aliases: [],
                                                            targetRoomId: parsed.roomId)
            currentJoinMode = lobbyTarget.joinMode
        }
        let decision = MeetingRoomSwitchPolicy.decide(MeetingRoomSwitchInputs.make(
            phase: inputs.phase,
            lobby: lobby,
            isSigningIn: inputs.isSigningIn,
            isSameRoom: isSameRoom,
            currentJoinMode: currentJoinMode,
            targetKind: EntryPolicies.switchTargetKind(kind),
            targetJoinMode: parsed.joinMode
        ))
        switch decision {
        case .openLobby, .openWebinarLanding:
            guard !blockedByUpdate() else { return }
            openForLink(parsed)
        case .replaceLobby:
            guard !blockedByUpdate() else { return }
            setPathValue([makeTarget(from: parsed, intent: .join).route])
            refreshLobby()
        case .prompt:
            let current = busy
                ? EntryPolicies.roomLabel(inputs.roomLabel.isEmpty ? inputs.currentRoomId : inputs.roomLabel)
                : EntryPolicies.roomLabel(lobbyTarget?.roomId ?? "")
            pendingSwitchTarget = parsed
            setSwitchPrompt(RoomSwitchPrompt(id: nextPromptId, currentLabel: current,
                                             targetLabel: EntryPolicies.roomLabel(parsed.roomId)))
            nextPromptId += 1
        case .ignore:
            return
        case .queue:
            queuedLink = raw
        case .invalidLink:
            reportInvalidLink()
        }
    }

    /// A Conclave scheme or host that failed to parse: the Home notice "This link can't be opened in Conclave."
    func reportInvalidLink() {
        localNotice = .invalidLink
        republishHome()
    }

    /// Leave and Join: keeps the parsed target, leaves through the shell, and opens the target's lobby once Home is
    /// reached. A stale id (a newer link replaced the prompt) does nothing.
    func confirmSwitch(id: Int) {
        guard let prompt = switchPrompt, prompt.id == id, let target = pendingSwitchTarget else { return }
        setSwitchPrompt(nil)
        pendingSwitchTarget = nil
        awaitingHomeTarget = target
        if MeetingRoomSwitchPolicy.isBusy(phase: inputs.phase, lobby: .none) {
            onCommand?(.leave)
        } else {
            awaitingHomeTarget = nil
            setPathValue([makeTarget(from: target, intent: .join).route])
            refreshLobby()
        }
    }

    /// Stay (Cancel role, Back, scrim): consumes the link.
    func stay(id: Int) {
        guard let prompt = switchPrompt, prompt.id == id else { return }
        setSwitchPrompt(nil)
        pendingSwitchTarget = nil
    }

    // MARK: - Private: links and targets

    private func openForLink(_ parsed: NativeJoinLinkTarget) {
        if root.showsOutcome {
            dismissOutcome()
        }
        openOrQueue(makeTarget(from: parsed, intent: .join))
    }

    /// Opens a target from Home, or, while a sheet is up (the join sheet's Rejoin suggestion, a link arriving over
    /// Account), keeps it pending and dismisses the sheets; the dismissal callback pushes it (never mid-dismissal).
    private func openOrQueue(_ target: PremeetingRouteTarget) {
        guard isJoinSheetPresented || isAccountSheetPresented else {
            openFromHome(target)
            return
        }
        if self.target(forRoute: target.routeId) == nil {
            targets.append(target)
        }
        pendingTarget = target
        setJoinSheet(false)
        setAccountSheet(false)
    }

    private func flushPendingTarget() {
        guard let target = pendingTarget else { return }
        pendingTarget = nil
        openFromHome(target)
        if pendingRejoinRouteId != 0 && pendingRejoinRouteId == target.routeId {
            pendingRejoinRouteId = 0
            if canRejoin(roomId: target.roomId) {
                sendRejoin()
            }
        }
    }

    /// ENT-6: the view model keeps this room's rejoin context and no call or join is running.
    private func canRejoin(roomId: String) -> Bool {
        guard inputs.phase == .home || inputs.phase == .outcome else { return false }
        return RejoinContextPolicy.matches(rejoinRoomId: inputs.rejoinRoomId, roomId: roomId)
    }

    private func sendRejoin() {
        rejoinCommands += 1
        onCommand?(.rejoinLastMeeting)
    }

    /// Lobby and webinar landing open from Home: the stack becomes `[Home, target]`.
    private func openFromHome(_ target: PremeetingRouteTarget) {
        if self.target(forRoute: target.routeId) == nil {
            targets.append(target)
        }
        setPathValue([target.route])
        refreshLobby()
    }

    private func makeTarget(from parsed: NativeJoinLinkTarget, intent: LobbyIntent) -> PremeetingRouteTarget {
        let target = PremeetingRouteTarget(
            routeId: allocateRouteId(),
            kind: EntryPolicies.routeKind(for: parsed),
            intent: intent,
            roomId: parsed.roomId,
            title: parsed.roomId,
            joinMode: parsed.joinMode,
            meetingInviteCode: parsed.meetingInviteCode,
            webinarInviteCode: parsed.webinarInviteCode,
            clientId: parsed.clientId,
            allowRoomCreation: parsed.allowRoomCreation
        )
        targets.append(target)
        return target
    }

    private func targetFromRecord(_ record: RecentMeetingRecord, routeId: Int, intent: LobbyIntent) -> PremeetingRouteTarget {
        let joinMode: JoinMode = record.isWebinar ? JoinMode.webinarAttendee : JoinMode.meeting
        return PremeetingRouteTarget(routeId: routeId, kind: record.isWebinar ? PremeetingRouteKind.webinarLanding : PremeetingRouteKind.lobby, intent: intent,
                                     roomId: record.roomId, title: record.title, joinMode: joinMode,
                                     meetingInviteCode: nil, webinarInviteCode: nil, clientId: nil,
                                     allowRoomCreation: false)
    }

    private func targetFromRecentRoute(_ route: PremeetingRoute) -> PremeetingRouteTarget? {
        let index = route.id - PremeetingRoute.recentRouteIdBase
        guard index >= 0, index < records.count else { return nil }
        let record = records[index]
        guard record.roomId == route.roomId else { return nil }
        return targetFromRecord(record, routeId: route.id, intent: .join)
    }

    private func topWebinarTarget() -> PremeetingRouteTarget? {
        guard let top = path.last, top.kind == .webinarLanding else { return nil }
        return target(forRoute: top.id)
    }

    private static func routesContain(_ routes: [PremeetingRoute], routeId: Int) -> Bool {
        for route in routes where route.id == routeId {
            return true
        }
        return false
    }

    private func topLobbyTarget() -> PremeetingRouteTarget? {
        // PH20: the promotion lobby over the viewer is the lobby while it is open.
        if let promotion = promotionRoute { return target(forRoute: promotion.id) }
        guard let top = path.last, top.kind == .lobby else { return nil }
        return target(forRoute: top.id)
    }

    private func pushLobbyIfAbsent(_ next: PremeetingInputs) {
        if let top = path.last, top.kind == .lobby || top.kind == .webinarLanding {
            return
        }
        let callRoom = next.currentRoomId.isEmpty ? next.roomLabel : next.currentRoomId
        let roomId = next.resumeInFlight && !next.resumeRoomId.isEmpty ? next.resumeRoomId : callRoom
        let target = PremeetingRouteTarget(routeId: allocateRouteId(), kind: .lobby,
                                           intent: next.resumeInFlight ? LobbyIntent.resume : LobbyIntent.join, roomId: roomId,
                                           title: next.roomLabel.isEmpty ? roomId : next.roomLabel,
                                           joinMode: next.currentJoinMode, meetingInviteCode: nil,
                                           webinarInviteCode: nil, clientId: nil, allowRoomCreation: false)
        targets.append(target)
        // Pushed without a transition by the roots (S10 1 c); the stack becomes `[Home, Lobby]`.
        setPathValue([target.route])
    }

    private func allocateRouteId() -> Int {
        let id = nextRouteId
        nextRouteId += 1
        return id
    }

    private func blockedByUpdate() -> Bool {
        guard inputs.updateRequired else { return false }
        setUpdatePrompt(true)
        return true
    }

    // MARK: - Private: session tracking and recents

    private func trackSessionRoom(_ next: PremeetingInputs) {
        let room = next.currentRoomId.isEmpty ? next.roomLabel : next.currentRoomId
        if next.callSession != sessionRoomCallSession {
            sessionRoomCallSession = next.callSession
            sessionRoomId = ""
        }
        if !room.isEmpty {
            sessionRoomId = room
        }
    }

    /// Recents are written on `inCall` (upsert) and on terminal outcomes (end), S10 2 j.
    private func recordRecents(_ next: PremeetingInputs) {
        let now = nowMillis()
        var changed = false
        if next.phase == .inCall && next.callSession != recordedCallSession && !sessionRoomId.isEmpty {
            recordedCallSession = next.callSession
            // ENT-9: an attendee call that started on the landing is recorded by the landing's slug and webinar title,
            // so its row (and Rejoin card) reopen the landing; the session's room id is the internal room by now.
            // The join mode comes from the view model's join context, so it holds before the attendee role arrives.
            let fromLanding = (next.isWebinarAttendee || next.currentJoinMode == .webinarAttendee) && !webinarSessionSlug.isEmpty
            let roomId = fromLanding ? webinarSessionSlug : sessionRoomId
            let id = RecentMeetingsPolicy.recordId(roomId: roomId, joinMode: next.currentJoinMode)
            recordedRecordId = id
            let role: RecentRole = (next.isWebinarAttendee || fromLanding) ? RecentRole.attendee
                : (next.isLocalHost ? RecentRole.host : RecentRole.participant)
            var title = next.roomLabel.isEmpty ? sessionRoomId : next.roomLabel
            if fromLanding {
                title = webinarSessionTitle.isEmpty ? webinarSessionSlug : webinarSessionTitle
            }
            webinarSessionSlug = ""
            webinarSessionTitle = ""
            records = RecentMeetingsPolicy.upsert(records, RecentMeetingRecord(
                id: id, roomId: roomId, title: title, joinMode: next.currentJoinMode.rawValue, role: role.rawValue,
                lastJoinedAtMillis: now, endedAtMillis: 0, end: ""))
            changed = true
        }
        if let kind = next.outcomeKind, next.outcomeId != 0, next.outcomeId != recordedOutcomeId {
            recordedOutcomeId = next.outcomeId
            let end = PremeetingRootPolicy.recentEnd(kind)
            if recordedCallSession == next.callSession && !recordedRecordId.isEmpty {
                records = RecentMeetingsPolicy.end(records, id: recordedRecordId, end: end, atMillis: now)
                changed = true
            } else if kind == .denied && !sessionRoomId.isEmpty {
                let id = RecentMeetingsPolicy.recordId(roomId: sessionRoomId, joinMode: next.currentJoinMode)
                records = RecentMeetingsPolicy.upsert(records, RecentMeetingRecord(
                    id: id, roomId: sessionRoomId, title: sessionRoomId, joinMode: next.currentJoinMode.rawValue,
                    role: RecentRole.participant.rawValue, lastJoinedAtMillis: now, endedAtMillis: now,
                    end: RecentEnd.denied.rawValue))
                changed = true
            }
        }
        if changed {
            store?.save(records)
            republishHome()
        }
    }

    // MARK: - Private: snapshots

    private func sessionNoticeKey(_ value: PremeetingInputs) -> String {
        String(value.callSession) + ":" + value.notice.rawValue + ":" + value.noticeText
    }

    private func currentNoticeKind() -> HomeNoticeKind {
        if localNotice != .none { return localNotice }
        guard inputs.phase == .home else { return .none }
        let kind = PremeetingRootPolicy.homeNotice(inputs.notice)
        guard kind != .none, sessionNoticeKey(inputs) != dismissedSessionNoticeKey else { return .none }
        return kind
    }

    private func republishHome() {
        let now = nowMillis()
        let candidate = RecentMeetingsPolicy.rejoinCandidate(records, nowMillis: now)
        var rows: [RecentMeetingRow] = []
        for index in 0..<records.count {
            let record = records[index]
            if let candidate, candidate.id == record.id {
                continue
            }
            rows.append(RecentMeetingRow(
                id: record.id,
                roomId: record.roomId,
                routeId: PremeetingRoute.recentRouteIdBase + index,
                routeKind: record.isWebinar ? PremeetingRouteKind.webinarLanding : PremeetingRouteKind.lobby,
                title: record.title,
                relativeTime: PremeetingTimeFormatting.relative(millis: record.lastJoinedAtMillis, nowMillis: now),
                role: record.recentRole,
                end: record.recentEnd ?? RecentEnd.left
            ))
        }
        var card: RejoinCard? = nil
        if let candidate {
            card = RejoinCard(recentId: candidate.id, title: candidate.title,
                              endedAtText: PremeetingTimeFormatting.clockTime(millis: candidate.endedAtMillis),
                              end: candidate.recentEnd ?? RecentEnd.left)
        }
        let noticeKind = currentNoticeKind()
        let noticeText = noticeKind != HomeNoticeKind.none && noticeKind == PremeetingRootPolicy.homeNotice(inputs.notice) ? inputs.noticeText : ""
        let next = HomeSnapshot(
            revision: home.revision,
            noticeKind: noticeKind,
            noticeText: noticeText,
            rejoin: card,
            recents: rows,
            isSignedIn: inputs.isSignedIn,
            accountName: inputs.accountName,
            accountSeed: inputs.accountSeed,
            updateRequired: inputs.updateRequired,
            storeURL: inputs.storeURL
        )
        if next != home {
            home = HomeSnapshot(revision: home.revision + 1, noticeKind: next.noticeKind, noticeText: next.noticeText,
                                rejoin: next.rejoin, recents: next.recents, isSignedIn: next.isSignedIn,
                                accountName: next.accountName, accountSeed: next.accountSeed,
                                updateRequired: next.updateRequired, storeURL: next.storeURL)
            publishCount += 1
        }
        scheduleRejoinExpiry(candidate)
    }

    /// The one-shot Rejoin wake-up (S10 0.5 task table): fires at `endedAt + 15 min` and republishes Home once.
    private func scheduleRejoinExpiry(_ candidate: RecentMeetingRecord?) {
        guard let candidate else {
            rejoinExpiryTask?.cancel()
            rejoinExpiryTask = nil
            scheduledRejoinKey = ""
            return
        }
        let key = candidate.id + ":" + String(candidate.endedAtMillis)
        guard key != scheduledRejoinKey || rejoinExpiryTask == nil else { return }
        rejoinExpiryTask?.cancel()
        scheduledRejoinKey = key
        let delayMillis = max(0.0, RecentMeetingsPolicy.rejoinExpiryMillis(candidate) - nowMillis())
        rejoinExpiryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delayMillis * 1_000_000.0))
            guard !Task.isCancelled else { return }
            self?.rejoinCardExpired()
        }
    }

    private func rejoinCardExpired() {
        rejoinExpiryTask = nil
        scheduledRejoinKey = ""
        republishHome()
    }

    private func refreshOutcome(_ next: PremeetingInputs, decision: PremeetingRootDecision) {
        guard decision.showsOutcome, let kind = next.outcomeKind,
              let variant = PremeetingRootPolicy.outcomeVariant(kind, entryOrigin: next.entryOrigin) else {
            setOutcome(nil)
            return
        }
        // ENT-6 (S10 10 f): Rejoin and Try Again while the view model keeps a rejoin context; a failed rejoin carries
        // its S10 8 g body class.
        let failure = EntryFailurePolicy.issue(category: next.joinFailureCategory, diagnosticCode: next.joinFailureCode,
                                               serverText: next.outcomeServerText)
        setOutcome(OutcomeModelPolicy.model(id: next.outcomeId, variant: variant, hasRejoinContext: !next.rejoinRoomId.isEmpty,
                                            serverText: next.outcomeServerText, failure: failure))
    }

    // MARK: - Private: the lobby (ENT-3, S10 6)

    /// Rebuilds the six lobby snapshots for the lobby on top (each published only when it changed), then the presence
    /// poll and the preview demand follow. No lobby on top clears all six and stops both.
    private func refreshLobby() {
        // ENT-9: the webinar landing follows the same inputs and path changes as the lobby.
        refreshWebinar()
        guard let target = topLobbyTarget() else {
            clearLobby()
            return
        }
        if target.routeId != lobbyRouteId {
            beginLobby(target)
        }
        updateFormIssue()
        let mode = root.lobbyMode ?? LobbyMode.editing
        var issue = LobbyIssue.none
        var issueServerText = ""
        if inputs.updateRequired {
            issue = .updateRequired
        } else if mode == .failed {
            // ENT-5 (S10 8 f): the failed block's class from the classifier's category, code and clean server text.
            issue = EntryFailurePolicy.issue(category: inputs.joinFailureCategory, diagnosticCode: inputs.joinFailureCode,
                                             serverText: inputs.outcomeServerText)
            if issue == .failedServerText {
                issueServerText = MeetingErrorClassifier.cleanServerText(inputs.outcomeServerText)
            }
        } else if inputs.isNetworkOffline && (mode == .editing || mode == .connecting) {
            // S10 8 f: offline while connecting keeps the pending primary and shows the waiting-for-a-connection row.
            issue = .offline
        } else if mode == .editing && formIssue.issue != .none {
            issue = formIssue.issue
            if issue == .failedServerText {
                issueServerText = MeetingErrorClassifier.cleanServerText(inputs.noticeText)
            }
        }
        var waiting = WaitingKind.standard
        var waitingText = ""
        if mode == .waiting {
            // ENT-5 (S10 9 f, RECONCILE R46): offline, server restart, reconnect, then today's server sentences.
            waiting = WaitingKindPolicy.classify(waitingMessage: inputs.phase == .waiting ? inputs.noticeText : "",
                                                 isNetworkOffline: inputs.isNetworkOffline,
                                                 serverRestartText: inputs.serverRestartText,
                                                 isReconnecting: root.showsReconnecting)
            if waiting == .serverRestarting {
                waitingText = MeetingErrorClassifier.cleanServerText(inputs.serverRestartText)
            }
        } else if root.showsReconnecting {
            waiting = .reconnecting
        }
        if mode != .waiting {
            // The Android confirmation belongs to the waiting state only (admitted, denied or cancelled closes it).
            setStopAsking(false)
        }
        updateSlowNotice(mode: mode, routeId: target.routeId)
        let reason = primaryReason(for: target)
        setLobbyStatus(LobbyStatusSnapshot(
            routeId: target.routeId,
            intent: target.intent,
            mode: mode,
            issue: issue,
            issueServerText: issueServerText,
            isPrimaryEnabled: (root.root == .premeeting || target.intent == .promotion)
                && LobbyPrimaryPolicy.isEnabled(mode: mode, reason: reason, isStarting: isStarting),
            primaryReason: LobbyPrimaryPolicy.snapshotValue(reason),
            showsSlowNotice: mode == .connecting && slowNoticeShown,
            waitingKind: waiting,
            isPrimaryPending: isStarting,
            waitingText: waitingText
        ))
        refreshMediaSnapshot()
        refreshPresenceSnapshot()
        setLobbyIdentity(LobbySnapshotPolicy.identity(
            routeId: target.routeId,
            isSignedIn: inputs.isSignedIn,
            accountName: inputs.accountName,
            accountSeed: inputs.accountSeed,
            guestName: guestNameDraft,
            formIssue: formIssue
        ))
        setLobbyLink(LobbySnapshotPolicy.link(routeId: target.routeId, intent: target.intent, roomId: target.roomId,
                                              title: target.title, clientId: target.clientId))
        refreshAudioSnapshot()
        updatePresencePolling()
        updatePreviewDemand()
    }

    private func primaryReason(for target: PremeetingRouteTarget) -> LobbyPrimaryReason {
        let reason = LobbyPrimaryPolicy.reason(intent: target.intent, isSignedIn: inputs.isSignedIn, guestName: guestNameDraft,
                                               isOffline: inputs.isNetworkOffline, updateRequired: inputs.updateRequired)
        // ENT-6: a rejoin with the view model's context joins under the call's own name.
        if target.intent == .rejoin && canRejoin(roomId: target.roomId)
            && (reason == .nameMissingJoin || reason == .nameMissingStart) {
            return LobbyPrimaryReason.none
        }
        // PH20: the speaker join keeps the attendee's identity, so no name is asked for.
        if target.intent == .promotion && (reason == .nameMissingJoin || reason == .nameMissingStart) {
            return LobbyPrimaryReason.none
        }
        return reason
    }

    /// Another lobby opened: the drafts, the form issue, the route choice and presence start fresh. The guest name
    /// seeds from the stored guest record (AppState, pushed as the identity's name). A form error already in the
    /// session belongs to an earlier lobby and is never shown here.
    private func beginLobby(_ target: PremeetingRouteTarget) {
        cancelLobbyTasks()
        lobbyRouteId = target.routeId
        guestNameDraft = inputs.isSignedIn ? "" : DisplayNamePolicy.capped(inputs.accountName)
        inviteCodeDraft = ""
        formIssue = LobbyFormIssue.none
        formIssueBaselineKey = inputs.notice == .formError ? sessionNoticeKey(inputs) : ""
        appliedFormIssueKey = ""
        chosenOutputKind = ""
        chosenInputId = ""
        presenceHasResult = false
        presenceCount = nil
        presenceRoomId = ""
        isStarting = false
    }

    private func clearLobby() {
        cancelLobbyTasks()
        isStarting = false
        if lobbyRouteId != 0 {
            lobbyRouteId = 0
        }
        visibleLobbyRouteId = 0
        setStopAsking(false)
        setLobbyStatus(nil)
        setLobbyMedia(nil)
        setLobbyPresence(nil)
        setLobbyIdentity(nil)
        setLobbyLink(nil)
        setLobbyAudio(nil)
        updatePreviewDemand()
    }

    private func cancelLobbyTasks() {
        stopPresencePolling()
        collisionTask?.cancel()
        collisionTask = nil
        cancelSlowNotice()
        slowNoticeShown = false
    }

    // MARK: - Private: the slow notice (ENT-5, S10 8 c)

    /// The one-shot 8 s footnote while the visible lobby is in Connecting; it publishes `stillConnecting` once per
    /// attempt (S10 0.5 premeeting tokens).
    private func updateSlowNotice(mode: LobbyMode, routeId: Int) {
        let runs = EntrySlowNoticePolicy.runs(mode: mode,
                                              isLobbyVisible: visibleLobbyRouteId == routeId && root.root == .premeeting,
                                              alreadyShown: slowNoticeShown)
        guard runs else {
            cancelSlowNotice()
            return
        }
        guard slowNoticeTask == nil else { return }
        let delay = slowNoticeDelayMillis
        slowNoticeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(1.0, delay) * 1_000_000.0))
            guard !Task.isCancelled else { return }
            self?.slowNoticeFired(routeId: routeId)
        }
    }

    private func slowNoticeFired(routeId: Int) {
        slowNoticeTask = nil
        guard lobbyRouteId == routeId, let status = lobbyStatus, status.mode == .connecting else { return }
        slowNoticeShown = true
        advanceFeedback(.stillConnecting)
        refreshLobby()
    }

    private func cancelSlowNotice() {
        slowNoticeTask?.cancel()
        slowNoticeTask = nil
    }

    /// S10 6 f form errors from the S1 `formError` notice: classified once per notice, cleared when a new attempt
    /// starts; once the invite field showed it stays for this lobby.
    private func updateFormIssue() {
        if inputs.phase == .entering || inputs.phase == .waiting {
            if formIssue.issue != .none || formIssue.inviteCodeInvalid {
                formIssue = LobbyFormIssue(issue: .none, needsInviteCode: formIssue.needsInviteCode, inviteCodeInvalid: false)
            }
            return
        }
        guard inputs.phase == .home, inputs.notice == .formError else { return }
        let key = sessionNoticeKey(inputs)
        guard key != formIssueBaselineKey, key != appliedFormIssueKey else { return }
        appliedFormIssueKey = key
        let classified = LobbyIssuePolicy.classify(formError: inputs.noticeText, enteredInviteCode: inviteCodeDraft)
        formIssue = LobbyFormIssue(issue: classified.issue,
                                   needsInviteCode: classified.needsInviteCode || formIssue.needsInviteCode,
                                   inviteCodeInvalid: classified.inviteCodeInvalid)
    }

    private func refreshMediaSnapshot() {
        guard lobbyRouteId != 0 else { return }
        let name = LobbySnapshotPolicy.avatarName(isSignedIn: inputs.isSignedIn, accountName: inputs.accountName,
                                                  guestName: guestNameDraft)
        setLobbyMedia(LobbySnapshotPolicy.media(
            routeId: lobbyRouteId,
            micIntentOn: inputs.micIntentOn,
            cameraIntentOn: inputs.cameraIntentOn,
            device: device,
            avatarName: name,
            avatarSeed: inputs.isSignedIn ? inputs.accountSeed : ""
        ))
    }

    private func refreshPresenceSnapshot() {
        guard lobbyRouteId != 0, let target = self.target(forRoute: lobbyRouteId) else { return }
        let mode = root.lobbyMode ?? LobbyMode.editing
        let kind = LobbyPresencePolicy.kind(hasResult: presenceHasResult, count: presenceCount, intent: target.intent,
                                            mode: mode)
        setLobbyPresence(LobbyPresenceSnapshot(routeId: lobbyRouteId, kind: kind,
                                               count: kind == .count ? (presenceCount ?? 0) : 0))
    }

    private func refreshAudioSnapshot() {
        guard lobbyRouteId != 0 else { return }
        setLobbyAudio(LobbyAudioPolicy.snapshot(routeId: lobbyRouteId, device: device, chosenOutputKind: chosenOutputKind,
                                                chosenInputId: chosenInputId))
    }

    /// The 10 s poll (S10 0.5 task table): only while the lobby is visible, the app is active and the mode is
    /// `editing`, never for a fresh code or the promotion lobby, and only with a presence hook.
    private func updatePresencePolling() {
        guard let target = topLobbyTarget(), lobbyHooks?.fetchPresence != nil else {
            stopPresencePolling()
            return
        }
        let mode = root.lobbyMode ?? LobbyMode.editing
        let wanted = root.root == .premeeting && LobbyPresencePolicy.polls(
            intent: target.intent, mode: mode, isVisible: visibleLobbyRouteId == target.routeId,
            isAppActive: inputs.isAppActive, roomId: target.roomId)
        guard wanted else {
            stopPresencePolling()
            return
        }
        if presenceTask != nil && presenceRoomId == target.roomId {
            return
        }
        stopPresencePolling()
        presenceRoomId = target.roomId
        let routeId = target.routeId
        let roomId = target.roomId
        presenceTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let presenter = self else { return }
                await presenter.pollPresenceOnce(routeId: routeId, roomId: roomId)
                let interval = presenter.presenceIntervalMillis
                try? await Task.sleep(nanoseconds: UInt64(max(1.0, interval) * 1_000_000.0))
            }
        }
    }

    private func stopPresencePolling() {
        presenceTask?.cancel()
        presenceTask = nil
        presenceRoomId = ""
    }

    private func pollPresenceOnce(routeId: Int, roomId: String) async {
        guard let fetch = lobbyHooks?.fetchPresence else { return }
        presenceFetches += 1
        let count = await fetch(roomId, presenceClientId(routeId: routeId))
        guard !Task.isCancelled, lobbyRouteId == routeId else { return }
        presenceHasResult = true
        presenceCount = count
        refreshPresenceSnapshot()
    }

    /// The tenant a room lives in: the link's client id, else the app's.
    private func presenceClientId(routeId: Int) -> String {
        if let clientId = target(forRoute: routeId)?.clientId, !clientId.isEmpty {
            return clientId
        }
        return lobbyHooks?.resolvedClientId?() ?? ""
    }

    /// S10 6 k: the preview runs while the camera intent is on, the permission is granted and the lobby is visible,
    /// until the call owns the camera. Stopping on the way into the call is the hand-off's job, not a stop.
    private func updatePreviewDemand() {
        guard let hooks = lobbyHooks else { return }
        var wanted = false
        if let target = topLobbyTarget(), visibleLobbyRouteId == target.routeId {
            // PH20 (RECONCILE R22): an attendee publishes nothing, so the promotion lobby's preview is the one camera
            // owner while the viewer plays; the publish latch keeps it off the wire.
            let callOwnsCamera = (root.root == .call && target.intent != .promotion) || previewHandedOff
            wanted = LocalPreviewPolicy.isWanted(cameraIntentOn: inputs.cameraIntentOn, permission: device.cameraPermission,
                                                 isLobbyVisible: true,
                                                 isCallOwningCamera: callOwnsCamera)
        }
        if wanted && !previewRequested {
            previewRequested = true
            hooks.startPreview?(device.isFrontCamera ? LocalCameraFacing.front : LocalCameraFacing.back)
        } else if !wanted && previewRequested {
            previewRequested = false
            if (root.root != .call || promotionRoute != nil || lobbyRouteIsPromotion) && !previewHandedOff {
                hooks.stopPreview?()
            }
        }
    }

    private func handOffPreview() {
        previewHandedOff = true
        previewRequested = false
        let running = device.previewState == .live || device.previewState == .starting
            || device.previewState == .interrupted
        if running {
            lobbyHooks?.handOffPreview?()
        }
    }

    /// C17: check the fresh code, regenerate while it is busy (at most 3 attempts), then join with the last code.
    private func runCollisionCheck(routeId: Int) async {
        var attempt = 1
        while !Task.isCancelled {
            guard let target = self.target(forRoute: routeId), let fetch = lobbyHooks?.fetchPresence else { break }
            let count = await fetch(target.roomId, presenceClientId(routeId: routeId))
            if Task.isCancelled { return }
            guard LobbyCollisionPolicy.shouldRegenerate(count: count, attempt: attempt) else { break }
            replaceTargetRoom(routeId: routeId, roomId: generateRoomCode())
            attempt += 1
        }
        if Task.isCancelled { return }
        collisionTask = nil
        isStarting = false
        guard let target = self.target(forRoute: routeId), topLobbyTarget()?.routeId == routeId else {
            refreshLobby()
            return
        }
        submitJoin(target)
    }

    /// The silent regeneration (R49): the route value keeps its first code (a NavigationStack or NavDisplay key never
    /// changes under the lobby); the target, the title and the join use the new one.
    private func replaceTargetRoom(routeId: Int, roomId: String) {
        var next: [PremeetingRouteTarget] = []
        for target in targets {
            if target.routeId == routeId {
                next.append(PremeetingRouteTarget(routeId: target.routeId, kind: target.kind, intent: target.intent,
                                                  roomId: roomId, title: roomId, joinMode: target.joinMode,
                                                  meetingInviteCode: target.meetingInviteCode,
                                                  webinarInviteCode: target.webinarInviteCode,
                                                  clientId: target.clientId,
                                                  allowRoomCreation: target.allowRoomCreation))
            } else {
                next.append(target)
            }
        }
        targets = next
        refreshLobby()
    }

    private func submitJoin(_ target: PremeetingRouteTarget) {
        let request = LobbyJoinCoordinator.makeRequest(
            target: target,
            isSignedIn: inputs.isSignedIn,
            accountName: inputs.accountName,
            guestName: guestNameDraft,
            enteredInviteCode: inviteCodeDraft,
            needsInviteCode: formIssue.needsInviteCode,
            resolvedClientId: lobbyHooks?.resolvedClientId?() ?? MeetingLinkBuilder.defaultClientId,
            facing: device.isFrontCamera ? LocalCameraFacing.front : LocalCameraFacing.back
        )
        guard let request else {
            refreshLobby()
            return
        }
        formIssue = LobbyFormIssue(issue: .none, needsInviteCode: formIssue.needsInviteCode, inviteCodeInvalid: false)
        joinRequests += 1
        lobbyHooks?.join?(request)
        refreshLobby()
    }

    private func advanceFeedback(_ kind: FeedbackKind) {
        let token = FeedbackToken(sequence: feedbackState.token.sequence + 1, kind: kind)
        feedbackState = MeetingShellFeedbackState(session: feedbackState.session, token: token)
        publishCount += 1
    }

    // MARK: - Private: the webinar landing (ENT-9, S10 12)

    /// Rebuilds the landing snapshot for the landing on top (published only when it changed), then the refetch and the
    /// open wake-up follow. No landing on top clears it and stops both. Called from `refreshLobby()`, so the landing
    /// follows every input and path change; it never calls back into the lobby.
    private func refreshWebinar() {
        guard let target = topWebinarTarget() else {
            clearWebinar()
            return
        }
        if target.routeId != webinarRouteId {
            beginWebinar(target)
        }
        if webinarJoinPending && inputs.phase != .home && inputs.phase != .outcome {
            // The session took the attempt (entering): the phase speaks for it from now on. Until then a Try Again
            // still sees the last attempt's outcome, which no longer describes the landing.
            webinarJoinPending = false
        }
        updateWebinarFormIssue()
        let now = nowMillis()
        let status = webinarStatus(now: now)
        var failure = WebinarLandingFailure.none
        if status == .failed {
            failure = isWebinarFailureShowing() ? WebinarLandingFailure.join : WebinarLandingFailure.lookup
        }
        let answer = webinarAnswer
        let needsName = WebinarLandingPolicy.needsName(isSignedIn: inputs.isSignedIn, accountName: inputs.accountName)
        let linkCode = (target.webinarInviteCode ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        // The field shows once the server asked for a code, or up front when the lookup says one is required and the
        // link carries none (one round trip fewer than waiting for the join's form error).
        let needsInviteCode = webinarNeedsInviteCode || (answer?.requiresInviteCode == true && linkCode.isEmpty)
        let primaryEnabled = root.root == .premeeting && WebinarLandingPolicy.isPrimaryEnabled(
            status: status, needsName: needsName, nameDraft: webinarNameDraft, needsInviteCode: needsInviteCode,
            inviteDraft: webinarInviteDraft, linkHasInviteCode: !linkCode.isEmpty && !webinarNeedsInviteCode)
        setWebinarSnapshot(WebinarLandingSnapshot(
            revision: 0,
            routeId: target.routeId,
            slug: target.roomId,
            status: status,
            tag: WebinarLandingPolicy.tag(status: status, answer: answer, nowMillis: now),
            title: answer?.title ?? "",
            hostName: answer?.hostName ?? "",
            startsAtMillis: answer?.startsAtMillis ?? 0.0,
            endsAtMillis: answer?.endsAtMillis ?? 0.0,
            earlyEntryMinutes: answer?.earlyEntryMinutes ?? 0,
            needsName: needsName,
            nameLimit: DisplayNamePolicy.limit,
            needsInviteCode: needsInviteCode,
            inviteCodeInvalid: webinarInviteInvalid,
            isPrimaryEnabled: primaryEnabled,
            action: WebinarLandingPolicy.action(status),
            failure: failure,
            link: WebinarLandingPolicy.shareLink(slug: target.roomId, serverLink: answer?.link ?? "")
        ))
        updateWebinarRefetch(status: status)
        updateWebinarWake(status: status, now: now)
    }

    /// The status from the attempt first (joining, the wait for the host, a failed join, a form error), else from the
    /// lookup. An ended or cancelled answer ends the wait for the host.
    private func webinarStatus(now: Double) -> WebinarLandingStatus {
        let lookup = WebinarLandingPolicy.lookupStatus(webinarAnswer, nowMillis: now)
        if let join = webinarJoinStatus() {
            if join == .waitingForHost && (lookup == .ended || lookup == .cancelled) {
                return lookup
            }
            return join
        }
        if webinarFormUnavailable {
            return .unavailable
        }
        return lookup
    }

    /// The attempt this landing started, or nil when there is none: Getting You In, then Almost There once the socket
    /// connected (the automatic retry keeps saying it waits for the host), then the S1 join failure's class.
    private func webinarJoinStatus() -> WebinarLandingStatus? {
        guard webinarAttempted else { return nil }
        if isWebinarJoinInFlight() || inputs.phase == .inCall {
            if webinarSilentRetry {
                return .waitingForHost
            }
            return inputs.entrySocketConnected ? WebinarLandingStatus.almostThere : WebinarLandingStatus.joining
        }
        if isWebinarFailureShowing() {
            return WebinarLandingPolicy.joinFailureStatus(category: inputs.joinFailureCategory,
                                                          diagnosticCode: inputs.joinFailureCode,
                                                          serverText: inputs.outcomeServerText)
        }
        return nil
    }

    /// A join this landing started is under way: the hook ran and the session has not taken it yet (still at home, or
    /// still showing the last attempt's outcome), or it is entering, waiting or recovering before the first admission.
    private func isWebinarJoinInFlight() -> Bool {
        guard webinarAttempted else { return false }
        switch inputs.phase {
        case .home, .outcome:
            return webinarJoinPending
        case .entering, .waiting:
            return true
        case .recovering:
            return !inputs.hasBeenAdmittedThisSession
        case .inCall, .leaving:
            return false
        }
    }

    /// The S1 `joinFailed` outcome of this landing's attempt is what the landing shows (an initial failure keeps the
    /// landing on top: `pushLobbyIfAbsent` never covers it).
    private func isWebinarFailureShowing() -> Bool {
        webinarAttempted && !webinarJoinPending && inputs.phase == .outcome && inputs.outcomeKind == .joinFailed
    }

    /// The view model's recoverable form errors after Start Watching (S1 `formError` at home), classified once: an
    /// invite code error reveals the invite field (invalid when the server said so); anything else ("No room found.")
    /// says the webinar isn't available. The attempt is over either way.
    private func updateWebinarFormIssue() {
        guard webinarAttempted, inputs.phase == .home, inputs.notice == .formError else { return }
        let key = sessionNoticeKey(inputs)
        guard key != webinarFormBaselineKey else { return }
        webinarFormBaselineKey = key
        webinarAttempted = false
        webinarJoinPending = false
        webinarSilentRetry = false
        if WebinarLandingPolicy.isInviteCodeError(inputs.noticeText) {
            webinarNeedsInviteCode = true
            webinarInviteInvalid = WebinarLandingPolicy.isInviteCodeInvalid(inputs.noticeText)
            webinarFormUnavailable = false
        } else {
            webinarFormUnavailable = true
        }
    }

    /// Another landing opened: the drafts, the answer and the attempt start fresh. A Rejoin card's connect for an
    /// attendee record (ENT-6) begins on this landing, so its progress and failure show here.
    private func beginWebinar(_ target: PremeetingRouteTarget) {
        stopWebinarRefetch()
        stopWebinarWake()
        webinarRouteId = target.routeId
        webinarAnswer = nil
        webinarNameDraft = ""
        webinarInviteDraft = ""
        webinarNeedsInviteCode = false
        webinarInviteInvalid = false
        webinarFormUnavailable = false
        webinarAttempted = false
        webinarJoinPending = false
        webinarSilentRetry = false
        webinarFormBaselineKey = inputs.notice == .formError ? sessionNoticeKey(inputs) : ""
        webinarLastFetchMillis = 0.0
        if target.intent == .rejoin && canRejoin(roomId: target.roomId) {
            webinarAttempted = true
            webinarJoinPending = true
            webinarSessionSlug = target.roomId
            webinarSessionTitle = target.title
        }
    }

    private func clearWebinar() {
        stopWebinarRefetch()
        stopWebinarWake()
        if webinarRouteId != 0 {
            webinarRouteId = 0
            webinarAnswer = nil
            webinarNameDraft = ""
            webinarInviteDraft = ""
            webinarNeedsInviteCode = false
            webinarInviteInvalid = false
            webinarFormUnavailable = false
            webinarAttempted = false
            webinarJoinPending = false
            webinarSilentRetry = false
            webinarFormBaselineKey = ""
            webinarLastFetchMillis = 0.0
            // The call (if one started here) was recorded on `inCall`; a later meeting never inherits the slug.
            webinarSessionSlug = ""
            webinarSessionTitle = ""
        }
        visibleWebinarRouteId = 0
        setWebinarSnapshot(nil)
    }

    /// The attendee join (`WebinarJoinRequest`): the landing's name (or the identity's), the typed or linked invite code,
    /// the link's client id and the lookup's title. `silent` is the automatic retry from the wait for the host.
    private func sendWebinarJoin(_ target: PremeetingRouteTarget, silent: Bool) {
        let typedCode = webinarInviteDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let linkCode = (target.webinarInviteCode ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var inviteCode: String? = nil
        if !typedCode.isEmpty {
            inviteCode = typedCode
        } else if !linkCode.isEmpty {
            inviteCode = linkCode
        }
        let title = webinarAnswer?.title ?? ""
        let request = WebinarJoinRequest(
            routeId: target.routeId,
            slug: target.roomId,
            displayName: WebinarLandingPolicy.displayName(isSignedIn: inputs.isSignedIn, accountName: inputs.accountName,
                                                          nameDraft: webinarNameDraft),
            isGuest: !inputs.isSignedIn,
            webinarInviteCode: inviteCode,
            clientId: target.clientId,
            title: title
        )
        webinarAttempted = true
        webinarJoinPending = true
        webinarSilentRetry = silent
        webinarFormUnavailable = false
        webinarInviteInvalid = false
        webinarFormBaselineKey = inputs.notice == .formError ? sessionNoticeKey(inputs) : ""
        // Recents record this call by the landing's slug and title (the session's room id becomes the internal room).
        webinarSessionSlug = target.roomId
        webinarSessionTitle = title.isEmpty ? target.title : title
        webinarJoinRequests += 1
        webinarHooks?.join?(request)
        refreshWebinar()
    }

    /// S10 12 f: the wait for the host retries on its own once a fresh answer reads open. Called only when a lookup
    /// answers, so a retry happens at most once per refetch.
    private func retryWaitingForHostIfOpen() {
        guard let target = topWebinarTarget(), let snapshot = webinar, snapshot.routeId == target.routeId,
              snapshot.status == .waitingForHost, !isWebinarJoinInFlight() else { return }
        guard WebinarLandingPolicy.lookupStatus(webinarAnswer, nowMillis: nowMillis()) == .open else { return }
        guard root.root == .premeeting, !inputs.updateRequired else { return }
        sendWebinarJoin(target, silent: true)
    }

    /// The refetch (S10 0.5 task table): only while the landing is visible, the app and scene are active, no call shows,
    /// the status still changes on its own (loading, early, open, the wait for the host) and a lookup hook exists.
    private func updateWebinarRefetch(status: WebinarLandingStatus) {
        let visible = visibleWebinarRouteId != 0 && visibleWebinarRouteId == webinarRouteId
        let wanted = visible && webinarSceneActive && inputs.isAppActive && root.root == .premeeting
            && webinarHooks?.lookup != nil && WebinarLandingPolicy.refetches(status)
        guard wanted else {
            stopWebinarRefetch()
            return
        }
        guard webinarRefetchTask == nil else { return }
        let routeId = webinarRouteId
        webinarRefetchTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let presenter = self else { return }
                let wait = presenter.webinarRefetchWaitMillis()
                if wait <= 0.0 {
                    await presenter.lookUpWebinarOnce(routeId: routeId)
                } else {
                    try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000.0))
                }
            }
        }
    }

    /// Zero when a lookup is due (none yet, Try Again, or the interval passed), else the time left.
    private func webinarRefetchWaitMillis() -> Double {
        guard webinarLastFetchMillis > 0.0 else { return 0.0 }
        return max(0.0, webinarLastFetchMillis + max(1.0, webinarRefetchIntervalMillis) - nowMillis())
    }

    private func stopWebinarRefetch() {
        webinarRefetchTask?.cancel()
        webinarRefetchTask = nil
    }

    /// One lookup. The attempt time is recorded first, so a missing hook or target never spins the loop; a lookup
    /// cancelled before any answer arrived is due again at once when the landing returns.
    private func lookUpWebinarOnce(routeId: Int) async {
        webinarLastFetchMillis = max(1.0, nowMillis())
        guard let lookup = webinarHooks?.lookup, let target = self.target(forRoute: routeId) else { return }
        webinarLookups += 1
        let answer = await lookup(target.roomId, target.clientId ?? "")
        guard webinarRouteId == routeId else { return }
        guard !Task.isCancelled else {
            if webinarAnswer == nil {
                webinarLastFetchMillis = 0.0
            }
            return
        }
        // A failed refetch keeps the last good answer; only a landing with none says "Couldn't load this webinar."
        if answer.outcome == WebinarLookupOutcome.failed && webinarAnswer != nil {
            return
        }
        webinarAnswer = answer
        refreshWebinar()
        retryWaitingForHostIfOpen()
    }

    /// The one open wake-up (S10 0.5 task table): at `startsAt - earlyEntryMinutes` while an early landing is visible
    /// and active, so the early state flips to open without waiting for the refetch.
    private func updateWebinarWake(status: WebinarLandingStatus, now: Double) {
        let visible = visibleWebinarRouteId != 0 && visibleWebinarRouteId == webinarRouteId
        guard visible, webinarSceneActive, inputs.isAppActive, root.root == .premeeting, status == .early,
              let answer = webinarAnswer,
              let delay = WebinarLandingPolicy.openWakeDelayMillis(answer, nowMillis: now) else {
            stopWebinarWake()
            return
        }
        let opensAt = WebinarLandingPolicy.opensAtMillis(answer)
        if webinarOpenWakeTask != nil && webinarWakeAtMillis == opensAt {
            return
        }
        stopWebinarWake()
        webinarWakeAtMillis = opensAt
        let routeId = webinarRouteId
        webinarOpenWakeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(1.0, delay) * 1_000_000.0))
            guard !Task.isCancelled else { return }
            self?.webinarOpenWakeFired(routeId: routeId)
        }
    }

    private func webinarOpenWakeFired(routeId: Int) {
        webinarOpenWakeTask = nil
        webinarWakeAtMillis = 0.0
        guard webinarRouteId == routeId else { return }
        refreshWebinar()
    }

    private func stopWebinarWake() {
        webinarOpenWakeTask?.cancel()
        webinarOpenWakeTask = nil
        webinarWakeAtMillis = 0.0
    }

    /// Equality-guarded on everything but the revision, which counts real changes only.
    private func setWebinarSnapshot(_ value: WebinarLandingSnapshot?) {
        guard let value else {
            guard webinar != nil else { return }
            webinar = nil
            publishCount += 1
            return
        }
        if let current = webinar, current.withRevision(0) == value.withRevision(0) {
            return
        }
        webinarRevision += 1
        webinar = value.withRevision(webinarRevision)
        publishCount += 1
    }

    // MARK: - Private: equality-guarded setters

    private func setPathValue(_ routes: [PremeetingRoute]) {
        guard routes != path else { return }
        let hadAccount = PremeetingPresenter.containsAccount(path)
        path = routes
        publishCount += 1
        if hadAccount && !PremeetingPresenter.containsAccount(routes) {
            // ENT-7 (HD request B4-T3 R3): the Android Account page left the back stack.
            account.didDismiss()
        }
        var kept: [PremeetingRouteTarget] = []
        for target in targets {
            var inPath = false
            for route in routes where route.id == target.routeId {
                inPath = true
            }
            let isPending = pendingTarget?.routeId == target.routeId
            if inPath || isPending {
                kept.append(target)
            }
        }
        targets = kept
    }

    private static func containsAccount(_ routes: [PremeetingRoute]) -> Bool {
        for route in routes where route.kind == .account {
            return true
        }
        return false
    }

    private func setRoot(_ value: PremeetingRootDecision) {
        guard value != root else { return }
        root = value
        publishCount += 1
    }

    private func setOutcome(_ value: OutcomeModel?) {
        guard value != outcome else { return }
        outcome = value
        publishCount += 1
    }

    private func setLobbyStatus(_ value: LobbyStatusSnapshot?) {
        guard value != lobbyStatus else { return }
        lobbyStatus = value
        publishCount += 1
    }

    private func setLobbyMedia(_ value: LobbyMediaSnapshot?) {
        guard value != lobbyMedia else { return }
        lobbyMedia = value
        publishCount += 1
    }

    private func setLobbyPresence(_ value: LobbyPresenceSnapshot?) {
        guard value != lobbyPresence else { return }
        lobbyPresence = value
        publishCount += 1
    }

    private func setLobbyIdentity(_ value: LobbyIdentitySnapshot?) {
        guard value != lobbyIdentity else { return }
        lobbyIdentity = value
        publishCount += 1
    }

    private func setLobbyLink(_ value: LobbyLinkSnapshot?) {
        guard value != lobbyLink else { return }
        lobbyLink = value
        publishCount += 1
    }

    private func setLobbyAudio(_ value: LobbyAudioSnapshot?) {
        guard value != lobbyAudio else { return }
        lobbyAudio = value
        publishCount += 1
    }

    private func setJoinSheet(_ value: Bool) {
        guard value != isJoinSheetPresented else { return }
        isJoinSheetPresented = value
        publishCount += 1
    }

    private func setAccountSheet(_ value: Bool) {
        guard value != isAccountSheetPresented else { return }
        isAccountSheetPresented = value
        publishCount += 1
    }

    private func setUpdatePrompt(_ value: Bool) {
        guard value != isUpdatePromptPresented else { return }
        isUpdatePromptPresented = value
        publishCount += 1
    }

    private func setStopAsking(_ value: Bool) {
        guard value != isStopAskingPresented else { return }
        isStopAskingPresented = value
        publishCount += 1
    }

    private func setSwitchPrompt(_ value: RoomSwitchPrompt?) {
        guard value != switchPrompt else { return }
        switchPrompt = value
        publishCount += 1
    }
}
