#if os(iOS) && !SKIP
import Foundation

/// S60 9 g (ACT-3): the one exhaustive copy mapping for the six prompt game scenes on iOS (catalog keys with typed
/// arguments, RC R15). Server text (questions, options, bluffs, names, categories) stays verbatim; two facts on one
/// line use the localized "Two Facts %@ %@", never concatenation. Every enum case is named so a new case fails here.
enum PromptGameCopy {
    // MARK: Shared

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

    static func round(_ number: Int, of total: Int) -> String {
        if total <= 0 || number <= 0 { return "" }
        return ConclaveStrings.format("Round %lld of %lld", number, total)
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

    // MARK: Trivia

    /// "Science · 3 of 7"; "Question · 3 of 7" without a category.
    static func triviaKicker(_ scene: TriviaScene) -> String {
        let label = scene.category.isEmpty ? ConclaveStrings.text("Question") : scene.category
        if scene.questionTotal <= 0 { return label }
        return twoFacts(label, ConclaveStrings.format("%lld of %lld", scene.questionNumber, scene.questionTotal))
    }

    static func triviaWaiting() -> String { ConclaveStrings.text("Waiting for the question.") }

    /// "Answer locked in · 4 of 6 answered", or the count alone before you answer (and for spectators).
    static func triviaProgress(_ scene: TriviaScene) -> String {
        let count = ConclaveStrings.format("%lld of %lld answered", scene.answeredCount, scene.totalPlayers)
        return scene.hasAnswered ? twoFacts(ConclaveStrings.text("Answer locked in"), count) : count
    }

    /// The local player's reveal line (players only; nil for a spectator, INM G7).
    static func triviaOutcome(_ scene: TriviaScene) -> String? {
        switch scene.outcome {
        case .none: return nil
        case .correct:
            return scene.lastPoints > 0 ? ConclaveStrings.format("Correct +%lld", scene.lastPoints) : ConclaveStrings.text("Correct")
        case .wrong: return ConclaveStrings.text("Not quite")
        case .timeUp: return ConclaveStrings.text("Time’s up")
        }
    }

    /// "1900 points · #2" for a seated player with a rank.
    static func triviaStanding(_ scene: TriviaScene) -> String? {
        if !scene.isPlayer || scene.rank <= 0 { return nil }
        return twoFacts(ConclaveStrings.format("Game Points %lld", scene.score), ConclaveStrings.format("Rank Number %lld", scene.rank))
    }

    static func correctAnswer(_ text: String) -> String { ConclaveStrings.format("Correct answer: %@", text) }

    // MARK: Bluff

    static func bluffKicker(_ scene: BluffScene) -> String {
        switch scene.phase {
        case "write": return ConclaveStrings.text("Write a Convincing Lie")
        case "choose": return ConclaveStrings.text("Which One Is the Truth?")
        default: return round(scene.round, of: scene.roundTotal)
        }
    }

    static func bluffField() -> String { ConclaveStrings.text("Your Bluff") }
    static func bluffPlaceholder() -> String { ConclaveStrings.text("Make up a believable answer") }
    static func bluffSubmit() -> String { ConclaveStrings.text("Submit Bluff") }
    static func bluffSubmitted(_ text: String) -> String { ConclaveStrings.format("Submitted: %@", text) }
    static func bluffSubmittedCount(_ scene: BluffScene) -> String {
        ConclaveStrings.format("%lld of %lld submitted", scene.submittedCount, scene.totalPlayers)
    }
    static func bluffChosenCount(_ scene: BluffScene) -> String {
        ConclaveStrings.format("%lld of %lld chose", scene.chosenCount, scene.totalPlayers)
    }
    static func ownBluff() -> String { ConclaveStrings.text("Your bluff") }

    /// The reveal lines of one option: "The truth", or "Bluff by Sam · 2 votes"; plus "You picked this" and "Your bluff".
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

    // MARK: Would You Rather

    static func wouldYouRather() -> String { ConclaveStrings.text("Would You Rather") }
    static func chose(_ done: Int, _ total: Int) -> String { ConclaveStrings.format("%lld of %lld chose", done, total) }
    static func nobodyPicked() -> String { ConclaveStrings.text("Nobody picked this") }
    static func wyrWrapBody() -> String { ConclaveStrings.text("Nice picks. Run it back any time.") }

    // MARK: Most Likely To

    static func mostLikelyTitle(_ prompt: String) -> String { ConclaveStrings.format("Who Is Most Likely %@", prompt) }
    static func mostVotes() -> String { ConclaveStrings.text("Most votes") }

    /// "Tied: Avery and Ben"; three or more names put all but the last in the first slot.
    static func tied(_ names: [String]) -> String {
        if names.count < 2 { return names.first ?? "" }
        let head = names.dropLast().joined(separator: ", ")
        return ConclaveStrings.format("Tied: %@ and %@", head, names[names.count - 1])
    }

    /// The vote result announced once ("Most votes: Sam", or the tie line).
    static func voteResultAnnouncement(_ scene: PersonVoteScene) -> String {
        if scene.isTie { return tied(scene.tiedNames) }
        if scene.winnerName.isEmpty { return "" }
        return ConclaveStrings.format("Most votes: %@", scene.winnerName)
    }

    static func mltWrapBody() -> String { ConclaveStrings.text("No hard feelings, right?") }

    // MARK: Reaction

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

    // MARK: Imposter

    static func holdToReveal() -> String { ConclaveStrings.text("Press and Hold to Reveal Your Word") }

    /// What the held K11 card shows. Built only while the card is held (the view passes it into the card, which
    /// composes it only while shown); a spectator has no card at all.
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

    static func discussKicker(_ scene: ImposterScene) -> String {
        let starts = scene.starterName.isEmpty ? "" : ConclaveStrings.format("%@ starts", scene.starterName)
        return twoFacts(scene.category, starts)
    }

    static func discussBody() -> String { ConclaveStrings.text("Take turns describing the word, but stay vague.") }
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

    static func imposterWas(_ name: String) -> String { ConclaveStrings.format("The imposter was %@", name) }
    static func wordWas(_ word: String) -> String { ConclaveStrings.format("The secret word was %@", word) }

    // MARK: Results awards (S60 9 c)

    static func award(kind: String) -> String {
        switch kind {
        case GameSceneKind.bluff: return bestBluffer()
        case GameSceneKind.reaction: return sharpestReflexes()
        default: return ConclaveStrings.text("Results")
        }
    }
}
#endif
