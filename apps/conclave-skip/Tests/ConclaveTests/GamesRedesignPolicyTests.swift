#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct GamesRedesignPolicyTests {

    private func presenter(_ pushes: [GameStageInputs]) -> GameStagePresenter {
        let games = GameStagePresenter()
        games.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        for inputs in pushes {
            games.apply(inputs)
        }
        return games
    }

    private func row(_ id: String, rank: Int, score: Int) -> GameScoreboardRow {
        GameScoreboardRow(id: id, rank: rank, name: id, score: score, isYou: false, isLeader: rank == 1)
    }

    private func headerShowsSeat(_ games: GameStagePresenter) -> Bool {
        let bar = GameShellBarPolicy.content(chrome: games.chrome, scene: games.scene, results: games.results)
        return GameShellHeaderPolicy.showsSeatControl(chrome: games.chrome, sceneKind: games.scene.kind, barContent: bar)
    }

    @Test func everyGameIdGetsItsOwnGlyphAndUnknownIdsFallBack() {
        let ids = ["trivia", "bluff", "would-you-rather", "most-likely-to", "reaction", "imposter", "wordle", "chess", "zip"]
        let glyphs = ids.map { GameGlyphPolicy.glyph(gameId: $0) }
        #expect(Set(glyphs).count == ids.count)
        #expect(!glyphs.contains(.generic))
        #expect(GameGlyphPolicy.glyph(gameId: "pictionary") == .generic)
        #expect(GameGlyphPolicy.glyph(gameId: "") == .generic)
    }

    @Test func lobbyCaptionSpeaksOnlyWhenSomethingBlocksTheStart() {
        #expect(GameLobbyPolicy.caption(reason: .none, isHost: true) == .none)
        #expect(GameLobbyPolicy.caption(reason: .none, isHost: false) == .waitingForHost)
        #expect(GameLobbyPolicy.caption(reason: .hostStarts, isHost: false) == .waitingForHost)
        #expect(GameLobbyPolicy.caption(reason: .joinToStart, isHost: true) == .none)
        #expect(GameLobbyPolicy.caption(reason: .needsPlayers, isHost: true) == .needsPlayers)
        #expect(GameLobbyPolicy.caption(reason: .reconnecting, isHost: false) == .reconnecting)
        #expect(GameLobbyPolicy.showsSpinner(.waitingForHost))
        #expect(!GameLobbyPolicy.showsSpinner(.needsPlayers))
    }

    @Test func podiumLiftsASoleWinnerAndKeepsTiesInTheList() {
        let solo = [row("a", rank: 1, score: 2400), row("b", rank: 2, score: 1900), row("c", rank: 3, score: 1200)]
        #expect(GameKitPodiumPolicy.winner(solo)?.id == "a")
        #expect(GameKitPodiumPolicy.rest(solo).map(\.id) == ["b", "c"])
        let tied = [row("a", rank: 1, score: 900), row("b", rank: 1, score: 900), row("c", rank: 3, score: 100)]
        #expect(GameKitPodiumPolicy.winner(tied) == nil)
        #expect(GameKitPodiumPolicy.rest(tied).count == 3)
        let scoreless = [row("a", rank: 1, score: 0)]
        #expect(GameKitPodiumPolicy.winner(scoreless) == nil)
        #expect(GameKitPodiumPolicy.winner([]) == nil)
    }

    @Test func progressReadsAsCompactCountAndClamps() {
        #expect(GameKitProgressPolicy.text(acted: 4, total: 6) == "4/6")
        #expect(GameKitProgressPolicy.text(acted: 9, total: 6) == "6/6")
        #expect(GameKitProgressPolicy.text(acted: -1, total: 6) == "0/6")
        #expect(GameKitProgressPolicy.text(acted: 3, total: 0).isEmpty)
        #expect(GameKitProgressPolicy.isComplete(acted: 6, total: 6))
        #expect(!GameKitProgressPolicy.isComplete(acted: 0, total: 0))
    }

    @Test func nameStackShowsFiveFacesThenACount() {
        #expect(GameKitNameStackPolicy.overflow(3) == 0)
        #expect(GameKitNameStackPolicy.overflow(5) == 0)
        #expect(GameKitNameStackPolicy.overflow(8) == 3)
    }

    @Test func triviaOutcomeToneMatchesTheRowMarks() {
        #expect(GameKitOutcomePolicy.tone(.correct) == .correct)
        #expect(GameKitOutcomePolicy.tone(.wrong) == .wrongPick)
        #expect(GameKitOutcomePolicy.tone(.timeUp) == .none)
    }

    @Test func hostOverridesAreQuietWhileProgressionStaysProminent() throws {
        let question = presenter(PromptGameFixtures.pushes(.triviaAnswered))
        #expect(PromptScenePolicy.hostAction(question.scene).isOverride)
        let reveal = presenter(PromptGameFixtures.pushes(.triviaReveal))
        #expect(PromptScenePolicy.hostAction(reveal.scene) == .next)
        #expect(!PromptScenePolicy.hostAction(reveal.scene).isOverride)
        let imposterVote = presenter(PromptGameFixtures.pushes(.imposterVote))
        #expect(PromptScenePolicy.hostAction(imposterVote.scene).isOverride)
        let discuss = presenter(PromptGameFixtures.pushes(.imposterCrew))
        let action = PromptScenePolicy.hostAction(discuss.scene)
        #expect(action == .callVote || action == .none)
        #expect(!action.isOverride)
    }

    @Test func joinAppearsOnceForAnUnseatedHostInTheLobby() {
        let lobby = presenter([ActivityFixtureScript.gameInputs(.gameLobbyHostUnseated)])
        #expect(lobby.chrome.seat == .canJoin)
        #expect(GameShellBarPolicy.content(chrome: lobby.chrome, scene: lobby.scene, results: lobby.results) == .join)
        #expect(!headerShowsSeat(lobby))
    }

    @Test func aMidGameSpectatorSeesTheSeatInTheBodyNotTheHeader() {
        let spectator = presenter([ActivityFixtureScript.gameInputs(.gameSpectator)])
        #expect(spectator.chrome.seat != .player)
        #expect(GameShellHeaderPolicy.bodyShowsSeat(chrome: spectator.chrome, sceneKind: spectator.scene.kind))
        #expect(!headerShowsSeat(spectator))
    }

    @Test func seatedPlayersNeverGetAHeaderSeatControl() {
        let host = presenter([ActivityFixtureScript.gameInputs(.gameLobbyHost)])
        #expect(host.chrome.seat == .player)
        #expect(!headerShowsSeat(host))
    }

    @Test func gamesWithoutABodySeatKeepTheHeaderControl() {
        let chrome = GameChromeModel(revision: 1, gameId: "wordle", name: "Wordle", phase: .playing, roundIndex: 1, roundTotal: 3,
                                     seat: .watching, isHost: false, playerCount: 3, pendingCount: 0, isReconnecting: false,
                                     canEnd: false, endPending: false, endFailed: false, isKnownGame: true)
        #expect(!GameShellHeaderPolicy.bodyShowsSeat(chrome: chrome, sceneKind: GameSceneKind.wordle))
        #expect(GameShellHeaderPolicy.showsSeatControl(chrome: chrome, sceneKind: GameSceneKind.wordle, barContent: .none))
        #expect(!GameShellHeaderPolicy.bodyShowsSeat(chrome: chrome, sceneKind: GameSceneKind.chess))
    }
}
#endif
