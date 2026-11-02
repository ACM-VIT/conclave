import Foundation

enum GameShellBarContent: String, CaseIterable, Equatable {
    case none, join, start, rematch, promptHost, wordleNextRound, zipNextRound, waitingForHost
}

enum GameShellBarPolicy {

    static func content(chrome: GameChromeModel, scene: GameScene, results: GameResultsModel) -> GameShellBarContent {
        switch chrome.phase {
        case GameChromePhase.lobby:
            if scene.lobby.reason == GameLobbyReason.reconnecting { return GameShellBarContent.none }
            if scene.lobby.showsJoin { return GameShellBarContent.join }
            if !chrome.isHost { return chrome.seat == SeatState.player ? GameShellBarContent.waitingForHost : GameShellBarContent.none }
            if scene.lobby.reason == GameLobbyReason.joinToStart { return GameShellBarContent.none }
            return GameShellBarContent.start
        case GameChromePhase.results:
            if results.canRematch { return GameShellBarContent.rematch }
            return chrome.isHost ? GameShellBarContent.none : GameShellBarContent.waitingForHost
        case GameChromePhase.playing:
            if PromptScenePolicy.hostAction(scene) != PromptHostAction.none { return GameShellBarContent.promptHost }
            if let wordle = scene.wordle, wordle.canAdvanceRound { return GameShellBarContent.wordleNextRound }
            if let zip = scene.zip, zip.canAdvanceRound { return GameShellBarContent.zipNextRound }
            return GameShellBarContent.none
        case GameChromePhase.unsupported:
            return GameShellBarContent.none
        }
    }

    static func showsResultsEnd(chrome: GameChromeModel) -> Bool {
        !chrome.canEnd && !chrome.endPending
    }
}

enum GameKitChoicePolicy {

    static func isMuted(_ choice: GameKitChoice, isInteractive: Bool) -> Bool {
        !isInteractive && choice.mark == GameKitMark.none
    }

    static func isInteractive(_ choice: GameKitChoice, listEnabled: Bool, pendingId: String) -> Bool {
        listEnabled && pendingId.isEmpty && !choice.isDisabled
    }
}

enum GameKitEntryPolicy {

    static func canSubmit(text: String, isEnabled: Bool, isPending: Bool) -> Bool {
        isEnabled && !isPending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func showsCounter(count: Int, limit: Int) -> Bool {
        limit > 0 && count >= max(0, limit - ActivitiesCatalogPolicy.counterLead)
    }
}

enum GameKitTextPolicy {

    static func question(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "" }
        if trimmed.hasSuffix("?") || trimmed.hasSuffix("!") || trimmed.hasSuffix(".") || trimmed.hasSuffix("…") { return trimmed }
        return trimmed + "?"
    }
}

enum GameKitSplitPolicy {

    static func fraction(_ count: Int, total: Int) -> Double {
        if total <= 0 || count <= 0 { return 0.0 }
        return min(1.0, Double(count) / Double(total))
    }

    static func isLeading(_ count: Int, other: Int) -> Bool {
        count > 0 && count >= other
    }
}

enum GameGlyph: String, CaseIterable, Equatable {
    case trivia, bluff, wouldYouRather, mostLikelyTo, reaction, imposter, wordle, chess, zip, generic
}

enum GameGlyphPolicy {

    static func glyph(gameId: String) -> GameGlyph {
        let kind = GameSceneKind.kind(forGameId: gameId)
        if kind == GameSceneKind.trivia { return GameGlyph.trivia }
        if kind == GameSceneKind.bluff { return GameGlyph.bluff }
        if kind == GameSceneKind.wouldYouRather { return GameGlyph.wouldYouRather }
        if kind == GameSceneKind.mostLikelyTo { return GameGlyph.mostLikelyTo }
        if kind == GameSceneKind.reaction { return GameGlyph.reaction }
        if kind == GameSceneKind.imposter { return GameGlyph.imposter }
        if kind == GameSceneKind.wordle { return GameGlyph.wordle }
        if kind == GameSceneKind.chess { return GameGlyph.chess }
        if kind == GameSceneKind.zip { return GameGlyph.zip }
        return GameGlyph.generic
    }
}

enum GameLobbyCaption: String, CaseIterable, Equatable {
    case none, waitingForHost, needsPlayers, reconnecting
}

enum GameLobbyPolicy {

    static func caption(reason: GameLobbyReason, isHost: Bool) -> GameLobbyCaption {
        switch reason {
        case .needsPlayers: return GameLobbyCaption.needsPlayers
        case .reconnecting: return GameLobbyCaption.reconnecting
        case .hostStarts: return isHost ? GameLobbyCaption.none : GameLobbyCaption.waitingForHost
        case .none: return isHost ? GameLobbyCaption.none : GameLobbyCaption.waitingForHost
        case .joinToStart: return GameLobbyCaption.none
        }
    }

    static func showsSpinner(_ caption: GameLobbyCaption) -> Bool {
        caption == GameLobbyCaption.waitingForHost || caption == GameLobbyCaption.reconnecting
    }

    static func bodyCaption(_ caption: GameLobbyCaption, barContent: GameShellBarContent) -> GameLobbyCaption {
        if caption == GameLobbyCaption.waitingForHost && barContent == GameShellBarContent.waitingForHost { return GameLobbyCaption.none }
        return caption
    }
}

enum GameKitPodiumPolicy {

    static func winner(_ rows: [GameScoreboardRow]) -> GameScoreboardRow? {
        guard let first = rows.first, first.rank == 1, first.score > 0 else { return nil }
        let tied = rows.filter { $0.rank == 1 }.count
        return tied == 1 ? first : nil
    }

    static func rest(_ rows: [GameScoreboardRow]) -> [GameScoreboardRow] {
        guard let lead = winner(rows) else { return rows }
        return rows.filter { $0.id != lead.id }
    }
}

enum GameKitProgressPolicy {

    static func text(acted: Int, total: Int) -> String {
        if total <= 0 { return "" }
        return String(max(0, min(acted, total))) + "/" + String(total)
    }

    static func isComplete(acted: Int, total: Int) -> Bool {
        total > 0 && acted >= total
    }
}

enum GameShellHeaderPolicy {

    static func bodyShowsSeat(chrome: GameChromeModel, sceneKind: String) -> Bool {
        if chrome.phase != GameChromePhase.playing || chrome.seat == SeatState.player { return false }
        if sceneKind == GameSceneKind.trivia || sceneKind == GameSceneKind.bluff || sceneKind == GameSceneKind.wouldYouRather
            || sceneKind == GameSceneKind.mostLikelyTo || sceneKind == GameSceneKind.imposter {
            return true
        }
        if sceneKind == GameSceneKind.chess { return chrome.seat == SeatState.canJoin }
        return false
    }

    static func showsSeatControl(chrome: GameChromeModel, sceneKind: String, barContent: GameShellBarContent) -> Bool {
        if chrome.seat == SeatState.player { return false }
        if chrome.seat == SeatState.canJoin && barContent == GameShellBarContent.join { return false }
        return !bodyShowsSeat(chrome: chrome, sceneKind: sceneKind)
    }
}

enum GameKitNameStackPolicy {
    static let visible = 5

    static func overflow(_ count: Int) -> Int {
        max(0, count - visible)
    }
}

enum GameKitOutcomePolicy {

    static func tone(_ outcome: TriviaOutcome) -> GameKitMark {
        switch outcome {
        case .correct: return GameKitMark.correct
        case .wrong: return GameKitMark.wrongPick
        case .none, .timeUp: return GameKitMark.none
        }
    }
}
