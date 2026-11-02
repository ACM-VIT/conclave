package conclave.module

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

private const val PRIVACY_BULLET = "•"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun PrivacyPolicyScreen(onBack: () -> Unit, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val blocks = remember { PrivacyPolicyDocument.blocks.toList() }
    val uriHandler = LocalUriHandler.current
    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        conclaveString("pm_privacy_policy"),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.semantics { heading() },
                    )
                },
                navigationIcon = { ConclaveBackButton(toCall = false, onClick = onBack, identifier = "privacy.back") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = scheme.surface),
            )
        },
        containerColor = scheme.surface,
        contentWindowInsets = WindowInsets.safeDrawing,
    ) { padding ->
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            LazyColumn(
                modifier = Modifier.fillMaxSize().widthIn(max = 640.dp).testTag("privacy.page"),
                contentPadding = padding,
            ) {
                items(blocks, key = { block -> block.id }) { block -> PrivacyPolicyBlockItem(block) }
                item("web") {
                    ListItem(
                        headlineContent = { Text(conclaveString("pm_view_on_web"), color = scheme.primary) },
                        colors = ListItemDefaults.colors(containerColor = scheme.surface),
                        modifier = Modifier.testTag("privacy.web").clickable(role = Role.Button) {
                            runCatching { uriHandler.openUri(PrivacyPolicyDestination.urlString) }
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun PrivacyPolicyBlockItem(block: PrivacyPolicyBlock) {
    val typography = MaterialTheme.typography
    when (block.kind) {
        PrivacyPolicyBlockKind.heading -> Text(
            block.text,
            style = typography.titleMedium,
            modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 4.dp).semantics { heading() },
        )
        PrivacyPolicyBlockKind.paragraph -> Text(
            block.text,
            style = typography.bodyLarge,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
        )
        PrivacyPolicyBlockKind.bullet -> Row(Modifier.padding(start = 16.dp, end = 16.dp, top = 2.dp, bottom = 2.dp)) {
            Text(PRIVACY_BULLET, style = typography.bodyLarge, modifier = Modifier.padding(end = 8.dp).clearAndSetSemantics { })
            Text(block.text, style = typography.bodyLarge)
        }
    }
}
