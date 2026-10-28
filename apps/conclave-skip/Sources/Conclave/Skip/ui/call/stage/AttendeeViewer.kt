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

/*
 * S20 12 (STG-8, SL13) on Android: the webinar attendee viewer. The program feed and the speaker inset are ordinary
 * canvas slots (`programFeed`, `speakerInset`; `AttendeeViewerPolicy.slots`), so the feed keeps its TextureView when a
 * share starts; the top row keeps Minimize, the capsule (webinar title and "Live", which opens Webinar details,
 * RECONCILE R44) and the RouteButton; the toolbar is the S30 attendee composition `[hand] [Q&A] | [end]` (CTL-1).
 * This file adds the waiting state (F00 C14 d in the in-call theme) and the attendee copy the chrome, the slots and
 * the announcement region resolve. No mic, camera, chat, reactions, People or captions for attendees (12 b).
 */

/** The waiting state (12 c, f): shown while nobody is on the feed. Reads only `stage.attendee`. */
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
        // The broadcast concept is pending in the icon manifest (S20 SR1); the video glyph stands in.
        ConclaveEmptyStatus(
            title = conclaveString("stg_webinar_waiting_title"),
            body = body,
            icon = ConclaveIcons.VideocamFill1,
            identifier = "stage.attendee.waiting",
        )
    }
}

/**
 * S50 12 d (PPL-7, PH9): the stage invitation over the attendee viewer, an AlertDialog in the in-call theme. Outside
 * taps stay disabled (a decision is required); system Back calls onDismissRequest, which declines exactly like
 * "Not now", so Back is never swallowed and `webinar:declineStage` releases the server-side invite. "Join as a speaker"
 * starts the PH20 handoff (the promotion lobby over the still-playing viewer). Nothing plays on the invitation (remote
 * event, R05). Composed by the native call root (HD request B6-T1 R2); reads only `people.stageInvitation`.
 */
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

/** The capsule's second line for attendees (12 g). */
@Composable
internal fun attendeeCapsuleSubtitle(): String = conclaveString("stg_live")

/** The webinar title, or "Webinar" while the landing title is unknown (SC22). */
@Composable
internal fun attendeeTitle(title: String): String = if (title.isEmpty()) conclaveString("stg_webinar_fallback_title") else title

/** The same outside composition (clipboard labels, share titles). */
internal fun attendeeTitleOf(context: Context, title: String): String =
    if (title.isEmpty()) conclaveStringOf(context, "stg_webinar_fallback_title") else title

/** "Live video from Avery" or "Shared screen from Avery" (12 i). */
@Composable
internal fun attendeeFeedLabel(isShare: Boolean, name: String): String =
    if (isShare) conclaveString("stg_shared_screen_from", name) else conclaveString("stg_live_video_from", name)

/** One-shot announcements (12 f, 12 i); null for kinds this file does not own. */
@Composable
internal fun attendeeAnnouncementText(kind: String): String? = when (kind) {
    AttendeeViewerPolicy.demotedAnnouncement -> conclaveString("stg_announce_demoted")
    AttendeeViewerPolicy.webinarLiveAnnouncement -> conclaveString("stg_announce_webinar_live")
    else -> null
}

/** The fixture readout's view of the attendee layer (tests): whether the waiting card draws for a snapshot. */
internal fun attendeeShowsWaitingCard(viewer: AttendeeViewerSnapshot?): Boolean = viewer != null && !viewer.isLive

/** Keeps the waiting layer's container full size in the stage surface. */
internal fun Modifier.attendeeLayer(): Modifier = this.fillMaxSize().testTag("stage.attendee")
