package conclave.module

import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView

@Composable
internal fun BrowserStageBody(browser: BrowserStagePresenter, stage: StagePresenter, onShowVideo: () -> Unit, modifier: Modifier = Modifier) {
    val model = browser.model
    val ext = LocalConclaveExtendedColors.current
    LaunchedEffect(model.wantsWebView, model.browserSessionId) {

        if (!model.wantsWebView && model.browserSessionId.isNotEmpty()) BrowserWebViewRegistry.release(model.browserSessionId)
    }
    Column(modifier.fillMaxSize().testTag("browser.body.${model.load.rawValue}").semantics { isTraversalGroup = true }) {
        if (model.showsAddressRow) {
            BrowserAddressRow(browser, model)
            HorizontalDivider(color = ext.border)
        }
        BrowserVideoArea(browser, model, stage, onShowVideo, Modifier.weight(1f).fillMaxWidth())
        val sharer = browserSharer(model)
        if (model.isActive && (sharer != null || model.showsAudioControl)) {
            HorizontalDivider(color = ext.border)
            BrowserFooterRow(browser, model, sharer)
        }
        if (browser.showsDebugReadouts) BrowserReadouts(browser)
    }
}

@Composable
private fun BrowserAddressRow(browser: BrowserStagePresenter, model: BrowserStageModel) {
    val scheme = MaterialTheme.colorScheme
    var draft by rememberSaveable { mutableStateOf(model.pageURL) }
    var seededURL by rememberSaveable { mutableStateOf(model.pageURL) }
    var focused by remember { mutableStateOf(false) }
    LaunchedEffect(model.pageURL) {

        if (model.pageURL != seededURL && !focused) {
            seededURL = model.pageURL
            draft = model.pageURL
        }
    }
    val message = browserInlineMessage(model)
    val stacked = LocalDensity.current.fontScale >= 1.5f
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
        val field = @Composable { fieldModifier: Modifier ->
            OutlinedTextField(
                value = draft,
                onValueChange = {
                    draft = it
                    browser.clearValidation()
                },
                label = { Text(conclaveString("br_website"), maxLines = 1) },
                singleLine = true,
                enabled = !model.navigatePending,
                isError = message != null,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false, imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { browser.navigate(draft) }),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = scheme.surfaceContainerHigh,
                    unfocusedContainerColor = scheme.surfaceContainerHigh,
                    disabledContainerColor = scheme.surfaceContainerHigh,
                    errorContainerColor = scheme.surfaceContainerHigh,
                ),
                modifier = fieldModifier.onFocusChanged { focused = it.isFocused }.testTag("browser.address"),
            )
        }
        val actions = @Composable {
            Button(
                onClick = { browser.navigate(draft) },
                enabled = !model.navigatePending,
                colors = ButtonDefaults.buttonColors(containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer),
                modifier = Modifier.heightIn(min = 48.dp).testTag("browser.go"),
            ) {
                if (model.navigatePending) {
                    CircularProgressIndicator(Modifier.size(16.dp), color = scheme.onPrimaryContainer, strokeWidth = 2.dp)
                    Spacer(Modifier.width(6.dp))
                }
                Text(conclaveString(if (model.navigatePending) "br_navigating" else "br_go"), maxLines = 1)
            }
            OutlinedButton(
                onClick = { browser.focusKeyboard() },
                enabled = model.inputInteractive && model.hasSurface,
                modifier = Modifier.heightIn(min = 48.dp).testTag("browser.keyboard"),
            ) {
                Text(conclaveString("br_keyboard"), maxLines = 1)
            }
        }
        if (stacked) {
            field(Modifier.fillMaxWidth())
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) { actions() }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                field(Modifier.weight(1f))
                actions()
            }
        }
        if (message != null) {
            Text(message, style = MaterialTheme.typography.bodySmall, color = scheme.error,
                modifier = Modifier.padding(top = 4.dp).testTag("browser.validation"))
        }
    }
}

@Composable
private fun BrowserVideoArea(browser: BrowserStagePresenter, model: BrowserStageModel, stage: StagePresenter, onShowVideo: () -> Unit,
                             modifier: Modifier) {
    val ext = LocalConclaveExtendedColors.current
    val label = browserRegionLabel(model)
    val sharer = browserSharer(model) ?: ""
    val hint = if (model.canControl) "" else conclaveString("br_viewer_hint")
    Box(modifier.background(ext.stage).clipToBounds()) {

        Box(
            Modifier.fillMaxSize().testTag("browser.surface.${model.surface.rawValue}").clearAndSetSemantics {
                contentDescription = if (hint.isEmpty()) label else "$label. $hint"
                if (sharer.isNotEmpty()) stateDescription = sharer
            },
            contentAlignment = Alignment.Center,
        ) {
            BrowserSurfaceLayer(browser, model)
        }
        if (model.surface == BrowserSurfaceKind.video) BrowserFrameSizeRelay(stage.frameSizes, browser)
        if (model.load == BrowserLoadState.loading && model.browserSessionId.isNotEmpty()) {
            BrowserPageProgressBar(model.browserSessionId, Modifier.align(Alignment.TopCenter))
        }
        BrowserStateOverlay(browser, model, onShowVideo)
    }
}

@Composable
private fun BrowserSurfaceLayer(browser: BrowserStagePresenter, model: BrowserStageModel) {
    when (model.surface) {
        BrowserSurfaceKind.video -> {
            val ratio = BrowserStagePresenter.aspectRatio(width = model.framebufferWidth, height = model.framebufferHeight).toFloat()
            Box(Modifier.aspectRatio(ratio)) {
                BrowserVideoRenderer(model.videoUserId, model.videoTrackKey)
                if (model.webViewRole == BrowserWebViewRole.input && model.wantsWebView) {
                    BrowserWebViewHost(browser, model, Modifier.fillMaxSize())
                }
            }
        }
        BrowserSurfaceKind.liveView -> {
            if (model.wantsWebView) BrowserWebViewHost(browser, model, Modifier.fillMaxSize())
        }
        BrowserSurfaceKind.none -> {}
    }
}

@Composable
private fun BrowserVideoRenderer(videoUserId: String, videoTrackKey: String) {
    val track = remember(videoUserId, videoTrackKey) {
        stageLiveTrack(videoUserId, isLocal = false, isShare = true, videoKey = videoTrackKey)
    }
    VideoTrackView(track = track, mirror = false, fit = true, rendererKey = "stage:" + BrowserStagePresenter.videoSlotId,
        clearBeforeAttach = false)
}

@Composable
private fun BrowserFrameSizeRelay(store: RendererFrameSizeStore, browser: BrowserStagePresenter) {
    val revision = store.revision
    LaunchedEffect(revision) {
        val size = store.size(slotId = BrowserStagePresenter.videoSlotId)
        browser.videoFrameArrived(width = size.width, height = size.height)
    }
}

@Composable
private fun BrowserPageProgressBar(browserSessionId: String, modifier: Modifier) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val progress = BrowserWebViewRegistry.progressFor(browserSessionId)
    LinearProgressIndicator(
        progress = { progress / 100f },
        modifier = modifier.fillMaxWidth().height(2.dp).clearAndSetSemantics {},
        color = scheme.primary,
        trackColor = ext.stage,
    )
}

@Composable
private fun BrowserStateOverlay(browser: BrowserStagePresenter, model: BrowserStageModel, onShowVideo: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    when (model.load) {
        BrowserLoadState.starting -> {
            Column(
                Modifier.fillMaxSize().background(ext.stage).padding(16.dp).testTag("browser.starting").semantics(mergeDescendants = true) {},
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                CircularProgressIndicator(color = scheme.onSurface)
                Spacer(Modifier.size(12.dp))
                Text(conclaveString("br_starting"), style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant,
                    textAlign = TextAlign.Center)
            }
        }
        BrowserLoadState.failed -> BrowserFailureView(browser, model, onShowVideo)
        BrowserLoadState.reconnecting -> {
            Box(Modifier.fillMaxSize().padding(10.dp)) {
                Text(
                    conclaveString("br_reconnecting"),
                    style = MaterialTheme.typography.labelMedium,
                    color = scheme.onSurface,
                    maxLines = 1,
                    modifier = Modifier.align(Alignment.TopStart).background(ext.labelScrim, RoundedCornerShape(50))
                        .padding(horizontal = 10.dp, vertical = 4.dp).testTag("browser.reconnecting"),
                )
            }
        }
        BrowserLoadState.loading, BrowserLoadState.live -> {}
    }
}

@Composable
private fun BrowserFailureView(browser: BrowserStagePresenter, model: BrowserStageModel, onShowVideo: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val stacked = LocalDensity.current.fontScale >= 1.5f
    Column(
        Modifier.fillMaxSize().background(ext.stage).padding(16.dp).testTag("browser.failed.${model.issue.rawValue}"),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(ConclaveIcons.ErrorFill1, contentDescription = null, tint = scheme.error)
        Spacer(Modifier.size(12.dp))
        Text(conclaveString("br_load_failed"), style = MaterialTheme.typography.titleMedium, color = scheme.onSurface,
            textAlign = TextAlign.Center, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        Spacer(Modifier.size(12.dp))
        val buttons = @Composable {
            OutlinedButton(onClick = { browser.retryLoad() }, modifier = Modifier.heightIn(min = 48.dp).testTag("browser.retry")) {
                Text(conclaveString("ds_try_again"))
            }
            OutlinedButton(onClick = onShowVideo, modifier = Modifier.heightIn(min = 48.dp).testTag("browser.failedShowVideo")) {
                Text(conclaveString("stg_show_video"))
            }
        }
        if (stacked) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = Alignment.CenterHorizontally) { buttons() }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { buttons() }
        }
    }
}

@Composable
private fun BrowserFooterRow(browser: BrowserStagePresenter, model: BrowserStageModel, sharer: String?) {
    val scheme = MaterialTheme.colorScheme
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 12.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (sharer != null) {
            Text(sharer, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, maxLines = 2,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).testTag("browser.sharer"))
        } else {
            Spacer(Modifier.weight(1f))
        }
        if (model.showsAudioControl) {
            val playing = !model.isAudioMuted

            Row(
                Modifier.heightIn(min = 48.dp).toggleable(value = playing, role = Role.Switch, onValueChange = { browser.toggleAudio() })
                    .testTag("browser.audio"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(conclaveString("br_play_audio"), style = MaterialTheme.typography.bodySmall, color = scheme.onSurface, maxLines = 2)
                Switch(checked = playing, onCheckedChange = null)
            }
        }
    }
}

@Composable
internal fun BrowserStageMenu(browser: BrowserStagePresenter) {
    val model = browser.model
    if (!model.canClose && !model.closePending) return
    var expanded by remember { mutableStateOf(false) }
    var confirmClose by remember { mutableStateOf(false) }
    var sessionInfo by remember { mutableStateOf(false) }
    val scheme = MaterialTheme.colorScheme
    Box {
        IconButton(onClick = { expanded = true }, modifier = Modifier.testTag("browser.menu")) {
            if (model.closePending) {
                CircularProgressIndicator(Modifier.size(18.dp), color = scheme.onSurface, strokeWidth = 2.dp)
            } else {
                Icon(ConclaveIcons.MoreVertFill0, contentDescription = conclaveString("br_more_actions"), tint = scheme.onSurface)
            }
        }
        ConclaveDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, identifier = "browser.actions") {
            if (model.showsAudioControl) {
                ConclaveMenuItem(
                    title = conclaveString(if (model.isAudioMuted) "br_unmute_audio" else "br_mute_audio"),
                    identifier = "browser.menu.audio",
                    onClick = {
                        expanded = false
                        browser.toggleAudio()
                    },
                )
            }
            ConclaveMenuItem(
                title = conclaveString("br_session_info"),
                identifier = "browser.menu.sessionInfo",
                onClick = {
                    expanded = false
                    sessionInfo = true
                },
            )
            ConclaveMenuDivider()
            ConclaveMenuItem(
                title = conclaveString("act_close_browser"),
                identifier = "browser.menu.close",
                onClick = {
                    expanded = false
                    confirmClose = true
                },
                role = ConclaveMenuRole.Destructive,
                enabled = !model.closePending,
            )
        }
    }
    if (confirmClose) {
        AlertDialog(
            onDismissRequest = { confirmClose = false },
            title = { Text(conclaveString("act_close_browser_title")) },
            text = { Text(conclaveString("act_close_message")) },
            confirmButton = {
                TextButton(onClick = {
                    confirmClose = false
                    browser.confirmClose()
                }, colors = ButtonDefaults.textButtonColors(contentColor = scheme.error)) { Text(conclaveString("act_close_confirm")) }
            },
            dismissButton = { TextButton(onClick = { confirmClose = false }) { Text(conclaveString("ds_cancel")) } },
        )
    }
    if (sessionInfo) {
        AlertDialog(
            onDismissRequest = { sessionInfo = false },
            title = { Text(conclaveString("br_session_info")) },
            text = { Text(browserSessionInfo(model)) },
            confirmButton = { TextButton(onClick = { sessionInfo = false }) { Text(conclaveString("ds_close")) } },
        )
    }
}

@Composable
private fun BrowserWebViewHost(browser: BrowserStagePresenter, model: BrowserStageModel, modifier: Modifier) {
    val stageArgb = LocalConclaveExtendedColors.current.stage.toArgb()
    AndroidView(
        factory = { context -> FrameLayout(context) },
        modifier = modifier.testTag("browser.webView"),
        onRelease = { container -> container.removeAllViews() },
        update = { container ->
            val webView = BrowserWebViewRegistry.webView(container.context, model, browser, stageArgb)
            if (webView == null) {
                container.removeAllViews()
            } else if (webView.parent !== container) {
                (webView.parent as? ViewGroup)?.removeView(webView)
                container.removeAllViews()
                container.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            }
        },
    )
}

@Composable
private fun BrowserReadouts(browser: BrowserStagePresenter) {
    val tertiary = MaterialTheme.colorScheme.onSurfaceVariant
    val style = MaterialTheme.typography.labelSmall

    val readouts = listOf(
        "browser.inputViews" to BrowserWebViewRegistry.inputViews.toString(),
        "browser.load" to browser.model.load.rawValue,
        "browser.webViews" to BrowserWebViewRegistry.registrySerial.toString(),
        "browser.commands" to browser.commandLog.count.toString(),
    )
    Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        for ((identifier, value) in readouts) {
            val line = identifier + "=" + value
            Text(line, style = style, color = tertiary, maxLines = 1, modifier = Modifier.testTag(identifier))
        }
    }
}
