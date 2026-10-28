package conclave.module

import androidx.compose.runtime.Composable

/*
 * S60 14 g (ACT-9) on Android: the shared browser card's copy, Material sentence case, resolved by resource name at run
 * time (Skip/res is not Android res; ConclaveStrings.kt). The presenter publishes typed values and raw names only; the
 * browser's own names use the br_ prefix and the shared ones keep theirs (act_ for the close dialog and the two-facts
 * join, ds_ and stg_ for the generic actions).
 */

/** Every resource name the browser card asks for (the bridge test checks prefixes; the Swift test checks strings.xml). */
internal val browserStringResources: List<String> = listOf(
    "br_title", "br_shared_by", "br_you_sharing", "br_live", "br_website", "br_go", "br_navigating", "br_keyboard",
    "br_mute_audio", "br_unmute_audio", "br_session_info", "br_more_actions", "br_starting", "br_load_failed",
    "br_reconnecting", "br_region", "br_viewer_hint", "br_play_audio", "br_err_empty", "br_err_spaces", "br_err_scheme",
    "br_err_invalid", "br_fail_page", "br_provider_chromium", "br_provider_cloud", "act_close_browser",
    "act_close_browser_title", "act_close_message", "act_close_confirm", "act_two_facts", "ds_try_again", "ds_cancel",
    "ds_close", "stg_show_video",
)

/** The header state word: Navigating while a navigate is pending, else Starting browser, Live or Reconnecting. */
internal fun browserStateResource(model: BrowserStageModel): String? {
    if (model.navigatePending) return "br_navigating"
    return when (model.load) {
        BrowserLoadState.starting -> "br_starting"
        BrowserLoadState.loading, BrowserLoadState.live -> "br_live"
        BrowserLoadState.reconnecting -> "br_reconnecting"
        BrowserLoadState.failed -> null
    }
}

/** "You're sharing" for the controller, "Shared by %1$s" otherwise, null when nobody is named. */
internal fun browserSharerResource(model: BrowserStageModel): String? {
    if (!model.isActive) return null
    if (model.isYouSharing) return "br_you_sharing"
    if (model.sharedByName.isEmpty()) return null
    return "br_shared_by"
}

/** The header status line: the site and the state ("example.com · Live"). */
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

/** The video region is one node: "Shared browser, example.com" (the sharer is its state description). */
@Composable
internal fun browserRegionLabel(model: BrowserStageModel): String {
    val sharer = browserSharer(model) ?: ""
    val site = if (model.hostLabel.isEmpty()) sharer else model.hostLabel
    if (site.isEmpty()) return conclaveString("br_title")
    return conclaveString("br_region", site)
}

/** The line under the address field: validation first, then a failed navigate from this card. */
@Composable
internal fun browserInlineMessage(model: BrowserStageModel): String? {
    val name = activitiesValidationResource(model.validation) ?: activitiesFailureResource(model.commandFailure) ?: return null
    return conclaveString(name)
}

/** Session info (S60 Q3): "Chromium" or "Cloud browser", never the raw provider id. */
@Composable
internal fun browserSessionInfo(model: BrowserStageModel): String = activitiesProviderTitle(model.provider)
