package conclave.module

import androidx.compose.runtime.Composable

internal fun promptHostActionResource(action: PromptHostAction): String? = when (action) {
    PromptHostAction.none -> null
    PromptHostAction.skipQuestion -> "gm_skip_question"
    PromptHostAction.next -> "gm_next"
    PromptHostAction.skipWriting -> "gm_skip_writing"
    PromptHostAction.revealNow -> "gm_reveal_now"
    PromptHostAction.callVote -> "gm_imp_call_vote"
    PromptHostAction.endVote -> "gm_imp_end_vote"
}

internal fun triviaOutcomeResource(outcome: TriviaOutcome, hasPoints: Boolean): String? = when (outcome) {
    TriviaOutcome.none -> null
    TriviaOutcome.correct -> if (hasPoints) "gm_trivia_correct_points" else "gm_correct"
    TriviaOutcome.wrong -> "gm_trivia_not_quite"
    TriviaOutcome.timeUp -> "gm_trivia_time_up"
}

internal fun reactionPadResource(state: ReactionPadState, hasTime: Boolean): String = when (state) {
    ReactionPadState.wait -> "gm_reaction_wait"
    ReactionPadState.go -> "gm_reaction_go"
    ReactionPadState.early -> "gm_reaction_early"
    ReactionPadState.locked -> "gm_reaction_locked"
    ReactionPadState.measured -> if (hasTime) "gm_ms" else "gm_reaction_locked"
    ReactionPadState.spectating -> "gm_reaction_spectating"
}

internal fun reactionResultResource(outcome: ReactionResultOutcome): String = when (outcome) {
    ReactionResultOutcome.time -> "gm_ms"
    ReactionResultOutcome.early -> "gm_reaction_too_soon_row"
    ReactionResultOutcome.noTap -> "gm_reaction_no_tap"
}

internal fun imposterResultResource(kind: ImposterResultKind): String? = when (kind) {
    ImposterResultKind.none -> null
    ImposterResultKind.crewWins -> "gm_imp_crew_wins"
    ImposterResultKind.imposterWins -> "gm_imp_escapes"
    ImposterResultKind.tie -> "gm_imp_tie"
}

internal fun imposterSecretResource(role: ImposterRole): String? = when (role) {
    ImposterRole.crew -> "gm_imp_word"
    ImposterRole.imposter -> "gm_imp_you"
    ImposterRole.spectator -> null
}

internal fun promptAwardResource(kind: String): String = when (kind) {
    GameSceneKind.bluff -> "gm_bluff_best"
    GameSceneKind.reaction -> "gm_reaction_best"
    else -> "gm_results"
}

@Composable
internal fun promptHostAction(action: PromptHostAction): String {
    val name = promptHostActionResource(action) ?: return ""
    return conclaveString(name)
}

@Composable
internal fun promptTwoFacts(first: String, second: String): String = when {
    first.isEmpty() -> second
    second.isEmpty() -> first
    else -> conclaveString("act_two_facts", first, second)
}

@Composable
internal fun promptDeparted(name: String): String = conclaveString("gm_vote_left", name)

@Composable
internal fun triviaKicker(scene: TriviaScene): String = scene.category

@Composable
internal fun triviaProgress(scene: TriviaScene): String {
    val count = conclaveString("gm_trivia_answered", scene.answeredCount, scene.totalPlayers)
    return if (scene.hasAnswered) promptTwoFacts(conclaveString("gm_trivia_locked"), count) else count
}

@Composable
internal fun triviaOutcome(scene: TriviaScene): String? {
    val name = triviaOutcomeResource(scene.outcome, scene.lastPoints > 0) ?: return null
    return if (name == "gm_trivia_correct_points") conclaveString(name, scene.lastPoints) else conclaveString(name)
}

@Composable
internal fun triviaStanding(scene: TriviaScene): String? {
    if (!scene.isPlayer || scene.rank <= 0) return null
    return promptTwoFacts(conclavePlural("gm_points", scene.score, scene.score), conclaveString("gm_rank", scene.rank))
}

@Composable
internal fun bluffKicker(scene: BluffScene): String = when (scene.phase) {
    "write" -> conclaveString("gm_bluff_write")
    "choose" -> conclaveString("gm_bluff_choose")
    else -> ""
}

@Composable
internal fun bluffRevealLines(option: BluffOptionModel): List<String> {
    val votes = activitiesVotes(maxOf(0, option.votes))
    val lines = mutableListOf<String>()
    lines.add(if (!option.isTruth && option.ownerName.isNotEmpty()) promptTwoFacts(conclaveString("gm_bluff_by", option.ownerName), votes) else votes)
    if (option.isMine) lines.add(conclaveString("gm_bluff_you_picked"))
    if (option.isOwn) lines.add(conclaveString("gm_bluff_own"))
    return lines
}

@Composable
internal fun promptTied(names: Iterable<String>): String {
    val list = names.toList()
    if (list.size < 2) return list.firstOrNull() ?: ""
    return conclaveString("gm_mlt_tied", list.dropLast(1).joinToString(", "), list.last())
}

@Composable
internal fun promptVoteResult(scene: PersonVoteScene): String = when {
    scene.isTie -> promptTied(scene.tiedNames)
    scene.winnerName.isEmpty() -> ""
    else -> conclaveString("gm_mlt_most_votes_announce", scene.winnerName)
}

@Composable
internal fun reactionPadTitle(state: ReactionPadState, ms: Int): String {
    val name = reactionPadResource(state, ms >= 0)
    return if (name == "gm_ms") conclaveString(name, ms) else conclaveString(name)
}

@Composable
internal fun reactionResultValue(row: ReactionResultModel): String {
    val name = reactionResultResource(row.outcome)
    return if (name == "gm_ms") conclaveString(name, row.ms) else conclaveString(name)
}

@Composable
internal fun imposterSecret(scene: ImposterScene): String {
    val name = imposterSecretResource(scene.role) ?: return ""
    return if (scene.role == ImposterRole.crew) {
        conclaveString(name, scene.secretWord) + "\n" + conclaveString("gm_imp_category", scene.category)
    } else {
        conclaveString(name) + "\n" + conclaveString("gm_imp_hint", scene.category)
    }
}

@Composable
internal fun imposterResult(kind: ImposterResultKind): String {
    val name = imposterResultResource(kind) ?: return ""
    return conclaveString(name)
}

@Composable
internal fun imposterFacts(scene: ImposterScene): List<GameKitFactRow> {
    val facts = mutableListOf<GameKitFactRow>()
    if (scene.imposterName.isNotEmpty()) facts.add(GameKitFactRow("imposter", conclaveString("gm_imp_fact_imposter"), scene.imposterName))
    if (scene.revealedWord.isNotEmpty()) facts.add(GameKitFactRow("word", conclaveString("gm_imp_fact_word"), scene.revealedWord))
    return facts
}
