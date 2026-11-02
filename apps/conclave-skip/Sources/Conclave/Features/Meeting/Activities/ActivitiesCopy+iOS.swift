#if os(iOS) && !SKIP
import Foundation

enum ActivitiesCopy {

    static func appName(_ appId: String) -> String {
        switch appId {
        case "whiteboard": return ConclaveStrings.text("Whiteboard")
        case "wheel": return ConclaveStrings.text("Spin the Wheel")
        case "watch": return ConclaveStrings.text("Watch Together")
        default: return ConclaveStrings.text("App")
        }
    }

    static func appDetail(_ appId: String) -> String {
        switch appId {
        case "whiteboard": return ConclaveStrings.text("Collaborative whiteboard")
        case "wheel": return ConclaveStrings.text("Random picker for names and choices")
        case "watch": return ConclaveStrings.text("Synced YouTube playback")
        default: return ""
        }
    }

    static func kindName(_ kind: ActivityKind, gameName: String, appId: String) -> String {
        switch kind {
        case .game: return gameName.isEmpty ? ConclaveStrings.text("Game") : gameName
        case .app: return appName(appId)
        case .browser: return ConclaveStrings.text("Shared Browser")
        }
    }

    static func nowPlayingTitle(_ item: NowPlayingModel) -> String {
        kindName(item.kind, gameName: item.gameName, appId: item.appId)
    }

    static func players(_ count: Int) -> String {
        ConclaveStrings.format("Activity Players %lld", count)
    }

    static func nowPlayingStatus(_ item: NowPlayingModel) -> String {
        switch item.kind {
        case .game:
            if item.roundTotal > 0 && item.round > 0 {
                return ConclaveStrings.format("Two Facts %@ %@", ConclaveStrings.format("Round %lld of %lld", item.round, item.roundTotal),
                                              players(item.playerCount))
            }
            return players(item.playerCount)
        case .app:
            return item.isEditingLocked ? ConclaveStrings.text("Editing locked") : ConclaveStrings.text("Live")
        case .browser:
            return item.browserLabel.isEmpty ? ConclaveStrings.text("Live") : item.browserLabel
        }
    }

    static func endTitle(_ item: NowPlayingModel) -> String {
        switch item.kind {
        case .game: return ConclaveStrings.text("End Game…")
        case .app: return ConclaveStrings.format("Close %@…", appName(item.appId))
        case .browser: return ConclaveStrings.text("Close Shared Browser…")
        }
    }

    static func endDialogTitle(_ item: NowPlayingModel) -> String {
        switch item.kind {
        case .game: return ConclaveStrings.format("End %@ for Everyone?", nowPlayingTitle(item))
        case .app: return ConclaveStrings.format("Close %@ for Everyone?", appName(item.appId))
        case .browser: return ConclaveStrings.text("Close the Shared Browser for Everyone?")
        }
    }

    static func endDialogMessage(_ item: NowPlayingModel) -> String {
        switch item.kind {
        case .game: return ConclaveStrings.text("Scores and progress are lost for everyone.")
        case .app: return item.appId == "whiteboard" ? ConclaveStrings.text("The board clears for everyone.")
            : ConclaveStrings.text("Everyone returns to the meeting.")
        case .browser: return ConclaveStrings.text("Everyone returns to the meeting.")
        }
    }

    static func endConfirm(_ item: NowPlayingModel) -> String {
        item.kind == .game ? ConclaveStrings.text("End Game") : ConclaveStrings.text("Close")
    }

    static func reason(_ reason: ActivitiesReason, setup: GameSetupModel? = nil, serverText: String = "") -> String? {
        switch reason {
        case .none: return nil
        case .recovering: return ConclaveStrings.text("Available when you’re reconnected.")
        case .voteOpen: return ConclaveStrings.text("Cancel the vote to pick a game directly.")
        case .gameLive: return ConclaveStrings.text("End the current game to start another.")
        case .belowPlayerRange:
            guard let setup = setup else { return ConclaveStrings.text("Not enough people are here yet.") }
            return ConclaveStrings.format("%@ needs %@ players. %lld people are here.", setup.name,
                                          playerRangeShort(setup.minPlayers, setup.maxPlayers), setup.playersHere)
        case .hostOnly: return ConclaveStrings.text("Only hosts can open apps.")
        case .noAppOpen: return ConclaveStrings.text("Open an app to lock editing.")
        case .browserUnavailable: return ConclaveStrings.text("The shared browser isn’t available on this server.")
        case .noVotes: return ConclaveStrings.text("No votes yet.")
        case .endFailed: return ConclaveStrings.text("Couldn’t end the game.")
        case .actionFailed:
            let trimmed = serverText.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? ConclaveStrings.text("That didn’t go through. Try again.") : trimmed
        }
    }

    static func playerRange(_ minPlayers: Int, _ maxPlayers: Int) -> String {
        if minPlayers == maxPlayers { return players(minPlayers) }
        return ConclaveStrings.format("%lld to %lld players", minPlayers, maxPlayers)
    }

    static func playerRangeShort(_ minPlayers: Int, _ maxPlayers: Int) -> String {
        if minPlayers == maxPlayers { return String(minPlayers) }
        return ConclaveStrings.format("%lld to %lld", minPlayers, maxPlayers)
    }

    static func voteCount(cast: Int, players: Int) -> String {
        ConclaveStrings.format("%lld of %lld voted", cast, players)
    }

    static func voteCountLabel(_ count: Int) -> String {
        ConclaveStrings.format("Activity Votes %lld", count)
    }

    static func startLeaderTitle(_ snapshot: ActivitiesSnapshot) -> String {
        snapshot.leaderVotes > 0 ? ConclaveStrings.format("Start %@", snapshot.leaderName) : ConclaveStrings.text("Start the Leader")
    }

    static func startTitle(_ setup: GameSetupModel) -> String {
        switch setup.phase {
        case .starting, .slow: return ConclaveStrings.text("Starting")
        case .idle, .failed: return ConclaveStrings.format("Start %@", setup.name)
        }
    }

    static func setupFooter(_ setup: GameSetupModel) -> String? {
        switch setup.phase {
        case .slow: return ConclaveStrings.text("Still starting. AI content can take a moment.")
        case .failed:
            let trimmed = setup.failureServerText.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? ConclaveStrings.text("That didn’t go through. Try again.") : trimmed
        case .idle, .starting:
            return reason(setup.reason, setup: setup)
        }
    }

    static func characterCount(_ count: Int, limit: Int) -> String {
        ConclaveStrings.format("%lld of %lld characters", count, limit)
    }

    static func validation(_ value: BrowserValidation) -> String? {
        switch value {
        case .none: return nil
        case .empty: return ConclaveStrings.text("Enter a URL to continue.")
        case .spaces: return ConclaveStrings.text("URLs cannot contain spaces.")
        case .scheme: return ConclaveStrings.text("Only http and https URLs are supported.")
        case .invalid: return ConclaveStrings.text("Enter a valid URL.")
        }
    }

    static func failure(_ value: BrowserFailure) -> String? {
        switch value {
        case .none: return nil
        case .startFailed: return ConclaveStrings.text("The shared browser couldn’t start. Try again.")
        case .navigateFailed, .loadFailed: return ConclaveStrings.text("Couldn’t open that page. Try again.")
        case .unavailable: return ConclaveStrings.text("The shared browser isn’t available on this server.")
        case .timedOut: return ConclaveStrings.text("The shared browser took too long to respond. Try again.")
        }
    }

    static func browserPrimary(_ browser: BrowserLauncherModel) -> String {
        switch browser.phase {
        case .launching: return ConclaveStrings.text("Launching")
        case .navigating: return ConclaveStrings.text("Navigating")
        case .closing: return ConclaveStrings.text("In Progress")
        case .idle: return browser.isActive ? ConclaveStrings.text("Go") : ConclaveStrings.text("Launch Shared Browser")
        }
    }

    static func providerTitle(_ provider: String) -> String {
        switch provider.lowercased() {
        case "chromium", "local", "": return ConclaveStrings.text("Chromium")
        default: return ConclaveStrings.text("Cloud browser")
        }
    }

    static func opening(_ name: String) -> String { ConclaveStrings.format("Opening %@", name) }
    static func couldNotOpen(_ name: String) -> String { ConclaveStrings.format("Couldn’t Open %@", name) }
    static func started(_ name: String) -> String { ConclaveStrings.format("%@ started", name) }
    static func ended(_ name: String) -> String { ConclaveStrings.format("%@ ended", name) }

    static func phaseCopy(_ phase: ActivityCardPhase, name: String) -> String? {
        switch phase {
        case .live: return nil
        case .opening: return opening(name)
        case .failed: return couldNotOpen(name)
        }
    }
}
#endif
