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

internal fun interface ConclaveTextReporter {
    fun report(line: String, hasVisualOverflow: Boolean)
}

internal val LocalConclaveTextReporter = staticCompositionLocalOf<ConclaveTextReporter?> { null }

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

internal enum class ConclaveButtonRole { Primary, Tonal, Text, Destructive }

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

@Composable
internal fun ConclaveIconButton(
    description: String, icon: ImageVector, identifier: String, onClick: () -> Unit, modifier: Modifier = Modifier,
    enabled: Boolean = true, tint: Color = LocalContentColor.current,
) {
    IconButton(onClick = onClick, enabled = enabled, modifier = modifier.testTag(identifier)) {
        Icon(icon, contentDescription = description, tint = tint)
    }
}

@Composable
internal fun ConclaveCloseButton(title: String?, onClick: () -> Unit, modifier: Modifier = Modifier, identifier: String = "panel.close") {
    val description = if (title != null) conclaveString("ds_close_title", title) else conclaveString("ds_close")
    ConclaveIconButton(description, ConclaveIcons.CloseFill0, identifier, onClick, modifier)
}

@Composable
internal fun ConclaveBackButton(toCall: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, identifier: String = "panel.close") {
    val description = if (toCall) conclaveString("ds_back_to_call") else conclaveString("ds_back")
    ConclaveIconButton(description, ConclaveIcons.ArrowBackFill0, identifier, onClick, modifier)
}

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
