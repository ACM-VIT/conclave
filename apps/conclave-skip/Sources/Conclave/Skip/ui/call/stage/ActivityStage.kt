package conclave.module

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/*
 * S20 11 and SL12 (STG-9) on Android: the activity takeover container in the canvas `activity` slot. One flat card
 * (Surface surfaceContainer, RoundedCornerShape(16.dp), BorderStroke(1.dp, ext.border)) with a header owned here
 * (identity, the name as a heading, the status line, the Show video IconToggleButton, then the trailing host or seat
 * actions spec 60 places) and a body slot: the game shell (ACT-2) or the app and browser bodies (ACT-7, ACT-9) with
 * their opening and failed states. Only the card body pads for the IME (windowInsetsPadding(ime.only(Bottom)), fixing
 * the untested legacy Android IME, INM G3), so the stage height never changes. People stay in the strip with you
 * included; no floating self view over the card. The container reads only layout.activityKind; the body reads its
 * own presenter, so game pushes never recompose the stage (S20 11 k).
 */

/** The session's activity presenters, provided once by the call root (HD request B4-T8 R5); null outside it. */
internal val LocalActivitySession = staticCompositionLocalOf<ActivitySession?> { null }

/** The `activity` slot content (SlotView's activity branch, HD request B4-T8 R6). */
@Composable
internal fun ActivityStageCard(stage: StagePresenter, modifier: Modifier = Modifier) {
    val kind = stage.layout.activityKind
    ActivityStageCardContent(kind, stage, LocalActivitySession.current, modifier)
}

@Composable
private fun ActivityStageCardContent(kind: String, stage: StagePresenter, session: ActivitySession?, modifier: Modifier) {
    val ext = LocalConclaveExtendedColors.current
    Surface(
        modifier = modifier.testTag("stage.activity.$kind").semantics { isTraversalGroup = true },
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceContainer,
        border = BorderStroke(1.dp, ext.border),
    ) {
        Column(Modifier.fillMaxSize()) {
            ActivityStageHeader(kind, stage, session)
            HorizontalDivider(color = ext.border)
            Box(Modifier.weight(1f).fillMaxWidth().windowInsetsPadding(WindowInsets.ime.only(WindowInsetsSides.Bottom))) {
                ActivityStageBody(kind, stage, session)
            }
        }
    }
}

internal fun activityStageKind(raw: String): ActivityKind = ActivityKind.init(rawValue = raw) ?: ActivityKind.game

internal fun activityStageIcon(raw: String, appId: String): ImageVector = when (activityStageKind(raw)) {
    ActivityKind.game -> ConclaveIcons.SportsEsportsFill0
    ActivityKind.app -> if (appId == "whiteboard") ConclaveIcons.DrawFill0 else ConclaveIcons.AppsFill0
    ActivityKind.browser -> ConclaveIcons.PublicFill0
}

/**
 * The chip and announcement name (HD request B4-T8 R7: the Now Playing chip calls this, so an app chip shows the
 * app's localized name, never its id).
 */
@Composable
internal fun activityStageDisplayName(kind: String, name: String): String = when (activityStageKind(kind)) {
    ActivityKind.game -> if (name.isEmpty()) conclaveString("act_game") else name
    ActivityKind.app -> activitiesAppName(name)
    ActivityKind.browser -> conclaveString("br_title")
}

/**
 * `activityStarted` and `activityEnded` (S20 11 g); null for any other announcement kind. `name` is the encoded
 * ActivityStagePolicy.announcementName (kind and raw name), decoded here so an app reads its localized name.
 */
@Composable
internal fun activityStageAnnouncement(kind: String, name: String): String? {
    val display = activityStageDisplayName(ActivityStagePolicy.announcedKind(name), ActivityStagePolicy.announcedName(name))
    return when (kind) {
        ActivityStagePolicy.startedAnnouncement -> conclaveString("stg_announce_activity_started", display)
        ActivityStagePolicy.endedAnnouncement -> conclaveString("stg_announce_activity_ended", display)
        else -> null
    }
}

/** The card's identity: a game reads the shell's chrome (per phase), an app or the browser the Now Playing row. */
private data class ActivityStageIdentityParts(val name: String, val status: String, val appId: String)

@Composable
private fun activityStageIdentity(kind: String, session: ActivitySession?): ActivityStageIdentityParts {
    if (session == null) return ActivityStageIdentityParts(activityStageDisplayName(kind, ""), "", "")
    val activityKind = activityStageKind(kind)
    if (activityKind == ActivityKind.game) {
        val chrome = session.games.chrome
        return ActivityStageIdentityParts(activityStageDisplayName(kind, chrome.name), gameHeaderStatus(chrome), "")
    }
    val item = session.activities.snapshot.nowPlayingItem(kind = activityKind)
        ?: return ActivityStageIdentityParts(activityStageDisplayName(kind, ""), "", "")
    return ActivityStageIdentityParts(activitiesNowPlayingTitle(item), activitiesNowPlayingStatus(item), item.appId)
}

/** Identity, Show video, then the trailing actions; the header's controls precede the body in reading order. */
@Composable
private fun ActivityStageHeader(kind: String, stage: StagePresenter, session: ActivitySession?) {
    val scheme = MaterialTheme.colorScheme
    val parts = activityStageIdentity(kind, session)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(activityStageIcon(kind, parts.appId), contentDescription = null, tint = scheme.onSurface)
        Column(Modifier.weight(1f)) {
            Text(parts.name, style = MaterialTheme.typography.titleMedium, color = scheme.onSurface, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() })
            if (parts.status.isNotEmpty()) {
                Text(parts.status, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, maxLines = 1,
                    overflow = TextOverflow.Ellipsis)
            }
        }
        // Show video is local and reversible: the card leaves the stage and the Now Playing chip brings it back, so the
        // visible toggle always reads "Showing activity".
        ConclaveIconToggleButton(
            description = conclaveString("stg_show_video"),
            stateText = conclaveString("stg_showing_activity"),
            icon = ConclaveIcons.VideocamFill1,
            checkedIcon = ConclaveIcons.VideocamFill1,
            checked = false,
            onCheckedChange = { stage.setShowsVideoOverActivity(true) },
            identifier = "stage.activity.showVideo",
        )
        if (session != null) {
            if (activityStageKind(kind) == ActivityKind.game) {
                GameShellHeaderActions(session.games)
            } else {
                ActivityCloseButton(activityStageKind(kind), session.activities)
            }
        }
    }
}

/** The host Close for an app or the browser, with its confirmation (R09); participants get none. */
@Composable
private fun ActivityCloseButton(kind: ActivityKind, activities: ActivitiesPresenter) {
    val item = activities.snapshot.nowPlayingItem(kind = kind) ?: return
    if (!item.canEnd && !item.endPending) return
    var prompt by remember { mutableStateOf(false) }
    val scheme = MaterialTheme.colorScheme
    TextButton(
        onClick = { prompt = true },
        enabled = !item.endPending,
        colors = ButtonDefaults.textButtonColors(contentColor = scheme.error),
        modifier = Modifier.heightIn(min = 48.dp).testTag("stage.activity.close"),
    ) {
        if (item.endPending) {
            CircularProgressIndicator(Modifier.size(18.dp), color = scheme.error, strokeWidth = 2.dp)
        } else {
            Text(conclaveString("ds_close"))
        }
    }
    if (prompt) {
        AlertDialog(
            onDismissRequest = { prompt = false },
            title = { Text(activitiesEndDialogTitle(item)) },
            text = { Text(activitiesEndDialogMessage(item)) },
            confirmButton = {
                TextButton(onClick = { prompt = false; activities.requestEnd(item.id) },
                    colors = ButtonDefaults.textButtonColors(contentColor = scheme.error)) { Text(activitiesEndConfirm(item)) }
            },
            dismissButton = { TextButton(onClick = { prompt = false }) { Text(conclaveString("ds_cancel")) } },
        )
    }
}

@Composable
private fun ActivityStageBody(kind: String, stage: StagePresenter, session: ActivitySession?) {
    if (session == null) return
    if (activityStageKind(kind) == ActivityKind.game) {
        GameShellBody(session.games, session.storeURL, onShowVideo = { stage.setShowsVideoOverActivity(true) })
    } else {
        ActivityWebBody(kind, stage, session)
    }
}

/**
 * Apps and the shared browser before their hosts land (ACT-7, ACT-9): "Opening %1$s" with a system spinner, or
 * "Couldn't open %1$s" with Retry and Show video (S60R 25). A live body belongs to the host (one retained WebView).
 */
@Composable
private fun ActivityWebBody(kind: String, stage: StagePresenter, session: ActivitySession) {
    val phase = session.cardPhase(kind = kind)
    val parts = activityStageIdentity(kind, session)
    val scheme = MaterialTheme.colorScheme
    Column(
        Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        when (phase) {
            ActivityCardPhase.opening -> {
                CircularProgressIndicator(color = scheme.onSurface)
                Spacer(Modifier.size(12.dp))
                Text(activitiesCardPhase(phase, parts.name) ?: "", style = MaterialTheme.typography.bodyMedium,
                    color = scheme.onSurfaceVariant, textAlign = TextAlign.Center)
            }
            ActivityCardPhase.failed -> {
                Text(activitiesCardPhase(phase, parts.name) ?: "", style = MaterialTheme.typography.titleMedium,
                    color = scheme.onSurface, textAlign = TextAlign.Center)
                Spacer(Modifier.size(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = {
                        session.setCardPhase(kind = kind, phase = ActivityCardPhase.opening)
                        session.activities.refresh()
                    }, modifier = Modifier.heightIn(min = 48.dp).testTag("stage.activity.retry")) {
                        Text(conclaveString("stg_retry"))
                    }
                    Spacer(Modifier.width(0.dp))
                    OutlinedButton(onClick = { stage.setShowsVideoOverActivity(true) },
                        modifier = Modifier.heightIn(min = 48.dp).testTag("stage.activity.failedShowVideo")) {
                        Text(conclaveString("stg_show_video"))
                    }
                }
            }
            ActivityCardPhase.live -> {}
        }
    }
}
