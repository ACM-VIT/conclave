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
/// `root` (the 0.4 call branch), `lobbyStatus` (the lobby), `outcome`, `switchPrompt` and `feedbackState`.
@MainActor
@Observable
final class PremeetingPresenter {
    private(set) var path: [PremeetingRoute] = []
    private(set) var home: HomeSnapshot = HomeSnapshot.empty
    private(set) var root: PremeetingRootDecision = PremeetingRootDecision.home
    private(set) var lobbyStatus: LobbyStatusSnapshot? = nil
    private(set) var outcome: OutcomeModel? = nil
    /// iOS sheet; Android pushes `.account` instead (S10 5).
    private(set) var isJoinSheetPresented = false
    private(set) var isAccountSheetPresented = false
    /// R51: New Meeting, Join, Rejoin and links open the "Update Conclave" explanation instead of the lobby.
    private(set) var isUpdatePromptPresented = false
    private(set) var switchPrompt: RoomSwitchPrompt? = nil
    /// Premeeting async outcomes as tokens (F00 8; S10 0.5): `validationFailed` on a rejected join submit. The root
    /// consumer reads it beside the shell's stream and plays only `DeliveredTokenKinds`.
    private(set) var feedbackState = MeetingShellFeedbackState(session: 0, token: FeedbackToken.baseline)

    /// Core only: the view model forwards commands to the S1 shell. Nil in the L9 fixture and in tests.
    @ObservationIgnored var onCommand: ((PremeetingCommand) -> Void)? = nil
    /// The device store; nil keeps recents in memory (fixture, tests).
    @ObservationIgnored var store: RecentMeetingsStore? = nil
    @ObservationIgnored var nowMillis: () -> Double = { Date().timeIntervalSince1970 * 1000.0 }

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

    init() {
    }

    // MARK: - Diagnostics (tests, fixture self-check)

    var currentInputs: PremeetingInputs { inputs }
    /// Every assignment to a published value (the L9 self-check reads it).
    var snapshotPublishCount: Int { publishCount }
    /// Live presenter tasks (S1C 3.3 TEAR): only the Rejoin wake-up, and only while a card is published.
    var liveTaskCount: Int { rejoinExpiryTask == nil ? 0 : 1 }
    var recentRecords: [RecentMeetingRecord] { records }

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
        publishRoot(decision)
        refreshOutcome(next, decision: decision)

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
        refreshLobbyStatus()

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
        refreshLobbyStatus()
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

    /// The Rejoin card (S10 2 j). The lobby opens with `rejoin` intent; the automatic connect arrives with the
    /// view model's rejoin context (ENT-6, S10 0.8 C3).
    func rejoin() {
        guard !blockedByUpdate() else { return }
        guard let card = home.rejoin else { return }
        for record in records where record.id == card.recentId {
            openOrQueue(targetFromRecord(record, routeId: allocateRouteId(), intent: .rejoin))
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
        #if SKIP
        let account = PremeetingRouteTarget(routeId: allocateRouteId(), kind: .account, intent: .join, roomId: "",
                                            title: "", joinMode: .meeting, meetingInviteCode: nil,
                                            webinarInviteCode: nil, clientId: nil, allowRoomCreation: false)
        targets.append(account)
        setPathValue(path + [account.route])
        #else
        setAccountSheet(true)
        #endif
    }

    func openStoreListing() {
        setUpdatePrompt(false)
    }

    func dismissUpdatePrompt() {
        setUpdatePrompt(false)
    }

    /// Cancel while connecting or waiting: `shell.leave()` (no haptic, Q11).
    func cancelJoin() {
        if let onCommand = onCommand { onCommand(.leave) }
    }

    // MARK: - Outcome

    func performOutcomeAction(_ action: OutcomeAction) {
        switch action {
        case .backHome, .none:
            dismissOutcome()
        case .rejoin, .tryAgain:
            // ENT-6 (S10 0.8 C3): these need the view model's rejoin context; ENT-1 never offers them.
            dismissOutcome()
        }
    }

    func dismissOutcome() {
        if inputs.outcomeId != 0 {
            dismissedOutcomeId = inputs.outcomeId
        }
        publishOutcome(nil)
        if root.showsOutcome {
            publishRoot(PremeetingRootDecision.home)
        }
        setPathValue([])
        refreshLobbyStatus()
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
            refreshLobbyStatus()
        case .prompt:
            let current = busy
                ? EntryPolicies.roomLabel(inputs.roomLabel.isEmpty ? inputs.currentRoomId : inputs.roomLabel)
                : EntryPolicies.roomLabel(lobbyTarget?.roomId ?? "")
            pendingSwitchTarget = parsed
            publishSwitchPrompt(RoomSwitchPrompt(id: nextPromptId, currentLabel: current,
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
        publishSwitchPrompt(nil)
        pendingSwitchTarget = nil
        awaitingHomeTarget = target
        if MeetingRoomSwitchPolicy.isBusy(phase: inputs.phase, lobby: .none) {
            onCommand?(.leave)
        } else {
            awaitingHomeTarget = nil
            setPathValue([makeTarget(from: target, intent: .join).route])
            refreshLobbyStatus()
        }
    }

    /// Stay (Cancel role, Back, scrim): consumes the link.
    func stay(id: Int) {
        guard let prompt = switchPrompt, prompt.id == id else { return }
        publishSwitchPrompt(nil)
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
    }

    /// Lobby and webinar landing open from Home: the stack becomes `[Home, target]`.
    private func openFromHome(_ target: PremeetingRouteTarget) {
        if self.target(forRoute: target.routeId) == nil {
            targets.append(target)
        }
        setPathValue([target.route])
        refreshLobbyStatus()
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

    private func topLobbyTarget() -> PremeetingRouteTarget? {
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
            let id = RecentMeetingsPolicy.recordId(roomId: sessionRoomId, joinMode: next.currentJoinMode)
            recordedRecordId = id
            let role: RecentRole = next.isWebinarAttendee ? RecentRole.attendee : (next.isLocalHost ? RecentRole.host : RecentRole.participant)
            let title = next.roomLabel.isEmpty ? sessionRoomId : next.roomLabel
            records = RecentMeetingsPolicy.upsert(records, RecentMeetingRecord(
                id: id, roomId: sessionRoomId, title: title, joinMode: next.currentJoinMode.rawValue, role: role.rawValue,
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
            publishOutcome(nil)
            return
        }
        publishOutcome(OutcomeModel(id: next.outcomeId, variant: variant, primary: .backHome, secondary: .none,
                                serverDetail: next.outcomeServerText))
    }

    private func refreshLobbyStatus() {
        guard let target = topLobbyTarget() else {
            publishLobbyStatus(nil)
            return
        }
        let mode = root.lobbyMode ?? LobbyMode.editing
        var issue = LobbyIssue.none
        if inputs.updateRequired {
            issue = .updateRequired
        } else if mode == .failed {
            issue = inputs.outcomeServerText.isEmpty ? .failedUnknown : .failedServerText
        } else if inputs.isNetworkOffline && mode == .editing {
            issue = .offline
        }
        var waiting = WaitingKind.standard
        if root.showsReconnecting {
            waiting = .reconnecting
        } else if inputs.isNetworkOffline && mode == .waiting {
            waiting = .offline
        }
        publishLobbyStatus(LobbyStatusSnapshot(
            routeId: target.routeId,
            intent: target.intent,
            mode: mode,
            issue: issue,
            issueServerText: mode == .failed ? inputs.outcomeServerText : "",
            // The stand-in lobby has no Start or Join until ENT-3 brings the join coordinator.
            isPrimaryEnabled: false,
            primaryReason: "",
            showsSlowNotice: false,
            waitingKind: waiting
        ))
    }

    private func advanceFeedback(_ kind: FeedbackKind) {
        let token = FeedbackToken(sequence: feedbackState.token.sequence + 1, kind: kind)
        feedbackState = MeetingShellFeedbackState(session: feedbackState.session, token: token)
        publishCount += 1
    }

    // MARK: - Private: equality-guarded setters

    private func setPathValue(_ routes: [PremeetingRoute]) {
        guard routes != path else { return }
        path = routes
        publishCount += 1
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

    private func publishRoot(_ value: PremeetingRootDecision) {
        guard value != root else { return }
        root = value
        publishCount += 1
    }

    private func publishOutcome(_ value: OutcomeModel?) {
        guard value != outcome else { return }
        outcome = value
        publishCount += 1
    }

    private func publishLobbyStatus(_ value: LobbyStatusSnapshot?) {
        guard value != lobbyStatus else { return }
        lobbyStatus = value
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

    private func publishSwitchPrompt(_ value: RoomSwitchPrompt?) {
        guard value != switchPrompt else { return }
        switchPrompt = value
        publishCount += 1
    }
}
