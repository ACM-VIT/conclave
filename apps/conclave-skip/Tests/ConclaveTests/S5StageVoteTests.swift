#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct S5StageVoteTests {
    private final class Recorder {
        var commands: [GameStageCommand] = []
    }

    private static let voteView = #"{"phase":"vote","index":0,"total":3,"prompt":"to be late","players":[{"id":"you","name":"You"},{"id":"r1","name":"Avery"},{"id":"r2","name":"Ben"}],"counts":{},"votedPlayerIds":[],"answeredCount":0,"totalPlayers":3}"#

    private func scene(phase: String = "vote", mine: String = "{}", isPlayer: Bool = true,
                       isRecovering: Bool = false) -> PersonVoteScene? {
        let projection = GameProjectionParser.parse(gameId: "most-likely-to", publicPhase: phase,
                                                    publicViewJSON: Self.voteView.replacingOccurrences(of: #""phase":"vote""#, with: #""phase":""# + phase + #"""#),
                                                    playerViewJSON: mine)
        guard let projected = projection.mostLikelyTo else { return nil }
        let context = PromptSceneContext.make(localId: "you", isPlayer: isPlayer, isHost: false, isRecovering: isRecovering,
                                              players: ActivityFixtureScript.players(3, includingYou: true), knownPlayers: [])
        return PromptSceneBuilder.mostLikelyTo(projected, context: context)
    }

    private func presenter(_ state: PromptGameFixtureState, recorder: Recorder) -> GameStagePresenter {
        let games = GameStagePresenter()
        games.sleep = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }
        games.onCommand = { command in recorder.commands.append(command) }
        for inputs in PromptGameFixtures.pushes(state) {
            games.apply(inputs)
        }
        return games
    }

    @Test func votingPlayersGetAnAdornmentOnEveryEligibleTileWithTheirPickSelected() throws {
        let adornments = StageTileAdornmentPolicy.adornments(personVote: try #require(scene(mine: #"{"yourVote":"r2"}"#)))
        #expect(adornments.keys.sorted() == ["r1", "r2", "you"])
        #expect(adornments["r1"] == StageTileAdornment(userId: "r1", name: "Avery", isYou: false, isSelected: false))
        #expect(adornments["r2"]?.isSelected == true)
        #expect(adornments["you"]?.isYou == true)
    }

    @Test func noAdornmentOutsideTheVotingPhaseOrForPeopleWhoCannotVote() throws {
        #expect(StageTileAdornmentPolicy.adornments(personVote: try #require(scene(phase: "reveal"))).isEmpty)
        #expect(StageTileAdornmentPolicy.adornments(personVote: try #require(scene(isPlayer: false))).isEmpty)
        #expect(StageTileAdornmentPolicy.adornments(personVote: try #require(scene(isRecovering: true))).isEmpty)
        #expect(StageTileAdornmentPolicy.adornments(personVote: nil).isEmpty)
    }

    @Test func theGamePresenterFeedsTheTilesAndATileVoteSendsTheVoteMove() throws {
        let recorder = Recorder()
        let games = presenter(.mltVote, recorder: recorder)
        let vote = try #require(games.scene.mostLikelyTo)
        let eligible = vote.candidates.filter { $0.isEligible }.map { $0.id }.sorted()
        #expect(!eligible.isEmpty)
        #expect(games.tileAdornments.keys.sorted() == eligible)
        let target = try #require(vote.candidates.first { !$0.isYou && $0.isEligible })
        #expect(games.tileAdornment(for: target.id)?.name == target.name)
        #expect(games.tileAdornment(for: "not-a-player") == nil)

        #expect(games.voteFromTile("not-a-player") == .ignored)
        #expect(recorder.commands.isEmpty)
        #expect(games.voteFromTile(target.id) == .dispatched)
        let command = try #require(recorder.commands.last)
        #expect(command.kind == .move && command.type == "vote")
        #expect(command.payloadJSON.contains(target.id))
    }

    @Test func theRevealClearsTheTileAdornments() {
        let recorder = Recorder()
        let games = presenter(.mltVote, recorder: recorder)
        #expect(!games.tileAdornments.isEmpty)
        for inputs in PromptGameFixtures.pushes(.mltRevealTie) {
            games.apply(inputs)
        }
        #expect(games.tileAdornments.isEmpty)
        games.reset()
        #expect(games.tileAdornments.isEmpty)
    }
}
#endif
