package conclave.module

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.TextButton
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp

internal fun peopleActionTitlesOf(context: Context, name: String): PeopleActionTitles = PeopleActionTitles(
    pin = conclaveStringOf(context, "ppl_pin"),
    unpin = conclaveStringOf(context, "ppl_unpin"),
    sendPrivateMessage = conclaveStringOf(context, "ppl_send_private_message"),
    hideMessages = conclaveStringOf(context, "ppl_hide_messages", name),
    showMessages = conclaveStringOf(context, "ppl_show_messages", name),
    changeName = conclaveStringOf(context, "ppl_change_name"),
    lowerHand = conclaveStringOf(context, "ppl_lower_hand"),
    mute = conclaveStringOf(context, "ppl_mute"),
    turnOffCamera = conclaveStringOf(context, "ppl_turn_off_camera"),
    stopScreenShare = conclaveStringOf(context, "ppl_stop_screen_share"),
    stopScreenAudio = conclaveStringOf(context, "ppl_stop_screen_audio"),
    makeCoHost = conclaveStringOf(context, "ppl_make_cohost"),
    makeHost = conclaveStringOf(context, "ppl_make_host"),
    moveToAudience = conclaveStringOf(context, "ppl_move_to_audience"),
    remove = conclaveStringOf(context, "ppl_remove_from_meeting"),
    reasonReconnecting = conclaveStringOf(context, "ds_unavailable_reconnecting"),
    reasonOffline = conclaveStringOf(context, "ds_unavailable_offline"),
    reasonNotJoined = conclaveStringOf(context, "ds_unavailable_reconnecting"),
    reasonPending = conclaveStringOf(context, "ds_in_progress"),
    reasonRenameDisabled = conclaveStringOf(context, "ppl_rename_disabled"),
)

internal fun peopleRowName(context: Context, model: PersonRowModel): String =
    if (model.name.isEmpty() && model.isSelf) conclaveStringOf(context, "ds_you") else model.name

internal fun peopleMenuSections(context: Context, model: PersonRowModel): List<MenuSectionModel> =
    PeopleActionPolicy.menuSections(model.actions, titles = peopleActionTitlesOf(context, peopleRowName(context, model))).toList()

internal fun peopleRowAccessibilityActions(context: Context, model: PersonRowModel, perform: (PersonActionID) -> Unit): List<CustomAccessibilityAction> {
    if (model.actions.isEmpty) return emptyList()
    val titles = peopleActionTitlesOf(context, peopleRowName(context, model))
    val result = mutableListOf<CustomAccessibilityAction>()
    for (item in PeopleActionPolicy.availableActions(model.actions)) {
        val action = item.action
        result.add(CustomAccessibilityAction(PeopleActionPolicy.title(action, titles = titles)) { perform(action); true })
    }
    return result
}

@Composable
internal fun PeopleRowMenu(people: PeoplePresenter, model: PersonRowModel, sectionId: String, expanded: Boolean, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val sections = remember(model, expanded) { if (expanded) peopleMenuSections(context, model) else emptyList() }
    ConclaveDropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismiss,
        sections = sections,
        identifier = "people.row.$sectionId.${model.id}.menu",
        onSelect = { item ->
            onDismiss()
            val action = PersonActionID.init(rawValue = item.id)
            if (action != null) people.perform(action, rowId = model.id, source = PeopleActionSource.rowMenu)
        },
    )
}

internal data class PeopleDialogCopy(
    val title: String,
    val message: String,
    val confirm: String,
    val destructive: Boolean,
    val alsoBlock: String?,
)

internal fun peopleDialogCopy(context: Context, confirmation: PeopleConfirmation): PeopleDialogCopy {
    val name = confirmation.targetName
    return when (confirmation.kind) {
        PeopleConfirmationKind.remove -> {
            var message = conclaveStringOf(context, "ppl_remove_message", name)
            if (confirmation.canBlock && confirmation.isGuest) message += " " + conclaveStringOf(context, "ppl_block_guest_note")
            PeopleDialogCopy(conclaveStringOf(context, "ppl_remove_title", name), message, conclaveStringOf(context, "ppl_remove"), true,
                if (confirmation.canBlock) conclaveStringOf(context, "ppl_also_block", name) else null)
        }
        PeopleConfirmationKind.makeCoHost -> PeopleDialogCopy(conclaveStringOf(context, "ppl_cohost_title", name),
            conclaveStringOf(context, "ppl_cohost_message"), conclaveStringOf(context, "ppl_cohost_confirm"), false, null)
        PeopleConfirmationKind.makeHost -> PeopleDialogCopy(conclaveStringOf(context, "ppl_host_title", name),
            conclaveStringOf(context, "ppl_host_message", name), conclaveStringOf(context, "ppl_host_confirm"), false, null)
        PeopleConfirmationKind.moveToAudience -> PeopleDialogCopy(conclaveStringOf(context, "ppl_demote_title", name),
            conclaveStringOf(context, "ppl_demote_message", name), conclaveStringOf(context, "ppl_demote_confirm"), true, null)
        PeopleConfirmationKind.denyAll -> PeopleDialogCopy(conclavePluralOf(context, "ppl_deny_all_title", confirmation.count, confirmation.count),
            conclaveStringOf(context, "ppl_deny_all_message"), conclaveStringOf(context, "ppl_deny_all_confirm"), true, null)
        PeopleConfirmationKind.muteAll -> PeopleDialogCopy(conclaveStringOf(context, "hst_mute_all_title"),
            conclaveStringOf(context, "hst_mute_all_message"), conclaveStringOf(context, "hst_mute_all_confirm"), false, null)
        PeopleConfirmationKind.camerasOff -> PeopleDialogCopy(conclaveStringOf(context, "hst_cameras_off_title"),
            conclaveStringOf(context, "hst_cameras_off_message"), conclaveStringOf(context, "hst_cameras_off_confirm"), false, null)
        PeopleConfirmationKind.stopAllShares -> PeopleDialogCopy(conclaveStringOf(context, "hst_stop_shares_title"),
            conclaveStringOf(context, "hst_stop_shares_message"), conclaveStringOf(context, "hst_stop_shares_confirm"), false, null)
        PeopleConfirmationKind.clearInviteCode -> PeopleDialogCopy(
            conclaveStringOf(context, "hst_remove_code_title"), conclaveStringOf(context, "hst_remove_code_message"),
            conclaveStringOf(context, "hst_remove_code_confirm"), true, null)

        PeopleConfirmationKind.clearAttendeeCode -> PeopleDialogCopy(
            conclaveStringOf(context, "hst_remove_attendee_code_title"), conclaveStringOf(context, "hst_remove_attendee_code_message"),
            conclaveStringOf(context, "hst_remove_code_confirm"), true, null)
        PeopleConfirmationKind.block -> PeopleDialogCopy(conclaveStringOf(context, "hst_block_title", name),
            conclaveStringOf(context, "hst_block_message"), conclaveStringOf(context, "hst_block_confirm"), true, null)
        PeopleConfirmationKind.rotateWebinarLink -> PeopleDialogCopy(conclaveStringOf(context, "hst_rotate_title"),
            conclaveStringOf(context, "hst_rotate_message"), conclaveStringOf(context, "hst_rotate_confirm"), true, null)
    }
}

@Composable
internal fun PeopleConfirmationHost(people: PeoplePresenter) {
    val confirmation = people.confirmation ?: return
    if (confirmation.source == PeopleActionSource.tileMenu || confirmation.source == PeopleActionSource.hostControls) return
    PeopleConfirmationDialog(people, confirmation)
}

@Composable
internal fun StagePeopleConfirmationHost(people: PeoplePresenter?) {
    val presenter = people ?: return
    val confirmation = presenter.confirmation ?: return
    if (confirmation.source != PeopleActionSource.tileMenu) return
    HostingTheme(inCall = true) {
        PeopleConfirmationDialog(presenter, confirmation)
    }
}

@Composable
internal fun PeopleConfirmationDialog(people: PeoplePresenter, confirmation: PeopleConfirmation) {
    val context = LocalContext.current
    val copy = remember(confirmation) { peopleDialogCopy(context, confirmation) }
    var block by rememberSaveable(confirmation.id) { mutableStateOf(false) }
    val scheme = MaterialTheme.colorScheme
    val identifier = "people.dialog.${confirmation.kind.rawValue}"
    AlertDialog(
        onDismissRequest = { people.cancelConfirmation(id = confirmation.id) },
        modifier = Modifier.testTag(identifier).semantics { testTagsAsResourceId = true },
        title = {
            NativeSemanticsPopupRoot(identifier)
            ConclaveText(copy.title, line = "$identifier.title")
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                ConclaveText(copy.message, line = "$identifier.message", color = scheme.onSurfaceVariant)
                val alsoBlock = copy.alsoBlock
                if (alsoBlock != null) {
                    Row(
                        Modifier.fillMaxWidth().minimumInteractiveComponentSize()
                            .toggleable(value = block, role = Role.Checkbox) { block = it }
                            .testTag("$identifier.block"),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(checked = block, onCheckedChange = null)
                        Spacer(Modifier.width(8.dp))
                        ConclaveText(alsoBlock, line = "$identifier.block.title")
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { people.confirm(id = confirmation.id, block = block) },
                modifier = Modifier.testTag("$identifier.confirm"),
                colors = if (copy.destructive) ButtonDefaults.textButtonColors(contentColor = scheme.error) else ButtonDefaults.textButtonColors(),
            ) { ConclaveText(copy.confirm, line = "$identifier.confirm") }
        },
        dismissButton = {
            TextButton(onClick = { people.cancelConfirmation(id = confirmation.id) }, modifier = Modifier.testTag("$identifier.cancel")) {
                ConclaveText(conclaveString("ds_cancel"), line = "$identifier.cancel")
            }
        },
    )
}

internal fun peopleRenameRefusalOf(context: Context, raw: String): String = when (raw) {
    HostActionFailure.renameRateLimited.rawValue -> conclaveStringOf(context, "ppl_rename_rate_limited")
    HostActionFailure.renameDisabled.rawValue -> conclaveStringOf(context, "ppl_rename_disabled")
    HostActionFailure.renameTooLong.rawValue -> conclaveStringOf(context, "ppl_rename_too_long")
    else -> conclaveStringOf(context, "ppl_fail_rename")
}

@Composable
internal fun PeopleRenameDialog(people: PeoplePresenter) {
    val rename = people.rename
    if (!rename.isPresented) return
    val context = LocalContext.current
    var draft by rememberSaveable(rename.id) { mutableStateOf(rename.draft) }
    val model = ConclaveTextEntryDialogModel(
        kind = ConclaveTextEntryKind.name_,
        title = conclaveString("ppl_change_name_title"),
        message = conclaveString("ppl_name_rules"),
        fieldLabel = conclaveString("ppl_name_label"),
        confirmTitle = conclaveString("ppl_save"),
        limit = DisplayNamePolicy.limit,
        counterFrom = DisplayNamePolicy.counterThreshold,
    )
    ConclaveTextEntryDialog(
        model = model,
        value = draft,
        onValueChange = { draft = it },
        identifier = "people.rename",
        onConfirm = { people.submitRename(draft) },
        onDismiss = { people.cancelRename() },
        error = if (rename.phase == PeopleRenamePhase.refused) peopleRenameRefusalOf(context, rename.refusal) else null,
        pending = rename.phase == PeopleRenamePhase.pending,
    )
}

internal fun peopleFailureMessageOf(context: Context, kind: String, name: String, sourceKey: String): String = when (kind) {
    PeopleFailureCopy.cantRemove -> conclaveStringOf(context, "ppl_fail_cant_remove")
    PeopleFailureCopy.rateLimited -> conclaveStringOf(context, "ppl_fail_rate_limited")
    PeopleFailureCopy.reconnect -> conclaveStringOf(context, "ppl_fail_reconnect")
    PeopleFailureCopy.alreadyLeft -> conclaveStringOf(context, "ppl_fail_already_left")
    PeopleFailureCopy.mute -> conclaveStringOf(context, "ppl_fail_mute", name)
    PeopleFailureCopy.camera -> conclaveStringOf(context, "ppl_fail_camera", name)
    PeopleFailureCopy.share, PeopleFailureCopy.shareAudio -> conclaveStringOf(context, "ppl_fail_share", name)
    PeopleFailureCopy.remove -> conclaveStringOf(context, "ppl_fail_remove", name)
    PeopleFailureCopy.coHost -> conclaveStringOf(context, "ppl_fail_cohost", name)
    PeopleFailureCopy.host -> conclaveStringOf(context, "ppl_fail_host", name)
    PeopleFailureCopy.audience -> conclaveStringOf(context, "ppl_fail_audience", name)
    PeopleFailureCopy.rename -> conclaveStringOf(context, "ppl_fail_rename")
    PeopleFailureCopy.lockMeeting -> conclaveStringOf(context, "ctl_toast_lock_failed")
    PeopleFailureCopy.policy -> conclaveStringOf(context, "hst_fail_policy", hostPolicyTitleOf(context, sourceKey))
    PeopleFailureCopy.muteAll -> conclaveStringOf(context, "hst_fail_mute_all")
    PeopleFailureCopy.cameras -> conclaveStringOf(context, "hst_fail_cameras")
    PeopleFailureCopy.shares -> conclaveStringOf(context, "hst_fail_shares")
    PeopleFailureCopy.codeSave -> conclaveStringOf(context, "hst_fail_code_save")
    PeopleFailureCopy.codeRemove -> conclaveStringOf(context, "hst_fail_code_remove")
    PeopleFailureCopy.access -> conclaveStringOf(context, "hst_fail_access")
    PeopleFailureCopy.notice -> conclaveStringOf(context, "hst_fail_notice")
    PeopleFailureCopy.link -> conclaveStringOf(context, "hst_fail_link")
    PeopleFailureCopy.invite -> conclaveStringOf(context, "hst_fail_invite", name)
    PeopleFailureCopy.inviteGone -> conclaveStringOf(context, "hst_fail_gone", name)
    PeopleFailureCopy.cancelInvite -> conclaveStringOf(context, "hst_fail_cancel_invite")
    PeopleFailureCopy.webinar -> conclaveStringOf(context, "hst_fail_webinar")
    PeopleFailureCopy.qaSend -> conclaveStringOf(context, "qa_fail_send")
    PeopleFailureCopy.qaRateLimited -> conclaveStringOf(context, "qa_rate_limited")
    PeopleFailureCopy.qaTooShort -> conclaveStringOf(context, "qa_too_short")
    PeopleFailureCopy.qaModerate -> conclaveStringOf(context, "qa_fail_moderate")

    PeopleFailureCopy.admit -> conclaveStringOf(context, "hst_fail_admit", name)
    PeopleFailureCopy.admitAll -> conclaveStringOf(context, "hst_fail_admit_all")
    PeopleFailureCopy.deny -> conclaveStringOf(context, "hst_fail_deny", name)
    PeopleFailureCopy.hands -> conclaveStringOf(context, "hst_fail_lower_all")
    else -> conclaveStringOf(context, "stg_toast_failed_generic")
}

internal fun peopleFailureMessageOf(context: Context, failure: HostActionFailureModel): String =
    peopleFailureMessageOf(context, PeopleFailureCopy.kind(action = failure.action, failure = failure.failure, sourceKey = failure.sourceKey),
        failure.targetName, failure.sourceKey)

@Composable
internal fun PeopleFailureSnackbar(people: PeoplePresenter, snackbar: SnackbarHostState) {
    val failure = people.lastFailure
    val context = LocalContext.current
    val retry = conclaveString("ds_retry")
    LaunchedEffect(failure?.id) {
        val current = failure ?: return@LaunchedEffect
        if (current.placement != HostFailurePlacement.panelSnackbar.rawValue) return@LaunchedEffect
        val result = snackbar.showSnackbar(message = peopleFailureMessageOf(context, current), actionLabel = retry,
            duration = SnackbarDuration.Long)
        if (result == SnackbarResult.ActionPerformed) people.retry(failureId = current.id) else people.dismissFailure(id = current.id)
    }
}

@Composable
internal fun peopleStageToastMessage(notice: MeetingNotice): String {
    val context = LocalContext.current
    val kind = PeopleFailureCopy.kind(action = PeopleFailurePlacementPolicy.stageAction(notice.detail),
        failure = PeopleFailurePlacementPolicy.stageFailure(notice.detail), sourceKey = notice.userId)
    return peopleFailureMessageOf(context, kind, notice.name, notice.userId)
}

@Composable
internal fun peopleAnnouncementText(announcement: StageAnnouncement): String? {
    val context = LocalContext.current
    return when (announcement.kind) {
        PeopleAnnouncementKind.madeCoHost -> conclaveStringOf(context, "ppl_announce_cohost", announcement.name)
        PeopleAnnouncementKind.madeHost -> conclaveStringOf(context, "ppl_announce_host", announcement.name)
        PeopleAnnouncementKind.removed -> conclaveStringOf(context, "ppl_announce_removed", announcement.name)
        PeopleAnnouncementKind.policyOn -> conclaveStringOf(context, "hst_announce_on", hostPolicyTitleOf(context, announcement.name))
        PeopleAnnouncementKind.policyOff -> conclaveStringOf(context, "hst_announce_off", hostPolicyTitleOf(context, announcement.name))
        PeopleAnnouncementKind.noticeSent -> conclaveStringOf(context, "hst_notice_sent")
        PeopleAnnouncementKind.invitedToStage -> conclaveStringOf(context, "ppl_announce_invited", announcement.name)
        PeopleAnnouncementKind.joinedStage -> conclaveStringOf(context, "ppl_announce_joined_stage", announcement.name)
        PeopleAnnouncementKind.movedToAudience -> conclaveStringOf(context, "ppl_announce_demoted", announcement.name)
        PeopleAnnouncementKind.newLinkCopied -> conclaveStringOf(context, "hst_announce_new_link")
        PeopleAnnouncementKind.questionSent -> conclaveStringOf(context, "qa_announce_sent")
        PeopleAnnouncementKind.qaOff -> conclaveStringOf(context, "qa_announce_off")
        PeopleAnnouncementKind.newHost -> conclaveStringOf(context, "ppl_announce_new_host", announcement.name)

        PeopleAnnouncementKind.admittedAll -> {
            val count = announcement.name.toIntOrNull() ?: 0
            conclavePluralOf(context, "ppl_announce_admitted_all", count, count)
        }
        PeopleAnnouncementKind.knock -> conclaveStringOf(context, "stg_banner_knock_one", announcement.name)
        PeopleAnnouncementKind.knockMany -> {
            val count = announcement.name.toIntOrNull() ?: 0
            conclavePluralOf(context, "stg_banner_knock_many", count, count)
        }
        else -> null
    }
}
