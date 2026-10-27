package conclave.module

import android.content.res.Configuration
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/** Where a page is hosted: the phone overlay (WP1-3b1), the expanded side pane (WP1-3b2), a sheet (WP1-3c). */
internal enum class InCallPageVariant { Overlay, SidePane, Sheet }

/** Mini tile size (R07): 96 x 128 dp in portrait, 128 x 96 dp in landscape. */
internal fun callMiniTileWidthDp(landscape: Boolean): Int = if (landscape) 128 else 96

internal fun callMiniTileHeightDp(landscape: Boolean): Int = if (landscape) 96 else 128

/**
 * Space the page body keeps clear of a visible mini tile: its height plus 32 dp (PS 8.4), so large text and
 * final actions never sit beneath it; 16 dp when no tile shows.
 */
internal fun miniTileReservationDp(landscape: Boolean, tileVisible: Boolean): Int =
    if (tileVisible) callMiniTileHeightDp(landscape) + 32 else 16

/**
 * One keyed page of a retained-stage panel (PS 8.4). The host acknowledges removal only after this composition
 * disposes. On explicit open the page moves focus to its title, so TalkBack and the keyboard enter the overlay or
 * the side pane (PS 8.10); a later move between the two (a window-class change) keeps the page composed and does
 * not move focus again. The pane title announces it and the traversal group keeps its content together. The side
 * pane takes the keyboard inset inside itself and only the top, end and bottom safe-drawing insets.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun InCallPage(
    title: String,
    variant: InCallPageVariant,
    appearance: PanelAppearance = PanelAppearance.system,
    hasComposer: Boolean,
    miniTile: CallMiniTileModel?,
    onClose: () -> Unit,
    onMounted: () -> Unit,
    onDisposed: () -> Unit,
    miniTileVideo: (@Composable () -> Unit)? = null,
    composer: @Composable () -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    DisposableEffect(Unit) {
        onMounted()
        onDispose { onDisposed() }
    }
    val imeVisible = WindowInsets.isImeVisible
    val configuration = LocalConfiguration.current
    val landscape = configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
    val margin = if (configuration.screenWidthDp >= 600) 24.dp else 16.dp
    val titleFocus = remember { FocusRequester() }
    // The tile shows on the overlay only and hides while a composer has the keyboard.
    val tileVisible = miniTile != null && variant == InCallPageVariant.Overlay && !(hasComposer && imeVisible)
    val reservation = miniTileReservationDp(landscape, tileVisible).dp
    // Keyed to the page, not to the variant, so moving between the overlay and the side pane never runs it again.
    LaunchedEffect(Unit) {
        if (variant != InCallPageVariant.Sheet) {
            // Retried for a few frames until the title has attached and accepted focus (PS 8.10).
            requestPanelFocus(PANEL_FOCUS_ATTEMPTS, awaitFrame = { withFrameNanos { } }) { titleFocus.requestFocusOrFalse() }
        }
    }
    val sidePane = variant == InCallPageVariant.SidePane
    val sidePaneSides = WindowInsetsSides.Top + WindowInsetsSides.End + WindowInsetsSides.Bottom
    HostingTheme(inCall = appearance == PanelAppearance.inCall) {
        Scaffold(
            modifier = Modifier.fillMaxSize().imePadding().testTag("panel.page")
                .semantics { paneTitle = title; isTraversalGroup = true },
            contentWindowInsets = if (sidePane) WindowInsets.safeDrawing.only(sidePaneSides) else WindowInsets.safeDrawing,
            topBar = {
                TopAppBar(
                    title = {
                        Text(title, modifier = Modifier.testTag("panel.title").focusRequester(titleFocus).focusable()
                            .semantics { heading() })
                    },
                    navigationIcon = { PanelNavigationIcon(title, variant, onClose) },
                    windowInsets = if (sidePane) TopAppBarDefaults.windowInsets.only(WindowInsetsSides.Top + WindowInsetsSides.End)
                        else TopAppBarDefaults.windowInsets,
                )
            },
        ) { insets ->
            Column(Modifier.fillMaxSize().padding(insets).consumeWindowInsets(insets)) {
                Box(Modifier.weight(1f).fillMaxSize()) {
                    Column(
                        Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                            .padding(horizontal = margin)
                            .padding(top = if (hasComposer && tileVisible) reservation else 16.dp,
                                bottom = if (!hasComposer && tileVisible) reservation else 16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp), content = content,
                    )
                    if (tileVisible && miniTile != null) {
                        CallMiniTile(
                            model = miniTile,
                            onReturnToCall = onClose,
                            modifier = Modifier.align(if (hasComposer) Alignment.TopEnd else Alignment.BottomEnd).padding(16.dp),
                            video = miniTileVideo,
                        )
                    }
                }
                if (hasComposer) Box(Modifier.padding(horizontal = margin, vertical = 8.dp)) { composer() }
            }
        }
    }
}

/** Overlay: Back to call (arrow_back auto-mirrors, D07). Side pane and sheet: Close with the panel title. */
@Composable
private fun PanelNavigationIcon(title: String, variant: InCallPageVariant, onClose: () -> Unit) {
    IconButton(onClick = onClose, modifier = Modifier.testTag("panel.close")) {
        if (variant == InCallPageVariant.Overlay) {
            Icon(ConclaveIcons.ArrowBackFill0, contentDescription = conclaveString("native_panel_back_to_call"))
        } else {
            Icon(ConclaveIcons.CloseFill0, contentDescription = conclaveString("native_panel_close", title))
        }
    }
}
