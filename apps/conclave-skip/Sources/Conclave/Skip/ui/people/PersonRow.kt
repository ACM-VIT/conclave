package conclave.module

import android.content.Context
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.util.Locale

/*
 * S50 2 d (PPL-1): the Android person row, a Material 3 ListItem (F00 C10 with the PL1 and PL3 deltas). The row reads
 * only its PersonRowEntry; the speaking glyph is a leaf on the S20 TileSpeakingState, so a speaker change recomposes the
 * leaf, never the row (S50 2 k). The whole row is one merged node: name and sub line as its text, the states as its
 * state description, and the speaking leaf's "Speaking" description merged in while it shows. When PPL-2 gives the row
 * actions the whole row becomes the one clickable target that opens the DropdownMenu (PL3; long press opens the same
 * menu and plays longPress) with the trailing MoreVertFill0 decorative inside it. Texts are resolved once per model
 * change, never per frame.
 */

/** The row's resolved texts (S50 2 g), rebuilt only when the model changes. */
internal data class PersonRowTexts(val name: String, val sub: String?, val states: String, val actionsLabel: String)

internal fun personRowTexts(context: Context, model: PersonRowModel, showsQueue: Boolean, queueCount: Int): PersonRowTexts {
    val name = if (model.name.isEmpty() && model.isSelf) conclaveStringOf(context, "ds_you") else model.name
    val parts = mutableListOf<String>()
    if (model.isSelf && model.name.isNotEmpty()) parts.add(conclaveStringOf(context, "ds_tag_you"))
    when (model.role) {
        PersonRole.host -> parts.add(conclaveStringOf(context, "ds_tag_host"))
        PersonRole.coHost -> parts.add(conclaveStringOf(context, "ds_tag_cohost"))
        // Attendees are never roster rows (PH12); attendee hand-queue rows arrive with PPL-5.
        else -> {}
    }
    when (model.detail) {
        PersonDetail.presenting -> parts.add(conclaveStringOf(context, "ppl_detail_presenting"))
        PersonDetail.reconnecting -> parts.add(conclaveStringOf(context, "ppl_detail_reconnecting"))
        PersonDetail.stageInvited -> parts.add(conclaveStringOf(context, "ppl_detail_invited"))
        // PPL-5 (S50 10 g): attendee hand-queue rows read "Attendee".
        PersonDetail.attendee -> parts.add(conclaveStringOf(context, "ds_attendee"))
        else -> {}
    }
    if (model.messagesHidden) parts.add(conclaveStringOf(context, "ppl_detail_hidden"))
    var sub: String? = null
    for (part in parts) {
        val current = sub
        sub = if (current == null) part else conclaveStringOf(context, "ppl_sub_join", current, part)
    }
    // State values in the S50 2 i order (Speaking joins through the leaf's own description).
    val states = mutableListOf<String>()
    if (model.isHandRaised) {
        states.add(conclaveStringOf(context, "ds_state_hand_raised"))
        if (showsQueue && model.handOrder > 0) {
            states.add(conclaveStringOf(context, "ppl_queue_position", model.handOrder, queueCount))
        }
    }
    if (model.isPresenting) states.add(conclaveStringOf(context, "ds_state_presenting"))
    if (model.isCameraOff) states.add(conclaveStringOf(context, "ds_state_camera_off"))
    if (model.isMuted) states.add(conclaveStringOf(context, "ds_state_muted"))
    if (model.isReconnecting) states.add(conclaveStringOf(context, "ds_state_reconnecting"))
    if (model.pendingAction.isNotEmpty()) states.add(conclaveStringOf(context, "ds_in_progress"))
    return PersonRowTexts(name = name, sub = sub, states = states.joinToString(", "),
        actionsLabel = conclaveStringOf(context, "ppl_actions_for", name))
}

/**
 * One person (S50 2 d). [onOpenMenu] is PPL-2's: null while the row has no actions, so the row is a plain merged node
 * with no click and no MoreVertFill0; [menu] is the row's DropdownMenu, anchored at the trailing edge; [actions] are the
 * same items as TalkBack custom actions on the merged node (S50 3 i, AX4).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun PersonRow(
    entry: PersonRowEntry,
    speaking: TileSpeakingState,
    sectionId: String,
    queueCount: Int,
    probe: PeopleRecomposeLedger?,
    modifier: Modifier = Modifier,
    onOpenMenu: (() -> Unit)? = null,
    actions: List<CustomAccessibilityAction> = emptyList(),
    menu: @Composable () -> Unit = {},
) {
    val model = entry.model
    val showsQueue = sectionId == PeopleSectionID.raisedHands.rawValue
    val context = LocalContext.current
    val texts = remember(model, showsQueue, queueCount, context) { personRowTexts(context, model, showsQueue, queueCount) }
    val identity = remember(model.avatarSeed) { ConclaveAvatarIdentity.fromSeed(model.avatarSeed) }
    val haptics = rememberConclaveHaptics()
    val identifier = "people.row.$sectionId.${model.id}"
    // people.recompose.<section>:<rowId> (PL12): the fixture ledger counts row compositions; production passes none.
    SideEffect { probe?.record("$sectionId:${model.id}") }
    val click = if (onOpenMenu != null) {
        Modifier.combinedClickable(
            role = Role.Button,
            onClickLabel = texts.actionsLabel,
            onLongClickLabel = texts.actionsLabel,
            hapticFeedbackEnabled = false,
            onClick = onOpenMenu,
            onLongClick = { haptics.gesture(FeedbackKind.longPress); onOpenMenu() },
        )
    } else Modifier
    Box(modifier) {
        ListItem(
            headlineContent = { ConclaveText(texts.name, line = "$identifier.name", maxLines = 2, overflow = TextOverflow.Ellipsis) },
            supportingContent = if (texts.sub == null) null else { { ConclaveText(texts.sub, line = "$identifier.detail") } },
            leadingContent = { ConclaveAvatar(identity, ConclaveAvatarSize.row.diameter.dp) },
            trailingContent = {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    PeopleStatusIcons(model, speaking, showsQueue)
                    if (model.pendingAction.isNotEmpty()) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    } else if (onOpenMenu != null) {
                        Icon(ConclaveIcons.MoreVertFill0, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            },
            colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
            modifier = Modifier.heightIn(min = 56.dp).then(click).testTag(identifier)
                .semantics(mergeDescendants = true) { if (texts.states.isNotEmpty()) stateDescription = texts.states }
                .semantics { if (actions.isNotEmpty()) customActions = actions },
        )
        menu()
    }
}

/**
 * Status icons, only for notable states, in the S50 2 c order: speaking (leaf), raised hand in handRaised with the
 * queue number before it in Raised Hands, presenting, camera off, muted, reconnecting. 20 dp, onSurfaceVariant.
 */
@Composable
private fun PeopleStatusIcons(model: PersonRowModel, speaking: TileSpeakingState, showsQueue: Boolean) {
    val tint = MaterialTheme.colorScheme.onSurfaceVariant
    val hand = LocalConclaveExtendedColors.current.handRaised
    PeopleSpeakingIcon(speaking)
    if (model.isHandRaised) {
        Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
            if (showsQueue && model.handOrder > 0) {
                // The queue position is read from the state description, so the digit is not a node of its own.
                ConclaveText(String.format(Locale.getDefault(), "%d", model.handOrder), line = "people.row.queue",
                    style = rememberTabular(MaterialTheme.typography.labelLarge), color = hand,
                    modifier = Modifier.clearAndSetSemantics { })
            }
            Icon(ConclaveIcons.FrontHandFill1, contentDescription = null, tint = hand, modifier = Modifier.size(20.dp))
        }
    }
    if (model.isPresenting) Icon(ConclaveIcons.PresentToAllFill1, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
    if (model.isCameraOff) Icon(ConclaveIcons.VideocamOffFill1, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
    if (model.isMuted) Icon(ConclaveIcons.MicOffFill1, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
    if (model.isReconnecting) Icon(ConclaveIcons.SignalWifiBadFill0, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
}

/**
 * The only hot read of a row (S50 2 k): a static glyph that appears and disappears with no animation. Its description
 * merges into the row's node, so TalkBack hears "Speaking" without the row reading the speaking state.
 */
@Composable
private fun PeopleSpeakingIcon(speaking: TileSpeakingState) {
    if (speaking.isSpeaking) {
        Icon(ConclaveIcons.GraphicEqFill0, contentDescription = conclaveString("native_panel_speaking"),
            tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
    }
}
