package conclave.module

import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext

/*
 * S30 5 d and 6 d (CTL-5, CTL-6): the Android More sheet the bar's More control opens. The FND-2 in-call action sheet
 * (ConclaveActionSheet, F00 C17): dark over the stage in every system appearance, the recovery notice while recovering
 * or offline, the six reaction targets (the sheet stays open across sends; the flat art row stays hidden until the
 * assets ship, CC14), the wide Raise hand tile (pending spinner, "Raising hand…", Engaged when raised; the sheet stays
 * open so the acknowledgment is visible), the tiles in the shared 5 d order (MoreMenuPolicy.tiles), and the host
 * section (Host controls, Lock meeting, then End call for everyone… after a divider). Panels, End and a share start
 * act only after the sheet finished hiding (D17: no panel or dialog from a dismissing sheet; CC15: the MediaProjection
 * consent never stacks on the sheet); the Leave control composes the End dialog for invoker "more" (CTL-2). Reads only
 * `controls.more` and `controls.reactions` through their caches (CL14), composed only while shown. Feedback plays
 * only for dispatched actions (S30 5 h): `reactionSent`, `handRaised` or `handLowered`, `linkCopied` (silent on API
 * 33+). Resolved strings sit in vals before any semantics block (CL14).
 */

@Composable
internal fun MoreSheet(controls: CallControlsPresenter, onDismissed: () -> Unit) {
    val more = remember(controls) { MoreCache(controls) }.current()
    val reactions = remember(controls) { ReactionsCache(controls) }.current()
    val stage = controls.stage
    val context = LocalContext.current
    val haptics = rememberConclaveHaptics()
    // S30 CC16: the open sheet keeps chrome visible.
    DisposableEffect(stage) {
        stage.setTransientChrome(id = ChromeAutoHidePolicy.moreSheet, open = true)
        onDispose { stage.setTransientChrome(id = ChromeAutoHidePolicy.moreSheet, open = false) }
    }
    val palette = reactions.emoji.map { option ->
        ConclavePaletteOption(id = option.id, emoji = option.id, label = moreReactionLabel(option.nameKey), isSelected = false)
    }
    val tiles = more.tiles.map { item -> moreTile(item) }
    val hostRows = more.hostItems.map { item -> moreHostRow(item) }
    val hand = more.item(MoreItemID.hand)
    val handLabel = if (hand != null) moreHandLabel(hand) else null
    val handState = if (hand != null) moreHandState(hand) else null
    val reactionsNotice = if (reactions.availability == ReactionAvailability.disabledByHost) conclaveString("ds_reactions_off") else null
    val notice = if (more.isRecovering) conclaveString("ctl_more_recovering") else null
    val hostTitle = conclaveString("ctl_host_section")
    val shareSubject = conclaveString("ds_share_subject")
    val shareText = conclaveString("ds_share_text", more.meetingLink)
    val clipLabel = conclaveString("pm_clip_label")
    ConclaveActionSheet(
        identifier = "sheet.more",
        onDismiss = {
            // S30 5 l5: counted before a panel the sheet chose presents.
            controls.noteMoreSheetDismissed()
            onDismissed()
        },
        tiles = tiles,
        onTile = { tile ->
            val id = MoreItemID.init(rawValue = tile.id) ?: MoreItemID.reactions
            when (id) {
                MoreItemID.invite -> {
                    // After the sheet is gone: the F00 payload, EXTRA_TITLE the room label, no chooser title (CL19, R14).
                    if (controls.select(MoreItemID.invite) == ControlTapResult.dispatched) {
                        NativeMeetingShare.shareMeetingLink(link = more.meetingLink, subject = shareSubject, text = shareText,
                            title = more.roomLabel)
                    }
                }
                MoreItemID.copyLink -> {
                    // In place; the sheet stays. The snackbar "Link copied" only where the system shows no confirmation.
                    meetingDetailsCopy(context, more.meetingLink, clipLabel)
                    val postsToast = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                    if (controls.copyLink(postsToast = postsToast) == ControlTapResult.dispatched) {
                        haptics.gesture(FeedbackKind.linkCopied)
                    }
                }
                MoreItemID.captions -> controls.setCaptions(!tile.engaged)
                // An unknown id maps to the palette row, which `select` ignores.
                else -> controls.select(id)
            }
        },
        reactions = palette,
        reactionsEnabled = reactions.isAvailable,
        onReaction = { option -> controls.sendReaction(id = option.id) == ControlTapResult.dispatched },
        reactionsNotice = reactionsNotice,
        handRaised = hand?.isOn,
        handEnabled = hand?.isEnabled ?: false,
        handPending = hand?.isPending ?: false,
        handLabel = handLabel,
        handState = handState,
        onRaiseHand = { _ -> controls.select(MoreItemID.hand) == ControlTapResult.dispatched },
        hostTitle = hostTitle,
        hostRows = hostRows,
        onHostRow = { row, _ ->
            val id = MoreItemID.init(rawValue = row.id)
            if (id != null) controls.select(id)
        },
        notice = notice,
        haptics = haptics,
    )
}

/** One tile in the 5 d set: label, icon, Engaged state, the status or reason line, badge and the after-dismiss rule. */
@Composable
private fun moreTile(item: MoreItem): ConclaveActionTile {
    val line = moreTileLine(item)
    val isSwitch = item.kind == MoreItemID.captions
    return ConclaveActionTile(
        id = item.id,
        label = moreTileLabel(item),
        icon = moreTileIcon(item),
        enabled = item.isEnabled,
        engaged = item.isOn,
        statusLine = line,
        dismissesSheet = MoreMenuPolicy.actsAfterDismiss(item),
        badgeCount = if (item.kind == MoreItemID.participants || item.kind == MoreItemID.qa || item.kind == MoreItemID.chat) item.count else 0,
        description = moreTileDescription(item),
        switchOn = if (isSwitch) item.isOn else null,
    )
}

@Composable
private fun moreTileLabel(item: MoreItem): String = when (item.kind) {
    MoreItemID.chat -> conclaveString("ds_chat")
    MoreItemID.screenShare -> if (item.isOn) conclaveString("ctl_stop_sharing") else conclaveString("ds_share_screen")
    MoreItemID.captions -> conclaveString("ctl_captions")
    MoreItemID.participants -> conclaveString("native_panel_participants")
    MoreItemID.activities -> conclaveString("ctl_activities")
    MoreItemID.transcript -> conclaveString("ctl_transcript")
    MoreItemID.layout -> conclaveString("ctl_layout")
    MoreItemID.effects -> conclaveString("ctl_effects")
    MoreItemID.invite -> conclaveString("ctl_invite")
    MoreItemID.copyLink -> conclaveString("ctl_copy_link")
    MoreItemID.meetingDetails -> conclaveString("ctl_meeting_details")
    MoreItemID.qa -> conclaveString("ctl_qa_short")
    MoreItemID.settings -> conclaveString("native_panel_settings")
    else -> ""
}

/** The full spoken label where the tile shows a short one (S30 5 g, RECONCILE R14). */
@Composable
private fun moreTileDescription(item: MoreItem): String? = when (item.kind) {
    MoreItemID.invite -> conclaveString("ds_share_invite")
    MoreItemID.qa -> conclaveString("ctl_qa")
    else -> null
}

/** S30 5 e concepts (the manifest's Layout and Effects concepts are CL11 requests; both rows are hidden this push). */
private fun moreTileIcon(item: MoreItem): ImageVector = when (item.kind) {
    MoreItemID.chat -> ConclaveIcons.ChatBubbleFill0
    MoreItemID.screenShare -> if (item.isOn) ConclaveIcons.CancelPresentationFill1 else ConclaveIcons.PresentToAllFill0
    MoreItemID.captions -> if (item.isOn) ConclaveIcons.ClosedCaptionFill1 else ConclaveIcons.ClosedCaptionFill0
    MoreItemID.participants -> ConclaveIcons.GroupFill0
    MoreItemID.activities -> ConclaveIcons.AppsFill0
    MoreItemID.transcript -> ConclaveIcons.DescriptionFill0
    MoreItemID.layout -> ConclaveIcons.FeaturedVideoFill0
    MoreItemID.effects -> ConclaveIcons.MoodFill1
    MoreItemID.invite -> ConclaveIcons.ShareFill0
    MoreItemID.copyLink -> ConclaveIcons.ContentCopyFill0
    MoreItemID.meetingDetails -> ConclaveIcons.InfoFill0
    MoreItemID.qa -> ConclaveIcons.QuizFill0
    MoreItemID.settings -> ConclaveIcons.SettingsFill0
    else -> ConclaveIcons.MoreVertFill0
}

/** The tile line: the short reason while blocked (S30 7 Android tile line), else the status (5 f); captions read On or
 *  Off. Null for none. */
@Composable
private fun moreTileLine(item: MoreItem): String? {
    if (!item.isEnabled && !item.isPending) {
        val reason = moreShortReason(item.reason, item.reasonName)
        if (reason != null) return reason
    }
    if (item.kind == MoreItemID.captions) return conclaveString(if (item.isOn) "ds_state_on" else "ds_state_off")
    return when (item.status) {
        MoreItemStatus.waiting -> conclavePlural("ctl_waiting_short", item.count, item.count)
        MoreItemStatus.unseen -> conclavePlural("ctl_qa_new", item.count, item.count)
        MoreItemStatus.unread -> conclaveString("ds_unread_count", item.count)
        MoreItemStatus.running -> conclaveString("ctl_activity_running", item.statusName)
        MoreItemStatus.voteOpen -> conclaveString("ctl_vote_open")
        MoreItemStatus.whiteboard -> conclaveString("ctl_whiteboard_open")
        MoreItemStatus.live -> conclaveString("ctl_notes_live")
        MoreItemStatus.paused -> conclaveString("ctl_notes_paused")
        MoreItemStatus.attention -> conclaveString("ctl_notes_attention")
        else -> if (item.kind == MoreItemID.layout) moreLayoutTitle(item.statusName) else null
    }
}

/** S30 7 "Android tile line": short reasons. */
@Composable
private fun moreShortReason(reason: ControlBlockedReason, name: String): String? = when (reason) {
    ControlBlockedReason.reconnecting -> conclaveString("ctl_reason_reconnecting_short")
    ControlBlockedReason.offline -> conclaveString("ctl_reason_offline_short")
    ControlBlockedReason.remoteShareActive -> conclaveString("ds_is_presenting", name)
    ControlBlockedReason.audioOnly -> conclaveString("ctl_reason_audio_only_short")
    else -> null
}

@Composable
private fun moreLayoutTitle(raw: String): String = when (raw) {
    "tiled" -> conclaveString("ctl_layout_tiled")
    "spotlight" -> conclaveString("ctl_layout_spotlight")
    "sidebar" -> conclaveString("ctl_layout_sidebar")
    else -> conclaveString("ctl_layout_auto")
}

/** Host controls, Lock meeting (a Switch row, "Locking…" while pending) and End call for everyone… (error, last). */
@Composable
private fun moreHostRow(item: MoreItem): ConclaveActionHostRow {
    val reason = if (!item.isEnabled && !item.isPending) callControlReasonText(CallControlKind.more, item.reason, item.reasonName) else null
    return when (item.kind) {
        MoreItemID.lockMeeting -> ConclaveActionHostRow(
            id = item.id,
            label = if (item.isPending) conclaveString(if (item.isOn) "ctl_unlocking" else "ctl_locking") else conclaveString("ctl_lock_meeting"),
            checked = item.isOn, enabled = item.isEnabled, reason = reason, kind = ConclaveActionRowKind.Switch,
            icon = if (item.isOn) ConclaveIcons.LockFill1 else ConclaveIcons.LockOpenFill0,
        )
        MoreItemID.endForEveryone -> ConclaveActionHostRow(
            id = item.id,
            label = if (item.isPending || item.reason == ControlBlockedReason.ending) conclaveString("ctl_ending")
                else conclaveString("ctl_end_for_everyone_ellipsis"),
            enabled = item.isEnabled, reason = reason, kind = ConclaveActionRowKind.Destructive, icon = ConclaveIcons.CallEndFill1,
            dismissesSheet = true,
        )
        else -> ConclaveActionHostRow(
            id = item.id, label = conclaveString("stg_panel_host_controls"), enabled = item.isEnabled, reason = reason,
            kind = ConclaveActionRowKind.Action, icon = ConclaveIcons.ShieldPersonFill0, dismissesSheet = true,
        )
    }
}

/** S30 5 g and 6 g: "Raise hand", "Lower hand", "Raising hand…", "Lowering hand…". */
@Composable
private fun moreHandLabel(item: MoreItem): String = when (MoreMenuPolicy.handState(item)) {
    LocalHandState.raising -> conclaveString("ctl_raising_hand")
    LocalHandState.lowering -> conclaveString("ctl_lowering_hand")
    LocalHandState.raised -> conclaveString("ds_lower_hand")
    LocalHandState.lowered -> conclaveString("ds_raise_hand")
}

/** The Switch state description (S30 6 i): "Raised", "Not raised", "Raising", "Lowering". */
@Composable
private fun moreHandState(item: MoreItem): String = when (MoreMenuPolicy.handState(item)) {
    LocalHandState.raising -> conclaveString("ctl_state_raising")
    LocalHandState.lowering -> conclaveString("ctl_state_lowering")
    LocalHandState.raised -> conclaveString("ds_state_raised")
    LocalHandState.lowered -> conclaveString("ds_state_not_raised")
}

/** "React with thumbs up" (S30 6 g): a word label, never the glyph. */
@Composable
internal fun moreReactionLabel(nameKey: String): String {
    val name = when (nameKey) {
        "thumbsUp" -> conclaveString("ctl_reaction_thumbs_up")
        "clap" -> conclaveString("ctl_reaction_clap")
        "laugh" -> conclaveString("ctl_reaction_laugh")
        "heart" -> conclaveString("ctl_reaction_heart")
        "party" -> conclaveString("ctl_reaction_party")
        "wow" -> conclaveString("ctl_reaction_wow")
        "aura" -> conclaveString("ctl_reaction_aura")
        "crying" -> conclaveString("ctl_reaction_crying")
        "goblin" -> conclaveString("ctl_reaction_goblin")
        "phone" -> conclaveString("ctl_reaction_phone")
        "sixSeven" -> conclaveString("ctl_reaction_six_seven")
        "yawn" -> conclaveString("ctl_reaction_yawn")
        else -> nameKey
    }
    return conclaveString("ctl_react_with", name)
}
