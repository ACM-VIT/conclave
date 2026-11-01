#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct GamesPolishPolicyTests {

    private func presenter(_ pushes: [GameStageInputs]) -> GameStagePresenter {
        let games = GameStagePresenter()
        games.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        for inputs in pushes {
            games.apply(inputs)
        }
        return games
    }

    private func bar(_ games: GameStagePresenter) -> GameShellBarContent {
        GameShellBarPolicy.content(chrome: games.chrome, scene: games.scene, results: games.results)
    }

    @Test func bottomBarFollowsPhaseSeatAndHostRole() {
        #expect(bar(presenter([ActivityFixtureScript.gameInputs(.gameLobbyHost)])) == .start)
        #expect(bar(presenter([ActivityFixtureScript.gameInputs(.gameLobbyHostUnseated)])) == .join)
        #expect(bar(presenter([ActivityFixtureScript.gameInputs(.gameResults)])) == .rematch)
        #expect(bar(presenter([ActivityFixtureScript.gameInputs(.gameUnsupported)])) == .none)
        #expect(bar(presenter(PromptGameFixtures.pushes(.triviaAnswered))) == .promptHost)
        #expect(bar(presenter(PromptGameFixtures.pushes(.imposterVote))) == .promptHost)
        #expect(bar(presenter(WordleFixtures.pushes(.timeout))) == .wordleNextRound)
        #expect(bar(presenter(WordleFixtures.pushes(.roundResults))) == .none)
        #expect(bar(presenter(ZipFixtures.pushes(.timeout, receivedAtMillis: ZipFixtures.serverNow))) == .zipNextRound)
        #expect(bar(presenter(ZipFixtures.pushes(.roundResults, receivedAtMillis: ZipFixtures.serverNow))) == .none)
        #expect(bar(presenter(ZipFixtures.pushes(.playing, receivedAtMillis: ZipFixtures.serverNow))) == .none)
    }

    @Test func bottomBarIsEmptyForGuestsWhileTheHostDrivesTheGame() {
        let games = presenter([ActivityFixtureScript.gameInputs(.gameSpectator)])
        #expect(!games.chrome.isHost)
        #expect(bar(games) == .none)
    }

    @Test func resultsBarOffersEndOnlyWhenTheHeaderCannot() {
        let results = presenter([ActivityFixtureScript.gameInputs(.gameResults)])
        #expect(results.chrome.canEnd)
        #expect(!GameShellBarPolicy.showsResultsEnd(chrome: results.chrome))
        #expect(GameShellBarPolicy.showsResultsEnd(chrome: GameChromeModel.empty))
    }

    @Test func lockedChoicesStayReadableAndOnlyUnmarkedRowsMute() {
        let open = GameKitChoice.make(id: "a", text: "Saturn")
        let picked = GameKitChoice.make(id: "b", text: "Jupiter", isSelected: true, isDisabled: true)
        let correct = GameKitChoice.make(id: "c", text: "Neptune", isCorrect: true, isDisabled: true)
        #expect(!GameKitChoicePolicy.isMuted(open, isInteractive: true))
        #expect(GameKitChoicePolicy.isMuted(open, isInteractive: false))
        #expect(!GameKitChoicePolicy.isMuted(picked, isInteractive: false))
        #expect(!GameKitChoicePolicy.isMuted(correct, isInteractive: false))
        #expect(GameKitChoicePolicy.isInteractive(open, listEnabled: true, pendingId: ""))
        #expect(!GameKitChoicePolicy.isInteractive(open, listEnabled: true, pendingId: "b"))
        #expect(!GameKitChoicePolicy.isInteractive(picked, listEnabled: true, pendingId: ""))
    }

    @Test func answeredTriviaMutesOnlyTheRowsYouDidNotPick() throws {
        let trivia = try #require(presenter(PromptGameFixtures.pushes(.triviaAnswered)).scene.trivia)
        let rows = trivia.kitChoices()
        let muted = rows.filter { GameKitChoicePolicy.isMuted($0, isInteractive: GameKitChoicePolicy.isInteractive($0, listEnabled: trivia.canAnswer, pendingId: "")) }
        #expect(rows.count == 4 && muted.count == 3)
        #expect(rows.filter { $0.mark == GameKitMark.selected }.count == 1)
    }

    @Test func inlineSubmitNeedsTextAndNoPendingMove() {
        #expect(GameKitEntryPolicy.canSubmit(text: "pinkness", isEnabled: true, isPending: false))
        #expect(!GameKitEntryPolicy.canSubmit(text: "  \n", isEnabled: true, isPending: false))
        #expect(!GameKitEntryPolicy.canSubmit(text: "pinkness", isEnabled: true, isPending: true))
        #expect(!GameKitEntryPolicy.canSubmit(text: "pinkness", isEnabled: false, isPending: false))
        let limit = BluffScene.maxBluffLength
        #expect(!GameKitEntryPolicy.showsCounter(count: 0, limit: limit))
        #expect(GameKitEntryPolicy.showsCounter(count: limit, limit: limit))
        #expect(!GameKitEntryPolicy.showsCounter(count: 500, limit: 0))
    }

    @Test func questionTitlesEndWithOneQuestionMark() {
        #expect(GameKitTextPolicy.question("Who’s most likely to text back three days later") == "Who’s most likely to text back three days later?")
        #expect(GameKitTextPolicy.question("Who’s most likely to win?") == "Who’s most likely to win?")
        #expect(GameKitTextPolicy.question("Who’s most likely to say it… ") == "Who’s most likely to say it…")
        #expect(GameKitTextPolicy.question("   ") == "")
    }

    @Test func wouldYouRatherSplitCarriesYourPickAndRelativeFill() throws {
        let reveal = try #require(presenter(PromptGameFixtures.pushes(.wyrReveal)).scene.wouldYouRather)
        let split = reveal.split()
        #expect(split.picked == reveal.myChoice)
        #expect(split.fractionOfTotalA == 1.0 && split.fractionOfTotalB == 0)
        #expect(split.leadsA && !split.leadsB)

        let even = GameKitSplit(labelA: "A", labelB: "B", countA: 2, countB: 2, votersA: [], votersB: [], picked: -1)
        #expect(even.leadsA && even.leadsB && even.fractionOfTotalA == 0.5)
        let empty = GameKitSplit(labelA: "A", labelB: "B", countA: 0, countB: 0, votersA: [], votersB: [], picked: -1)
        #expect(!empty.leadsA && !empty.leadsB && empty.fractionOfTotalA == 0 && empty.fractionOfTotalB == 0)
    }

    @Test func imposterBallotNamesYouTheSameWayAsMostLikelyTo() throws {
        let vote = try #require(presenter(PromptGameFixtures.pushes(.imposterVote)).scene.imposter)
        let mine = try #require(vote.kitChoices(youLabel: "Me").first { $0.id == "you" })
        #expect(mine.text == "Me" && mine.detail.isEmpty && mine.isDisabled)
    }
}
#endif
