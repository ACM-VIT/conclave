package conclave.module

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

/** Tracks actual composition lifetime, including requests coalesced before first presentation. */
internal class NativePanelOverlayLifetime(private val coordinator: PanelCoordinator) {
    private var mountedSession: Int? = null
    private var mountedID: Int? = null

    fun mounted(session: Int, id: Int) {
        mountedSession = session
        mountedID = id
    }

    fun disposed(session: Int, id: Int) {
        if (mountedSession == session && mountedID == id) {
            mountedSession = null
            mountedID = null
        }
        coordinator.didDismiss(session = session, presentationID = id)
    }

    fun acknowledgeAbsent() {
        val state = coordinator.snapshot
        val request = state.current ?: return
        if (state.isDismissing && mountedID == null) {
            coordinator.didDismiss(session = state.session, presentationID = request.presentationID)
        }
    }
}

/** A retained-stage overlay. The parent acknowledges removal only after this composition disposes. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun InCallPage(
    title: String,
    hasComposer: Boolean,
    onClose: () -> Unit,
    onMounted: () -> Unit,
    onDisposed: () -> Unit,
    composer: @Composable () -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    DisposableEffect(Unit) {
        onMounted()
        onDispose { onDisposed() }
    }
    val imeVisible = WindowInsets.isImeVisible
    val margin = if (LocalConfiguration.current.screenWidthDp >= 600) 24.dp else 16.dp
    HostingTheme {
        Scaffold(
            modifier = Modifier.fillMaxSize().imePadding().testTag("panel.page"),
            contentWindowInsets = WindowInsets.safeDrawing,
            topBar = {
                TopAppBar(title = { Text(title) }, navigationIcon = {
                    TextButton(onClick = onClose, modifier = Modifier.testTag("panel.close")) { Text("Back") }
                })
            },
        ) { insets ->
            Column(Modifier.fillMaxSize().padding(insets).consumeWindowInsets(insets)) {
                Box(Modifier.weight(1f).fillMaxSize()) {
                    // Reserve the tile's area so large text and final actions never sit beneath it.
                    Column(
                        Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                            .padding(horizontal = margin)
                            .padding(top = if (hasComposer && !imeVisible) 160.dp else 16.dp,
                                bottom = if (!hasComposer) 160.dp else 16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp), content = content,
                    )
                    if (!hasComposer || !imeVisible) {
                        CallMiniTile(Modifier.align(if (hasComposer) Alignment.TopEnd else Alignment.BottomEnd).padding(16.dp))
                    }
                }
                if (hasComposer) Box(Modifier.padding(horizontal = margin, vertical = 8.dp)) { composer() }
            }
        }
    }
}
