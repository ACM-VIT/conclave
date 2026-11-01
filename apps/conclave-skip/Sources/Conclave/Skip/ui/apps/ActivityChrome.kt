package conclave.module

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Redo
import androidx.compose.material.icons.automirrored.rounded.StickyNote2
import androidx.compose.material.icons.automirrored.rounded.Undo
import androidx.compose.material.icons.rounded.AdsClick
import androidx.compose.material.icons.rounded.Brush
import androidx.compose.material.icons.rounded.CleaningServices
import androidx.compose.material.icons.rounded.CropSquare
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.FitScreen
import androidx.compose.material.icons.rounded.HighlightAlt
import androidx.compose.material.icons.rounded.HorizontalRule
import androidx.compose.material.icons.rounded.LineWeight
import androidx.compose.material.icons.rounded.NorthEast
import androidx.compose.material.icons.rounded.PanTool
import androidx.compose.material.icons.rounded.PanoramaFishEye
import androidx.compose.material.icons.rounded.TextFields
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonColors
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

internal fun activityGlyphIcon(glyph: ActivityGlyph): ImageVector = when (glyph) {
    ActivityGlyph.game -> ConclaveIcons.SportsEsportsFill0
    ActivityGlyph.whiteboard -> ConclaveIcons.DrawFill0
    ActivityGlyph.wheel -> ConclaveIcons.DonutLargeFill0
    ActivityGlyph.watch -> ConclaveIcons.SmartDisplayFill0
    ActivityGlyph.app -> ConclaveIcons.AppsFill0
    ActivityGlyph.browser -> ConclaveIcons.PublicFill0
}

internal fun whiteboardToolIcon(tool: AppWhiteboardTool): ImageVector = when (tool) {
    AppWhiteboardTool.select -> Icons.Rounded.HighlightAlt
    AppWhiteboardTool.pan -> Icons.Rounded.PanTool
    AppWhiteboardTool.pen -> Icons.Rounded.Edit
    AppWhiteboardTool.highlighter -> Icons.Rounded.Brush
    AppWhiteboardTool.eraser -> Icons.Rounded.CleaningServices
    AppWhiteboardTool.rect -> Icons.Rounded.CropSquare
    AppWhiteboardTool.ellipse -> Icons.Rounded.PanoramaFishEye
    AppWhiteboardTool.line -> Icons.Rounded.HorizontalRule
    AppWhiteboardTool.arrow -> Icons.Rounded.NorthEast
    AppWhiteboardTool.text -> Icons.Rounded.TextFields
    AppWhiteboardTool.sticky -> Icons.AutoMirrored.Rounded.StickyNote2
    AppWhiteboardTool.laser -> Icons.Rounded.AdsClick
}

internal fun whiteboardCommandIcon(kind: AppHostCommandKind): ImageVector = when (kind) {
    AppHostCommandKind.undo -> Icons.AutoMirrored.Rounded.Undo
    AppHostCommandKind.redo -> Icons.AutoMirrored.Rounded.Redo
    AppHostCommandKind.zoomToFit -> Icons.Rounded.FitScreen
    AppHostCommandKind.export -> ConclaveIcons.ShareFill0
    AppHostCommandKind.addPage -> ConclaveIcons.AddFill0
    AppHostCommandKind.renamePage -> ConclaveIcons.EditFill0
    AppHostCommandKind.deletePage -> ConclaveIcons.DeleteFill0
    AppHostCommandKind.setPage -> ConclaveIcons.DescriptionFill0
    AppHostCommandKind.setStrokeWidth -> Icons.Rounded.LineWeight
    AppHostCommandKind.setColor, AppHostCommandKind.setFill, AppHostCommandKind.setTool -> ConclaveIcons.MoreVertFill0
}

@Composable
internal fun ActivityLoadingBlock(title: String, identifier: String, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    Column(
        modifier.fillMaxSize().background(LocalConclaveExtendedColors.current.tile).padding(24.dp).testTag(identifier)
            .semantics(mergeDescendants = true) {},
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator(Modifier.size(32.dp), color = scheme.onSurfaceVariant, strokeWidth = 3.dp)
        Spacer(Modifier.height(12.dp))
        Text(title, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant, textAlign = TextAlign.Center)
    }
}

@Composable
internal fun ActivityFailureBlock(
    title: String,
    detail: String?,
    showsRetry: Boolean,
    identifier: String,
    retryIdentifier: String,
    showVideoIdentifier: String,
    onRetry: () -> Unit,
    onShowVideo: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scheme = MaterialTheme.colorScheme
    val stacked = LocalDensity.current.fontScale >= 1.5f
    Box(modifier.fillMaxSize().background(LocalConclaveExtendedColors.current.tile).testTag(identifier), contentAlignment = Alignment.Center) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(ConclaveIcons.WarningFill1, contentDescription = null, tint = scheme.onSurfaceVariant, modifier = Modifier.size(28.dp))
            Spacer(Modifier.height(8.dp))
            Text(title, style = MaterialTheme.typography.titleMedium, color = scheme.onSurface, textAlign = TextAlign.Center,
                modifier = Modifier.semantics { heading(); liveRegion = LiveRegionMode.Polite })
            if (detail != null) {
                Spacer(Modifier.height(4.dp))
                Text(detail, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant, textAlign = TextAlign.Center)
            }
            Spacer(Modifier.height(16.dp))
            val buttons = @Composable {
                if (showsRetry) {
                    Button(
                        onClick = onRetry,
                        colors = ButtonDefaults.buttonColors(containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer),
                        modifier = Modifier.heightIn(min = 48.dp).testTag(retryIdentifier),
                    ) { Text(conclaveString("ds_try_again"), maxLines = 2, textAlign = TextAlign.Center) }
                }
                OutlinedButton(onClick = onShowVideo, modifier = Modifier.heightIn(min = 48.dp).testTag(showVideoIdentifier)) {
                    Text(conclaveString("stg_show_video"), maxLines = 2, textAlign = TextAlign.Center)
                }
            }
            if (stacked) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = Alignment.CenterHorizontally) { buttons() }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { buttons() }
            }
        }
    }
}

@Composable
internal fun BoxScope.ActivityStatusChip(title: String, showsLock: Boolean, identifier: String, visible: Boolean, reduceMotion: Boolean) {
    AnimatedVisibility(
        visible = visible,
        enter = fadeIn(if (reduceMotion) snap() else tween(200)),
        exit = fadeOut(if (reduceMotion) snap() else tween(200)),
        modifier = Modifier.align(Alignment.TopStart).padding(10.dp),
    ) {
        ConclaveStageChip(title = title, identifier = identifier, icon = if (showsLock) ConclaveIcons.LockFill1 else null)
    }
}

@Composable
internal fun ActivityToolButton(
    label: String,
    icon: ImageVector,
    selected: Boolean,
    pending: Boolean,
    enabled: Boolean,
    identifier: String,
    stateText: String = "",
    onClick: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val pendingText = conclaveString("ds_in_progress")
    CallControlTooltip(label) {
        Surface(
            selected = selected,
            onClick = onClick,
            enabled = enabled,
            shape = RoundedCornerShape(12.dp),
            color = if (selected) scheme.surfaceContainerHighest else scheme.surfaceContainer,
            contentColor = if (selected) scheme.primary else scheme.onSurface,
            border = if (selected) BorderStroke(1.dp, ext.border) else null,
            modifier = Modifier.size(48.dp).testTag(identifier).semantics {
                contentDescription = label
                if (pending) stateDescription = pendingText else if (stateText.isNotEmpty()) stateDescription = stateText
            },
        ) {
            ActivityToolGlyph(icon, pending, enabled)
        }
    }
}

@Composable
internal fun ActivityToolGlyph(icon: ImageVector, pending: Boolean, enabled: Boolean = true, content: (@Composable () -> Unit)? = null) {
    Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
        val alpha = if (!enabled) 0.38f else if (pending) 0.35f else 1f
        if (content != null) content() else Icon(icon, contentDescription = null, modifier = Modifier.size(22.dp),
            tint = LocalContentColor.current.copy(alpha = alpha))
        if (pending) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
    }
}

@Composable
internal fun ActivityToolDivider() {
    val ext = LocalConclaveExtendedColors.current
    Box(Modifier.padding(horizontal = 4.dp).width(1.dp).height(24.dp).background(ext.border))
}

@Composable
internal fun activityHeaderIconColors(): IconButtonColors = IconButtonDefaults.filledTonalIconButtonColors(
    containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
    contentColor = MaterialTheme.colorScheme.onSurface,
)

@Composable
internal fun ActivityHeaderCapsuleButton(
    title: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    pending: Boolean = false,
    destructive: Boolean = false,
) {
    val scheme = MaterialTheme.colorScheme
    val ink = if (destructive) scheme.error else scheme.onSurface
    FilledTonalButton(
        onClick = onClick,
        enabled = enabled && !pending,
        modifier = modifier.heightIn(min = 40.dp),
        colors = ButtonDefaults.filledTonalButtonColors(
            containerColor = scheme.surfaceContainerHigh, contentColor = ink,
            disabledContainerColor = scheme.surfaceContainerHigh, disabledContentColor = ink,
        ),
        contentPadding = PaddingValues(horizontal = 16.dp),
    ) {
        if (pending) {
            CircularProgressIndicator(Modifier.size(18.dp), color = ink, strokeWidth = 2.dp)
        } else {
            Text(title, style = MaterialTheme.typography.labelLarge, maxLines = 1)
        }
    }
}
