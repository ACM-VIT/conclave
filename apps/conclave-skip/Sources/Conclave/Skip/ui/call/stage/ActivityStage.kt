package conclave.module

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalIconToggleButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

internal val LocalActivitySession = staticCompositionLocalOf<ActivitySession?> { null }

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
        shape = RoundedCornerShape(DesignTokens.radiusTile.dp),
        color = ext.tile,
    ) {
        if (activityStageKind(kind) == ActivityKind.game && session != null &&
            session.games.scene.kind == GameSceneKind.chess && session.games.scene.chess != null) {
            Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.ime.only(WindowInsetsSides.Bottom))) {
                ChessSceneBody(session.games, cardHeader = { compact -> ActivityStageHeader(kind, stage, session, compact) })
            }
        } else {
            Column(Modifier.fillMaxSize()) {
                ActivityStageHeader(kind, stage, session)
                Box(Modifier.weight(1f).fillMaxWidth().windowInsetsPadding(WindowInsets.ime.only(WindowInsetsSides.Bottom))) {
                    ActivityStageBody(kind, stage, session)
                }
            }
        }
    }
}

internal fun activityStageKind(raw: String): ActivityKind = ActivityKind.init(rawValue = raw) ?: ActivityKind.game

internal fun activityStageIcon(raw: String, appId: String): ImageVector =
    activityGlyphIcon(ActivityGlyphPolicy.glyph(kind = activityStageKind(raw).rawValue, appId = appId))

@Composable
internal fun activityStageDisplayName(kind: String, name: String): String = when (activityStageKind(kind)) {
    ActivityKind.game -> if (name.isEmpty()) conclaveString("act_game") else name
    ActivityKind.app -> activitiesAppName(name)
    ActivityKind.browser -> conclaveString("br_title")
}

@Composable
internal fun activityStageAnnouncement(kind: String, name: String): String? {
    val display = activityStageDisplayName(ActivityStagePolicy.announcedKind(name), ActivityStagePolicy.announcedName(name))
    return when (kind) {
        ActivityStagePolicy.startedAnnouncement -> conclaveString("stg_announce_activity_started", display)
        ActivityStagePolicy.endedAnnouncement -> conclaveString("stg_announce_activity_ended", display)
        else -> null
    }
}

private data class ActivityStageIdentityParts(val name: String, val status: String, val appId: String, val gameId: String = "")

@Composable
private fun activityStageIdentity(kind: String, session: ActivitySession?): ActivityStageIdentityParts {
    if (session == null) return ActivityStageIdentityParts(activityStageDisplayName(kind, ""), "", "")
    val activityKind = activityStageKind(kind)
    if (activityKind == ActivityKind.game) {
        val chrome = session.games.chrome
        return ActivityStageIdentityParts(activityStageDisplayName(kind, chrome.name), gameHeaderStatus(chrome), "", chrome.gameId)
    }
    if (activityKind == ActivityKind.browser && session.browser.model.isActive) {

        return ActivityStageIdentityParts(conclaveString("br_title"), browserHeaderStatus(session.browser.model), "")
    }
    val item = session.activities.snapshot.nowPlayingItem(kind = activityKind)
        ?: return ActivityStageIdentityParts(activityStageDisplayName(kind, ""), "", "")

    val hostStatus = if (activityKind == ActivityKind.app) nativeAppHostStatus(session.appHost) else ""
    return ActivityStageIdentityParts(activitiesNowPlayingTitle(item), hostStatus.ifEmpty { activitiesNowPlayingStatus(item) }, item.appId)
}

@Composable
private fun ActivityStageHeader(kind: String, stage: StagePresenter, session: ActivitySession?, stacked: Boolean = false) {
    val parts = activityStageIdentity(kind, session)
    if (stacked) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ActivityStageHeaderIdentity(kind, parts, Modifier.fillMaxWidth())
            ActivityStageHeaderActions(kind, stage, session)
        }
    } else {
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ActivityStageHeaderIdentity(kind, parts, Modifier.weight(1f))
            ActivityStageHeaderActions(kind, stage, session)
        }
    }
}

@Composable
private fun ActivityStageHeaderIdentity(kind: String, parts: ActivityStageIdentityParts, modifier: Modifier) {
    val scheme = MaterialTheme.colorScheme
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.size(36.dp).background(scheme.surfaceContainerHigh, RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
            Icon(if (parts.gameId.isNotEmpty()) gameGlyphIcon(parts.gameId) else activityStageIcon(kind, parts.appId), contentDescription = null,
                tint = scheme.onSurface, modifier = Modifier.size(20.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(parts.name, style = MaterialTheme.typography.titleMedium, color = scheme.onSurface, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() })
            if (parts.status.isNotEmpty()) {
                Text(parts.status, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, maxLines = 1,
                    overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun ActivityStageHeaderActions(kind: String, stage: StagePresenter, session: ActivitySession?) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        val stateText = conclaveString("stg_showing_activity")
        FilledTonalIconToggleButton(
            checked = false,
            onCheckedChange = { stage.setShowsVideoOverActivity(true) },
            colors = IconButtonDefaults.filledTonalIconToggleButtonColors(
                containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                contentColor = MaterialTheme.colorScheme.onSurface,
            ),
            modifier = Modifier.testTag("stage.activity.showVideo").semantics { stateDescription = stateText },
        ) {
            Icon(ConclaveIcons.VideocamFill1, contentDescription = conclaveString("stg_show_video"), modifier = Modifier.size(20.dp))
        }
        if (session != null) {
            if (activityStageKind(kind) == ActivityKind.game) {
                GameShellHeaderActions(session.games)
            } else if (activityStageKind(kind) == ActivityKind.app) {

                NativeAppHostMenu(session.appHost)
            } else if (session.browser.model.isActive) {

                BrowserStageMenu(session.browser)
            } else {
                ActivityCloseButton(activityStageKind(kind), session.activities)
            }
        }
    }
}

@Composable
private fun ActivityCloseButton(kind: ActivityKind, activities: ActivitiesPresenter) {
    val item = activities.snapshot.nowPlayingItem(kind = kind) ?: return
    if (!item.canEnd && !item.endPending) return
    var prompt by remember { mutableStateOf(false) }
    val scheme = MaterialTheme.colorScheme
    ActivityHeaderCapsuleButton(
        title = conclaveString("ds_close"),
        onClick = { prompt = true },
        pending = item.endPending,
        destructive = true,
        modifier = Modifier.testTag("stage.activity.close"),
    )
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
    } else if (activityStageKind(kind) == ActivityKind.app) {

        NativeAppHostBody(session.appHost, onShowVideo = { stage.setShowsVideoOverActivity(true) })
    } else if (session.browser.model.isActive) {

        BrowserStageBody(session.browser, stage, onShowVideo = { stage.setShowsVideoOverActivity(true) })
    } else {
        ActivityWebBody(kind, stage, session)
    }
}

@Composable
private fun ActivityWebBody(kind: String, stage: StagePresenter, session: ActivitySession) {
    val phase = session.cardPhase(kind = kind)
    val parts = activityStageIdentity(kind, session)
    when (phase) {
        ActivityCardPhase.opening -> ActivityLoadingBlock(activitiesCardPhase(phase, parts.name) ?: "", "stage.activity.opening")
        ActivityCardPhase.failed -> ActivityFailureBlock(
            title = activitiesCardPhase(phase, parts.name) ?: "", detail = null, showsRetry = true,
            identifier = "stage.activity.failed", retryIdentifier = "stage.activity.retry",
            showVideoIdentifier = "stage.activity.failedShowVideo",
            onRetry = {
                session.setCardPhase(kind = kind, phase = ActivityCardPhase.opening)
                session.activities.refresh()
            },
            onShowVideo = { stage.setShowsVideoOverActivity(true) },
        )
        ActivityCardPhase.live -> {}
    }
}
