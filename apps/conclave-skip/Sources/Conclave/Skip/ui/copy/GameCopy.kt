package conclave.module

import androidx.compose.runtime.Composable
import java.text.NumberFormat

/*
 * S60 L6-14 (ACT-2): the one exhaustive copy mapping for the game shell on Android (RC R15 "GameCopy uses keys and
 * typed args"): a `when` to gm_ resources resolved by name, plurals through conclavePlural. Server game strings stay
 * verbatim; module error text shows verbatim only for GameFailure.server.
 */

internal fun gameSeatTagResource(seat: SeatState): String? = when (seat) {
    SeatState.player, SeatState.canJoin -> null
    SeatState.joiningNextRound -> "gm_joining_next"
    SeatState.watching -> "gm_watching"
}

@Composable
internal fun gamePhaseLabel(chrome: GameChromeModel): String = when (chrome.phase) {
    GameChromePhase.lobby -> conclaveString("gm_lobby")
    GameChromePhase.playing -> if (chrome.roundTotal > 0 && chrome.roundIndex > 0) {
        conclaveString("act_round_of", chrome.roundIndex, chrome.roundTotal)
    } else {
        conclaveString("act_live")
    }
    GameChromePhase.results -> conclaveString("gm_results")
    GameChromePhase.unsupported -> ""
}

/** "6 players · Lobby", plus "+1 joining" while seats are queued. */
@Composable
internal fun gameHeaderStatus(chrome: GameChromeModel): String {
    val phase = gamePhaseLabel(chrome)
    var line = activitiesPlayers(chrome.playerCount)
    if (phase.isNotEmpty()) line = conclaveString("act_two_facts", line, phase)
    if (chrome.pendingCount > 0) {
        line = conclaveString("act_two_facts", line, conclavePlural("gm_joining_count", chrome.pendingCount, chrome.pendingCount))
    }
    return line
}

internal fun gameLobbyLineResource(reason: GameLobbyReason): String = when (reason) {
    GameLobbyReason.none -> "gm_host_start_hint"
    GameLobbyReason.needsPlayers -> "gm_needs_players"
    GameLobbyReason.joinToStart -> "gm_join_to_start"
    GameLobbyReason.hostStarts -> "gm_participant_start_hint"
    GameLobbyReason.reconnecting -> "gm_reconnecting"
}

@Composable
internal fun gameLobbyLine(lobby: GameLobbyModel, gameName: String): String =
    if (lobby.reason == GameLobbyReason.needsPlayers) conclaveString("gm_needs_players", gameName, lobby.minPlayers)
    else conclaveString(gameLobbyLineResource(lobby.reason))

internal fun gameFailureResource(failure: GameFailure): String? = when (failure) {
    GameFailure.none -> null
    GameFailure.notAccepted -> "gm_err_not_accepted"
    GameFailure.movedOn -> "gm_err_moved_on"
    GameFailure.slowDown -> "gm_err_slow_down"
    GameFailure.full -> "gm_err_full"
    GameFailure.notSeated -> "gm_err_not_seated"
    GameFailure.server -> "gm_err_not_accepted"
}

@Composable
internal fun gameFailure(failure: GameFailure, serverText: String): String? {
    if (failure == GameFailure.server && serverText.trim().isNotEmpty()) return serverText.trim()
    val name = gameFailureResource(failure) ?: return null
    return conclaveString(name)
}

/** K13 titles; single-sentence kinds have none. */
internal fun gameNoticeTitleResource(kind: GameKitNoticeKind): String? = when (kind) {
    GameKitNoticeKind.failure, GameKitNoticeKind.spectator, GameKitNoticeKind.info -> null
    GameKitNoticeKind.privateView -> "gm_private_loading_title"
    GameKitNoticeKind.unsupported -> "gm_unsupported"
    GameKitNoticeKind.reconnecting -> "gm_reconnecting"
}

@Composable
internal fun gameSeconds(value: Int): String = conclaveString("gm_seconds", value)

@Composable
internal fun gameSecondsLeft(value: Int): String = conclavePlural("gm_seconds_left", value, value)

@Composable
internal fun gameWinnerLine(results: GameResultsModel): String? {
    if (results.winnerName.isEmpty() || results.isTie) return null
    return conclaveString("gm_wins_with", results.winnerName, gameScore(results.winnerScore))
}

internal fun gameScore(value: Int): String = NumberFormat.getIntegerInstance().format(value.toLong())

@Composable
internal fun gameScoreRowLabel(row: GameScoreboardRow): String {
    val name = if (row.isYou) conclaveString("ds_you") else row.name
    return conclaveString("gm_score_row", NumberFormat.getIntegerInstance().format(row.rank.toLong()), name, gameScore(row.score))
}

@Composable
internal fun gameProgress(done: Int, total: Int): String = conclaveString("gm_progress", done, total)

/** "Questions: 7 · Pace: Normal" (two facts on one line through one resource, never concatenation). */
@Composable
internal fun gameOptionSummary(options: Iterable<GameOptionSummaryModel>): String {
    var line = ""
    for (option in options) {
        val part = conclaveString("gm_option_summary", option.label, option.value)
        line = if (line.isEmpty()) part else conclaveString("act_two_facts", line, part)
    }
    return line
}
