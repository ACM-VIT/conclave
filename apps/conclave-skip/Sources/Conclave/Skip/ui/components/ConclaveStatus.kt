package conclave.module

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

@Composable
internal fun ConclaveLoadingStatus(identifier: String, modifier: Modifier = Modifier, label: String? = null) {
    val text = label ?: conclaveString("ds_loading")
    Column(modifier.fillMaxWidth().padding(24.dp).testTag(identifier).semantics(mergeDescendants = true) {},
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        CircularProgressIndicator(modifier = Modifier.semantics { contentDescription = text })
        ConclaveText(text, line = "$identifier.label", color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.clearAndSetSemantics { })
    }
}

@Composable
internal fun ConclaveEmptyStatus(title: String, body: String, icon: ImageVector, identifier: String, modifier: Modifier = Modifier) {
    StatusColumn(title, body, icon, identifier, modifier, retryTitle = null, onRetry = null)
}

@Composable
internal fun ConclaveErrorStatus(
    title: String, body: String, icon: ImageVector, identifier: String, onRetry: () -> Unit,
    modifier: Modifier = Modifier, retryTitle: String? = null,
) {
    StatusColumn(title, body, icon, identifier, modifier, retryTitle ?: conclaveString("ds_try_again"), onRetry)
}

@Composable
internal fun ConclaveOfflineStatus(identifier: String, modifier: Modifier = Modifier, onRetry: (() -> Unit)? = null) {
    StatusColumn(conclaveString("ds_offline_title"), conclaveString("ds_offline_body"), ConclaveIcons.WifiOffFill0,
        identifier, modifier, retryTitle = if (onRetry == null) null else conclaveString("ds_try_again"), onRetry = onRetry)
}

@Composable
private fun StatusColumn(
    title: String, body: String, icon: ImageVector, identifier: String, modifier: Modifier, retryTitle: String?,
    onRetry: (() -> Unit)?,
) {
    val scheme = MaterialTheme.colorScheme
    Column(modifier.fillMaxWidth().padding(24.dp).testTag(identifier),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(48.dp), tint = scheme.onSurfaceVariant)
        ConclaveText(title, line = "$identifier.title", style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center,
            modifier = Modifier.semantics { heading() })

        if (body.isNotEmpty()) {
            ConclaveText(body, line = "$identifier.body", style = MaterialTheme.typography.bodyMedium,
                color = scheme.onSurfaceVariant, textAlign = TextAlign.Center)
        }
        if (retryTitle != null && onRetry != null) {
            FilledTonalButton(onClick = onRetry, modifier = Modifier.heightIn(min = 48.dp).testTag("$identifier.retry")) {
                ConclaveText(retryTitle, line = "$identifier.retry")
            }
        }
    }
}
