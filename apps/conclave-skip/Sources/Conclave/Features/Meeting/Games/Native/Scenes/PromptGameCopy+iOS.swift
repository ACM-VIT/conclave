#if os(iOS) && !SKIP
import Foundation

enum PromptGameCopy {

    static func hostAction(_ action: PromptHostAction) -> String {
        switch action {
        case .none: return ""
        case .skipQuestion: return ConclaveStrings.text("Skip Question")
        case .next: return ConclaveStrings.text("Next")
        case .skipWriting: return ConclaveStrings.text("Skip Writing")
        case .revealNow: return ConclaveStrings.text("Reveal Now")
        case .callVote: return ConclaveStrings.text("Call the Vote")
        case .endVote: return ConclaveStrings.text("End Vote")
        }
    }

    static func twoFacts(_ first: String, _ second: String) -> String {
        if first.isEmpty { return second }
        if second.isEmpty { return first }
        return ConclaveStrings.format("Two Facts %@ %@", first, second)
    }

    static func waitingForHost() -> String { ConclaveStrings.text("Waiting for the host") }
    static func voted(_ done: Int, _ total: Int) -> String { ConclaveStrings.format("%lld of %lld voted", done, total) }
    static func votes(_ count: Int) -> String { ConclaveStrings.format("Activity Votes %lld", count) }
    static func departed(_ name: String) -> String { ConclaveStrings.format("%@ left. Vote again.", name) }
    static func wrapTitle() -> String { ConclaveStrings.text("That’s a Wrap") }

    static func triviaKicker(_ scene: TriviaScene) -> String { scene.category }

    static func triviaWaiting() -> String { ConclaveStrings.text("Waiting for the question.") }

    static func triviaProgress(_ scene: TriviaScene) -> String {
        let count = ConclaveStrings.format("%lld of %lld answered", scene.answeredCount, scene.totalPlayers)
        return scene.hasAnswered ? twoFacts(ConclaveStrings.text("Answer locked in"), count) : count
    }

    static func triviaOutcome(_ scene: TriviaScene) -> String? {
        switch scene.outcome {
        case .none: return nil
        case .correct:
            return scene.lastPoints > 0 ? ConclaveStrings.format("Correct +%lld", scene.lastPoints) : ConclaveStrings.text("Correct")
        case .wrong: return ConclaveStrings.text("Not quite")
        case .timeUp: return ConclaveStrings.text("Time’s up")
        }
    }

    static func triviaStanding(_ scene: TriviaScene) -> String? {
        if !scene.isPlayer || scene.rank <= 0 { return nil }
        return twoFacts(ConclaveStrings.format("Game Points %lld", scene.score), ConclaveStrings.format("Rank Number %lld", scene.rank))
    }

    static func correctAnswer(_ text: String) -> String { ConclaveStrings.format("Correct answer: %@", text) }

    static func bluffKicker(_ scene: BluffScene) -> String {
        switch scene.phase {
        case "write": return ConclaveStrings.text("Write a Convincing Lie")
        case "choose": return ConclaveStrings.text("Which One Is the Truth?")
        default: return ""
        }
    }

    static func bluffField() -> String { ConclaveStrings.text("Your Bluff") }
    static func bluffPlaceholder() -> String { ConclaveStrings.text("Make up a believable answer") }
    static func bluffSubmit() -> String { ConclaveStrings.text("Submit Bluff") }
    static func bluffSubmitted(_ text: String) -> String { ConclaveStrings.format("Submitted: %@", text) }
    static func ownBluff() -> String { ConclaveStrings.text("Your bluff") }

    static func bluffRevealLines(_ option: BluffOptionModel) -> [String] {
        var lines: [String] = []
        if option.isTruth {
            lines.append(votes(max(0, option.votes)))
        } else if !option.ownerName.isEmpty {
            lines.append(twoFacts(ConclaveStrings.format("Bluff by %@", option.ownerName), votes(max(0, option.votes))))
        } else {
            lines.append(votes(max(0, option.votes)))
        }
        if option.isMine { lines.append(ConclaveStrings.text("You picked this")) }
        if option.isOwn { lines.append(ownBluff()) }
        return lines
    }

    static func truth() -> String { ConclaveStrings.text("The truth") }
    static func plusPoints(_ points: Int) -> String { ConclaveStrings.format("Plus Points %lld", points) }
    static func bestBluffer() -> String { ConclaveStrings.text("Best bluffer") }

    static func wouldYouRather() -> String { ConclaveStrings.text("Would You Rather") }
    static func chose(_ done: Int, _ total: Int) -> String { ConclaveStrings.format("%lld of %lld chose", done, total) }

    static func mostLikelyTitle(_ prompt: String) -> String {
        GameKitTextPolicy.question(ConclaveStrings.format("Who’s most likely %@", prompt))
    }
    static func mostVotes() -> String { ConclaveStrings.text("Most votes") }

    static func triviaTone(_ scene: TriviaScene) -> GameKitMark { GameKitOutcomePolicy.tone(scene.outcome) }

    static func candidateNote(_ candidate: PersonCandidateModel) -> String {
        var parts: [String] = []
        if candidate.isWinner { parts.append(mostVotes()) }
        if candidate.isMine { parts.append(ConclaveStrings.text("Your answer")) }
        return parts.joined(separator: ", ")
    }

    static func tied(_ names: [String]) -> String {
        if names.count < 2 { return names.first ?? "" }
        let head = names.dropLast().joined(separator: ", ")
        return ConclaveStrings.format("Tied: %@ and %@", head, names[names.count - 1])
    }

    static func voteResultAnnouncement(_ scene: PersonVoteScene) -> String {
        if scene.isTie { return tied(scene.tiedNames) }
        if scene.winnerName.isEmpty { return "" }
        return ConclaveStrings.format("Most votes: %@", scene.winnerName)
    }

    static func padTitle(_ state: ReactionPadState, ms: Int) -> String {
        switch state {
        case .wait: return ConclaveStrings.text("Wait for Green")
        case .go: return ConclaveStrings.text("Tap Now")
        case .early: return ConclaveStrings.text("Too Soon")
        case .locked: return ConclaveStrings.text("Locked In")
        case .measured: return ms >= 0 ? milliseconds(ms) : ConclaveStrings.text("Locked In")
        case .spectating: return ConclaveStrings.text("Players are tapping")
        }
    }

    static func tapNow() -> String { ConclaveStrings.text("Tap Now") }
    static func milliseconds(_ value: Int) -> String { ConclaveStrings.format("%lld ms", value) }
    static func tapped(_ done: Int, _ total: Int) -> String { ConclaveStrings.format("%lld of %lld tapped", done, total) }

    static func resultValue(_ row: ReactionResultModel) -> String {
        switch row.outcome {
        case .time: return milliseconds(row.ms)
        case .early: return ConclaveStrings.text("too soon")
        case .noTap: return ConclaveStrings.text("no tap")
        }
    }

    static func fastest(_ name: String) -> String {
        name.isEmpty ? ConclaveStrings.text("Nobody made it in time") : ConclaveStrings.format("%@ was fastest", name)
    }

    static func sharpestReflexes() -> String { ConclaveStrings.text("Sharpest reflexes") }

    static func holdToReveal() -> String { ConclaveStrings.text("Press and Hold to Reveal Your Word") }

    static func secret(_ scene: ImposterScene) -> String {
        switch scene.role {
        case .crew:
            return ConclaveStrings.format("Your word: %@", scene.secretWord) + "\n" + ConclaveStrings.format("Category: %@", scene.category)
        case .imposter:
            return ConclaveStrings.text("You’re the Imposter") + "\n"
                + ConclaveStrings.format("Blend in. You don’t know the word. Category: %@", scene.category)
        case .spectator:
            return ""
        }
    }

    static func voteTitle() -> String { ConclaveStrings.text("Who’s the Imposter?") }
    static func abstained() -> String { ConclaveStrings.text("You didn’t vote.") }

    static func result(_ kind: ImposterResultKind) -> String {
        switch kind {
        case .none: return ""
        case .crewWins: return ConclaveStrings.text("Crew Wins, Imposter Caught")
        case .imposterWins: return ConclaveStrings.text("The Imposter Escapes")
        case .tie: return ConclaveStrings.text("Tie, the Imposter Survives")
        }
    }

    static func imposterFacts(_ scene: ImposterScene) -> [GameKitFact] {
        var facts: [GameKitFact] = []
        if !scene.imposterName.isEmpty {
            facts.append(GameKitFact(id: "imposter", label: ConclaveStrings.text("Imposter"), value: scene.imposterName))
        }
        if !scene.revealedWord.isEmpty {
            facts.append(GameKitFact(id: "word", label: ConclaveStrings.text("Secret Word"), value: scene.revealedWord))
        }
        return facts
    }

}
#endif
