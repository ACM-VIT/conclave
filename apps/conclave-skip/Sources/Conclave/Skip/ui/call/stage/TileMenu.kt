package conclave.module

import android.content.Context
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt
import skip.foundation.ProcessInfo

/*
 * STG-2 (S20 3 d, f, g; F00 C16; RECONCILE R19): the Android tile menu. A long press opens the F00 C16 DropdownMenu
 * at the press point with one `longPress` haptic; TalkBack reaches the same items as custom actions on the tile node
 * and opens the menu through the long-click action "Show actions". Unavailable items stay, disabled, with their
 * reason (R10; the iOS context menu hides them instead). Items come from the shared TileMenuPolicy and dispatch through
 * the shared TileMenuDispatcher. PPL-2 (RECONCILE R19): the people items are the S50 PeopleActionPolicy items for that
 * person minus Admit and Deny, with the S50 3 g `ppl_` copy, read from the session's PeoplePresenter (`stage.people`)
 * when the menu opens (so the open menu follows that person's row) and performed with source `tileMenu`; confirmations
 * show over the stage in the in-call theme and failures use the stage toast lane (PL14). Extra sections (STG-3's Move
 * items) come after them, Move last. The menu composes only while expanded (F00 C16 k) and reports itself open so
 * chrome never hides under it (S30 CC16).
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

/**
 * One tile's menu: the shared context, every stage and extra section (Android keeps disabled items) and the actionable
 * items. The people sections are added when the menu opens or its actions are built ([withPeople]), from [titles] and
 * [extra] kept here.
 */
internal class StageTileMenu(
    val context: TileMenuContext,
    val sections: List<MenuSectionModel>,
    val actionItems: List<MenuItemModel>,
    val titles: TileMenuTitles? = null,
    val extra: List<MenuSectionModel> = emptyList(),
) {
    /** STG-2's rule, unchanged: the long press opens only a tile with a stage item (every remote participant tile). */
    val hasItems: Boolean get() = sections.isNotEmpty()

    /** A participant tile, whose menu also lists that person's people items. */
    val isPeopleCandidate: Boolean
        get() = TileMenuPolicy.hasMenu(slotId = context.slotId, role = context.role, kind = context.kind)

    /** The full sections with the people items for this person (R19): stage, people, then extra (Move last). */
    fun withPeople(people: List<MenuSectionModel>): List<MenuSectionModel> {
        val menuTitles = titles ?: return sections
        if (people.isEmpty()) return sections
        return TileMenuPolicy.sections(context, titles = menuTitles, people = skip.lib.Array(people + extra)).toList()
    }
}

/**
 * The people sections for the tile's person (RECONCILE R19): the row's action table minus Admit and Deny, titled with
 * the S50 3 g `ppl_` copy; S20 keeps Pin, so `TileMenuPolicy.sections` drops the people Pin and Unpin. Reading the row
 * entry inside composition ties the open menu to that person's row.
 */
internal fun tilePeopleSections(context: Context, menuContext: TileMenuContext, stage: StagePresenter): List<MenuSectionModel> {
    if (!TileMenuPolicy.hasMenu(slotId = menuContext.slotId, role = menuContext.role, kind = menuContext.kind)) return emptyList()
    val people = stage.people ?: return emptyList()
    if (!people.rows.contains(menuContext.userId)) return emptyList()
    val row = people.rows.entry(menuContext.userId).model
    val actions = PeopleActionPolicy.tileActions(row.actions)
    if (actions.isEmpty) return emptyList()
    return PeopleActionPolicy.menuSections(actions, titles = peopleActionTitlesOf(context, peopleRowName(context, row))).toList()
}

/** Performs a people item with source `tileMenu` (S50 3 a, 3 j); false when the id is not a people item. */
internal fun tilePeoplePerform(itemId: String, menuContext: TileMenuContext, stage: StagePresenter): Boolean {
    val action = PersonActionID.init(rawValue = itemId) ?: return false
    val people = stage.people ?: return false
    return people.perform(action, rowId = menuContext.userId, source = PeopleActionSource.tileMenu) == ControlTapResult.dispatched
}

/** Stage items first (TileMenuDispatcher), then the people items. */
internal fun tileMenuPerform(itemId: String, menuContext: TileMenuContext, stage: StagePresenter) {
    if (!TileMenuDispatcher.perform(itemId, context = menuContext, stage = stage)) {
        tilePeoplePerform(itemId, menuContext, stage)
    }
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
    return StageTileMenu(context, sections, items, titles, people)
}

/**
 * The same items as TalkBack custom actions on the tile node (S20 3 d, i), people items included in menu order. Built
 * outside composition, so the people titles resolve through the application context; a stale item after a row change
 * is refused by `PeoplePresenter.perform` (it re-reads the row's current actions).
 */
internal fun stageTileActions(menu: StageTileMenu, stage: StagePresenter): List<ConclaveTileAction> {
    val people = if (menu.isPeopleCandidate && stage.people != null) {
        tilePeopleSections(ProcessInfo.processInfo.androidContext, menu.context, stage)
    } else {
        emptyList()
    }
    val items = if (people.isEmpty()) menu.actionItems
        else TileMenuPolicy.accessibilityItems(skip.lib.Array(menu.withPeople(people))).toList()
    val result = mutableListOf<ConclaveTileAction>()
    for (item in items) {
        val id = item.id
        result.add(ConclaveTileAction(id, item.title) { tileMenuPerform(id, menu.context, stage) })
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
    // The people items are read only while the menu is open (F00 C16 k), so a closed menu never observes the row.
    val context = LocalContext.current
    val sections = if (open && menu.isPeopleCandidate) menu.withPeople(tilePeopleSections(context, menu.context, stage)) else menu.sections
    Box(modifier.absoluteOffset { IntOffset(state.anchor.x.roundToInt(), state.anchor.y.roundToInt()) }.size(0.dp)) {
        ConclaveDropdownMenu(
            expanded = open,
            onDismissRequest = { state.dismiss() },
            sections = sections,
            identifier = identifier,
            onSelect = { item ->
                state.dismiss()
                tileMenuPerform(item.id, menu.context, stage)
            },
        )
    }
}

/**
 * The pin announcements' words (S20 4 g) and the S50 people and host results (kind `peopleResult`, S50 3 i, 6 f, 8 i)
 * for the stage's one live region (CallRoot falls back to this).
 */
@Composable
internal fun tileAnnouncementText(announcement: StageAnnouncement): String? = when (announcement.kind) {
    TileFeaturePolicy.pinnedKind -> conclaveString("stg_announce_pinned", announcement.name)
    TileFeaturePolicy.pinClearedKind -> conclaveString("stg_announce_pin_cleared", announcement.name)
    else -> peopleAnnouncementText(announcement)
}
