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

internal class StageTileMenu(
    val context: TileMenuContext,
    val sections: List<MenuSectionModel>,
    val actionItems: List<MenuItemModel>,
    val titles: TileMenuTitles? = null,
    val extra: List<MenuSectionModel> = emptyList(),
) {

    val hasItems: Boolean get() = sections.isNotEmpty()

    val isPeopleCandidate: Boolean
        get() = TileMenuPolicy.hasMenu(slotId = context.slotId, role = context.role, kind = context.kind)

    fun withPeople(people: List<MenuSectionModel>): List<MenuSectionModel> {
        val menuTitles = titles ?: return sections
        if (people.isEmpty()) return sections
        return TileMenuPolicy.sections(context, titles = menuTitles, people = skip.lib.Array(people + extra)).toList()
    }
}

internal fun tilePeopleSections(context: Context, menuContext: TileMenuContext, stage: StagePresenter): List<MenuSectionModel> {
    if (!TileMenuPolicy.hasMenu(slotId = menuContext.slotId, role = menuContext.role, kind = menuContext.kind)) return emptyList()
    val people = stage.people ?: return emptyList()
    if (!people.rows.contains(menuContext.userId)) return emptyList()
    val row = people.rows.entry(menuContext.userId).model
    val actions = PeopleActionPolicy.tileActions(row.actions)
    if (actions.isEmpty) return emptyList()
    return PeopleActionPolicy.menuSections(actions, titles = peopleActionTitlesOf(context, peopleRowName(context, row))).toList()
}

internal fun tilePeoplePerform(itemId: String, menuContext: TileMenuContext, stage: StagePresenter): Boolean {
    val action = PersonActionID.init(rawValue = itemId) ?: return false
    val people = stage.people ?: return false
    return people.perform(action, rowId = menuContext.userId, source = PeopleActionSource.tileMenu) == ControlTapResult.dispatched
}

internal fun tileMenuPerform(itemId: String, menuContext: TileMenuContext, stage: StagePresenter) {
    if (!TileMenuDispatcher.perform(itemId, context = menuContext, stage = stage)) {
        tilePeoplePerform(itemId, menuContext, stage)
    }
}

internal fun stageTileMenu(slot: StageSlot, model: TileChromeModel, kind: StageKind, titles: TileMenuTitles,
                           people: List<MenuSectionModel> = emptyList()): StageTileMenu {
    val context = TileMenuContext.make(slot = slot, model = model, kind = kind, canFlipCamera = false, offersFlipItem = false)
    val sections = TileMenuPolicy.sections(context, titles = titles, people = skip.lib.Array(people)).toList()
    val items = TileMenuPolicy.accessibilityItems(skip.lib.Array(sections)).toList()
    return StageTileMenu(context, sections, items, titles, people)
}

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

@Composable
internal fun TileMenuAnchor(state: TileMenuState, menu: StageTileMenu, stage: StagePresenter, identifier: String, modifier: Modifier = Modifier) {
    val open = state.expanded
    DisposableEffect(open) {
        if (open) stage.setTransientChrome(id = TileMenuPolicy.menuTransientId, open = true)
        onDispose {
            if (open) stage.setTransientChrome(id = TileMenuPolicy.menuTransientId, open = false)
        }
    }

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

@Composable
internal fun tileAnnouncementText(announcement: StageAnnouncement): String? = when (announcement.kind) {
    TileFeaturePolicy.pinnedKind -> conclaveString("stg_announce_pinned", announcement.name)
    TileFeaturePolicy.pinClearedKind -> conclaveString("stg_announce_pin_cleared", announcement.name)
    else -> peopleAnnouncementText(announcement)
}
