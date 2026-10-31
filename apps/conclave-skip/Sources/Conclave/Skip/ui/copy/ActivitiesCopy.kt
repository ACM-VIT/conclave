package conclave.module

import androidx.compose.runtime.Composable

internal fun activitiesAppNameResource(appId: String): String = when (appId) {
    "whiteboard" -> "app_whiteboard"
    "wheel" -> "app_wheel"
    "watch" -> "app_watch"
    else -> "app_generic"
}

internal fun activitiesAppDetailResource(appId: String): String? = when (appId) {
    "whiteboard" -> "app_whiteboard_detail"
    "wheel" -> "app_wheel_detail"
    "watch" -> "app_watch_detail"
    else -> null
}

@Composable
internal fun activitiesAppName(appId: String): String = conclaveString(activitiesAppNameResource(appId))

@Composable
internal fun activitiesAppDetail(appId: String): String {
    val name = activitiesAppDetailResource(appId) ?: return ""
    return conclaveString(name)
}

@Composable
internal fun activitiesKindName(kind: ActivityKind, gameName: String, appId: String): String = when (kind) {
    ActivityKind.game -> if (gameName.isEmpty()) conclaveString("act_game") else gameName
    ActivityKind.app -> activitiesAppName(appId)
    ActivityKind.browser -> conclaveString("br_title")
}

@Composable
internal fun activitiesPlayers(count: Int): String = conclavePlural("act_players_count", count, count)

@Composable
internal fun activitiesNowPlayingTitle(item: NowPlayingModel): String = activitiesKindName(item.kind, item.gameName, item.appId)

@Composable
internal fun activitiesNowPlayingStatus(item: NowPlayingModel): String = when (item.kind) {
    ActivityKind.game -> if (item.roundTotal > 0 && item.round > 0) {
        conclaveString("act_two_facts", conclaveString("act_round_of", item.round, item.roundTotal), activitiesPlayers(item.playerCount))
    } else {
        activitiesPlayers(item.playerCount)
    }
    ActivityKind.app -> if (item.isEditingLocked) conclaveString("act_editing_locked") else conclaveString("act_live")
    ActivityKind.browser -> if (item.browserLabel.isEmpty()) conclaveString("act_live") else item.browserLabel
}

@Composable
internal fun activitiesEndTitle(item: NowPlayingModel): String = when (item.kind) {
    ActivityKind.game -> conclaveString("act_end_game")
    ActivityKind.app -> conclaveString("act_close_app", activitiesAppName(item.appId))
    ActivityKind.browser -> conclaveString("act_close_browser")
}

@Composable
internal fun activitiesEndDialogTitle(item: NowPlayingModel): String = when (item.kind) {
    ActivityKind.game -> conclaveString("act_end_title", activitiesNowPlayingTitle(item))
    ActivityKind.app -> conclaveString("act_close_title", activitiesAppName(item.appId))
    ActivityKind.browser -> conclaveString("act_close_browser_title")
}

@Composable
internal fun activitiesEndDialogMessage(item: NowPlayingModel): String = when (item.kind) {
    ActivityKind.game -> conclaveString("act_end_message")
    ActivityKind.app -> if (item.appId == "whiteboard") conclaveString("act_close_board_message") else conclaveString("act_close_message")
    ActivityKind.browser -> conclaveString("act_close_message")
}

@Composable
internal fun activitiesEndConfirm(item: NowPlayingModel): String =
    if (item.kind == ActivityKind.game) conclaveString("act_end_confirm") else conclaveString("act_close_confirm")

internal fun activitiesReasonResource(reason: ActivitiesReason): String? = when (reason) {
    ActivitiesReason.none -> null
    ActivitiesReason.recovering -> "set_available_when_reconnected"
    ActivitiesReason.voteOpen -> "act_vote_open_reason"
    ActivitiesReason.gameLive -> "act_game_live_reason"
    ActivitiesReason.belowPlayerRange -> "act_below_range_generic"
    ActivitiesReason.hostOnly -> "act_host_only_apps"
    ActivitiesReason.noAppOpen -> "act_no_app_open"
    ActivitiesReason.browserUnavailable -> "br_unavailable"
    ActivitiesReason.noVotes -> "act_no_votes"
    ActivitiesReason.endFailed -> "act_end_failed"
    ActivitiesReason.actionFailed -> "act_action_failed"
}

@Composable
internal fun activitiesReason(reason: ActivitiesReason, setup: GameSetupModel? = null, serverText: String = ""): String? {
    if (reason == ActivitiesReason.belowPlayerRange && setup != null) {
        return conclaveString("act_below_range", setup.name, activitiesPlayerRangeShort(setup.minPlayers, setup.maxPlayers), setup.playersHere)
    }
    if (reason == ActivitiesReason.actionFailed && serverText.trim().isNotEmpty()) return serverText.trim()
    val name = activitiesReasonResource(reason) ?: return null
    return conclaveString(name)
}

@Composable
internal fun activitiesPlayerRange(minPlayers: Int, maxPlayers: Int): String =
    if (minPlayers == maxPlayers) activitiesPlayers(minPlayers) else conclaveString("act_players_range", minPlayers, maxPlayers)

@Composable
internal fun activitiesPlayerRangeShort(minPlayers: Int, maxPlayers: Int): String =
    if (minPlayers == maxPlayers) minPlayers.toString() else conclaveString("act_players_range_short", minPlayers, maxPlayers)

@Composable
internal fun activitiesVoteCount(cast: Int, players: Int): String = conclavePlural("act_vote_count", cast, cast, players)

@Composable
internal fun activitiesVotes(count: Int): String = conclavePlural("act_votes", count, count)

@Composable
internal fun activitiesStartLeaderTitle(snapshot: ActivitiesSnapshot): String =
    if (snapshot.leaderVotes > 0) conclaveString("act_start_game", snapshot.leaderName) else conclaveString("act_start_leader")

@Composable
internal fun activitiesStartTitle(setup: GameSetupModel): String = when (setup.phase) {
    SetupPhase.starting, SetupPhase.slow -> conclaveString("act_starting")
    SetupPhase.idle, SetupPhase.failed -> conclaveString("act_start_game", setup.name)
}

@Composable
internal fun activitiesSetupFooter(setup: GameSetupModel): String? = when (setup.phase) {
    SetupPhase.slow -> conclaveString("act_still_starting")
    SetupPhase.failed -> if (setup.failureServerText.trim().isEmpty()) conclaveString("act_action_failed") else setup.failureServerText.trim()
    SetupPhase.idle, SetupPhase.starting -> activitiesReason(setup.reason, setup)
}

@Composable
internal fun activitiesCharacterCount(count: Int, limit: Int): String = conclaveString("act_char_count", count, limit)

internal fun activitiesValidationResource(value: BrowserValidation): String? = when (value) {
    BrowserValidation.none -> null
    BrowserValidation.empty -> "br_err_empty"
    BrowserValidation.spaces -> "br_err_spaces"
    BrowserValidation.scheme -> "br_err_scheme"
    BrowserValidation.invalid -> "br_err_invalid"
}

internal fun activitiesFailureResource(value: BrowserFailure): String? = when (value) {
    BrowserFailure.none -> null
    BrowserFailure.startFailed -> "br_fail_start"
    BrowserFailure.navigateFailed, BrowserFailure.loadFailed -> "br_fail_page"
    BrowserFailure.unavailable -> "br_unavailable"
    BrowserFailure.timedOut -> "br_fail_timeout"
}

@Composable
internal fun activitiesBrowserMessage(browser: BrowserLauncherModel): String? {
    val name = activitiesValidationResource(browser.validation) ?: activitiesFailureResource(browser.failure) ?: return null
    return conclaveString(name)
}

@Composable
internal fun activitiesBrowserPrimary(browser: BrowserLauncherModel): String = when (browser.phase) {
    BrowserPhase.launching -> conclaveString("br_launching")
    BrowserPhase.navigating -> conclaveString("br_navigating")
    BrowserPhase.closing -> conclaveString("ds_in_progress")
    BrowserPhase.idle -> if (browser.isActive) conclaveString("br_go") else conclaveString("br_launch")
}

@Composable
internal fun activitiesProviderTitle(provider: String): String = when (provider.lowercase()) {
    "chromium", "local", "" -> conclaveString("br_provider_chromium")
    else -> conclaveString("br_provider_cloud")
}

@Composable
internal fun activitiesCardPhase(phase: ActivityCardPhase, name: String): String? = when (phase) {
    ActivityCardPhase.live -> null
    ActivityCardPhase.opening -> conclaveString("stg_activity_opening", name)
    ActivityCardPhase.failed -> conclaveString("stg_activity_failed", name)
}
