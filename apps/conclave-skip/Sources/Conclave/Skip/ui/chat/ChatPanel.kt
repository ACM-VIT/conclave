package conclave.module

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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

    val destination = panels.destinationRequest
    LaunchedEffect(destination?.sequence) {
        val latest = panels.latestDestination(request.presentationID) ?: return@LaunchedEffect
        presenter.panelDidOpen(ChatPresenter.destination(latest.destination), latest.targetId)
    }
    LaunchedEffect(actions.copiedRequest) {
        if (actions.copiedRequest > 0) snackbars.showSnackbar(copiedText)
    }

    val viewerInPane = sidePane && actions.viewerRowId.isNotEmpty()

    val gifsInPane = sidePane && actions.showsGifs && !viewerInPane
    val nestedTitle = when {
        viewerInPane -> conclaveString("chat_reactions_title")
        gifsInPane -> conclaveString("chat_gifs_title")
        else -> conclaveString("chat_title")
    }
    InCallPage(
        title = nestedTitle,
        variant = variant,
        appearance = appearance,
        hasComposer = !viewerInPane && !gifsInPane,
        miniTile = miniTile,
        onClose = { panels.dismiss(cancelPending = true) },
        onMounted = onMounted,
        onDisposed = onDisposed,
        miniTileVideo = miniTileVideo,
        composer = { ChatComposer(presenter, actions) },
        contentMode = InCallPageContent.lazyList,
        snackbarHost = { SnackbarHost(snackbars) },
        isNested = viewerInPane || gifsInPane,
        onBack = if (viewerInPane) ({ actions.closeViewer() }) else if (gifsInPane) ({ actions.closeGifs() }) else null,
    ) { reservation ->
        Box(Modifier.fillMaxSize().testTag("chat.panel")) {
            if (viewerInPane) {
                ReactionsViewerContent(presenter, actions.viewerRowId)
            } else if (gifsInPane) {
                GifPickerContent(presenter, onPicked = { actions.closeGifs() },
                    modifier = Modifier.testTag("chat.gifs").padding(top = reservation.calculateTopPadding()))
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

    if (!sidePane && actions.showsGifs && actions.menuRowId.isEmpty() && actions.viewerRowId.isEmpty()) {
        GifPickerSheet(presenter, onDismiss = { actions.closeGifs() })
    }
    if (actions.photoRowId.isNotEmpty()) {
        ChatImageViewer(presenter, actions.photoRowId, onDismiss = { actions.closePhoto() })
    }
    ChatExternalLinkDialog(actions)
    AssistantLinkDialog(actions)
}

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

@Composable
private fun ChatAnnouncementRegion(presenter: ChatPresenter) {
    val announcement = presenter.announcement ?: return
    val text = ChatCopyAndroid.announcement(announcement)
    if (text.isEmpty()) return

    LaunchedEffect(announcement.id) { ChatDiagnostics.counters?.bump("chat.announcement." + announcement.kind) }
    Box(Modifier.size(1.dp).semantics {
        liveRegion = LiveRegionMode.Polite
        contentDescription = text
    })
}

@Composable
private fun ChatExternalLinkDialog(actions: ChatRowActions) {
    val url = actions.pendingExternalUrl
    if (url.isEmpty()) return
    AlertDialog(
        onDismissRequest = { actions.pendingExternalUrl = "" },
        title = { ConclaveText(conclaveString("chat_link_title"), line = "chat.link.title") },
        text = {
            val body = if (actions.pendingExternalIsWeb) conclaveString("chat_link_body") else conclaveString("chat_link_body_app")

            val camera = if (actions.presenter.showsCameraLine) " " + conclaveString("chat_link_camera_pauses") else ""
            ConclaveText(body + camera, line = "chat.link.body")
        },
        confirmButton = {
            TextButton(onClick = {
                actions.pendingExternalUrl = ""
                NativeExternalHandoff.openExternalApp(url)
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

@Composable
private fun AssistantLinkDialog(actions: ChatRowActions) {
    val url = actions.pendingAssistantUrl
    if (url.isEmpty()) return
    val lower = url.lowercase()
    val isWeb = lower.startsWith("http://") || lower.startsWith("https://")
    val host = runCatching { android.net.Uri.parse(url).host }.getOrNull().orEmpty()
    AlertDialog(
        onDismissRequest = { actions.pendingAssistantUrl = "" },
        title = { ConclaveText(conclaveString("chat_link_title"), line = "chat.assistantLink.title") },
        text = {
            val body = if (isWeb) conclaveString("chat_link_body") else conclaveString("chat_link_body_app")
            val camera = if (!isWeb && actions.presenter.showsCameraLine) " " + conclaveString("chat_link_camera_pauses") else ""
            val hostLine = if (host.isNotEmpty()) "\n" + host else ""
            ConclaveText(body + camera + hostLine, line = "chat.assistantLink.body")
        },
        confirmButton = {
            Row {
                TextButton(onClick = { actions.copyAssistantLink() }, modifier = Modifier.testTag("chat.assistantLink.copy")) {
                    ConclaveText(conclaveString("chat_action_copy_link"), line = "chat.assistantLink.copy.label")
                }
                TextButton(onClick = { actions.confirmAssistantLink() }, modifier = Modifier.testTag("chat.assistantLink.open")) {
                    ConclaveText(conclaveString("chat_link_open"), line = "chat.assistantLink.open.label")
                }
            }
        },
        dismissButton = {
            TextButton(onClick = { actions.pendingAssistantUrl = "" }) {
                ConclaveText(conclaveString("ds_cancel"), line = "chat.assistantLink.cancel")
            }
        },
        modifier = Modifier.testTag("chat.assistantLink.dialog"),
    )
}

@Composable
private fun ChatFixtureBarIfInstalled() {
    val driver = ChatDiagnostics.driver ?: return
    ChatFixtureControlsBar(driver)
}
