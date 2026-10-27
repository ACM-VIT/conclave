#if os(iOS) && !SKIP
import Foundation

/// S60 L6-14 (ACT-2): the one exhaustive copy mapping for the game shell on iOS (RC R15 "GameCopy uses keys and typed
/// args"). Server game strings stay verbatim; module error text shows verbatim only for `GameFailure.server`.
enum GameCopy {
    // MARK: Header (S20 11 renders it; S60 8 g supplies the parts)

    static func seatTag(_ seat: SeatState) -> String? {
        switch seat {
        case .player, .canJoin: return nil
        case .joiningNextRound: return ConclaveStrings.text("Joining Next Round")
        case .watching: return ConclaveStrings.text("Watching")
        }
    }

    static func phaseLabel(_ chrome: GameChromeModel) -> String {
        switch chrome.phase {
        case .lobby: return ConclaveStrings.text("Lobby")
        case .playing:
            if chrome.roundTotal > 0 && chrome.roundIndex > 0 {
                return ConclaveStrings.format("Round %lld of %lld", chrome.roundIndex, chrome.roundTotal)
            }
            return ConclaveStrings.text("Live")
        case .results: return ConclaveStrings.text("Results")
        case .unsupported: return ""
        }
    }

    /// "6 players · Lobby", plus "+1 joining" while seats are queued.
    static func headerStatus(_ chrome: GameChromeModel) -> String {
        let phase = phaseLabel(chrome)
        var line = ActivitiesCopy.players(chrome.playerCount)
        if !phase.isEmpty { line = ConclaveStrings.format("Two Facts %@ %@", line, phase) }
        if chrome.pendingCount > 0 {
            line = ConclaveStrings.format("Two Facts %@ %@", line, ConclaveStrings.format("+%lld joining", chrome.pendingCount))
        }
        return line
    }

    // MARK: Lobby (S60 8 f, g)

    static func lobbyLine(_ lobby: GameLobbyModel, gameName: String, isHost: Bool) -> String {
        switch lobby.reason {
        case .none: return ConclaveStrings.text("Start when everyone is in.")
        case .needsPlayers: return ConclaveStrings.format("%@ needs at least %lld players.", gameName, lobby.minPlayers)
        case .joinToStart: return ConclaveStrings.text("Join the game to start it.")
        case .hostStarts: return ConclaveStrings.text("The host starts the game.")
        case .reconnecting: return ConclaveStrings.text("Reconnecting")
        }
    }

    // MARK: Countdown

    static func seconds(_ value: Int) -> String { ConclaveStrings.format("%lld s", value) }
    static func secondsLeft(_ value: Int) -> String { ConclaveStrings.format("Seconds Left %lld", value) }
    static func warning() -> String { ConclaveStrings.text("5 s left") }

    // MARK: Failures and notices (exhaustive)

    static func failure(_ failure: GameFailure, serverText: String) -> String? {
        switch failure {
        case .none: return nil
        case .notAccepted: return ConclaveStrings.text("That move wasn’t accepted. Try again.")
        case .movedOn: return ConclaveStrings.text("The game has moved on.")
        case .slowDown: return ConclaveStrings.text("Slow down a little.")
        case .full: return ConclaveStrings.text("This game is full.")
        case .notSeated: return ConclaveStrings.text("You’re watching this round.")
        case .server:
            let trimmed = serverText.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? ConclaveStrings.text("That move wasn’t accepted. Try again.") : trimmed
        }
    }

    /// K13 titles; kinds whose notice is a single sentence have none.
    static func noticeTitle(_ kind: GameKitNoticeKind) -> String? {
        switch kind {
        case .failure, .spectator, .info: return nil
        case .privateView: return ConclaveStrings.text("Loading Your Game View")
        case .unsupported: return ConclaveStrings.text("This Game Needs a Newer Version of Conclave")
        case .reconnecting: return ConclaveStrings.text("Reconnecting")
        }
    }

    static func privateViewBody() -> String { ConclaveStrings.text("Waiting for the server to send your private view.") }
    static func spectatorBody() -> String { ConclaveStrings.text("You’re watching this round.") }
    static func rolesSecret() -> String { ConclaveStrings.text("You’re watching. Roles are secret.") }
    static func endFailed() -> String { ConclaveStrings.text("Couldn’t end the game. Try again.") }

    // MARK: Results

    static func winnerLine(_ results: GameResultsModel) -> String? {
        if results.winnerName.isEmpty || results.isTie { return nil }
        return ConclaveStrings.format("%@ wins with %@", results.winnerName, score(results.winnerScore))
    }

    static func score(_ value: Int) -> String {
        value.formatted(.number)
    }

    static func scoreRowLabel(_ row: GameScoreboardRow) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .ordinal
        let place = formatter.string(from: NSNumber(value: row.rank)) ?? String(row.rank)
        let name = row.isYou ? ConclaveStrings.text("You") : row.name
        return ConclaveStrings.format("%@ place, %@, %@ points", place, name, score(row.score))
    }

    // MARK: Generic scene (the ACT-2 body for games whose scene lands with ACT-3 to ACT-6)

    static func progress(_ done: Int, _ total: Int) -> String { ConclaveStrings.format("%lld of %lld", done, total) }
}
#endif
