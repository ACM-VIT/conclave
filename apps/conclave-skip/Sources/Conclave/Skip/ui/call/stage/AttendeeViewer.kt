package conclave.module

import android.content.Context
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties

@Composable
internal fun AttendeeWaitingLayer(stage: StagePresenter, modifier: Modifier = Modifier) {
    val viewer = stage.attendee ?: return
    if (viewer.isLive) return
    val count = viewer.waitingCount
    val body = if (AttendeeViewerPolicy.showsWaitingCount(count)) conclavePlural("stg_webinar_waiting_count", count, count) else ""
    Box(
        modifier.padding(start = 24.dp, end = 24.dp, top = StageCanvasMetrics.TOP_RESERVE_DP.dp,
            bottom = StageCanvasMetrics.BAR_RESERVE_DP.dp),
        contentAlignment = Alignment.Center,
    ) {

        ConclaveEmptyStatus(
            title = conclaveString("stg_webinar_waiting_title"),
            body = body,
            icon = ConclaveIcons.PodcastsFill0,
            identifier = "stage.attendee.waiting",
        )
    }
}

@Composable
internal fun AttendeeRoleLayer(stage: StagePresenter) {
    val people = stage.people ?: return
    val invitation = people.stageInvitation ?: return
    val title = conclaveString("ppl_invite_title")
    val message = if (invitation.promotedByName.isEmpty()) conclaveString("ppl_invite_message_fallback")
        else conclaveString("ppl_invite_message", invitation.promotedByName)
    HostingTheme(inCall = true) {
        AlertDialog(
            onDismissRequest = { people.declineStageInvitation(id = invitation.id) },
            modifier = Modifier.testTag("stage.invite").semantics { paneTitle = title },
            title = { ConclaveText(title, line = "stage.invite.title") },
            text = { ConclaveText(message, line = "stage.invite.message") },
            confirmButton = {
                TextButton(onClick = { people.acceptStageInvitation(id = invitation.id) }, modifier = Modifier.testTag("stage.invite.accept")) {
                    ConclaveText(conclaveString("pm_join_as_speaker"), line = "stage.invite.accept")
                }
            },
            dismissButton = {
                TextButton(onClick = { people.declineStageInvitation(id = invitation.id) }, modifier = Modifier.testTag("stage.invite.decline")) {
                    ConclaveText(conclaveString("ds_not_now"), line = "stage.invite.decline")
                }
            },
            properties = DialogProperties(dismissOnClickOutside = false, dismissOnBackPress = true),
        )
    }
}

@Composable
internal fun attendeeCapsuleSubtitle(): String = conclaveString("stg_live")

@Composable
internal fun attendeeTitle(title: String): String = if (title.isEmpty()) conclaveString("stg_webinar_fallback_title") else title

internal fun attendeeTitleOf(context: Context, title: String): String =
    if (title.isEmpty()) conclaveStringOf(context, "stg_webinar_fallback_title") else title

@Composable
internal fun attendeeFeedLabel(isShare: Boolean, name: String): String =
    if (isShare) conclaveString("stg_shared_screen_from", name) else conclaveString("stg_live_video_from", name)

@Composable
internal fun attendeeAnnouncementText(kind: String): String? = when (kind) {
    AttendeeViewerPolicy.demotedAnnouncement -> conclaveString("stg_announce_demoted")
    AttendeeViewerPolicy.webinarLiveAnnouncement -> conclaveString("stg_announce_webinar_live")
    else -> null
}

internal fun attendeeShowsWaitingCard(viewer: AttendeeViewerSnapshot?): Boolean = viewer != null && !viewer.isLive

internal fun Modifier.attendeeLayer(): Modifier = this.fillMaxSize().testTag("stage.attendee")
