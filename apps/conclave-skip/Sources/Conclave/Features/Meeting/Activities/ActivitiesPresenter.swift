import Foundation
import Observation

/// S60 0.5 and 7 (ACT-1): the session-owned Activities launcher presenter. Pushed inputs (`apply`), equality-guarded
/// publishing, no self-observation. Three stored properties, each its own observation unit: `snapshot` (the cold root
/// list: Now Playing, vote, catalog, apps, browser), `setup` (the pushed setup page) and `dismissSignal` (the panel
/// closes once a started activity goes live, the legacy auto-close). The presenter never reads `MeetingState`; the
/// view model performs `onCommand` and reports failures through `commandFailed(_:serverText:)`.
@MainActor
@Observable
final class ActivitiesPresenter {
    private(set) var snapshot: ActivitiesSnapshot = ActivitiesSnapshot.empty
    private(set) var setup: GameSetupModel? = nil
    /// Grows when a started game, app or browser goes live; the panel dismisses on a change (S60 7 a).
    private(set) var dismissSignal: Int = 0

    /// Core only: the view model performs launcher actions (the S1 `onCommand` pattern).
    @ObservationIgnored var onCommand: ((ActivitiesCommand) -> Void)? = nil
    @ObservationIgnored var sleep: (Double) async -> Void = { millis in
        try? await Task.sleep(nanoseconds: UInt64(max(0.0, millis) * 1_000_000.0))
    }

    @ObservationIgnored private(set) var inputs = ActivitiesInputs.make()
    @ObservationIgnored private(set) var game = ActivityGameSummary.none
    @ObservationIgnored private(set) var onStageKind = ""
    /// Diagnostics for readouts and tests (never observed).
    @ObservationIgnored private(set) var commandLog: [String] = []
    @ObservationIgnored private(set) var beginSetupCount = 0

    @ObservationIgnored private var setupGameId = ""
    @ObservationIgnored private var setupPhase = SetupPhase.idle
    @ObservationIgnored private var setupFailureText = ""
    /// Drafts keyed "gameId/optionId"; text drafts are stored without publishing (the field keeps its own text).
    @ObservationIgnored private var drafts: [String: ActivityOptionValue] = [:]
    @ObservationIgnored private var pendingVoteId = ""
    @ObservationIgnored private var endPendingKind = ""
    @ObservationIgnored private var endFailedKind = ""
    @ObservationIgnored private var openPendingAppId = ""
    @ObservationIgnored private var lockPending = false
    @ObservationIgnored private var browserPending = BrowserPhase.idle
    @ObservationIgnored private var browserValidation = BrowserValidation.none
    @ObservationIgnored private var browserFailure = BrowserFailure.none
    @ObservationIgnored private var inlineError = ActivitiesReason.none
    @ObservationIgnored private var inlineErrorText = ""
    /// The kind a start, open or launch is waiting to see live (auto-dismiss).
    @ObservationIgnored private var awaitingLiveKind = ""
    @ObservationIgnored private var slowTask: Task<Void, Never>? = nil
    @ObservationIgnored private var pendingTimeoutTask: Task<Void, Never>? = nil
    @ObservationIgnored private var timerSerial = 0

    init() {}

    // MARK: Core hooks

    /// Core only (S1C 3.2): the cold launcher inputs. A new call session starts clean.
    func apply(_ next: ActivitiesInputs) {
        if inputs.callSession != 0 && next.callSession != inputs.callSession {
            reset()
        }
        let previous = inputs
        inputs = next
        settlePending(previous: previous)
        rebuild()
    }

    /// Core only: the running game's summary, from `GameStagePresenter.summary()` after each game push (equality
    /// guarded, so a move never rebuilds the launcher).
    func applyGameSummary(_ next: ActivityGameSummary) {
        if next == game { return }
        let previous = game
        game = next
        if endPendingKind == ActivityKind.game.rawValue && !next.isActive {
            endPendingKind = ""
        }
        // A new session went live: from nothing, from a finished game (a replacement) or under another game id.
        let newSession = !previous.isActive || previous.isFinished || previous.gameId != next.gameId
        if awaitingLiveKind == ActivityKind.game.rawValue && next.isActive && !next.isFinished && newSession {
            awaitingLiveKind = ""
            setupPhase = SetupPhase.idle
            setupFailureText = ""
            cancelSlowTimer()
            dismissSignal += 1
        }
        rebuild()
    }

    /// Core only: the stage's resolved card (`StagePresenter.onActivityResolved`), for Now Playing's Show.
    func setOnStageActivityKind(_ kind: String) {
        if kind == onStageKind { return }
        onStageKind = kind
        rebuild()
    }

    /// Core only: a launcher command the core could not perform. `serverText` is shown verbatim only where the spec
    /// allows server text (setup failure, inline action failure).
    func commandFailed(_ kind: ActivitiesCommandKind, serverText: String) {
        switch kind {
        case .startGame:
            if setupPhase == SetupPhase.starting || setupPhase == SetupPhase.slow {
                setupPhase = SetupPhase.failed
                setupFailureText = serverText
                cancelSlowTimer()
            } else {
                inlineError = ActivitiesReason.actionFailed
                inlineErrorText = serverText
            }
            awaitingLiveKind = ""
        case .endGame, .closeApp, .closeBrowser:
            endFailedKind = endPendingKind.isEmpty ? kindForEnd(kind) : endPendingKind
            endPendingKind = ""
        case .castVote:
            pendingVoteId = ""
            inlineError = ActivitiesReason.actionFailed
            inlineErrorText = serverText
        case .openApp:
            openPendingAppId = ""
            awaitingLiveKind = ""
            inlineError = ActivitiesReason.actionFailed
            inlineErrorText = serverText
        case .setAppsLocked:
            lockPending = false
            inlineError = ActivitiesReason.actionFailed
            inlineErrorText = serverText
        case .launchBrowser:
            browserPending = BrowserPhase.idle
            browserFailure = BrowserFailure.startFailed
            awaitingLiveKind = ""
        case .navigateBrowser:
            browserPending = BrowserPhase.idle
            browserFailure = BrowserFailure.navigateFailed
        case .refresh, .openVote, .cancelVote, .toggleBrowserAudio:
            inlineError = ActivitiesReason.actionFailed
            inlineErrorText = serverText
        }
        rebuild()
        if let current = setup { publishSetup(current.gameId) }
    }

    // MARK: Actions (views)

    /// Silent refresh on open (two acks, legacy behavior); never blocks the first frame.
    func refresh() {
        send(ActivitiesCommand.make(ActivitiesCommandKind.refresh))
    }

    /// Idempotent: runs from `.task(id:)` / `LaunchedEffect(id)`, so idling on Setup records exactly one call.
    func beginSetup(_ gameId: String) {
        if setupGameId == gameId && setup != nil { return }
        beginSetupCount += 1
        if setupGameId != gameId {
            setupGameId = gameId
            setupPhase = SetupPhase.idle
            setupFailureText = ""
            cancelSlowTimer()
        }
        publishSetup(gameId)
    }

    /// Select and number options republish the setup (they can show or hide others, C6-16).
    func setOption(_ optionId: String, value: String) {
        guard let entry = inputs.game(setupGameId), let option = ActivitiesPresenter.option(optionId, in: entry) else { return }
        let key = setupGameId + "/" + optionId
        switch option.type {
        case GameOptionModel.numberKind:
            drafts[key] = ActivityOptionValue(id: optionId, isNumber: true, number: Double(value) ?? option.defaultNumber, text: "")
        default:
            drafts[key] = ActivityOptionValue(id: optionId, isNumber: false, number: 0, text: value)
        }
        if option.type == GameOptionModel.textKind { return }
        publishSetup(setupGameId)
    }

    /// The draft text as typed (trimmed only on Start). Stored silently: nothing visible depends on it.
    func setText(_ optionId: String, text: String) {
        if setupGameId.isEmpty { return }
        drafts[setupGameId + "/" + optionId] = ActivityOptionValue(id: optionId, isNumber: false, number: 0, text: text)
    }

    /// The text a field starts from (the draft, else the server default).
    func draftText(_ optionId: String) -> String {
        if let draft = drafts[setupGameId + "/" + optionId] { return draft.text }
        guard let entry = inputs.game(setupGameId), let option = ActivitiesPresenter.option(optionId, in: entry) else { return "" }
        return option.defaultString
    }

    func startGame() {
        guard let current = setup, current.canStart, let entry = inputs.game(current.gameId) else { return }
        if setupPhase == SetupPhase.starting || setupPhase == SetupPhase.slow { return }
        var values: [ActivityOptionValue] = []
        for option in entry.options {
            values.append(ActivitiesCatalogPolicy.resolvedForStart(option, draft: drafts[entry.id + "/" + option.id]))
        }
        setupPhase = SetupPhase.starting
        setupFailureText = ""
        awaitingLiveKind = ActivityKind.game.rawValue
        startSlowTimer()
        publishSetup(entry.id)
        send(ActivitiesCommand.make(ActivitiesCommandKind.startGame, id: entry.id, options: values))
    }

    func openVote() {
        if !snapshot.canOpenVote { return }
        send(ActivitiesCommand.make(ActivitiesCommandKind.openVote))
    }

    /// `dispatched` only when a new choice is sent; `ignored` for the current choice, a duplicate or a pending cast;
    /// `explained` while blocked (the view shows the reason). The `voteCast` gesture plays only on `dispatched`.
    func castVote(_ gameId: String) -> ActivityTapResult {
        if inputs.isRecovering || !inputs.isVoteOpen { return ActivityTapResult.explained }
        if gameId == inputs.myVoteId || gameId == pendingVoteId || !pendingVoteId.isEmpty { return ActivityTapResult.ignored }
        pendingVoteId = gameId
        startPendingTimeout()
        rebuild()
        send(ActivitiesCommand.make(ActivitiesCommandKind.castVote, id: gameId))
        return ActivityTapResult.dispatched
    }

    func cancelVote() {
        if !snapshot.canCancelVote { return }
        send(ActivitiesCommand.make(ActivitiesCommandKind.cancelVote))
    }

    /// Starts the vote leader with its defaults; disabled at zero votes (fixes the silent first-candidate start).
    func startLeader() {
        if !snapshot.canStartLeader || snapshot.leaderId.isEmpty { return }
        awaitingLiveKind = ActivityKind.game.rawValue
        send(ActivitiesCommand.make(ActivitiesCommandKind.startGame, id: snapshot.leaderId))
    }

    /// After the confirmation (the invoking surface owns it, R09). `id` is the Now Playing id (the kind raw value). A
    /// second tap while pending is ignored.
    func requestEnd(_ id: String) {
        if !inputs.isHost || inputs.isRecovering || !endPendingKind.isEmpty { return }
        guard let kind = ActivityKind(rawValue: id) else { return }
        endPendingKind = id
        endFailedKind = ""
        startPendingTimeout()
        rebuild()
        switch kind {
        case .game: send(ActivitiesCommand.make(ActivitiesCommandKind.endGame))
        case .app: send(ActivitiesCommand.make(ActivitiesCommandKind.closeApp))
        case .browser: send(ActivitiesCommand.make(ActivitiesCommandKind.closeBrowser))
        }
    }

    func openApp(_ appId: String) {
        if !inputs.isHost || inputs.isRecovering || inputs.isAppsActionInFlight || appId == inputs.activeAppId { return }
        openPendingAppId = appId
        awaitingLiveKind = ActivityKind.app.rawValue
        startPendingTimeout()
        rebuild()
        send(ActivitiesCommand.make(ActivitiesCommandKind.openApp, id: appId))
    }

    func setAppsLocked(_ locked: Bool) {
        if !snapshot.canLockApps || inputs.activeAppId.isEmpty || inputs.isAppsActionInFlight || locked == inputs.isAppsLocked { return }
        lockPending = true
        startPendingTimeout()
        rebuild()
        send(ActivitiesCommand.make(ActivitiesCommandKind.setAppsLocked, flag: locked))
    }

    /// Validates under the field first (never on the stage); a valid URL launches or, while active, navigates.
    func submitBrowserURL(_ url: String) {
        if !inputs.isHost || inputs.isRecovering || browserPending != BrowserPhase.idle { return }
        let validation = BrowserURLValidationPolicy.validate(url)
        browserValidation = validation
        browserFailure = BrowserFailure.none
        if validation != BrowserValidation.none {
            rebuild()
            return
        }
        if inputs.isBrowserActive {
            browserPending = BrowserPhase.navigating
            startPendingTimeout()
            rebuild()
            send(ActivitiesCommand.make(ActivitiesCommandKind.navigateBrowser, text: url))
        } else {
            browserPending = BrowserPhase.launching
            awaitingLiveKind = ActivityKind.browser.rawValue
            startPendingTimeout()
            rebuild()
            send(ActivitiesCommand.make(ActivitiesCommandKind.launchBrowser, text: url))
        }
    }

    /// Typing clears a shown validation (the field explains the newest problem only).
    func clearBrowserValidation() {
        if browserValidation == BrowserValidation.none && browserFailure == BrowserFailure.none { return }
        browserValidation = BrowserValidation.none
        browserFailure = BrowserFailure.none
        rebuild()
    }

    func toggleBrowserAudio() {
        if !inputs.hasBrowserAudio && !inputs.isBrowserActive { return }
        send(ActivitiesCommand.make(ActivitiesCommandKind.toggleBrowserAudio))
    }

    func dismissInlineError() {
        if inlineError == ActivitiesReason.none && endFailedKind.isEmpty { return }
        inlineError = ActivitiesReason.none
        inlineErrorText = ""
        endFailedKind = ""
        rebuild()
    }

    /// With the S1 reset (S1C 3.3 TEAR).
    func reset() {
        cancelSlowTimer()
        cancelPendingTimeout()
        inputs = ActivitiesInputs.make()
        game = ActivityGameSummary.none
        onStageKind = ""
        commandLog = []
        beginSetupCount = 0
        setupGameId = ""
        setupPhase = SetupPhase.idle
        setupFailureText = ""
        drafts = [:]
        pendingVoteId = ""
        endPendingKind = ""
        endFailedKind = ""
        openPendingAppId = ""
        lockPending = false
        browserPending = BrowserPhase.idle
        browserValidation = BrowserValidation.none
        browserFailure = BrowserFailure.none
        inlineError = ActivitiesReason.none
        inlineErrorText = ""
        awaitingLiveKind = ""
        if snapshot.withRevision(0) != ActivitiesSnapshot.empty {
            snapshot = ActivitiesSnapshot.empty.withRevision(snapshot.revision + 1)
        }
        if setup != nil { setup = nil }
    }

    // MARK: Building

    private func send(_ command: ActivitiesCommand) {
        commandLog.append(command.kind.rawValue + (command.id.isEmpty ? "" : ":" + command.id))
        if commandLog.count > 20 { commandLog.removeFirst() }
        onCommand?(command)
    }

    /// Pending flags clear on the state that proves the action happened (never on a guess).
    private func settlePending(previous: ActivitiesInputs) {
        if !pendingVoteId.isEmpty && (inputs.myVoteId == pendingVoteId || !inputs.isVoteOpen) {
            pendingVoteId = ""
        }
        if endPendingKind == ActivityKind.app.rawValue && inputs.activeAppId.isEmpty { endPendingKind = "" }
        if endPendingKind == ActivityKind.browser.rawValue && !inputs.isBrowserActive { endPendingKind = "" }
        if !openPendingAppId.isEmpty && inputs.activeAppId == openPendingAppId { openPendingAppId = "" }
        if lockPending && inputs.isAppsLocked != previous.isAppsLocked { lockPending = false }
        if browserPending == BrowserPhase.launching && inputs.isBrowserActive { browserPending = BrowserPhase.idle }
        if browserPending == BrowserPhase.navigating && previous.isBrowserNavigating && !inputs.isBrowserNavigating {
            browserPending = BrowserPhase.idle
        }
        var becameLive = false
        if awaitingLiveKind == ActivityKind.app.rawValue && !inputs.activeAppId.isEmpty && previous.activeAppId != inputs.activeAppId {
            becameLive = true
        }
        if awaitingLiveKind == ActivityKind.browser.rawValue && inputs.isBrowserActive && !previous.isBrowserActive {
            becameLive = true
        }
        if becameLive {
            awaitingLiveKind = ""
            dismissSignal += 1
        }
    }

    private func rebuild() {
        let isHost = inputs.isHost
        let recovering = inputs.isRecovering
        let gameLive = game.isActive && !game.isFinished
        let role = isHost ? ActivityRole.host : ActivityRole.participant

        var nowPlaying: [NowPlayingModel] = []
        let live = ActivityStagePolicy.liveKinds(activeAppId: inputs.activeAppId, isBrowserActive: inputs.isBrowserActive,
                                                 isGameActive: game.isActive)
        for raw in live {
            guard let kind = ActivityKind(rawValue: raw) else { continue }
            nowPlaying.append(NowPlayingModel(
                id: raw, kind: kind, gameName: kind == ActivityKind.game ? game.name : "",
                appId: kind == ActivityKind.app ? inputs.activeAppId : "",
                browserLabel: kind == ActivityKind.browser ? inputs.browserHostLabel : "",
                round: kind == ActivityKind.game ? game.round : 0, roundTotal: kind == ActivityKind.game ? game.roundTotal : 0,
                playerCount: kind == ActivityKind.game ? game.playerCount : 0,
                isEditingLocked: kind == ActivityKind.app && inputs.isAppsLocked,
                isOnStage: onStageKind == raw, canEnd: isHost && !recovering,
                endPending: endPendingKind == raw, endFailed: endFailedKind == raw))
        }

        var vote: [VoteCandidateModel] = []
        let leader = ActivitiesCatalogPolicy.leader(candidates: inputs.voteCandidates, counts: inputs.voteCounts)
        if inputs.isVoteOpen {
            for candidate in inputs.voteCandidates {
                let mine = pendingVoteId.isEmpty ? candidate.id == inputs.myVoteId : candidate.id == pendingVoteId
                vote.append(VoteCandidateModel(id: candidate.id, name: candidate.name, detail: candidate.detail,
                                               count: ActivitiesCatalogPolicy.voteCount(candidate.id, counts: inputs.voteCounts),
                                               isMine: mine, isLeader: leader?.id == candidate.id))
            }
        }
        let leaderVotes = leader == nil ? 0 : ActivitiesCatalogPolicy.voteCount(leader?.id ?? "", counts: inputs.voteCounts)

        var games: [GameCatalogRow] = []
        let catalogReason = ActivitiesCatalogPolicy.catalogReason(isRecovering: recovering, isVoteOpen: inputs.isVoteOpen, isGameLive: gameLive)
        if isHost {
            for entry in inputs.catalog {
                games.append(GameCatalogRow(id: entry.id, name: entry.name, detail: entry.detail, minPlayers: entry.minPlayers,
                                            maxPlayers: entry.maxPlayers, isPlayable: catalogReason == ActivitiesReason.none,
                                            reason: catalogReason))
            }
        }

        var apps: [AppRowModel] = []
        for appId in inputs.appIds {
            var reason = ActivitiesReason.none
            if !isHost { reason = ActivitiesReason.hostOnly } else if recovering { reason = ActivitiesReason.recovering }
            apps.append(AppRowModel(id: appId, isOpen: appId == inputs.activeAppId,
                                    canOpen: isHost && !recovering && appId != inputs.activeAppId,
                                    reason: reason, isPending: openPendingAppId == appId))
        }
        var appsReason = ActivitiesReason.none
        if !isHost { appsReason = ActivitiesReason.hostOnly } else if inputs.activeAppId.isEmpty { appsReason = ActivitiesReason.noAppOpen }

        var browserReason = ActivitiesReason.none
        if !inputs.isBrowserAvailable { browserReason = ActivitiesReason.browserUnavailable } else if recovering { browserReason = ActivitiesReason.recovering }
        var browserPhase = browserPending
        if browserPhase == BrowserPhase.idle {
            if inputs.isBrowserLaunching { browserPhase = BrowserPhase.launching } else if inputs.isBrowserNavigating { browserPhase = BrowserPhase.navigating }
        }
        if endPendingKind == ActivityKind.browser.rawValue { browserPhase = BrowserPhase.closing }
        let browser = BrowserLauncherModel(
            isAvailable: inputs.isBrowserAvailable, reason: browserReason, isActive: inputs.isBrowserActive, phase: browserPhase,
            validation: browserValidation, failure: inputs.isBrowserAvailable ? browserFailure : BrowserFailure.unavailable,
            hostLabel: inputs.browserHostLabel, provider: inputs.browserProvider, hasAudio: inputs.hasBrowserAudio,
            isAudioMuted: inputs.isBrowserAudioMuted, canControl: inputs.canControlBrowser)

        let candidate = ActivitiesSnapshot(
            revision: snapshot.revision, role: role, nowPlaying: nowPlaying, vote: vote, isVoteOpen: inputs.isVoteOpen,
            voteCast: inputs.voteCastCount, votePlayers: inputs.votePlayers,
            canOpenVote: isHost && !recovering && !inputs.isVoteOpen && !gameLive && inputs.catalog.count >= 2,
            canCancelVote: isHost && !recovering && inputs.isVoteOpen,
            leaderId: leader?.id ?? "", leaderName: leader?.name ?? "", leaderVotes: leaderVotes,
            canStartLeader: isHost && !recovering && inputs.isVoteOpen && leaderVotes > 0,
            games: games, catalogReason: catalogReason, catalogLoading: !inputs.catalogLoaded && inputs.catalog.isEmpty,
            apps: apps, appsLocked: inputs.isAppsLocked, appsLockPending: lockPending && inputs.isAppsActionInFlight,
            canLockApps: isHost, appsReason: appsReason, browser: browser, isRecovering: recovering,
            inlineError: inlineError, inlineErrorServerText: inlineErrorText)
        if candidate != snapshot {
            snapshot = candidate.withRevision(snapshot.revision + 1)
        }
        if setup != nil { publishSetup(setupGameId) }
    }

    private func publishSetup(_ gameId: String) {
        guard let entry = inputs.game(gameId) else {
            if setup != nil { setup = nil }
            return
        }
        var gameDrafts: [ActivityOptionValue] = []
        for option in entry.options {
            if let draft = drafts[entry.id + "/" + option.id] { gameDrafts.append(draft) }
        }
        var options: [GameOptionModel] = []
        for option in entry.options {
            options.append(ActivitiesCatalogPolicy.optionModel(option, among: entry.options, drafts: gameDrafts))
        }
        let gameLive = game.isActive && !game.isFinished
        var reason = ActivitiesCatalogPolicy.catalogReason(isRecovering: inputs.isRecovering, isVoteOpen: inputs.isVoteOpen, isGameLive: gameLive)
        if reason == ActivitiesReason.none && inputs.playersHere < entry.minPlayers { reason = ActivitiesReason.belowPlayerRange }
        if !inputs.isHost { reason = ActivitiesReason.hostOnly }
        let next = GameSetupModel(gameId: entry.id, name: entry.name, detail: entry.detail, options: options,
                                  playersHere: inputs.playersHere, minPlayers: entry.minPlayers, maxPlayers: entry.maxPlayers,
                                  canStart: reason == ActivitiesReason.none, reason: reason, phase: setupPhase,
                                  failureServerText: setupFailureText)
        if next != setup { setup = next }
    }

    private static func option(_ id: String, in entry: ActivityGameInput) -> ActivityOptionInput? {
        for option in entry.options where option.id == id {
            return option
        }
        return nil
    }

    private func kindForEnd(_ kind: ActivitiesCommandKind) -> String {
        switch kind {
        case .closeApp: return ActivityKind.app.rawValue
        case .closeBrowser: return ActivityKind.browser.rawValue
        default: return ActivityKind.game.rawValue
        }
    }

    // MARK: Timers (injectable sleep; never more than one of each)

    private func startSlowTimer() {
        cancelSlowTimer()
        timerSerial += 1
        let serial = timerSerial
        let wait = sleep
        slowTask = Task { @MainActor [weak self] in
            await wait(ActivitiesCatalogPolicy.slowStartMillis)
            if Task.isCancelled { return }
            guard let self = self else { return }
            self.fireSlowTimer(serial: serial)
        }
    }

    /// What the slow timer runs (tests call it directly with the current serial).
    func fireSlowTimer(serial: Int) {
        if serial != timerSerial { return }
        slowTask = nil
        if setupPhase == SetupPhase.starting {
            setupPhase = SetupPhase.slow
            if let current = setup { publishSetup(current.gameId) }
        }
    }

    var currentTimerSerial: Int { timerSerial }

    private func cancelSlowTimer() {
        slowTask?.cancel()
        slowTask = nil
    }

    private func startPendingTimeout() {
        cancelPendingTimeout()
        let wait = sleep
        pendingTimeoutTask = Task { @MainActor [weak self] in
            await wait(ActivitiesCatalogPolicy.pendingTimeoutMillis)
            if Task.isCancelled { return }
            guard let self = self else { return }
            self.firePendingTimeout()
        }
    }

    /// A command the core dropped never leaves a control pending forever (no failure is invented).
    func firePendingTimeout() {
        pendingTimeoutTask = nil
        pendingVoteId = ""
        endPendingKind = ""
        openPendingAppId = ""
        lockPending = false
        browserPending = BrowserPhase.idle
        rebuild()
    }

    private func cancelPendingTimeout() {
        pendingTimeoutTask?.cancel()
        pendingTimeoutTask = nil
    }

    var hasLiveTimers: Bool { slowTask != nil || pendingTimeoutTask != nil }
}
