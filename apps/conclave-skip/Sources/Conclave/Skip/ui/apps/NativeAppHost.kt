package conclave.module

import android.content.Context
import android.net.Uri
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView

@Composable
internal fun NativeAppHostBody(host: AppHostPresenter, onShowVideo: () -> Unit, modifier: Modifier = Modifier) {
    val model = host.model
    val accessibility = rememberSystemAccessibility()
    LaunchedEffect(accessibility.removeAnimations, model.appSessionId) {
        host.session?.setReduceMotion(accessibility.removeAnimations)
    }
    LaunchedEffect(model.wantsWebView, model.appSessionId) {

        if (!model.wantsWebView && model.appSessionId.isNotEmpty()) ActivityWebViewRegistry.release(model.appSessionId)
    }
    val block = AppHostChromePolicy.statusBlock(model)
    val chip = AppHostChromePolicy.chip(model)
    val bar = AppHostChromePolicy.bar(model)
    val removeAnimations = accessibility.removeAnimations
    val lastChip = remember { mutableStateOf(AppHostTag.none) }
    SideEffect { if (chip != AppHostTag.none) lastChip.value = chip }
    val shownChip = if (chip != AppHostTag.none) chip else lastChip.value
    Column(modifier.fillMaxSize().testTag("app.host.${model.phase.rawValue}").semantics { isTraversalGroup = true }) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (model.wantsWebView) AppHostCanvas(host, model)
            Crossfade(targetState = block.kind, animationSpec = if (removeAnimations) snap() else tween(200), label = "app.status") { kind ->
                when (kind) {
                    ActivityStatusBlockKind.loading -> ActivityLoadingBlock(conclaveString("stg_activity_opening", appHostName(model.appId)), "app.opening")
                    ActivityStatusBlockKind.failure -> ActivityFailureBlock(
                        title = appHostFailureTitle(model), detail = appHostFailureDetail(model), showsRetry = block.showsRetry,
                        identifier = "app.failed.${model.issue.rawValue}", retryIdentifier = "app.retry",
                        showVideoIdentifier = "app.failedShowVideo", onRetry = { host.retry() }, onShowVideo = onShowVideo,
                    )
                    ActivityStatusBlockKind.none -> Box(Modifier.fillMaxSize())
                }
            }
            if (bar == AppHostBar.whiteboard) AppBoardEmptyHint(host, Modifier.align(Alignment.Center))
            ActivityStatusChip(appHostTag(shownChip), AppHostChromePolicy.chipShowsLock(shownChip), "app.tag.${shownChip.rawValue}",
                visible = chip != AppHostTag.none, reduceMotion = removeAnimations)
        }
        if (bar != AppHostBar.none) {
            HorizontalDivider(color = LocalConclaveExtendedColors.current.border)
            if (bar == AppHostBar.whiteboard) WhiteboardToolbar(host) else WheelCardBar(host)
        }
        if (host.showsDebugReadouts) AppHostReadouts(host)
    }
    AppPageAnnouncer(host)
    AppExternalLinkDialog()
}

@Composable
private fun WheelCardBar(host: AppHostPresenter) {
    val wheel = host.wheel
    val scheme = MaterialTheme.colorScheme
    val spinBusy = wheel.spinning || wheel.isPending(AppPageCommandKind.spin)
    val pendingText = conclaveString("ds_in_progress")
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(
            onClick = { host.spinWheel() },
            enabled = wheel.canSpin,
            colors = ButtonDefaults.buttonColors(containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer),
            modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("app.wheel.spin").semantics {
                if (spinBusy) stateDescription = pendingText
            },
        ) {
            if (spinBusy) {
                CircularProgressIndicator(Modifier.size(18.dp), color = scheme.onPrimaryContainer, strokeWidth = 2.dp)
                Spacer(Modifier.size(8.dp))
            }
            Text(conclaveString("app_wheel_spin"), maxLines = 1)
        }
        OutlinedButton(
            onClick = { host.openPage() },
            modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("app.wheel.editNames"),
        ) {
            Text(conclaveString("app_wheel_edit_names"), maxLines = 1)
        }
    }
}

@Composable
private fun AppWatchQueueButton(host: AppHostPresenter) {
    val label = conclaveString("app_watch_queue")
    FilledTonalIconButton(onClick = { host.openPage() }, colors = activityHeaderIconColors(),
        modifier = Modifier.testTag("app.watch.queue")) {
        Icon(Icons.AutoMirrored.Rounded.QueueMusic, contentDescription = label, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun AppPageAnnouncer(host: AppHostPresenter) {
    val view = LocalView.current
    val winnerSequence = host.wheel.winnerSequence
    val titleSequence = host.watch.titleSequence
    val winnerText = conclaveString("app_wheel_winner", host.wheel.winnerLabel)
    val initialWinner = remember { winnerSequence }
    val initialTitle = remember { titleSequence }
    LaunchedEffect(winnerSequence) {
        if (winnerSequence != initialWinner && host.wheel.winnerLabel.isNotEmpty()) view.announceForAccessibility(winnerText)
    }
    LaunchedEffect(titleSequence) {
        val title = host.watch.title
        if (titleSequence != initialTitle && title.isNotEmpty()) view.announceForAccessibility(title)
    }
}

@Composable
internal fun NativeAppHostMenu(host: AppHostPresenter) {
    val model = host.model

    if (model.appId == "watch" && (model.phase == AppHostPhase.ready || model.phase == AppHostPhase.readOnly)) AppWatchQueueButton(host)
    if (!model.canClose && !model.canLock) return
    var expanded by remember { mutableStateOf(false) }
    var confirmClose by remember { mutableStateOf(false) }
    val scheme = MaterialTheme.colorScheme
    val name = appHostName(model.appId)
    Box {
        FilledTonalIconButton(onClick = { expanded = true }, colors = activityHeaderIconColors(), modifier = Modifier.testTag("app.host.menu")) {
            if (model.closePending || model.lockPending) {
                CircularProgressIndicator(Modifier.size(18.dp), color = scheme.onSurface, strokeWidth = 2.dp)
            } else {
                Icon(ConclaveIcons.MoreVertFill0, contentDescription = conclaveString("app_more_actions", name), tint = scheme.onSurface)
            }
        }
        ConclaveDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, identifier = "app.host.actions") {
            if (model.canLock) {
                ConclaveMenuItem(
                    title = conclaveString("app_lock_editing"),
                    identifier = "app.host.lock",
                    onClick = {
                        expanded = false
                        host.setLocked(!model.isLocked)
                    },
                    role = ConclaveMenuRole.Toggle(model.isLocked),
                    enabled = !model.lockPending,
                )
            }
            if (model.canClose) {
                if (model.canLock) ConclaveMenuDivider()
                ConclaveMenuItem(
                    title = conclaveString("act_close_app", name),
                    identifier = "app.host.close",
                    onClick = {
                        expanded = false
                        confirmClose = true
                    },
                    role = ConclaveMenuRole.Destructive,
                    enabled = !model.closePending,
                )
            }
        }
    }
    if (confirmClose) {
        AlertDialog(
            onDismissRequest = { confirmClose = false },
            title = { Text(conclaveString("act_close_title", name)) },
            text = { Text(conclaveString(if (model.appId == "whiteboard") "act_close_board_message" else "act_close_message")) },
            confirmButton = {
                TextButton(onClick = {
                    confirmClose = false
                    host.confirmClose()
                }, colors = ButtonDefaults.textButtonColors(contentColor = scheme.error)) { Text(conclaveString("act_close_confirm")) }
            },
            dismissButton = { TextButton(onClick = { confirmClose = false }) { Text(conclaveString("ds_cancel")) } },
        )
    }
}

@Composable
internal fun nativeAppHostStatus(host: AppHostPresenter): String = appHostStatus(host.model)

@Composable
private fun AppHostCanvas(host: AppHostPresenter, model: AppHostModel) {
    val background = LocalConclaveExtendedColors.current.tile.toArgb()
    val label = if (model.appId == "whiteboard") conclaveString("app_wb_canvas") else appHostName(model.appId)
    val hint = if (model.canEdit && model.appId == "whiteboard") conclaveString("app_wb_canvas_hint") else ""
    AndroidView(
        factory = { context -> FrameLayout(context) },
        modifier = Modifier.fillMaxSize().testTag("app.canvas").semantics {
            contentDescription = label
            if (hint.isNotEmpty()) stateDescription = hint
        },

        onRelease = { container -> container.removeAllViews() },
        update = { container ->
            val session = host.session
            val webView = if (session != null) ActivityWebViewRegistry.webView(container.context, model, session, background) else null
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
private fun AppBoardEmptyHint(host: AppHostPresenter, modifier: Modifier) {
    val toolbar = host.toolbar
    if (!AppHostChromePolicy.showsBoardHint(host.model, elementCount = toolbar.elementCount, pageId = toolbar.pageId)) return
    val scheme = MaterialTheme.colorScheme
    Column(modifier.widthIn(max = 360.dp).padding(24.dp).clearAndSetSemantics {}, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(conclaveString("app_wb_empty_title"), style = MaterialTheme.typography.titleMedium, color = scheme.onSurfaceVariant,
            textAlign = TextAlign.Center)
        Spacer(Modifier.size(6.dp))
        Text(conclaveString("app_wb_empty_body"), style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant,
            textAlign = TextAlign.Center)
    }
}

@Composable
private fun WhiteboardToolbar(host: AppHostPresenter) {
    val toolbar = host.toolbar
    val view = LocalView.current
    val context = LocalContext.current
    val exportTitle = conclaveString("app_whiteboard")
    var renaming by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    LaunchedEffect(toolbar.exportSequence) {
        val png = host.takeExport()
        if (png.isNotEmpty()) shareWhiteboardExport(context, png, exportTitle)
    }
    val selectTool: (AppWhiteboardTool) -> Unit = { tool ->
        if (host.perform(AppHostCommandKind.setTool, value = tool.rawValue) == ActivityTapResult.dispatched) {
            ConclaveHaptics.perform(view, FeedbackKind.selectionChanged)
        }
    }
    val toolsLabel = conclaveString("app_wb_tools")
    Column(Modifier.fillMaxWidth().testTag("app.whiteboard.toolbar").semantics { contentDescription = toolsLabel }) {
        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            LazyRow(
                modifier = Modifier.weight(1f),
                contentPadding = PaddingValues(horizontal = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                for (tool in WhiteboardToolbarPolicy.drawingTools) {
                    item(key = tool.rawValue) { ToolToggle(host, tool, selectTool) }
                }
                item(key = "shape") { ShapeMenu(host, selectTool) }
                for (tool in WhiteboardToolbarPolicy.markupTools) {
                    item(key = tool.rawValue) { ToolToggle(host, tool, selectTool) }
                }
                item(key = "divider") { ActivityToolDivider() }
                item(key = "color") { ColorMenu(host) }
                item(key = "width") { WidthMenu(host) }
            }
            ActivityToolDivider()
            Row(Modifier.padding(end = 8.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                ActivityToolButton(appHostCommand(AppHostCommandKind.undo), whiteboardCommandIcon(AppHostCommandKind.undo), selected = false,
                    pending = toolbar.isPending(AppHostCommandKind.undo), enabled = toolbar.canUndo, identifier = "app.wb.undo") {
                    host.perform(AppHostCommandKind.undo)
                }
                ActivityToolButton(appHostCommand(AppHostCommandKind.redo), whiteboardCommandIcon(AppHostCommandKind.redo), selected = false,
                    pending = toolbar.isPending(AppHostCommandKind.redo), enabled = toolbar.canRedo, identifier = "app.wb.redo") {
                    host.perform(AppHostCommandKind.redo)
                }
                MoreMenu(host, onRename = { renaming = true }, onDelete = { deleting = true })
            }
        }
        if (toolbar.exportFailed) {
            Text(conclaveString("app_wb_export_failed"), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 6.dp))
        }
    }
    if (renaming) RenamePageDialog(host, onDone = { renaming = false })
    if (deleting) DeletePageDialog(host, onDone = { deleting = false })
}

@Composable
private fun ToolToggle(host: AppHostPresenter, tool: AppWhiteboardTool, onSelect: (AppWhiteboardTool) -> Unit) {
    val toolbar = host.toolbar
    ActivityToolButton(appHostTool(tool), whiteboardToolIcon(tool), selected = WhiteboardToolbarPolicy.isSelected(tool, current = toolbar.tool),
        pending = toolbar.isPending(AppHostCommandKind.setTool), enabled = true, identifier = "app.wb.tool.${tool.rawValue}") { onSelect(tool) }
}

@Composable
private fun ShapeMenu(host: AppHostPresenter, onSelect: (AppWhiteboardTool) -> Unit) {
    val toolbar = host.toolbar
    var expanded by remember { mutableStateOf(false) }
    val glyph = WhiteboardToolbarPolicy.shapeGlyph(current = toolbar.tool)
    Box {
        ActivityToolButton(appHostCommand(AppHostCommandKind.setFill), whiteboardToolIcon(glyph),
            selected = WhiteboardToolbarPolicy.isShapeSelected(current = toolbar.tool),
            pending = WhiteboardToolbarPolicy.isPending(WhiteboardToolbarPolicy.shapeCommands, toolbar = toolbar),
            enabled = true, identifier = "app.wb.shape", stateText = appHostTool(glyph)) { expanded = true }
        ConclaveDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, identifier = "app.wb.shape.menu") {
            for (tool in WhiteboardToolbarPolicy.shapeTools) {
                WhiteboardChoiceItem(appHostTool(tool), "app.wb.shape.${tool.rawValue}", checked = toolbar.tool == tool.rawValue,
                    leadingContent = { Icon(whiteboardToolIcon(tool), contentDescription = null) }) {
                    expanded = false
                    onSelect(tool)
                }
            }
            ConclaveMenuDivider()
            for (fill in listOf(AppShapeFill.outline, AppShapeFill.filled)) {
                WhiteboardChoiceItem(appHostFill(fill), "app.wb.fill.${fill.rawValue}", checked = toolbar.filled == (fill == AppShapeFill.filled)) {
                    expanded = false
                    host.perform(AppHostCommandKind.setFill, value = fill.rawValue)
                }
            }
        }
    }
}

@Composable
private fun ColorMenu(host: AppHostPresenter) {
    val toolbar = host.toolbar
    var expanded by remember { mutableStateOf(false) }
    val currentName = AppInkColor.init(rawValue = toolbar.color)?.let { appHostColor(it) } ?: ""
    Box {
        val label = appHostCommand(AppHostCommandKind.setColor)
        val pending = toolbar.isPending(AppHostCommandKind.setColor)
        val pendingText = conclaveString("ds_in_progress")
        CallControlTooltip(label) {
            Surface(onClick = { expanded = true }, shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainer,
                modifier = Modifier.size(48.dp).testTag("app.wb.color").semantics {
                    contentDescription = label
                    stateDescription = if (pending) pendingText else currentName
                }) {
                ActivityToolGlyph(ConclaveIcons.MoreVertFill0, pending) { InkSwatch(toolbar.color, 22) }
            }
        }
        ConclaveDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, identifier = "app.wb.color.menu") {
            for (color in AppInkColor.allCases) {
                WhiteboardChoiceItem(appHostColor(color), "app.wb.color.${color.rawValue.removePrefix("#")}", checked = toolbar.color == color.rawValue,
                    leadingContent = { Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) { InkSwatch(color.rawValue, 16) } }) {
                    expanded = false
                    host.perform(AppHostCommandKind.setColor, value = color.rawValue)
                }
            }
        }
    }
}

@Composable
private fun WidthMenu(host: AppHostPresenter) {
    val toolbar = host.toolbar
    var expanded by remember { mutableStateOf(false) }
    Box {
        ActivityToolButton(appHostCommand(AppHostCommandKind.setStrokeWidth), whiteboardCommandIcon(AppHostCommandKind.setStrokeWidth),
            selected = false, pending = toolbar.isPending(AppHostCommandKind.setStrokeWidth), enabled = true, identifier = "app.wb.width",
            stateText = appHostWidth(toolbar.strokeWidth)) { expanded = true }
        ConclaveDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, identifier = "app.wb.width.menu") {
            for (width in AppStrokeWidths.steps) {
                WhiteboardChoiceItem(appHostWidth(width), "app.wb.width.$width", checked = toolbar.strokeWidth == width) {
                    expanded = false
                    host.perform(AppHostCommandKind.setStrokeWidth, value = width.toString())
                }
            }
        }
    }
}

@Composable
private fun MoreMenu(host: AppHostPresenter, onRename: () -> Unit, onDelete: () -> Unit) {
    val toolbar = host.toolbar
    var expanded by remember { mutableStateOf(false) }
    Box {
        ActivityToolButton(conclaveString("app_wb_more"), ConclaveIcons.MoreVertFill0, selected = false,
            pending = WhiteboardToolbarPolicy.isPending(WhiteboardToolbarPolicy.moreCommands, toolbar = toolbar), enabled = true,
            identifier = "app.wb.more", stateText = toolbar.pageName) { expanded = true }
        ConclaveDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, identifier = "app.wb.more.menu") {
            ConclaveMenuHeader(conclaveString("app_wb_pages"), "app.wb.pages.header")
            for (page in toolbar.pages) {
                WhiteboardChoiceItem(page.name, "app.wb.page.select.${page.id}", checked = page.isCurrent) {
                    expanded = false
                    host.perform(AppHostCommandKind.setPage, value = page.id)
                }
            }
            ConclaveMenuItem(title = appHostCommand(AppHostCommandKind.addPage), identifier = "app.wb.page.add",
                leadingIcon = whiteboardCommandIcon(AppHostCommandKind.addPage), onClick = {
                    expanded = false
                    host.perform(AppHostCommandKind.addPage)
                })
            ConclaveMenuItem(title = appHostCommand(AppHostCommandKind.renamePage), identifier = "app.wb.page.rename",
                leadingIcon = whiteboardCommandIcon(AppHostCommandKind.renamePage),
                enabled = WhiteboardToolbarPolicy.canRenamePage(toolbar), onClick = {
                    expanded = false
                    onRename()
                })
            ConclaveMenuItem(title = appHostCommand(AppHostCommandKind.deletePage), identifier = "app.wb.page.delete",
                leadingIcon = whiteboardCommandIcon(AppHostCommandKind.deletePage), role = ConclaveMenuRole.Destructive,
                enabled = WhiteboardToolbarPolicy.canDeletePage(toolbar), onClick = {
                    expanded = false
                    onDelete()
                })
            ConclaveMenuDivider()
            ConclaveMenuItem(title = appHostCommand(AppHostCommandKind.zoomToFit), identifier = "app.wb.fit",
                leadingIcon = whiteboardCommandIcon(AppHostCommandKind.zoomToFit), onClick = {
                    expanded = false
                    host.perform(AppHostCommandKind.zoomToFit)
                })
            ConclaveMenuItem(title = appHostCommand(AppHostCommandKind.export), identifier = "app.wb.export",
                leadingIcon = whiteboardCommandIcon(AppHostCommandKind.export), onClick = {
                    expanded = false
                    host.perform(AppHostCommandKind.export)
                })
        }
    }
}

@Composable
private fun WhiteboardChoiceItem(
    label: String,
    identifier: String,
    checked: Boolean,
    leadingContent: (@Composable () -> Unit)? = null,
    onClick: () -> Unit,
) {
    ConclaveMenuItem(title = label, identifier = identifier, onClick = onClick, role = ConclaveMenuRole.Single(checked), leadingContent = leadingContent)
}

@Composable
private fun InkSwatch(hex: String, sizeDp: Int) {
    val ext = LocalConclaveExtendedColors.current
    val fill = inkSwatchColor(hex) ?: MaterialTheme.colorScheme.onSurface
    Box(Modifier.size(sizeDp.dp).background(fill, CircleShape).border(1.dp, ext.border, CircleShape))
}

internal fun inkSwatchColor(hex: String): Color? =
    if (hex.length == 7 && hex.startsWith("#")) runCatching { Color(android.graphics.Color.parseColor(hex)) }.getOrNull() else null

@Composable
private fun RenamePageDialog(host: AppHostPresenter, onDone: () -> Unit) {
    var draft by remember { mutableStateOf(host.toolbar.pageName) }
    AlertDialog(
        onDismissRequest = onDone,
        title = { Text(conclaveString("app_wb_rename_title")) },
        text = {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it.take(AppBridgeProtocol.pageNameLimit) },
                label = { Text(conclaveString("app_wb_page_name")) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words),
                modifier = Modifier.testTag("app.wb.renameField"),
            )
        },
        confirmButton = {
            TextButton(enabled = draft.trim().isNotEmpty(), onClick = {
                host.perform(AppHostCommandKind.renamePage, value = host.toolbar.pageId, extra = draft)
                onDone()
            }) { Text(conclaveString("app_wb_rename")) }
        },
        dismissButton = { TextButton(onClick = onDone) { Text(conclaveString("ds_cancel")) } },
    )
}

@Composable
private fun DeletePageDialog(host: AppHostPresenter, onDone: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    AlertDialog(
        onDismissRequest = onDone,
        title = { Text(conclaveString("app_wb_delete_title", host.toolbar.pageName)) },
        text = { Text(conclaveString("app_wb_delete_message")) },
        confirmButton = {
            TextButton(onClick = {
                host.perform(AppHostCommandKind.deletePage, value = host.toolbar.pageId)
                onDone()
            }, colors = ButtonDefaults.textButtonColors(contentColor = scheme.error)) { Text(conclaveString("app_wb_delete")) }
        },
        dismissButton = { TextButton(onClick = onDone) { Text(conclaveString("ds_cancel")) } },
    )
}

@Composable
private fun AppExternalLinkDialog() {
    val url = ActivityWebViewRegistry.pendingExternalUrl ?: return
    AlertDialog(
        onDismissRequest = { ActivityWebViewRegistry.clearExternalLink() },
        title = { Text(conclaveString("app_open_link_title")) },
        text = { Text(Uri.parse(url).host ?: url) },
        confirmButton = {
            TextButton(onClick = {
                ActivityWebViewRegistry.clearExternalLink()
                NativeExternalHandoff.openWebLink(url)
            }) { Text(conclaveString("act_open")) }
        },
        dismissButton = { TextButton(onClick = { ActivityWebViewRegistry.clearExternalLink() }) { Text(conclaveString("ds_cancel")) } },
    )
}

@Composable
private fun AppHostReadouts(host: AppHostPresenter) {
    val tertiary = MaterialTheme.colorScheme.onSurfaceVariant
    val style = MaterialTheme.typography.labelSmall

    val readouts = listOf(
        "app.registrySerial" to ActivityWebViewRegistry.registrySerial,
        "app.reloads" to ActivityWebViewRegistry.reloads,
        "app.rejections" to (host.session?.rejectionCount ?: 0),
    )
    Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        for ((identifier, value) in readouts) {
            val line = identifier + "=" + value
            Text(line, style = style, color = tertiary, modifier = Modifier.testTag(identifier))
        }
    }
}

private suspend fun shareWhiteboardExport(context: Context, pngBase64: String, title: String) {
    WhiteboardExport.share(context, pngBase64) { file -> ChatPhotoFiles.share(context, file, title) }
}
