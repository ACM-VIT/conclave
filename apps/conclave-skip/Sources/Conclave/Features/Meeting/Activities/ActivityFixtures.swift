import Foundation

// S60 L6-12 and S20 SL14 (STG-9, ACT-1, ACT-2): activity fixture states layered on the stage fixture. No socket,
// network, audio or capture: the launcher and the game shell receive scripted inputs, and their commands land in a
// recording fake owner (`ActivityFixtureOwner`, the `FakeActivityOwner` of L6-12) that answers the way the server
// would where a fixture needs it. Raw values are launch values (`CONCLAVE_STAGE_FIXTURE` / `conclave.stageFixture`);
// the stage fixture adds them through HD request B4-T8 R8 and calls `ActivityFixtureScript.apply(named:...)`.

enum ActivityFixtureState: String, CaseIterable, Equatable {
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
}

/// Records what a real core would perform and answers like the server where the fixture needs it.
@MainActor
final class ActivityFixtureOwner {
    private(set) var activityCommands: [String] = []
    private(set) var gameEmits: [String] = []
    /// When false, moves stay unanswered so the 10 s timeout cell can run (S60 8 l 8).
    var acknowledgesMoves = true
    /// ACT-7 (HD request B7-T1 R5): the app host fixture's recording owner (Close, Lock Editing, relayed bytes).
    let appHost = AppHostFixtureOwner()
    /// ACT-9 (HD request B8-T1 R3): the browser card fixture's recording owner (navigate, audio, close, refresh).
    let browser = BrowserFixtureOwner()
    var failsEnd = false

    func record(_ command: ActivitiesCommand) {
        var entry = command.kind.rawValue
        if !command.id.isEmpty { entry += ":" + command.id }
        if !command.text.isEmpty { entry += " " + command.text }
        for option in command.options {
            entry += " " + option.id + "=" + (option.isNumber ? ActivitiesCatalogPolicy.numberKey(option.number) : option.text)
        }
        activityCommands.append(entry)
    }

    func record(_ command: GameStageCommand) {
        let event: String
        switch command.kind {
        case .move: event = "game:move " + command.type + (command.payloadJSON.isEmpty ? "" : " " + command.payloadJSON)
        case .join: event = "game:join"
        case .rematch: event = "game:rematch"
        case .end: event = "game:end"
        }
        gameEmits.append(event)
    }

    /// `game.emits` readout (L6-12): count and the last payload.
    func emitsReadout() -> String {
        if gameEmits.isEmpty { return "none" }
        return String(gameEmits.count) + " last=" + (gameEmits.last ?? "")
    }

    func commandsReadout() -> String {
        if activityCommands.isEmpty { return "none" }
        return String(activityCommands.count) + " last=" + (activityCommands.last ?? "")
    }
}

enum ActivityFixtureScript {
    static let localUserId = "you"
    static let serverNow = 1700000600000.0

    static func state(named raw: String) -> ActivityFixtureState? {
        ActivityFixtureState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Whether the fixture opens the Activities panel over the stage (the `activities-*` panel cells).
    static func opensActivitiesPanel(_ state: ActivityFixtureState) -> Bool {
        state.rawValue.hasPrefix("activities-")
    }

    // MARK: Catalog (the nine server games, G/*.ts metadata and options)

    static func choice(_ id: String, _ label: String) -> GameChoiceModel { GameChoiceModel(id: id, label: label) }

    static let topicOption = ActivityOptionInput.make(id: "topic", type: "text", label: "Topic", placeholder: "Movies, space, team lore",
                                                      maxLength: 60)

    static func catalog() -> [ActivityGameInput] {
        [
            ActivityGameInput(id: "trivia", name: "Trivia", detail: "Quick-fire quiz", minPlayers: 1, maxPlayers: 24, options: [
                topicOption,
                ActivityOptionInput.make(id: "questions", type: "number", label: "Questions", min: 3, max: 15, defaultNumber: 7,
                                         presets: [5, 7, 10]),
                ActivityOptionInput.make(id: "pace", type: "select", label: "Pace", defaultString: "normal",
                                         choices: [choice("relaxed", "Relaxed"), choice("normal", "Normal"), choice("fast", "Fast")]),
            ]),
            ActivityGameInput(id: "bluff", name: "Bluff", detail: "Fool the room, find the truth", minPlayers: 2, maxPlayers: 16,
                              options: [topicOption]),
            ActivityGameInput(id: "would-you-rather", name: "Would You Rather", detail: "Pick a side, no wrong answers",
                              minPlayers: 1, maxPlayers: 50, options: [topicOption]),
            ActivityGameInput(id: "most-likely-to", name: "Most Likely To", detail: "Vote who the room picks", minPlayers: 3,
                              maxPlayers: 50, options: [topicOption]),
            ActivityGameInput(id: "reaction", name: "Reaction", detail: "Tap the instant it turns green", minPlayers: 1, maxPlayers: 50,
                              options: []),
            ActivityGameInput(id: "imposter", name: "Imposter", detail: "Spot the faker in the room", minPlayers: 3, maxPlayers: 12,
                              options: [topicOption, ActivityOptionInput.make(id: "category", type: "select", label: "Category",
                                                                              defaultString: "surprise", choices: [
                                choice("surprise", "Surprise me"), choice("Places", "Places"), choice("Food", "Food"),
                                choice("Animals", "Animals"), choice("Jobs", "Jobs"), choice("Sports", "Sports"), choice("Movies", "Movies"),
                              ])]),
            ActivityGameInput(id: "wordle", name: "Wordle", detail: "Guess a hidden five-letter word", minPlayers: 1, maxPlayers: 32,
                              options: [ActivityOptionInput.make(id: "timeLimitMinutes", type: "number", label: "Time limit", min: 1,
                                                                 max: 10, defaultNumber: 3, presets: [1, 2, 3, 5, 10], suffix: "min")]),
            ActivityGameInput(id: "chess", name: "Chess", detail: "Duel a friend, split into teams, or take on the computer",
                              minPlayers: 1, maxPlayers: 32, options: chessOptions()),
            ActivityGameInput(id: "zip", name: "Zip", detail: "Draw one path through every cell", minPlayers: 1, maxPlayers: 32, options: [
                ActivityOptionInput.make(id: "gridSize", type: "select", label: "Grid", defaultString: "6",
                                         choices: [choice("6", "6\u{00D7}6 Easy"), choice("7", "7\u{00D7}7 Medium"),
                                                   choice("8", "8\u{00D7}8 Hard"), choice("9", "9\u{00D7}9 Expert")]),
                ActivityOptionInput.make(id: "rounds", type: "number", label: "Rounds", min: 1, max: 5, defaultNumber: 1, presets: [1, 3, 5]),
                ActivityOptionInput.make(id: "timeLimitMinutes", type: "number", label: "Time limit", min: 1, max: 10, defaultNumber: 3,
                                         presets: [1, 2, 3, 5, 10], suffix: "min"),
            ]),
        ]
    }

    static func chessOptions() -> [ActivityOptionInput] {
        [
            ActivityOptionInput.make(id: "mode", type: "select", label: "Mode", defaultString: "duel",
                                     choices: [choice("duel", "Duel"), choice("teams", "Teams"), choice("computer", "vs Computer")]),
            ActivityOptionInput.make(id: "timeControl", type: "select", label: "Time control", defaultString: "600+0", choices: [
                choice("60+0", "1 min"), choice("120+1", "2 | 1"), choice("180+0", "3 min"), choice("180+2", "3 | 2"),
                choice("300+0", "5 min"), choice("300+3", "5 | 3"), choice("600+0", "10 min"), choice("600+5", "10 | 5"),
                choice("900+10", "15 | 10"), choice("1800+0", "30 min"), choice("unlimited", "No clock"),
            ]),
            ActivityOptionInput.make(id: "rapidFire", type: "select", label: "Rapid fire (auto-move when the per-move timer runs out)",
                                     defaultString: "off", choices: [choice("off", "Off"), choice("10", "10s / move"),
                                                                     choice("20", "20s / move"), choice("30", "30s / move")]),
            ActivityOptionInput.make(id: "takebacks", type: "select", label: "Takebacks", defaultString: "on",
                                     choices: [choice("on", "Allowed"), choice("off", "Off")]),
            ActivityOptionInput.make(id: "side", type: "select", label: "Play as", defaultString: "random",
                                     choices: [choice("random", "Random"), choice("white", "White"), choice("black", "Black")],
                                     showWhenId: "mode", showWhenEquals: ["computer"]),
            ActivityOptionInput.make(id: "difficulty", type: "select", label: "Computer level", defaultString: "medium",
                                     choices: [choice("easy", "Easy"), choice("medium", "Medium"), choice("hard", "Hard")],
                                     showWhenId: "mode", showWhenEquals: ["computer"]),
        ]
    }

    // MARK: Stage layer

    /// What the activity layer adds to the stage fixture inputs (presence and names only, S20 11 j).
    static func stageInputs(named raw: String, base: StageInputs, appId appOverride: String = "") -> StageInputs {
        // ACT-7 app host states (HD request B7-T1 R5) show the app card like `app-opening`; ACT-8 states name their app
        // (HD request B8-T2 R6).
        if AppHostFixtures.isFixture(raw) {
            return stageInputs(named: ActivityFixtureState.appOpening.rawValue, base: base, appId: AppHostFixtures.appId(named: raw))
        }
        // ACT-9 browser states (HD request B8-T1 R3): the browser is live on the stage (presence only).
        if BrowserStageFixtures.isFixture(raw) { return BrowserStageFixtures.stageInputs(named: raw, base: base) }
        // ACT-3 prompt game states (HD request B6-T7 R4), ACT-4 Wordle states (HD request B7-T7 R4), ACT-5 chess and
        // ACT-6 Zip states (HD requests B8-T3 R5, B8-T4 R8); `base` for any other name.
        guard let state = state(named: raw) else {
            if WordleFixtures.state(named: raw) != nil { return WordleFixtures.stageInputs(named: raw, base: base) }
            // ACT-5 chess states (HD request B8-T3 R5).
            if ChessFixtures.state(named: raw) != nil { return ChessFixtures.stageInputs(named: raw, base: base) }
            // ACT-6 Zip states (HD request B8-T4 R8).
            if ZipFixtures.state(named: raw) != nil { return ZipFixtures.stageInputs(named: raw, base: base) }
            return PromptGameFixtures.stageInputs(named: raw, base: base)
        }
        var appId = ""
        var gameActive = false
        var gameName = ""
        switch state {
        case .appAndGame:
            appId = "whiteboard"
            gameActive = true
            gameName = "Trivia"
        case .appOpening, .appFailed:
            appId = appOverride.isEmpty ? "whiteboard" : appOverride
        case .gameTrivia6, .gameLobbyHost, .gameLobbyHostUnseated, .gameSpectator, .gameResults, .gamePrivateLoading, .activitiesGameLive:
            gameActive = true
            gameName = "Trivia"
        case .gameLobbyImposter2:
            gameActive = true
            gameName = "Imposter"
        case .gameUnsupported:
            gameActive = true
            gameName = "Pictionary"
        case .activitiesHostIdle, .activitiesParticipantIdle, .activitiesVote, .activitiesVoteZero, .activitiesRecovering:
            break
        }
        return StageInputs.make(
            callSession: base.callSession, isInCall: base.isInCall, localUserId: base.localUserId, roomLabel: base.roomLabel,
            meetingLink: base.meetingLink, participants: base.participants, viewMode: base.viewMode, viewMaxTiles: base.viewMaxTiles,
            hideTilesWithoutVideo: base.hideTilesWithoutVideo, selfViewMode: base.selfViewMode, selfViewCorner: base.selfViewCorner,
            pinnedUserId: base.pinnedUserId, activeAppId: appId, activeAppName: appId, isBrowserActive: false,
            isGameActive: gameActive, gameName: gameName, screenShareUserId: base.screenShareUserId,
            isLocalScreenSharing: base.isLocalScreenSharing, isWebinarAttendee: false, webinarSpeakerUserId: "",
            isRoomLocked: base.isRoomLocked, captionsOn: base.captionsOn, liveNotes: base.liveNotes,
            isAloneConfirmed: base.isAloneConfirmed, canFlipCamera: base.canFlipCamera, isFrontCamera: base.isFrontCamera,
            routeKind: base.routeKind, routeName: base.routeName, isHandRaised: base.isHandRaised,
            handToggleInFlight: base.handToggleInFlight, isRecovering: state == .activitiesRecovering,
            isMediaPending: base.isMediaPending, joinedAtMillis: base.joinedAtMillis, alwaysShowControls: base.alwaysShowControls,
            isEffectsOpen: base.isEffectsOpen)
    }

    // MARK: Launcher and shell layers

    static func activitiesInputs(_ state: ActivityFixtureState, appId appOverride: String = "") -> ActivitiesInputs {
        let host = state != .activitiesParticipantIdle && state != .gameSpectator
        let appId = state == .appAndGame || state == .appOpening || state == .appFailed
            ? (appOverride.isEmpty ? "whiteboard" : appOverride) : ""
        var voteOpen = false
        var counts: [ActivityVoteCount] = []
        var myVote = ""
        var cast = 0
        if state == .activitiesVote {
            voteOpen = true
            counts = [ActivityVoteCount(gameId: "trivia", count: 3), ActivityVoteCount(gameId: "bluff", count: 1)]
            myVote = "trivia"
            cast = 4
        } else if state == .activitiesVoteZero {
            voteOpen = true
        }
        let all = catalog()
        let candidates = voteOpen ? [all[0], all[1], all[5]] : []
        return ActivitiesInputs.make(callSession: 1, isHost: host, isRecovering: state == .activitiesRecovering, catalog: all,
                                     catalogLoaded: true, isVoteOpen: voteOpen, voteCandidates: candidates, voteCounts: counts,
                                     myVoteId: myVote, voteCastCount: cast, votePlayers: 6, playersHere: 6, activeAppId: appId,
                                     isBrowserAvailable: true)
    }

    static func players(_ count: Int, includingYou: Bool) -> [GamePlayerInput] {
        var result: [GamePlayerInput] = []
        if includingYou { result.append(GamePlayerInput(id: localUserId, name: "You")) }
        var index = 0
        while result.count < count {
            result.append(GamePlayerInput(id: StageFixtureScript.remoteId(index), name: StageFixtureScript.remoteName(index)))
            index += 1
        }
        return result
    }

    static let triviaQuestionView = "{\"phase\":\"question\",\"questionIndex\":2,\"totalQuestions\":7,\"serverNow\":1700000600000,"
        + "\"deadline\":1700000620000,\"questionDurationMs\":20000,\"category\":\"Science\","
        + "\"prompt\":\"Which planet has the most moons?\",\"options\":[\"Jupiter\",\"Saturn\",\"Neptune\",\"Uranus\"],"
        + "\"correctIndex\":null,\"optionCounts\":[],\"answeredCount\":4,\"totalPlayers\":6,"
        + "\"scoreboard\":[{\"id\":\"r1\",\"name\":\"Avery\",\"score\":2400},{\"id\":\"you\",\"name\":\"You\",\"score\":1900},"
        + "{\"id\":\"r2\",\"name\":\"Ben\",\"score\":1200}],\"tiles\":{\"r1\":{\"acted\":true},\"r2\":{\"acted\":true}}}"
    static let triviaPlayerView = "{\"answered\":false,\"choice\":null,\"score\":1900,\"rank\":2,\"lastRoundPoints\":0,\"correct\":null}"
    static let triviaResultsView = "{\"phase\":\"results\",\"questionIndex\":6,\"totalQuestions\":7,\"serverNow\":1700000600000,"
        + "\"deadline\":null,\"answeredCount\":0,\"totalPlayers\":6,\"scoreboard\":[{\"id\":\"r1\",\"name\":\"Avery\",\"score\":2400},"
        + "{\"id\":\"you\",\"name\":\"You\",\"score\":1900},{\"id\":\"r2\",\"name\":\"Ben\",\"score\":1200}],\"tiles\":{}}"
    static let lobbyView = "{\"phase\":\"lobby\",\"serverNow\":1700000600000,\"deadline\":null}"

    static func gameInputs(_ state: ActivityFixtureState) -> GameStageInputs {
        let trivia = catalog()[0]
        let config = [ActivityOptionValue(id: "questions", isNumber: true, number: 7, text: ""),
                      ActivityOptionValue(id: "pace", isNumber: false, number: 0, text: "normal")]
        switch state {
        case .gameTrivia6, .appAndGame, .activitiesGameLive:
            return GameStageInputs.make(callSession: 1, isActive: true, gameId: "trivia", name: "Trivia", phase: "question",
                                        players: players(6, includingYou: true), config: config, options: trivia.options,
                                        minPlayers: trivia.minPlayers, publicViewJSON: triviaQuestionView,
                                        playerViewJSON: triviaPlayerView, localPlayerId: localUserId, isHost: true,
                                        receivedAtMillis: serverNow)
        case .gamePrivateLoading:
            return GameStageInputs.make(callSession: 1, isActive: true, gameId: "trivia", name: "Trivia", phase: "question",
                                        players: players(6, includingYou: true), config: config, options: trivia.options,
                                        minPlayers: trivia.minPlayers, publicViewJSON: triviaQuestionView, playerViewJSON: "",
                                        localPlayerId: localUserId, isHost: true, receivedAtMillis: serverNow)
        case .gameLobbyHost:
            return GameStageInputs.make(callSession: 1, isActive: true, gameId: "trivia", name: "Trivia", phase: "lobby",
                                        players: players(4, includingYou: true),
                                        pendingJoiners: [GamePlayerInput(id: "r9", name: "Dee")], config: config,
                                        options: trivia.options, minPlayers: trivia.minPlayers, publicViewJSON: lobbyView,
                                        localPlayerId: localUserId, isHost: true, receivedAtMillis: serverNow)
        case .gameLobbyHostUnseated:
            return GameStageInputs.make(callSession: 1, isActive: true, gameId: "trivia", name: "Trivia", phase: "lobby",
                                        players: players(3, includingYou: false), canJoinLate: true, config: config,
                                        options: trivia.options, minPlayers: trivia.minPlayers, publicViewJSON: lobbyView,
                                        localPlayerId: "", isHost: true, receivedAtMillis: serverNow)
        case .gameLobbyImposter2:
            return GameStageInputs.make(callSession: 1, isActive: true, gameId: "imposter", name: "Imposter", phase: "lobby",
                                        players: players(2, includingYou: true), options: catalog()[5].options, minPlayers: 3,
                                        publicViewJSON: lobbyView, localPlayerId: localUserId, isHost: true, receivedAtMillis: serverNow)
        case .gameSpectator:
            return GameStageInputs.make(callSession: 1, isActive: true, gameId: "trivia", name: "Trivia", phase: "question",
                                        players: players(5, includingYou: false), canJoinLate: true, config: config,
                                        options: trivia.options, minPlayers: trivia.minPlayers, publicViewJSON: triviaQuestionView,
                                        playerViewJSON: "{\"answered\":false,\"choice\":null,\"score\":0,\"rank\":null,\"lastRoundPoints\":0}",
                                        localPlayerId: "", isHost: false, receivedAtMillis: serverNow)
        case .gameResults:
            return GameStageInputs.make(callSession: 1, isActive: true, gameId: "trivia", name: "Trivia", phase: "results",
                                        players: players(6, includingYou: true), isFinished: true, config: config,
                                        options: trivia.options, minPlayers: trivia.minPlayers, publicViewJSON: triviaResultsView,
                                        playerViewJSON: triviaPlayerView, localPlayerId: localUserId, isHost: true,
                                        receivedAtMillis: serverNow)
        case .gameUnsupported:
            return GameStageInputs.make(callSession: 1, isActive: true, gameId: "pictionary", name: "Pictionary", phase: "drawing",
                                        players: players(4, includingYou: true), publicViewJSON: "{\"phase\":\"drawing\"}",
                                        localPlayerId: localUserId, isHost: true, receivedAtMillis: serverNow)
        case .appOpening, .appFailed, .activitiesHostIdle, .activitiesParticipantIdle, .activitiesVote, .activitiesVoteZero,
             .activitiesRecovering:
            return GameStageInputs.make(callSession: 1)
        }
    }

    /// Feeds the activity session for a fixture name and wires its commands to the recording owner. Returns nil for a
    /// name that is not an activity fixture (the stage fixture keeps its own state).
    @discardableResult
    static func apply(named raw: String, session: ActivitySession, owner: ActivityFixtureOwner) -> ActivityFixtureState? {
        if BrowserStageFixtures.isFixture(raw) {
            // ACT-9 browser states (HD request B8-T1 R3): the scripted browser card.
            BrowserStageFixtures.apply(named: raw, presenter: session.browser, owner: owner.browser)
            return nil
        }
        if AppHostFixtures.isFixture(raw) {
            // ACT-7 app host states (HD request B7-T1 R5): the `app-opening` layer, then the scripted host.
            apply(named: ActivityFixtureState.appOpening.rawValue, session: session, owner: owner)
            let fixtureApp = AppHostFixtures.appId(named: raw)
            if fixtureApp != "whiteboard" {
                // ACT-8 (HD request B8-T2 R6): the launcher names the fixture's app.
                session.applyActivities(activitiesInputs(ActivityFixtureState.appOpening, appId: fixtureApp))
            }
            AppHostFixtures.apply(named: raw, presenter: session.appHost, owner: owner.appHost)
            return nil
        }
        guard let state = state(named: raw) else {
            // ACT-3 prompt game states (HD request B6-T7 R4), ACT-4 Wordle states (HD request B7-T7 R4), ACT-5 chess and
            // ACT-6 Zip states (HD requests B8-T3 R5, B8-T4 R8); nothing for any other name (each returns nil for a name
            // it does not own).
            PromptGameFixtures.apply(named: raw, session: session, owner: owner)
            WordleFixtures.apply(named: raw, session: session, owner: owner)
            // ACT-5 chess states (HD request B8-T3 R5); nil for any other name.
            ChessFixtures.apply(named: raw, session: session, owner: owner)
            // ACT-6 Zip states (HD request B8-T4 R8); nil for any other name.
            ZipFixtures.apply(named: raw, session: session, owner: owner)
            return nil
        }
        session.activities.onCommand = { [weak owner] command in
            owner?.record(command)
        }
        session.games.onCommand = { [weak owner, weak session] command in
            guard let owner = owner else { return }
            owner.record(command)
            guard let session = session else { return }
            if command.kind == GameStageCommandKind.move && owner.acknowledgesMoves {
                session.games.moveAcknowledged(requestId: command.requestId, success: true, serverText: "")
            } else if command.kind == GameStageCommandKind.end && owner.failsEnd {
                session.games.endFailed(serverText: "")
            }
        }
        session.applyActivities(activitiesInputs(state))
        session.applyGame(gameInputs(state))
        if state == .appFailed {
            session.setCardPhase(kind: ActivityStageKind.app, phase: ActivityCardPhase.failed)
        }
        if opensActivitiesPanel(state) {
            session.shell.panels.present(MeetingPanel.activities, from: PanelInvoker.call)
        }
        return state
    }
}
