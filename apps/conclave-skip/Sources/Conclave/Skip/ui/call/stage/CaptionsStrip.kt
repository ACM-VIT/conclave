package conclave.module

import android.content.Context
import android.view.accessibility.CaptioningManager
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import skip.foundation.ProcessInfo

/*
 * S20 10 d (SL11; TRN-1, S60 5): the captions strip above the stage-lane snackbar. It mounts only while captions are on
 * and live notes are live for a non-attendee (stage.captionsActive), and only the strip reads the CaptionLineFeed leaf,
 * so a caption delta recomposes the strip alone (S20 10 k). Surface(surfaceContainer) with a 1 dp extended border and
 * the medium shape; the speaker name in semibold, then the line; partial text in onSurfaceVariant (S60 R6-12); at most 2
 * lines (3 at font scale 1.5 and up), the oldest words clipped at the top; the quiet first state reads "Captions will
 * appear here." and the line hides after 6 s of silence (the feed decides). The strip is one button "Open transcript"
 * with the latest line as its state; it is no live region (captions are not announced). The CaptioningManager user style
 * applies its foreground and background colors and font scale (AAPPS 6.14) and refreshes when the setting changes.
 */

@Composable
internal fun CaptionsStripSlot(stage: StagePresenter) {
    if (stage.captionsActive) {
        CaptionsStrip(stage.captions) { stage.openTranscript(destination = PanelDestination.transcriptLive) }
    }
}

@Composable
private fun CaptionsStrip(feed: CaptionLineFeed, onOpen: () -> Unit) {
    val line = feed.line
    if (!line.isVisible) return
    val style = rememberCaptionUserStyle()
    val access = rememberSystemAccessibility()
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val maxLines = if (access.fontScale >= 1.5f) 3 else 2
    val openLabel = conclaveString("stg_open_transcript")
    val emptyText = conclaveString("stg_captions_empty")
    val value = when {
        line.isPlaceholder -> emptyText
        line.speakerName.isEmpty() -> line.text
        else -> line.speakerName + ", " + line.text
    }
    val base = MaterialTheme.typography.bodyLarge
    val textStyle = if (style.fontScale != 1.0f) base.copy(fontSize = base.fontSize * style.fontScale,
        lineHeight = base.lineHeight * style.fontScale) else base
    val ink = style.foreground ?: scheme.onSurface
    val maxHeight = with(LocalDensity.current) { (textStyle.lineHeight * maxLines).toDp() }
    Surface(
        color = style.background ?: scheme.surfaceContainer,
        contentColor = ink,
        border = BorderStroke(1.dp, ext.border),
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth().testTag("stage.captions")
            .clickable(onClickLabel = openLabel, role = Role.Button) { onOpen() }
            .clearAndSetSemantics {
                contentDescription = openLabel
                stateDescription = value
                role = Role.Button
                onClick(label = openLabel) { onOpen(); true }
            },
    ) {
        Box(Modifier.padding(horizontal = 16.dp, vertical = 12.dp).heightIn(max = maxHeight).clipToBounds(),
            contentAlignment = Alignment.BottomStart) {
            if (line.isPlaceholder) {
                Text(emptyText, style = textStyle, color = style.foreground ?: scheme.onSurfaceVariant, maxLines = maxLines)
            } else {
                val secondary = style.foreground ?: scheme.onSurfaceVariant
                val annotated = buildAnnotatedString {
                    if (line.speakerName.isNotEmpty()) {
                        withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = ink)) { append(line.speakerName + "  ") }
                    }
                    withStyle(SpanStyle(color = if (line.isFinal) ink else secondary)) { append(line.text) }
                }
                // The full line lays out at its natural height; the box shows its last lines (oldest clipped at the top).
                Text(annotated, style = textStyle, modifier = Modifier.fillMaxWidth().testTag("stage.captions.text"))
            }
        }
    }
}

/** The person's caption style; null colors keep the in-call tokens. */
internal data class CaptionUserStyle(val foreground: Color?, val background: Color?, val fontScale: Float) {
    companion object {
        val standard = CaptionUserStyle(foreground = null, background = null, fontScale = 1.0f)

        fun read(context: Context): CaptionUserStyle {
            val manager = context.getSystemService(Context.CAPTIONING_SERVICE) as? CaptioningManager ?: return standard
            if (!manager.isEnabled) return standard
            val user = manager.userStyle
            val foreground = if (user.hasForegroundColor()) Color(user.foregroundColor) else null
            val background = if (user.hasBackgroundColor()) Color(user.backgroundColor) else null
            val scale = manager.fontScale
            return CaptionUserStyle(foreground = foreground, background = background, fontScale = if (scale > 0f) scale else 1.0f)
        }
    }
}

/** Reads the CaptioningManager style and listens for changes while the strip shows. */
@Composable
private fun rememberCaptionUserStyle(): CaptionUserStyle {
    val context = LocalContext.current.applicationContext
    var style by remember(context) { mutableStateOf(CaptionUserStyle.read(context)) }
    DisposableEffect(context) {
        val manager = context.getSystemService(Context.CAPTIONING_SERVICE) as? CaptioningManager
        val listener = object : CaptioningManager.CaptioningChangeListener() {
            override fun onEnabledChanged(enabled: Boolean) { style = CaptionUserStyle.read(context) }
            override fun onUserStyleChanged(userStyle: CaptioningManager.CaptionStyle) { style = CaptionUserStyle.read(context) }
            override fun onFontScaleChanged(fontScale: Float) { style = CaptionUserStyle.read(context) }
        }
        manager?.addCaptioningChangeListener(listener)
        onDispose { manager?.removeCaptioningChangeListener(listener) }
    }
    return style
}

/**
 * S60 Q10 on Android: the first-use captions default follows CaptioningManager.isEnabled. Called from the transpiled
 * CaptionsPreference (TranscriptModels.swift) under SKIP.
 */
internal object NativeCaptioning {
    fun isSystemCaptioningEnabled(): Boolean {
        return try {
            val context = ProcessInfo.processInfo.androidContext
            val manager = context.getSystemService(Context.CAPTIONING_SERVICE) as? CaptioningManager
            manager?.isEnabled == true
        } catch (error: Throwable) {
            false
        }
    }
}
