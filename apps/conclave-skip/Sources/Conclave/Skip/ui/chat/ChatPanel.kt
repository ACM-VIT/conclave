package conclave.module

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import android.content.Intent
import android.net.Uri

/*
 * S40 1 d (CHT-1): the chat panel on Android, one InCallPage in the system theme (content panels follow the system
 * appearance, D3). Below 840 dp (or 480 dp tall) the overlay with the call mini tile; from 840 dp the side pane
 * (WP1-3b2), where message actions are an anchored menu and the reactions viewer an in-pane page (R40-12), so no
 * window sheet or scrim covers the live stage. The list is lazy (`InCallPageContent.lazyList`, R40-3); the composer
 * sits in the page's composer slot with imePadding from the page. Registered in the native call root by request
 * (HD/requests/B4-T1.md R1); the panel reads only the presenter's snapshots and row entries.
 */
@Composable
internal fun ChatPanel(
    presenter: ChatPresenter,
    panels: PanelCoordinator,
    request: PanelRequest,
    variant: InCallPageVariant,
    appearance: PanelAppearance,
    miniTile: CallMiniTileModel?,
    miniTileVideo: (@Composable () -> Unit)?,
    onMounted: () -> Unit,
    onDisposed: () -> Unit,
) {
    val context = LocalContext.current
    val actions = remember(presenter) { ChatRowActions(presenter, context) }
    val cache = remember(presenter) { ChatTimelineCache(presenter) }
    val snackbars = remember { SnackbarHostState() }
    val sidePane = variant == InCallPageVariant.SidePane
    val copiedText = conclaveString("chat_copied")
    LaunchedEffect(request.presentationID) {
        val opened = System.currentTimeMillis()
        presenter.panelDidOpen(ChatPresenter.destination(request.destination), request.targetId)
        ChatDiagnostics.counters?.recordOpenLatency((System.currentTimeMillis() - opened).toDouble())
    }
    DisposableEffect(presenter) {
        onDispose { presenter.panelDidClose() }
    }
    // R40-2: a destination for the panel that is already current (a tile's "Send private message" while chat is open).
    val destination = panels.destinationRequest
    LaunchedEffect(destination?.sequence) {
        val latest = panels.latestDestination(request.presentationID) ?: return@LaunchedEffect
        presenter.panelDidOpen(ChatPresenter.destination(latest.destination), latest.targetId)
    }
    LaunchedEffect(actions.copiedRequest) {
        if (actions.copiedRequest > 0) snackbars.showSnackbar(copiedText)
    }
    // R40-12: in the side pane the viewer is an in-pane page; system Back pops it before closing the pane.
    val viewerInPane = sidePane && actions.viewerRowId.isNotEmpty()
    InCallPage(
        title = if (viewerInPane) conclaveString("chat_reactions_title") else conclaveString("chat_title"),
        variant = variant,
        appearance = appearance,
        hasComposer = !viewerInPane,
        miniTile = miniTile,
        onClose = { panels.dismiss(cancelPending = true) },
        onMounted = onMounted,
        onDisposed = onDisposed,
        miniTileVideo = miniTileVideo,
        composer = { ChatComposer(presenter, actions) },
        contentMode = InCallPageContent.lazyList,
        snackbarHost = { SnackbarHost(snackbars) },
        isNested = viewerInPane,
        onBack = if (viewerInPane) ({ actions.closeViewer() }) else null,
    ) { reservation ->
        Box(Modifier.fillMaxSize().testTag("chat.panel")) {
            if (viewerInPane) {
                ReactionsViewerContent(presenter, actions.viewerRowId)
            } else {
                Column(Modifier.fillMaxSize()) {
                    ChatPolicyBanner(presenter)
                    ChatFixtureBarIfInstalled()
                    ChatTimeline(cache, presenter, actions, sidePane, reservation)
                }
            }
            ChatAnnouncementRegion(presenter)
        }
    }
    if (!sidePane && actions.menuRowId.isNotEmpty()) {
        MessageActionsSheet(presenter, actions, actions.menuRowId)
    }
    if (!sidePane && actions.viewerRowId.isNotEmpty()) {
        ReactionsViewerSheet(presenter, actions, actions.viewerRowId)
    }
    ChatExternalLinkDialog(actions)
}

/** 2 f: the locked banner for guests and the host note. */
@Composable
private fun ChatPolicyBanner(presenter: ChatPresenter) {
    val panel = presenter.panel
    if (!panel.isLocked) return
    if (panel.isHost) {
        ConclaveComposerStatusLine(conclaveString("chat_locked_host_note"), "chat.lockedNote",
            Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
    } else {
        ConclaveBanner(
            kind = ConclaveBannerKind.Info,
            text = conclaveString("chat_locked_title") + "\n" + conclaveString("chat_locked_body"),
            identifier = "chat.lockedBanner",
            inCall = false,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        )
    }
}

/** 2 i: one hidden polite live region owned by the panel, never on rows. */
@Composable
private fun ChatAnnouncementRegion(presenter: ChatPresenter) {
    val announcement = presenter.announcement ?: return
    val text = ChatCopyAndroid.announcement(announcement)
    if (text.isEmpty()) return
    Box(Modifier.size(1.dp).semantics {
        liveRegion = LiveRegionMode.Polite
        contentDescription = text
    })
}

/**
 * D23 links: Conclave meeting links route in the app (S10 4, `ChatRowActions.openLink`); http and https keep today's
 * `ACTION_VIEW` path behind this confirmation until Custom Tabs lands (Q16, `androidx.browser` is a build-owner
 * dependency); other apps' links say "This link opens another app." (S70 R70-9).
 */
@Composable
private fun ChatExternalLinkDialog(actions: ChatRowActions) {
    val url = actions.pendingExternalUrl
    if (url.isEmpty()) return
    val context = LocalContext.current
    AlertDialog(
        onDismissRequest = { actions.pendingExternalUrl = "" },
        title = { ConclaveText(conclaveString("chat_link_title"), line = "chat.link.title") },
        text = {
            val body = if (actions.pendingExternalIsWeb) conclaveString("chat_link_body") else conclaveString("chat_link_body_app")
            // S70 R70-5: the camera line shows while the camera does not continue in the background.
            val camera = if (actions.cameraContinuesInBackground) "" else " " + conclaveString("chat_link_camera_pauses")
            ConclaveText(body + camera, line = "chat.link.body")
        },
        confirmButton = {
            TextButton(onClick = {
                actions.pendingExternalUrl = ""
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            }) { ConclaveText(conclaveString("chat_link_open"), line = "chat.link.open") }
        },
        dismissButton = {
            TextButton(onClick = { actions.pendingExternalUrl = "" }) {
                ConclaveText(conclaveString("ds_cancel"), line = "chat.link.cancel")
            }
        },
        modifier = Modifier.testTag("chat.link.dialog"),
    )
}

/** CH22: the Debug fixture's script bar while a fixture driver is installed (never set in a release run). */
@Composable
private fun ChatFixtureBarIfInstalled() {
    val driver = ChatDiagnostics.driver ?: return
    ChatFixtureControlsBar(driver)
}
