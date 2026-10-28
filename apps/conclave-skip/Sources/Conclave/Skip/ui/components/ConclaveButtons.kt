package conclave.module

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconToggleButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/*
 * Text buttons (F00 C01, TG 4.2 button.*) and the text helper every component file uses. Handwritten Compose
 * Material 3; colors are theme roles from HostingTheme, never literals. Titles are resolved by the caller.
 */

/** Receives the layout of every component text line: the line name and whether it overflowed. */
internal fun interface ConclaveTextReporter {
    fun report(line: String, hasVisualOverflow: Boolean)
}

/**
 * The Debug gallery provides a reporter per specimen so its clipped-text count sees component text (the
 * gallery only measures its own lines otherwise). Production never provides one, so the value stays null and
 * nothing is reported.
 */
internal val LocalConclaveTextReporter = staticCompositionLocalOf<ConclaveTextReporter?> { null }

/**
 * The only text call in the component files: every component line reports its layout through
 * [LocalConclaveTextReporter]. Text wraps by default; [maxLines] is for consuming screens whose geometry needs a
 * cap (OQ-2b-5), and the gallery never sets it.
 */
@Composable
internal fun ConclaveText(
    text: String, line: String, modifier: Modifier = Modifier, style: TextStyle = LocalTextStyle.current,
    color: Color = Color.Unspecified, textAlign: TextAlign? = null, maxLines: Int = Int.MAX_VALUE,
    overflow: TextOverflow = TextOverflow.Clip,
) {
    val reporter = LocalConclaveTextReporter.current
    Text(text, modifier = modifier, color = color, textAlign = textAlign, overflow = overflow, maxLines = maxLines, style = style,
        onTextLayout = { reporter?.report(line, it.hasVisualOverflow) })
}

/** The four text button roles (F00 C01). Call controls are C04, not buttons. */
internal enum class ConclaveButtonRole { Primary, Tonal, Text, Destructive }

/**
 * A text button. Primary is the one coral action per screen (primaryContainer with onPrimaryContainer ink, never
 * the light `primary`, which is coralText); tonal is the neutral secondary; text uses `primary`; destructive uses
 * `error`, never coral. A pending button keeps its label after a spinner on the leading side, is disabled and
 * says "In progress" in its state description. Buttons play no haptic (F00 C01 h).
 */
@Composable
internal fun ConclaveButton(
    title: String, role: ConclaveButtonRole, identifier: String, onClick: () -> Unit,
    modifier: Modifier = Modifier, enabled: Boolean = true, pending: Boolean = false, maxLines: Int = Int.MAX_VALUE,
) {
    val inProgress = conclaveString("ds_in_progress")
    val buttonModifier = modifier.heightIn(min = 48.dp).testTag(identifier)
        .semantics { if (pending) stateDescription = inProgress }
    val active = enabled && !pending
    val scheme = MaterialTheme.colorScheme
    val content: @Composable () -> Unit = { ButtonLabel(title, identifier, pending, maxLines) }
    when (role) {
        ConclaveButtonRole.Primary -> Button(onClick = onClick, modifier = buttonModifier, enabled = active,
            colors = ButtonDefaults.buttonColors(containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer)) {
            content()
        }
        ConclaveButtonRole.Tonal -> FilledTonalButton(onClick = onClick, modifier = buttonModifier, enabled = active) { content() }
        ConclaveButtonRole.Text -> TextButton(onClick = onClick, modifier = buttonModifier, enabled = active) { content() }
        ConclaveButtonRole.Destructive -> TextButton(onClick = onClick, modifier = buttonModifier, enabled = active,
            colors = ButtonDefaults.textButtonColors(contentColor = scheme.error)) { content() }
    }
}

/** The spinner sits before the title, so it mirrors to the leading side in right-to-left layouts. */
@Composable
private fun ButtonLabel(title: String, identifier: String, pending: Boolean, maxLines: Int) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (pending) {
            CircularProgressIndicator(modifier = Modifier.size(18.dp), color = LocalContentColor.current, strokeWidth = 2.dp)
            Spacer(Modifier.width(8.dp))
        }
        ConclaveText(title, line = "$identifier.title", textAlign = TextAlign.Center, maxLines = maxLines)
    }
}

// MARK: Icon buttons, Close and Back (F00 C02)

/**
 * An icon-only action in system-appearance chrome or content (app bar actions, a row's trailing More, a field
 * clear): an M3 IconButton (48 dp target) whose description names the action, not the glyph. [tint] defaults to
 * the content color the app bar or row provides (onSurface navigation, onSurfaceVariant actions). No tooltip in
 * this push (OQ-2b-9; the M3 tooltip box needs an experimental opt-in the component files do not take).
 */
@Composable
internal fun ConclaveIconButton(
    description: String, icon: ImageVector, identifier: String, onClick: () -> Unit, modifier: Modifier = Modifier,
    enabled: Boolean = true, tint: Color = LocalContentColor.current,
) {
    IconButton(onClick = onClick, enabled = enabled, modifier = modifier.testTag(identifier)) {
        Icon(icon, contentDescription = description, tint = tint)
    }
}

/** Panel Close (side pane) and sheet Close: "Close {title}", or plain "Close" when [title] is null (S10 R10). */
@Composable
internal fun ConclaveCloseButton(title: String?, onClick: () -> Unit, modifier: Modifier = Modifier, identifier: String = "panel.close") {
    val description = if (title != null) conclaveString("ds_close_title", title) else conclaveString("ds_close")
    ConclaveIconButton(description, ConclaveIcons.CloseFill0, identifier, onClick, modifier)
}

/**
 * Back: the auto-mirrored ArrowBackFill0 (callers never mirror it again). Panel overlays say "Back to call";
 * pushed premeeting pages say "Back" (F00 C02 d).
 */
@Composable
internal fun ConclaveBackButton(toCall: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, identifier: String = "panel.close") {
    val description = if (toCall) conclaveString("ds_back_to_call") else conclaveString("ds_back")
    ConclaveIconButton(description, ConclaveIcons.ArrowBackFill0, identifier, onClick, modifier)
}

/** A two-state icon button (Q&A upvote): IconToggleButton with a constant description and the state in its state
 *  description; [checkedIcon] is the FILL 1 glyph. */
@Composable
internal fun ConclaveIconToggleButton(
    description: String, stateText: String, icon: ImageVector, checkedIcon: ImageVector, checked: Boolean,
    onCheckedChange: (Boolean) -> Unit, identifier: String, modifier: Modifier = Modifier, enabled: Boolean = true,
) {
    IconToggleButton(checked = checked, onCheckedChange = onCheckedChange, enabled = enabled,
        modifier = modifier.testTag(identifier).semantics { stateDescription = stateText }) {
        Icon(if (checked) checkedIcon else icon, contentDescription = description)
    }
}
