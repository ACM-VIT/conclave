package conclave.module

import android.content.Context
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

internal object ConclaveTipStore {
    const val PREFERENCES = "conclave.tips"

    fun isDismissed(context: Context, id: String): Boolean =
        context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getBoolean(OneTimeTipPolicy.storeKey(id), false)

    fun dismiss(context: Context, id: String) {
        context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
            .putBoolean(OneTimeTipPolicy.storeKey(id), true).apply()
    }

    fun reset(context: Context) {
        context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().clear().apply()
    }
}

@Composable
internal fun ConclaveTipCard(
    id: String, title: String, body: String, icon: ImageVector, identifier: String, modifier: Modifier = Modifier,
    onDismiss: () -> Unit = {},
) {
    val context = LocalContext.current
    var visible by remember(id) { mutableStateOf(!ConclaveTipStore.isDismissed(context, id)) }
    if (!visible) return
    val scheme = MaterialTheme.colorScheme
    Surface(
        modifier = modifier.fillMaxWidth().testTag(identifier),
        shape = MaterialTheme.shapes.medium,
        color = scheme.surfaceContainerHigh,
        border = BorderStroke(1.dp, scheme.outlineVariant),
        tonalElevation = 0.dp,
        shadowElevation = 0.dp,
    ) {
        Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
            Row(Modifier.weight(1f).semantics(mergeDescendants = true) { }, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(icon, contentDescription = null, tint = scheme.onSurfaceVariant)
                Column(Modifier.weight(1f)) {
                    ConclaveText(title, line = "$identifier.title", style = MaterialTheme.typography.titleSmall, color = scheme.onSurface)
                    ConclaveText(body, line = "$identifier.body", style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
                }
            }
            IconButton(
                onClick = {
                    ConclaveTipStore.dismiss(context, id)
                    visible = false
                    onDismiss()
                },
                modifier = Modifier.testTag("$identifier.dismiss"),
            ) {
                Icon(ConclaveIcons.CloseFill0, contentDescription = conclaveString("ds_dismiss_tip"))
            }
        }
    }
}
