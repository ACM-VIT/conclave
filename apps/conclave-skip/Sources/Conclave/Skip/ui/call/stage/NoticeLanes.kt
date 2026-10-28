package conclave.module

import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import skip.ui.UIApplication

private object NoticeLaneDefaults {

    const val CHIP_ROW_DP = 56.0
    const val TOAST_GAP_DP = 8
    const val MAX_TOAST_WIDTH_DP = 560
}

private class RetainedNotice {
    var notice: MeetingNotice? = null
}

@Composable
internal fun NoticeLanes(stage: StagePresenter, forceScreenReader: Boolean, installsSound: Boolean, modifier: Modifier = Modifier) {
    DisposableEffect(stage, installsSound) {
        stage.setNoticePlatform(NoticePlatform.android)
        if (installsSound) {
            stage.sounds.output = { kind -> NativeNoticeSound.play(kind) }
        }
        onDispose {
            if (installsSound) stage.sounds.output = null
        }
    }
    Box(modifier.fillMaxSize()) {
        NoticeBannerLane(stage)
        NoticeBottomLanes(stage)
    }
}

@Composable
private fun NoticeBannerLane(stage: StagePresenter) {
    val geometry = stage.noticeGeometry
    val notice = stage.banner
    val retained = remember { RetainedNotice() }
    if (notice != null) retained.notice = notice
    val top = geometry.bannerTop + (if (geometry.chipsVisible) NoticeLaneDefaults.CHIP_ROW_DP else 0.0)
    ConclaveBannerLane(noticeId = notice?.id, identifier = "stage.banner", modifier = Modifier.padding(top = top.dp)) {
        val shown = retained.notice
        if (shown != null) NoticeBanner(stage, shown)
    }
}

@Composable
private fun NoticeBanner(stage: StagePresenter, notice: MeetingNotice) {
    val context = LocalContext.current
    var expanded by remember(notice.id) { mutableStateOf(false) }
    val actions = mutableListOf<ConclaveBannerAction>()
    for (action in notice.actions) {
        if (action.id == NoticeAction.catchUp) continue
        val title = noticeActionTitle(action.id, notice, expanded)
        actions.add(ConclaveBannerAction(title, "stage.banner.${notice.kind}.${action.id}", action.isEnabled,
            if (action.id == NoticeAction.retryRecovery) conclaveString("sys_retrying_now") else "") {
            when (action.id) {
                NoticeAction.expand -> expanded = !expanded
                NoticeAction.openSettings -> openNoticeSettings(context, notice)
                else -> stage.performNoticeAction(noticeId = notice.id, actionId = action.id)
            }
        })
    }
    val catchUpLabel = noticeBannerText(notice)
    val modifier = if (notice.hasAction(NoticeAction.catchUp)) {
        Modifier.clickable(onClickLabel = catchUpLabel, role = Role.Button) {
            stage.performNoticeAction(noticeId = notice.id, actionId = NoticeAction.catchUp)
        }
    } else Modifier
    ConclaveBanner(
        kind = noticeBannerKind(notice),
        text = noticeBannerText(notice),
        identifier = "stage.banner.${notice.kind}",
        inCall = true,
        modifier = modifier,
        actions = actions,
        onDismiss = if (notice.isDismissible) ({ stage.dismissNotice(id = notice.id) }) else null,
        maxLines = if (expanded) Int.MAX_VALUE else ConclaveBannerLaneMetrics.LINE_LIMIT,
        announces = notice.announcement != NoticeAnnouncement.none,
        isAssertive = notice.announcement == NoticeAnnouncement.assertiveOnce,
    )
}

@Composable
private fun NoticeBottomLanes(stage: StagePresenter) {
    val geometry = stage.noticeGeometry
    Column(
        Modifier.fillMaxSize().padding(start = geometry.toastLeading.dp, end = geometry.toastTrailing.dp,
            bottom = (geometry.toastBottom + NoticeLaneDefaults.TOAST_GAP_DP).dp),
        verticalArrangement = Arrangement.spacedBy(NoticeLaneDefaults.TOAST_GAP_DP.dp, Alignment.Bottom),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CaptionsStripSlot(stage)
        NoticeToastLane(stage, Modifier.fillMaxWidth().widthIn(max = NoticeLaneDefaults.MAX_TOAST_WIDTH_DP.dp))
    }
}

@Composable
private fun NoticeToastLane(stage: StagePresenter, modifier: Modifier) {
    val notice = stage.toast
    val item = if (notice == null || ChatPreviewPolicy.isChatPreview(notice)) null else noticeToastItem(notice)
    Box(modifier.testTag("stage.toast.lane"), contentAlignment = Alignment.BottomCenter) {
        ConclaveToastHost(
            item = item,
            identifier = "stage.toast",
            onAction = { shown -> stage.performNoticeAction(noticeId = shown.id, actionId = shown.actionId) },
            onDismiss = { id -> stage.dismissNotice(id = id) },
        )
        ChatPreviewSnackbarHost(stage)
    }
}

private fun openNoticeSettings(context: Context, notice: MeetingNotice) {

    if (notice.kind == NoticeKind.captivePortal) {
        val intent = if (Build.VERSION.SDK_INT >= 29) Intent(Settings.Panel.ACTION_WIFI) else Intent(Settings.ACTION_WIFI_SETTINGS)
        val activity = UIApplication.shared.androidActivity
        if (activity == null) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            (activity ?: context).startActivity(intent)
        } catch (error: Throwable) {
            NativePerformanceDiagnostics.event("notice_settings_failed", error.message ?: "unknown")
        }
        return
    }
    PermissionHelper.openAppSettings()
}

internal fun noticeBannerKind(notice: MeetingNotice): ConclaveBannerKind = when (notice.severity) {
    NoticeSeverity.progress -> ConclaveBannerKind.Reconnecting
    NoticeSeverity.warning -> ConclaveBannerKind.Warning
    NoticeSeverity.error -> ConclaveBannerKind.Error
    NoticeSeverity.success -> ConclaveBannerKind.Success
    else -> ConclaveBannerKind.Info
}

@Composable
internal fun noticeBannerText(notice: MeetingNotice): String = when (notice.kind) {
    NoticeKind.offline -> conclaveString("stg_banner_offline")
    NoticeKind.captivePortal -> conclaveString("stg_banner_captive_portal")
    NoticeKind.reconnecting -> {
        val title = conclaveString("stg_banner_reconnecting")
        if (notice.count > 0) title + "\n" + conclaveString("stg_banner_attempt", notice.count, notice.total) else title
    }
    NoticeKind.serverRestart -> if (notice.serverText.isNotEmpty()) notice.serverText else conclaveString("stg_banner_server_restart")
    NoticeKind.recapPosting -> conclaveString("ctl_banner_recap")
    NoticeKind.onHold -> conclaveString("stg_banner_on_hold")
    NoticeKind.audioPaused -> conclaveString("stg_banner_audio_paused")
    NoticeKind.knock -> if (notice.count == 1 && notice.name.isNotEmpty()) conclaveString("stg_banner_knock_one", notice.name)
        else conclavePlural("stg_banner_knock_many", notice.count, notice.count)
    NoticeKind.sharing -> conclaveString("stg_banner_sharing")
    NoticeKind.shareRestoreFailed -> conclaveString("stg_banner_share_restore")
    NoticeKind.shareNotSending -> conclaveString("stg_banner_share_stalled")
    NoticeKind.hostNotice -> if (notice.name.isEmpty()) notice.serverText
        else conclaveString("stg_banner_notice_from", notice.name) + " " + notice.serverText
    NoticeKind.liveNotesStarted -> conclaveString("stg_banner_live_notes")
    NoticeKind.catchUp -> conclavePlural("stg_banner_catch_up", notice.count, notice.count)
    NoticeKind.audioOnly -> conclaveString("stg_banner_audio_only")
    NoticeKind.veryPoorConnection -> conclaveString("stg_banner_poor_connection")
    NoticeKind.permission -> if (notice.detail == MeetingNoticePolicy.permissionMicrophone) conclaveString("stg_banner_mic_permission")
        else conclaveString("stg_banner_camera_permission")
    NoticeKind.notificationsOff -> conclaveString("sys_notif_prime_call")
    else -> ""
}

@Composable
internal fun noticeActionTitle(actionId: String, notice: MeetingNotice, expanded: Boolean): String = when (actionId) {
    NoticeAction.view -> conclaveString("ds_view")
    NoticeAction.admit -> conclaveString("ds_admit")
    NoticeAction.admitAll -> conclaveString("stg_admit_all")
    NoticeAction.stopSharing -> conclaveString("stg_stop_sharing")
    NoticeAction.turnOffAudioOnly -> conclaveString("stg_turn_off")
    NoticeAction.openSettings -> if (notice.kind == NoticeKind.captivePortal) conclaveString("sys_open_wifi_settings")
        else conclaveString("ds_open_settings")
    NoticeAction.shareAgain -> conclaveString("stg_share_again")
    NoticeAction.retry -> conclaveString("ds_retry")
    NoticeAction.retryRecovery -> conclaveString("stg_retry_now")
    NoticeAction.resume -> conclaveString("stg_banner_resume")
    NoticeAction.useAudioOnly -> conclaveString("stg_use_audio_only")
    NoticeAction.endNow -> conclaveString("ctl_end_now")
    NoticeAction.vote -> conclaveString("stg_vote")
    NoticeAction.allow -> conclaveString("sys_allow")
    NoticeAction.notNow -> conclaveString("ds_not_now")
    NoticeAction.expand -> if (expanded) conclaveString("stg_less") else conclaveString("stg_more")
    else -> ""
}

@Composable
internal fun noticeToastItem(notice: MeetingNotice): ConclaveToastItem {
    val first = if (notice.actions.count == 0) null else notice.actions[0]
    val showsAvatar = notice.kind == NoticeKind.chatPreview || notice.kind == NoticeKind.handRaised
    return ConclaveToastItem(
        id = notice.id,
        message = noticeToastMessage(notice),
        actionTitle = if (first == null) "" else noticeActionTitle(first.id, notice, false),
        actionId = first?.id ?: "",
        avatarName = if (showsAvatar) notice.name else "",
        avatarId = if (showsAvatar) notice.userId else "",
        isFailure = notice.isFailure,
        isProgress = notice.severity == NoticeSeverity.progress,
    )
}

@Composable
internal fun noticeToastMessage(notice: MeetingNotice): String = when (notice.kind) {
    NoticeKind.joined -> if (notice.count > 1) conclavePlural("stg_toast_joined_many", notice.count - 1, notice.name, notice.count - 1)
        else conclaveString("stg_toast_joined", notice.name)
    NoticeKind.left -> conclaveString("stg_toast_left", notice.name)
    NoticeKind.handRaised -> if (notice.count > 1) conclavePlural("stg_toast_hand_many", notice.count - 1, notice.name, notice.count - 1)
        else conclaveString("stg_toast_hand", notice.name)
    NoticeKind.hostMutedYou -> conclaveString("stg_toast_host_muted")
    NoticeKind.hostCameraOff -> conclaveString("stg_toast_host_camera")
    NoticeKind.hostLoweredHand -> conclaveString("stg_toast_host_hand")
    NoticeKind.hostStoppedShare -> conclaveString("stg_toast_host_share")
    NoticeKind.becameHost -> conclaveString("stg_toast_became_host")
    NoticeKind.lostHost -> conclaveString("stg_toast_lost_host")
    NoticeKind.routeChanged -> conclaveString("stg_toast_route", notice.name)
    NoticeKind.actionFailed -> when (notice.detail) { "hand" -> conclaveString("stg_toast_hand_failed"); "flipCamera" -> conclaveString("stg_flip_failed"); else -> conclaveString("stg_toast_failed_generic") }
    NoticeKind.rateLimited -> if (notice.detail == "hand") conclaveString("sys_err_hand_rate") else conclaveString("stg_toast_reaction_rate")
    NoticeKind.voteOpened -> conclaveString("stg_toast_vote_opened", notice.name)
    NoticeKind.resumedMuted -> conclaveString("stg_toast_resumed_muted")
    NoticeKind.qualityLowered -> conclaveString("stg_toast_quality_lowered")
    NoticeKind.chatPreview -> {

        val title = if (notice.senderCount > 1) conclavePlural("ds_name_and_others", notice.senderCount - 1, notice.name, notice.senderCount - 1)
            else notice.name
        if (notice.detail.isEmpty()) title else title + ": " + notice.detail
    }
    NoticeKind.endingForEveryone -> conclaveString("ctl_toast_ending")
    NoticeKind.endFailed -> conclaveString("ctl_toast_end_failed")
    NoticeKind.routeFailed -> conclaveString("ctl_toast_route_failed")
    NoticeKind.lockFailed -> conclaveString("ctl_toast_lock_failed")
    NoticeKind.linkCopied -> conclaveString("ds_link_copied")

    PeopleFailurePlacementPolicy.stageNoticeKind -> peopleStageToastMessage(notice)

    NoticeKind.blockedExplanation ->
        ControlBarPolicy.explanation(fromNotice = notice)?.let { callControlToast(it) } ?: conclaveString("stg_toast_failed_generic")

    NoticeKind.shareFailed -> conclaveString(ScreenShareFailurePolicy.androidResourceName(detail = notice.detail))
    else -> conclaveString("stg_toast_failed_generic")
}
