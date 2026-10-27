package conclave.module

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitLongPressOrCancellation
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.absoluteOffset
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt

/*
 * STG-2 (S20 3 d, f, g; F00 C16; RECONCILE R19): the Android tile menu. A long press opens the F00 C16 DropdownMenu
 * at the press point with one `longPress` haptic; TalkBack reaches the same items as custom actions on the tile node
 * and opens the menu through the long-click action "Show actions". Unavailable items stay, disabled, with their
 * reason (R10; the iOS context menu hides them instead). Items come from the shared TileMenuPolicy and dispatch through
 * the shared TileMenuDispatcher; the people items (S50 3 g `ppl_` copy) arrive with PPL-2 as `people` sections. The
 * menu composes only while expanded (F00 C16 k) and reports itself open so chrome never hides under it (S30 CC16).
 */

/** Tile menu titles from the app-module resources: `ppl_pin` and `ppl_unpin` from S50 3 g (the single source, R19). */
@Composable
internal fun rememberTileMenuTitles(): TileMenuTitles {
    val pin = conclaveString("ppl_pin")
    val unpin = conclaveString("ppl_unpin")
    val flip = conclaveString("ds_flip_camera")
    val minimize = conclaveString("stg_minimize_self_view")
    val show = conclaveString("stg_show_self_view")
    val full = conclaveString("stg_show_full_video")
    val crop = conclaveString("stg_crop_to_fill")
    return remember(pin, unpin, flip, minimize, show, full, crop) {
        TileMenuTitles(pin = pin, unpin = unpin, flipCamera = flip, minimizeSelfView = minimize, showSelfView = show,
            showFullVideo = full, cropToFill = crop)
    }
}

/** One tile's menu: the shared context, every section (Android keeps disabled items) and the actionable items. */
internal class StageTileMenu(val context: TileMenuContext, val sections: List<MenuSectionModel>, val actionItems: List<MenuItemModel>) {
    val hasItems: Boolean get() = sections.isNotEmpty()
}

/**
 * Builds the menu from values the tile already holds. Android keeps Flip in the top row (S20 6 d, 7 d), so the own
 * tile menu offers no Flip item and never reads the chrome snapshot.
 */
internal fun stageTileMenu(slot: StageSlot, model: TileChromeModel, kind: StageKind, titles: TileMenuTitles,
                           people: List<MenuSectionModel> = emptyList()): StageTileMenu {
    val context = TileMenuContext.make(slot = slot, model = model, kind = kind, canFlipCamera = false, offersFlipItem = false)
    val sections = TileMenuPolicy.sections(context, titles = titles, people = skip.lib.Array(people)).toList()
    val items = TileMenuPolicy.accessibilityItems(skip.lib.Array(sections)).toList()
    return StageTileMenu(context, sections, items)
}

/** The same items as TalkBack custom actions on the tile node (S20 3 d, i). */
internal fun stageTileActions(menu: StageTileMenu, stage: StagePresenter): List<ConclaveTileAction> {
    val result = mutableListOf<ConclaveTileAction>()
    for (item in menu.actionItems) {
        val id = item.id
        result.add(ConclaveTileAction(id, item.title) { TileMenuDispatcher.perform(id, context = menu.context, stage = stage) })
    }
    return result
}

/** Open state and the press point; the menu anchors where the finger was (S20 3 d). */
internal class TileMenuState {
    var expanded by mutableStateOf(false)
        private set
    var anchor by mutableStateOf(Offset.Zero)
        private set

    fun open(at: Offset) {
        anchor = at
        expanded = true
    }

    fun dismiss() {
        expanded = false
    }
}

@Composable
internal fun rememberTileMenuState(): TileMenuState = remember { TileMenuState() }

/**
 * Long press opens the menu at the press point (S20 3 d). `combinedClickable` reports no position and
 * `detectTapGestures` consumes every down, which would stop the stage's tap from toggling chrome (S20 8 d), so this
 * awaits the long press directly: a plain tap passes through untouched, and after a long press the rest of the gesture
 * is consumed so the lift is never also a tap. The caller plays the `longPress` haptic once in `onLongPress`.
 */
internal fun Modifier.tileLongPress(enabled: Boolean, onLongPress: (Offset) -> Unit): Modifier =
    pointerInput(enabled) {
        if (!enabled) return@pointerInput
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false)
            val longPress = awaitLongPressOrCancellation(down.id)
            if (longPress != null) {
                longPress.consume()
                onLongPress(longPress.position)
                while (true) {
                    val event = awaitPointerEvent()
                    for (change in event.changes) change.consume()
                    if (event.changes.none { it.pressed }) break
                }
            }
        }
    }

/**
 * The menu itself, anchored by a zero-size box at the press point (absolute, so the anchor matches the pointer in
 * right-to-left layouts too). Keyboard and TalkBack opens anchor at the tile's top left corner.
 */
@Composable
internal fun TileMenuAnchor(state: TileMenuState, menu: StageTileMenu, stage: StagePresenter, identifier: String, modifier: Modifier = Modifier) {
    val open = state.expanded
    DisposableEffect(open) {
        if (open) stage.setTransientChrome(id = TileMenuPolicy.menuTransientId, open = true)
        onDispose {
            if (open) stage.setTransientChrome(id = TileMenuPolicy.menuTransientId, open = false)
        }
    }
    Box(modifier.absoluteOffset { IntOffset(state.anchor.x.roundToInt(), state.anchor.y.roundToInt()) }.size(0.dp)) {
        ConclaveDropdownMenu(
            expanded = open,
            onDismissRequest = { state.dismiss() },
            sections = menu.sections,
            identifier = identifier,
            onSelect = { item ->
                state.dismiss()
                TileMenuDispatcher.perform(item.id, context = menu.context, stage = stage)
            },
        )
    }
}

/** The pin announcements' words (S20 4 g) for the stage's one live region (CallRoot falls back to this). */
@Composable
internal fun tileAnnouncementText(announcement: StageAnnouncement): String? = when (announcement.kind) {
    TileFeaturePolicy.pinnedKind -> conclaveString("stg_announce_pinned", announcement.name)
    TileFeaturePolicy.pinClearedKind -> conclaveString("stg_announce_pin_cleared", announcement.name)
    else -> null
}
