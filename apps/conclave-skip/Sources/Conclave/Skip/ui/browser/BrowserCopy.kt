package conclave.module

import androidx.compose.runtime.Composable

internal val browserStringResources: List<String> = listOf(
    "br_title", "br_shared_by", "br_you_sharing", "br_live", "br_website", "br_go", "br_navigating", "br_keyboard",
    "br_mute_audio", "br_unmute_audio", "br_session_info", "br_more_actions", "br_starting", "br_load_failed",
    "br_reconnecting", "br_region", "br_viewer_hint", "br_play_audio", "br_err_empty", "br_err_spaces", "br_err_scheme",
    "br_err_invalid", "br_fail_page", "br_provider_chromium", "br_provider_cloud", "act_close_browser",
    "act_close_browser_title", "act_close_message", "act_close_confirm", "act_two_facts", "ds_try_again", "ds_cancel",
    "ds_close", "stg_show_video",
)

internal fun browserStateResource(model: BrowserStageModel): String? {
    if (model.navigatePending) return "br_navigating"
    return when (model.load) {
        BrowserLoadState.starting -> "br_starting"
        BrowserLoadState.loading, BrowserLoadState.live -> "br_live"
        BrowserLoadState.reconnecting -> "br_reconnecting"
        BrowserLoadState.failed -> null
    }
}

internal fun browserSharerResource(model: BrowserStageModel): String? {
    if (!model.isActive) return null
    if (model.isYouSharing) return "br_you_sharing"
    if (model.sharedByName.isEmpty()) return null
    return "br_shared_by"
}

@Composable
internal fun browserHeaderStatus(model: BrowserStageModel): String {
    if (!model.isActive) return ""
    val stateName = browserStateResource(model)
    val state = if (stateName != null) conclaveString(stateName) else ""
    if (model.hostLabel.isEmpty()) return state
    if (state.isEmpty()) return model.hostLabel
    return conclaveString("act_two_facts", model.hostLabel, state)
}

@Composable
internal fun browserSharer(model: BrowserStageModel): String? {
    val name = browserSharerResource(model) ?: return null
    return if (name == "br_shared_by") conclaveString(name, model.sharedByName) else conclaveString(name)
}

@Composable
internal fun browserRegionLabel(model: BrowserStageModel): String {
    val sharer = browserSharer(model) ?: ""
    val site = if (model.hostLabel.isEmpty()) sharer else model.hostLabel
    if (site.isEmpty()) return conclaveString("br_title")
    return conclaveString("br_region", site)
}

@Composable
internal fun browserInlineMessage(model: BrowserStageModel): String? {
    val name = activitiesValidationResource(model.validation) ?: activitiesFailureResource(model.commandFailure) ?: return null
    return conclaveString(name)
}

@Composable
internal fun browserSessionInfo(model: BrowserStageModel): String = activitiesProviderTitle(model.provider)
