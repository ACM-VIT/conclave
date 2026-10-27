package conclave.module

import android.content.res.Configuration
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
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
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Where a page is hosted: the phone overlay (WP1-3b1), the expanded side pane (WP1-3b2), a sheet (WP1-3c). */
internal enum class InCallPageVariant { Overlay, SidePane, Sheet }

/**
 * How the page holds its body (S40 R40-3, S50 R50-1): `scroll` places a column body in one `verticalScroll` and
 * keeps the reservation itself; `lazyList` passes the body unscrolled, so it can host a `LazyColumn`, and hands it
 * the reservation for the list's `contentPadding`. The lower-case names are the spec's (`InCallPageContent.lazyList`).
 */
internal enum class InCallPageContent { scroll, lazyList }

/** What the navigation icon does and says (S60 R6-2, PS 8.4). */
internal enum class InCallPageNavigation { BackToCall, Back, Close }

/**
 * An inner page pushed on the panel reads "Back" in every variant; at the root the overlay reads "Back to call" and
 * the side pane and the sheet read "Close <title>".
 */
internal fun inCallPageNavigation(variant: InCallPageVariant, isNested: Boolean): InCallPageNavigation = when {
    isNested -> InCallPageNavigation.Back
    variant == InCallPageVariant.Overlay -> InCallPageNavigation.BackToCall
    else -> InCallPageNavigation.Close
}

/** Mini tile size (R07): 96 x 128 dp in portrait, 128 x 96 dp in landscape. */
internal fun callMiniTileWidthDp(landscape: Boolean): Int = if (landscape) 128 else 96

internal fun callMiniTileHeightDp(landscape: Boolean): Int = if (landscape) 96 else 128

/**
 * Space the page body keeps clear of a visible mini tile: its height plus 32 dp (PS 8.4), so large text and
 * final actions never sit beneath it; 16 dp when no tile shows.
 */
internal fun miniTileReservationDp(landscape: Boolean, tileVisible: Boolean): Int =
    if (tileVisible) callMiniTileHeightDp(landscape) + 32 else 16

/** The tile shows on the overlay only, and hides while the keyboard shows for a composer or a page that asks. */
internal fun inCallPageTileVisible(
    hasTile: Boolean,
    variant: InCallPageVariant,
    hasComposer: Boolean,
    hideMiniTileWithIme: Boolean,
    imeVisible: Boolean,
): Boolean = hasTile && variant == InCallPageVariant.Overlay && !((hasComposer || hideMiniTileWithIme) && imeVisible)

/** The page body's top and bottom clearance (PS 8.4, S40 R40-3, S50 R50-1). */
internal data class InCallPageReservation(val top: Dp, val bottom: Dp)

/**
 * `scroll`: the tile term at the tile's edge (top with a composer, bottom without), 16 dp elsewhere; the body sits
 * inside the safe-drawing padding. `lazyList` without a composer: the list scrolls behind the navigation bar, so the
 * bottom carries the tile term plus `bottomInset`, the navigation-bar inset (R50-1); with a composer the bottom is
 * 0, because the composer sits below the list, and the top carries the tile term only while the tile shows.
 */
internal fun inCallPageReservation(
    contentMode: InCallPageContent,
    landscape: Boolean,
    tileVisible: Boolean,
    hasComposer: Boolean,
    bottomInset: Dp,
): InCallPageReservation {
    val tile = miniTileReservationDp(landscape, tileVisible).dp
    return when (contentMode) {
        InCallPageContent.scroll -> InCallPageReservation(
            top = if (hasComposer && tileVisible) tile else 16.dp,
            bottom = if (!hasComposer && tileVisible) tile else 16.dp,
        )
        InCallPageContent.lazyList -> InCallPageReservation(
            top = if (hasComposer && tileVisible) tile else 0.dp,
            bottom = if (hasComposer) 0.dp else tile + bottomInset,
        )
    }
}

/**
 * One keyed page of a retained-stage panel, in the one target signature (F00 C15 d, RECONCILE R33): PS 8.4
 * (`variant`, `appearance`, `miniTile`, `miniTileVideo`), S40 R40-3 and S50 R50-1 (`contentMode`, `snackbarHost`,
 * `hideMiniTileWithIme`, the `reservation` content parameter) and S60 R6-2 (`isNested`, `actions`). The host
 * acknowledges removal only after this composition disposes. On explicit open the page moves focus to its title,
 * so TalkBack and the keyboard enter the overlay or the side pane (PS 8.10); a later move between the two (a
 * window-class change) keeps the page composed and does not move focus again. The pane title announces it and the
 * traversal group keeps its content together. The side pane takes the keyboard inset inside itself and only the
 * top, end and bottom safe-drawing insets.
 *
 * `onClose` always closes the panel (Close, Back to call and the mini tile's Return to call); while `isNested`
 * the navigation icon calls `onBack` instead when it is given (the host's [PanelPageStack] pop, or a content back
 * stack), else `onClose`. `content` receives `reservation`: zero in `scroll` mode (the page applies it), the list
 * padding in `lazyList` mode. A panel-level `snackbarHost` goes to the page Scaffold; with a composer it sits just
 * above the composer, so a snackbar never covers the field.
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
    contentMode: InCallPageContent = InCallPageContent.scroll,
    snackbarHost: @Composable () -> Unit = {},
    hideMiniTileWithIme: Boolean = false,
    isNested: Boolean = false,
    onBack: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
    content: @Composable ColumnScope.(reservation: PaddingValues) -> Unit,
) {
    DisposableEffect(Unit) {
        onMounted()
        onDispose { onDisposed() }
    }
    val imeVisible = WindowInsets.isImeVisible
    val configuration = LocalConfiguration.current
    val layoutDirection = LocalLayoutDirection.current
    val landscape = configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
    val margin = if (configuration.screenWidthDp >= 600) 24.dp else 16.dp
    val titleFocus = remember { FocusRequester() }
    val tileVisible = inCallPageTileVisible(miniTile != null, variant, hasComposer, hideMiniTileWithIme, imeVisible)
    val lazyList = contentMode == InCallPageContent.lazyList
    // Keyed to the page, not to the variant, so moving between the overlay and the side pane never runs it again.
    LaunchedEffect(Unit) {
        if (variant != InCallPageVariant.Sheet) {
            // Retried for a few frames until the title has attached and accepted focus (PS 8.10).
            requestPanelFocus(PANEL_FOCUS_ATTEMPTS, awaitFrame = { withFrameNanos { } }) { titleFocus.requestFocusOrFalse() }
        }
    }
    val sidePane = variant == InCallPageVariant.SidePane
    val sidePaneSides = WindowInsetsSides.Top + WindowInsetsSides.End + WindowInsetsSides.Bottom
    val navigation = inCallPageNavigation(variant, isNested)
    val navigate: () -> Unit = if (navigation == InCallPageNavigation.Back && onBack != null) onBack else onClose
    HostingTheme(inCall = appearance == PanelAppearance.inCall) {
        Scaffold(
            modifier = Modifier.fillMaxSize().imePadding().testTag("panel.page")
                .semantics { paneTitle = title; isTraversalGroup = true },
            contentWindowInsets = if (sidePane) WindowInsets.safeDrawing.only(sidePaneSides) else WindowInsets.safeDrawing,
            snackbarHost = { if (!hasComposer) snackbarHost() },
            topBar = {
                TopAppBar(
                    title = {
                        Text(title, modifier = Modifier.testTag("panel.title").focusRequester(titleFocus).focusable()
                            .semantics { heading() })
                    },
                    navigationIcon = { PanelNavigationIcon(title, navigation, navigate) },
                    actions = actions,
                    windowInsets = if (sidePane) TopAppBarDefaults.windowInsets.only(WindowInsetsSides.Top + WindowInsetsSides.End)
                        else TopAppBarDefaults.windowInsets,
                )
            },
        ) { insets ->
            // A list without a composer scrolls behind the navigation bar; its inset moves into the reservation.
            val edgeToEdgeBottom = lazyList && !hasComposer
            val bottomInset = if (edgeToEdgeBottom) insets.calculateBottomPadding() else 0.dp
            val bodyPadding = if (edgeToEdgeBottom) {
                PaddingValues(start = insets.calculateStartPadding(layoutDirection), top = insets.calculateTopPadding(),
                    end = insets.calculateEndPadding(layoutDirection), bottom = 0.dp)
            } else insets
            val reservation = inCallPageReservation(contentMode, landscape, tileVisible, hasComposer, bottomInset)
            Column(Modifier.fillMaxSize().padding(bodyPadding).consumeWindowInsets(insets)) {
                Box(Modifier.weight(1f).fillMaxSize()) {
                    if (lazyList) {
                        Column(Modifier.fillMaxSize().testTag("panel.body")) {
                            content(PaddingValues(top = reservation.top, bottom = reservation.bottom))
                        }
                    } else {
                        Column(
                            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).testTag("panel.body")
                                .padding(horizontal = margin)
                                .padding(top = reservation.top, bottom = reservation.bottom),
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            content(PaddingValues(0.dp))
                        }
                    }
                    if (tileVisible && miniTile != null) {
                        CallMiniTile(
                            model = miniTile,
                            onReturnToCall = onClose,
                            modifier = Modifier.align(if (hasComposer) Alignment.TopEnd else Alignment.BottomEnd).padding(16.dp)
                                .padding(bottom = bottomInset),
                            video = miniTileVideo,
                        )
                    }
                    // With a composer the snackbar sits directly above it rather than over it.
                    if (hasComposer) Box(Modifier.align(Alignment.BottomCenter)) { snackbarHost() }
                }
                if (hasComposer) Box(Modifier.padding(horizontal = margin, vertical = 8.dp)) { composer() }
            }
        }
    }
}

/**
 * Overlay root: Back to call (arrow_back auto-mirrors, D07). Side pane and sheet root: Close with the panel title.
 * An inner page: Back. The tag follows the action, so a script never mistakes a pop for a close.
 */
@Composable
private fun PanelNavigationIcon(title: String, navigation: InCallPageNavigation, onClick: () -> Unit) {
    val tag = if (navigation == InCallPageNavigation.Back) "panel.back" else "panel.close"
    IconButton(onClick = onClick, modifier = Modifier.testTag(tag)) {
        when (navigation) {
            InCallPageNavigation.BackToCall ->
                Icon(ConclaveIcons.ArrowBackFill0, contentDescription = conclaveString("native_panel_back_to_call"))
            InCallPageNavigation.Back ->
                Icon(ConclaveIcons.ArrowBackFill0, contentDescription = conclaveString("native_panel_back"))
            InCallPageNavigation.Close ->
                Icon(ConclaveIcons.CloseFill0, contentDescription = conclaveString("native_panel_close", title))
        }
    }
}
