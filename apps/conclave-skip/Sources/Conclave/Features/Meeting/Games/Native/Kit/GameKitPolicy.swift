import Foundation

enum GameShellBarContent: String, CaseIterable, Equatable {
    case none, join, start, rematch, promptHost, wordleNextRound, zipNextRound
}

enum GameShellBarPolicy {

    static func content(chrome: GameChromeModel, scene: GameScene, results: GameResultsModel) -> GameShellBarContent {
        switch chrome.phase {
        case GameChromePhase.lobby:
            if !chrome.isHost || scene.lobby.reason == GameLobbyReason.reconnecting { return GameShellBarContent.none }
            if scene.lobby.showsJoin { return GameShellBarContent.join }
            if scene.lobby.reason == GameLobbyReason.joinToStart { return GameShellBarContent.none }
            return GameShellBarContent.start
        case GameChromePhase.results:
            return results.canRematch ? GameShellBarContent.rematch : GameShellBarContent.none
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
