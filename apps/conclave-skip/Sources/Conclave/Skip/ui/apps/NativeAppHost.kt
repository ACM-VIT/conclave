package conclave.module

import android.content.Context
import android.net.Uri
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.foundation.BorderStroke
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

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
    Column(modifier.fillMaxSize().testTag("app.host.${model.phase.rawValue}").semantics { isTraversalGroup = true }) {
        val failed = model.phase == AppHostPhase.failed || model.phase == AppHostPhase.versionMismatch
        if (model.tag != AppHostTag.none && !failed) AppHostTagRow(model.tag)
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (model.wantsWebView) AppHostCanvas(host, model)
            when (model.phase) {
                AppHostPhase.opening -> AppHostOpening(model.appId)
                AppHostPhase.failed, AppHostPhase.versionMismatch -> AppHostFailure(host, model, onShowVideo)
                AppHostPhase.ready, AppHostPhase.readOnly, AppHostPhase.closing -> {
                    if (model.appId == "whiteboard" && model.canEdit) AppBoardEmptyHint(host, Modifier.align(Alignment.Center))
                }
            }
        }
        if (model.appId == "whiteboard" && model.canEdit && (model.phase == AppHostPhase.ready || model.phase == AppHostPhase.closing)) {
            HorizontalDivider(color = LocalConclaveExtendedColors.current.border)
            WhiteboardToolbar(host)
        }
        if (model.appId == "wheel" && model.canEdit && (model.phase == AppHostPhase.ready || model.phase == AppHostPhase.closing)) {
            HorizontalDivider(color = LocalConclaveExtendedColors.current.border)
            WheelCardBar(host)
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
    TextButton(onClick = { host.openPage() }, modifier = Modifier.heightIn(min = 48.dp).testTag("app.watch.queue")) {
        Text(conclaveString("app_watch_queue"), color = MaterialTheme.colorScheme.onSurface, maxLines = 1)
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
        IconButton(onClick = { expanded = true }, modifier = Modifier.testTag("app.host.menu")) {
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
    val background = MaterialTheme.colorScheme.surfaceContainer.toArgb()
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
private fun AppHostTagRow(tag: AppHostTag) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp).testTag("app.tag.${tag.rawValue}")) {
        Row(
            Modifier.border(BorderStroke(1.dp, ext.border), RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (tag == AppHostTag.viewOnly || tag == AppHostTag.lockedForOthers) {
                Icon(ConclaveIcons.LockFill1, contentDescription = null, tint = scheme.onSurfaceVariant, modifier = Modifier.size(14.dp))
            }
            Text(appHostTag(tag), style = MaterialTheme.typography.labelMedium, color = scheme.onSurfaceVariant, maxLines = 1)
        }
    }
}

@Composable
private fun AppHostOpening(appId: String) {
    val scheme = MaterialTheme.colorScheme
    Column(
        Modifier.fillMaxSize().background(scheme.surfaceContainer).padding(16.dp).testTag("app.opening"),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator(color = scheme.onSurface)
        Spacer(Modifier.size(12.dp))
        Text(conclaveString("stg_activity_opening", appHostName(appId)), style = MaterialTheme.typography.bodyMedium,
            color = scheme.onSurfaceVariant, textAlign = TextAlign.Center)
    }
}

@Composable
private fun AppHostFailure(host: AppHostPresenter, model: AppHostModel, onShowVideo: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Column(
        Modifier.fillMaxSize().background(scheme.surfaceContainer).padding(16.dp).testTag("app.failed.${model.issue.rawValue}"),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(appHostFailureTitle(model), style = MaterialTheme.typography.titleMedium, color = scheme.onSurface, textAlign = TextAlign.Center)
        val detail = appHostFailureDetail(model)
        if (detail != null) {
            Spacer(Modifier.size(6.dp))
            Text(detail, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant, textAlign = TextAlign.Center)
        }
        Spacer(Modifier.size(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (model.hasEmbed && model.phase == AppHostPhase.failed) {
                OutlinedButton(onClick = { host.retry() }, modifier = Modifier.heightIn(min = 48.dp).testTag("app.retry")) {
                    Text(conclaveString("ds_try_again"))
                }
            }
            OutlinedButton(onClick = onShowVideo, modifier = Modifier.heightIn(min = 48.dp).testTag("app.failedShowVideo")) {
                Text(conclaveString("stg_show_video"))
            }
        }
    }
}

@Composable
private fun AppBoardEmptyHint(host: AppHostPresenter, modifier: Modifier) {
    val toolbar = host.toolbar
    if (toolbar.elementCount != 0 || toolbar.pageId.isEmpty()) return
    val scheme = MaterialTheme.colorScheme
    Column(modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(conclaveString("app_wb_empty_title"), style = MaterialTheme.typography.titleMedium, color = scheme.onSurfaceVariant)
        Spacer(Modifier.size(6.dp))
        Text(conclaveString("app_wb_empty_body"), style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant,
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
    Column(Modifier.fillMaxWidth().testTag("app.whiteboard.toolbar")) {
        LazyRow(
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            val plain = listOf(AppWhiteboardTool.select, AppWhiteboardTool.pan, AppWhiteboardTool.pen, AppWhiteboardTool.highlighter,
                AppWhiteboardTool.eraser)
            for (tool in plain) {
                item(key = tool.rawValue) { ToolToggle(host, tool, selectTool) }
            }
            item(key = "shape") { ShapeMenu(host, selectTool) }
            for (tool in listOf(AppWhiteboardTool.text, AppWhiteboardTool.sticky, AppWhiteboardTool.laser)) {
                item(key = tool.rawValue) { ToolToggle(host, tool, selectTool) }
            }
            item(key = "color") { ColorMenu(host) }
            item(key = "width") { WidthMenu(host) }
            item(key = "undo") {
                AppToolChip(appHostCommand(AppHostCommandKind.undo), selected = false, pending = toolbar.isPending(AppHostCommandKind.undo),
                    enabled = toolbar.canUndo, identifier = "app.wb.undo") { host.perform(AppHostCommandKind.undo) }
            }
            item(key = "redo") {
                AppToolChip(appHostCommand(AppHostCommandKind.redo), selected = false, pending = toolbar.isPending(AppHostCommandKind.redo),
                    enabled = toolbar.canRedo, identifier = "app.wb.redo") { host.perform(AppHostCommandKind.redo) }
            }
            item(key = "page") { PageMenu(host, onRename = { renaming = true }, onDelete = { deleting = true }) }
            item(key = "fit") {
                AppToolChip(appHostCommand(AppHostCommandKind.zoomToFit), selected = false,
                    pending = toolbar.isPending(AppHostCommandKind.zoomToFit), enabled = true, identifier = "app.wb.fit") {
                    host.perform(AppHostCommandKind.zoomToFit)
                }
            }
            item(key = "export") {
                AppToolChip(appHostCommand(AppHostCommandKind.export), selected = false,
                    pending = toolbar.isPending(AppHostCommandKind.export), enabled = true, identifier = "app.wb.export") {
                    host.perform(AppHostCommandKind.export)
                }
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
    AppToolChip(appHostTool(tool), selected = toolbar.tool == tool.rawValue, pending = toolbar.isPending(AppHostCommandKind.setTool),
        enabled = true, identifier = "app.wb.tool.${tool.rawValue}") { onSelect(tool) }
}

@Composable
private fun ShapeMenu(host: AppHostPresenter, onSelect: (AppWhiteboardTool) -> Unit) {
    val toolbar = host.toolbar
    var expanded by remember { mutableStateOf(false) }
    val current = AppWhiteboardTool.init(rawValue = toolbar.tool)
    val isShape = current?.isShape ?: false
    Box {
        AppToolChip(appHostCommand(AppHostCommandKind.setFill), selected = isShape,
            pending = toolbar.isPending(AppHostCommandKind.setTool) || toolbar.isPending(AppHostCommandKind.setFill),
            enabled = true, identifier = "app.wb.shape") { expanded = true }
        ConclaveDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, identifier = "app.wb.shape.menu") {
            for (tool in listOf(AppWhiteboardTool.rect, AppWhiteboardTool.ellipse, AppWhiteboardTool.line, AppWhiteboardTool.arrow)) {
                WhiteboardChoiceItem(appHostTool(tool), "app.wb.shape.${tool.rawValue}", checked = toolbar.tool == tool.rawValue) {
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
        AppToolChip(appHostCommand(AppHostCommandKind.setColor), selected = false, pending = toolbar.isPending(AppHostCommandKind.setColor),
            enabled = true, identifier = "app.wb.color", stateText = currentName,
            leading = { InkSwatch(toolbar.color) }) { expanded = true }
        ConclaveDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, identifier = "app.wb.color.menu") {
            for (color in AppInkColor.allCases) {
                WhiteboardChoiceItem(appHostColor(color), "app.wb.color.${color.rawValue.removePrefix("#")}", checked = toolbar.color == color.rawValue,
                    leadingContent = { Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) { InkSwatch(color.rawValue) } }) {
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
        AppToolChip(appHostCommand(AppHostCommandKind.setStrokeWidth), selected = false,
            pending = toolbar.isPending(AppHostCommandKind.setStrokeWidth), enabled = true, identifier = "app.wb.width",
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
private fun PageMenu(host: AppHostPresenter, onRename: () -> Unit, onDelete: () -> Unit) {
    val toolbar = host.toolbar
    var expanded by remember { mutableStateOf(false) }
    val pending = toolbar.isPending(AppHostCommandKind.setPage) || toolbar.isPending(AppHostCommandKind.addPage) ||
        toolbar.isPending(AppHostCommandKind.renamePage) || toolbar.isPending(AppHostCommandKind.deletePage)
    Box {
        AppToolChip(appHostCommand(AppHostCommandKind.setPage), selected = false, pending = pending, enabled = true,
            identifier = "app.wb.page", stateText = toolbar.pageName) { expanded = true }
        ConclaveDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, identifier = "app.wb.page.menu") {
            for (page in toolbar.pages) {
                WhiteboardChoiceItem(page.name, "app.wb.page.select.${page.id}", checked = page.isCurrent) {
                    expanded = false
                    host.perform(AppHostCommandKind.setPage, value = page.id)
                }
            }
            ConclaveMenuDivider()
            ConclaveMenuItem(title = appHostCommand(AppHostCommandKind.addPage), identifier = "app.wb.page.add", onClick = {
                expanded = false
                host.perform(AppHostCommandKind.addPage)
            })
            ConclaveMenuItem(title = appHostCommand(AppHostCommandKind.renamePage), identifier = "app.wb.page.rename",
                enabled = toolbar.pageId.isNotEmpty(), onClick = {
                    expanded = false
                    onRename()
                })
            ConclaveMenuItem(title = appHostCommand(AppHostCommandKind.deletePage), identifier = "app.wb.page.delete",
                role = ConclaveMenuRole.Destructive, enabled = toolbar.pages.count >= 2, onClick = {
                    expanded = false
                    onDelete()
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
private fun AppToolChip(
    label: String,
    selected: Boolean,
    pending: Boolean,
    enabled: Boolean,
    identifier: String,
    stateText: String = "",
    leading: (@Composable () -> Unit)? = null,
    onClick: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val container = if (selected) ext.toggleEngagedContainer else scheme.surfaceContainerHigh
    val content = if (selected) ext.onToggleEngaged else scheme.onSurface
    val pendingText = conclaveString("ds_in_progress")
    CallControlTooltip(label) {
        Surface(
            selected = selected,
            onClick = onClick,
            enabled = enabled,
            shape = RoundedCornerShape(10.dp),
            color = container,
            contentColor = content,
            border = BorderStroke(1.dp, ext.border),
            modifier = Modifier.heightIn(min = 48.dp).widthIn(min = 48.dp).testTag(identifier).semantics {
                if (pending) stateDescription = pendingText else if (stateText.isNotEmpty()) stateDescription = stateText
            },
        ) {
            Row(
                Modifier.heightIn(min = 48.dp).padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                leading?.invoke()
                if (pending) CircularProgressIndicator(Modifier.size(16.dp), color = content, strokeWidth = 2.dp)
                Text(label, style = MaterialTheme.typography.labelLarge, maxLines = 1)
            }
        }
    }
}

@Composable
private fun InkSwatch(hex: String) {
    val ext = LocalConclaveExtendedColors.current
    val fill = inkSwatchColor(hex) ?: MaterialTheme.colorScheme.onSurface
    Box(Modifier.size(16.dp).background(fill, CircleShape).border(1.dp, ext.border, CircleShape))
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
    val file = withContext(Dispatchers.IO) {
        runCatching {
            val bytes = android.util.Base64.decode(pngBase64, android.util.Base64.DEFAULT)
            val folder = File(context.cacheDir, "exports").apply { mkdirs() }
            File(folder, "whiteboard-" + System.currentTimeMillis() + ".png").apply { writeBytes(bytes) }
        }.getOrNull()
    } ?: return
    ChatPhotoFiles.share(context, file, title)
}
