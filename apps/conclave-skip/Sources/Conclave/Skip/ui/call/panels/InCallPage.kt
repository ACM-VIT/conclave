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

internal enum class InCallPageVariant { Overlay, SidePane, Sheet }

internal enum class InCallPageContent { scroll, lazyList }

internal enum class InCallPageNavigation { BackToCall, Back, Close }

internal fun inCallPageNavigation(variant: InCallPageVariant, isNested: Boolean): InCallPageNavigation = when {
    isNested -> InCallPageNavigation.Back
    variant == InCallPageVariant.Overlay -> InCallPageNavigation.BackToCall
    else -> InCallPageNavigation.Close
}

internal fun callMiniTileWidthDp(landscape: Boolean): Int = if (landscape) 128 else 96

internal fun callMiniTileHeightDp(landscape: Boolean): Int = if (landscape) 96 else 128

internal fun miniTileReservationDp(landscape: Boolean, tileVisible: Boolean): Int =
    if (tileVisible) callMiniTileHeightDp(landscape) + 32 else 16

internal fun inCallPageTileVisible(
    hasTile: Boolean,
    variant: InCallPageVariant,
    hasComposer: Boolean,
    hideMiniTileWithIme: Boolean,
    imeVisible: Boolean,
): Boolean = hasTile && variant == InCallPageVariant.Overlay && !((hasComposer || hideMiniTileWithIme) && imeVisible)

internal data class InCallPageReservation(val top: Dp, val bottom: Dp)

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

    LaunchedEffect(Unit) {
        if (variant != InCallPageVariant.Sheet) {

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

            val edgeToEdgeBottom = lazyList && !hasComposer
            val bottomInset = if (edgeToEdgeBottom) insets.calculateBottomPadding() else 0.dp
            val bodyPadding = if (edgeToEdgeBottom) {
                PaddingValues(start = insets.calculateStartPadding(layoutDirection), top = insets.calculateTopPadding(),
                    end = insets.calculateEndPadding(layoutDirection), bottom = 0.dp)
            } else insets

            val tileClearance = if (tileVisible) miniTileReservationDp(landscape, true).dp else 0.dp
            val reservation = inCallPageReservation(contentMode, landscape, false, hasComposer,
                if (tileVisible) 0.dp else bottomInset)
            Column(Modifier.fillMaxSize().padding(bodyPadding).consumeWindowInsets(insets)) {
                Box(Modifier.weight(1f).fillMaxSize()) {
                    Box(Modifier.fillMaxSize().padding(
                        top = if (hasComposer) tileClearance else 0.dp,
                        bottom = if (tileVisible && !hasComposer) tileClearance + bottomInset else 0.dp,
                    )) {
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

                    if (hasComposer) Box(Modifier.align(Alignment.BottomCenter)) { snackbarHost() }
                }
                if (hasComposer) Box(Modifier.padding(horizontal = margin, vertical = 8.dp)) { composer() }
            }
        }
    }
}

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
