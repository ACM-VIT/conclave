package conclave.module

import android.os.Build
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/*
 * ENT-8 (S10 6 d L8, 11 d; S20 SC21; RECONCILE R14, R50): the lobby's Meeting link row on Android. The link comes
 * from the shared MeetingLinkBuilder through `premeeting.lobbyLink` (`?clientId=` only for a non-default tenant).
 * Copy writes the clipboard (label `pm_clip_label`) and plays the `linkCopied` gesture (silent on API 33+ by
 * contract); the app snackbar "Link copied" shows only on API 28 to 32 (Android 13+ confirms by itself). Any copy
 * state is composable-local, never presenter state. Before a new meeting starts the row only explains that invites
 * come after Start (S10 Q1).
 */

/** API 28 to 32 only: Android 13 and later show their own copy confirmation (AND finding 17). */
internal fun lobbyShowsCopySnackbar(sdk: Int = Build.VERSION.SDK_INT): Boolean = sdk in 28..32

@Composable
internal fun MeetingLinkRow(premeeting: PremeetingPresenter, snackbarHostState: SnackbarHostState) {
    val link = premeeting.lobbyLink
    val scheme = MaterialTheme.colorScheme
    val haptics = rememberConclaveHaptics()
    val scope = rememberCoroutineScope()
    val copiedMessage = conclaveString("pm_link_copied")
    val clipLabel = conclaveString("pm_clip_label")
    if (link == null || !link.canShare || link.meetingLink.isEmpty()) {
        ListItem(
            headlineContent = {
                Text(conclaveString("pm_invite_after_start"), style = MaterialTheme.typography.bodyMedium,
                    color = scheme.onSurfaceVariant)
            },
            colors = ListItemDefaults.colors(containerColor = scheme.surface),
            modifier = Modifier.testTag("lobby.link"),
        )
        return
    }
    val url = link.meetingLink
    ListItem(
        overlineContent = { Text(conclaveString("pm_meeting_link")) },
        headlineContent = {
            Text(MeetingLinkBuilder.displayText(url), maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
        },
        trailingContent = {
            IconButton(
                onClick = {
                    ClipboardHelper.copyToClipboard(text = url, label = clipLabel)
                    haptics.gesture(FeedbackKind.linkCopied)
                    if (lobbyShowsCopySnackbar()) {
                        scope.launch { snackbarHostState.showSnackbar(copiedMessage) }
                    }
                },
                modifier = Modifier.testTag("lobby.link.copy"),
            ) {
                Icon(ConclaveIcons.ContentCopyFill0, contentDescription = conclaveString("pm_copy_link"),
                    tint = scheme.onSurfaceVariant)
            }
        },
        colors = ListItemDefaults.colors(containerColor = scheme.surface),
        modifier = Modifier.padding(horizontal = 0.dp).testTag("lobby.link"),
    )
}

/** The toolbar Share (S10 11 d): the F00 payload resolved here, EXTRA_TITLE = the room label, no chooser title. */
@Composable
internal fun rememberLobbyShare(premeeting: PremeetingPresenter): (() -> Unit)? {
    val link = premeeting.lobbyLink ?: return null
    if (!link.canShare || link.meetingLink.isEmpty()) return null
    val subject = conclaveString("ds_share_subject")
    val text = conclaveString("ds_share_text", link.meetingLink)
    val url = link.meetingLink
    val title = link.roomLabel
    return {
        NativeMeetingShare.shareMeetingLink(link = url, subject = subject, text = text, title = title)
        Unit
    }
}
