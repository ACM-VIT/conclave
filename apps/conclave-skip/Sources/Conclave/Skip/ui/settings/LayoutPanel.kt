package conclave.module

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import java.util.Locale
import kotlin.math.roundToInt

/*
 * S60 3 d (SET-5) on Android: MeetingPanel.layout, always in the in-call theme (owner default Q8 6). In compact and
 * medium windows it is the WP1-3c bottom sheet (NativePanelHost + LayoutSheetHost), opening partially expanded with the
 * live controls first: the title row, the four mode radio rows and Maximum tiles fill the partial state (about 396 dp on
 * the 360 x 800 dp AVD, so the upper half of the stage stays visible above the M3 scrim and its reflow can be watched),
 * then the footers, Hide tiles, Self view, Position and Audio only in the expanded state. In the expanded side pane it is
 * an InCallPage in lazyList mode beside the stage with the same list. Radio rows sit in selectable groups and play
 * selectionChanged only for a dispatched choice (D8, 3 h); Maximum tiles is the stable M3 Slider (range semantics,
 * TalkBack adjust, each distinct value written once, no haptic per step). Registered by the native call root.
 */

@Composable
internal fun LayoutPage(
    layout: LayoutPanelPresenter,
    variant: InCallPageVariant,
    appearance: PanelAppearance,
    miniTile: CallMiniTileModel?,
    onClose: () -> Unit,
    onMounted: () -> Unit,
    onDisposed: () -> Unit,
    miniTileVideo: (@Composable () -> Unit)? = null,
) {
    val title = conclaveString("lay_title")
    if (variant == InCallPageVariant.Sheet) {
        // The sheet variant: the host's ModalBottomSheet frames it; the page acknowledges when it disposes (C3).
        DisposableEffect(Unit) {
            onMounted()
            onDispose { onDisposed() }
        }
        Column(Modifier.fillMaxWidth().testTag("layout.sheet").semantics { paneTitle = title }) {
            Box(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 24.dp), contentAlignment = Alignment.CenterStart) {
                ConclaveText(title, line = "layout.title", style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.testTag("panel.title").semantics { heading() })
            }
            LayoutList(layout, PaddingValues(bottom = 16.dp), MaterialTheme.colorScheme.surfaceContainerLow)
        }
        return
    }
    InCallPage(
        title = title,
        variant = variant,
        appearance = appearance,
        hasComposer = false,
        miniTile = miniTile,
        onClose = onClose,
        onMounted = onMounted,
        onDisposed = onDisposed,
        miniTileVideo = miniTileVideo,
        contentMode = InCallPageContent.lazyList,
    ) { reservation ->
        LayoutList(layout, reservation, MaterialTheme.colorScheme.surface)
    }
}

/** One radio row of a group: the title, an optional detail (Auto while pinned) or reason line, and its enabled state. */
internal data class LayoutRadioOption(val id: String, val title: String, val detail: String?, val enabled: Boolean)

/** The one list both hosts draw (3 d order). Reads only `layout.snapshot` (3 k). */
@Composable
internal fun LayoutList(layout: LayoutPanelPresenter, contentPadding: PaddingValues, containerColor: Color) {
    val snapshot = layout.snapshot
    val haptics = rememberConclaveHaptics()
    val pinnedDetail = conclaveString("lay_auto_pinned")
    // Plain loops: a transpiled array's own `map` is not inline, so it cannot call composables (string lookups).
    val modes = mutableListOf<LayoutRadioOption>()
    for (mode in snapshot.modes) {
        val reason = LayoutCopy.reasonName(mode.reason)
        modes.add(LayoutRadioOption(
            id = mode.id,
            title = conclaveString(LayoutCopy.modeName(mode.id)),
            detail = if (reason != null) conclaveString(reason) else if (mode.id == "auto" && snapshot.isPinActive) pinnedDetail else null,
            enabled = mode.isEnabled,
        ))
    }
    val selfModes = mutableListOf<LayoutRadioOption>()
    for (id in LayoutPanelPolicy.selfModeIds) {
        selfModes.add(LayoutRadioOption(id = id, title = conclaveString(LayoutCopy.selfModeName(id)), detail = null, enabled = true))
    }
    val corners = mutableListOf<LayoutRadioOption>()
    for (id in LayoutPanelPolicy.cornerIds) {
        corners.add(LayoutRadioOption(id = id, title = conclaveString(LayoutCopy.cornerName(id)), detail = null, enabled = true))
    }
    val onlyYou = conclaveString("lay_only_you")
    val phoneCap = if (snapshot.phoneCap > 0) conclavePlural("lay_phone_tile_cap", snapshot.phoneCap, snapshot.phoneCap) else null
    val speakingPinned = conclaveString("lay_speaking_pinned")
    val selfViewTitle = conclaveString("lay_self_view")
    val positionTitle = conclaveString("lay_position")
    LazyColumn(Modifier.fillMaxSize().testTag("layout.list"), contentPadding = contentPadding) {
        item(key = "modes") {
            LayoutRadioRows(modes, snapshot.mode, "layout.mode", containerColor) { id ->
                if (layout.setViewMode(id) == ControlTapResult.dispatched) haptics.gesture(FeedbackKind.selectionChanged)
            }
        }
        item(key = "maxTiles") {
            LayoutMaxTilesItem(layout, snapshot.maxTiles, containerColor)
        }
        item(key = "footers") {
            Column {
                ConclaveSectionFooter(onlyYou, "layout.footer.onlyYou")
                if (phoneCap != null) ConclaveSectionFooter(phoneCap, "layout.footer.phoneCap")
                ConclaveSectionFooter(speakingPinned, "layout.footer.speaking")
            }
        }
        item(key = "hideVideoOff") {
            LayoutSwitchItem(conclaveString("lay_hide_video_off"), null, snapshot.hideTilesWithoutVideo, "layout.hideVideoOff",
                containerColor) { on -> layout.setHideTilesWithoutVideo(on) }
        }
        item(key = "selfView") {
            Column {
                ConclaveSectionHeader(selfViewTitle, "layout.selfView.header")
                LayoutRadioRows(selfModes, snapshot.selfMode, "layout.selfMode", containerColor) { id ->
                    if (layout.setSelfViewMode(id) == ControlTapResult.dispatched) haptics.gesture(FeedbackKind.selectionChanged)
                }
            }
        }
        if (snapshot.showsPosition) {
            item(key = "position") {
                Column {
                    ConclaveSectionHeader(positionTitle, "layout.position.header")
                    LayoutRadioRows(corners, snapshot.selfCorner, "layout.position", containerColor) { id ->
                        if (layout.setSelfViewCorner(id) == ControlTapResult.dispatched) haptics.gesture(FeedbackKind.selectionChanged)
                    }
                }
            }
        }
        item(key = "audioOnly") {
            LayoutSwitchItem(conclaveString("lay_audio_only"), conclaveString("lay_audio_only_detail"), snapshot.isAudioOnly,
                "layout.audioOnly", containerColor) { on -> layout.setAudioOnly(on) }
        }
    }
}

/** Radio rows in one selectable group (3 d, i): the row is the one clickable node with the radio role. */
@Composable
private fun LayoutRadioRows(
    options: List<LayoutRadioOption>, selectedId: String, identifier: String, containerColor: Color, onSelect: (String) -> Unit,
) {
    Column(Modifier.fillMaxWidth().testTag(identifier).selectableGroup()) {
        for (option in options) {
            val selected = option.id == selectedId
            val detail = option.detail
            ListItem(
                headlineContent = { ConclaveText(option.title, line = "$identifier.${option.id}") },
                supportingContent = if (detail == null) null else {
                    { ConclaveText(detail, line = "$identifier.${option.id}.detail") }
                },
                leadingContent = { RadioButton(selected = selected, onClick = null, enabled = option.enabled) },
                colors = ListItemDefaults.colors(containerColor = containerColor),
                modifier = Modifier.heightIn(min = 56.dp).testTag("$identifier.${option.id}")
                    .selectable(selected = selected, enabled = option.enabled, role = Role.RadioButton) { onSelect(option.id) },
            )
        }
    }
}

/**
 * Maximum tiles (3 d): the headline, the tabular value and the stable Slider over 2 to 49 with 46 steps. A drag writes
 * each distinct rounded value once (the presenter ignores repeats); no haptic per step (AND 13.3).
 */
@Composable
private fun LayoutMaxTilesItem(layout: LayoutPanelPresenter, value: Int, containerColor: Color) {
    val title = conclaveString("lay_max_tiles")
    val tabular = rememberTabular(MaterialTheme.typography.bodyLarge)
    ListItem(
        headlineContent = { ConclaveText(title, line = "layout.maxTiles.title") },
        trailingContent = {
            ConclaveText(String.format(Locale.getDefault(), "%d", value), line = "layout.maxTiles.value", style = tabular)
        },
        supportingContent = {
            Slider(
                value = value.toFloat(),
                onValueChange = { raw ->
                    val next = raw.roundToInt()
                    if (next != value) layout.setMaxTiles(next)
                },
                valueRange = LayoutPanelPolicy.minimumTiles.toFloat()..LayoutPanelPolicy.maximumTiles.toFloat(),
                steps = LayoutPanelPolicy.sliderSteps,
                modifier = Modifier.testTag("layout.maxTiles.slider").semantics { contentDescription = title },
            )
        },
        colors = ListItemDefaults.colors(containerColor = containerColor),
        modifier = Modifier.testTag("layout.maxTiles"),
    )
}

/** A switch row: one Switch node for the whole row (the Switch itself takes no clicks); no haptic (D8). */
@Composable
private fun LayoutSwitchItem(
    title: String, detail: String?, checked: Boolean, identifier: String, containerColor: Color, onChange: (Boolean) -> Unit,
) {
    ListItem(
        headlineContent = { ConclaveText(title, line = "$identifier.title") },
        supportingContent = if (detail == null) null else { { ConclaveText(detail, line = "$identifier.detail") } },
        trailingContent = { Switch(checked = checked, onCheckedChange = null) },
        colors = ListItemDefaults.colors(containerColor = containerColor),
        modifier = Modifier.heightIn(min = 56.dp).testTag(identifier)
            .toggleable(value = checked, role = Role.Switch, onValueChange = onChange),
    )
}

/**
 * L6-14 for the Layout panel on Android (Material sentence case, Q13): every mode, self view mode, corner and reason to
 * its `lay_` resource name. The S60 copy table names `K/ui/copy/SettingsCopy.kt`; that file belongs to SET-3 this batch,
 * so the Layout half lives here (HD record B7-T2).
 */
internal object LayoutCopy {
    fun modeName(id: String): String = when (id) {
        "tiled" -> "lay_tiled"
        "spotlight" -> "lay_spotlight"
        "sidebar" -> "lay_sidebar"
        else -> "lay_auto"
    }

    fun selfModeName(id: String): String = when (id) {
        "tile" -> "lay_self_tile"
        "floating" -> "lay_self_floating"
        "minimized" -> "lay_self_minimized"
        else -> "lay_self_auto"
    }

    fun cornerName(id: String): String = when (id) {
        "top-left" -> "lay_top_left"
        "top-right" -> "lay_top_right"
        "bottom-left" -> "lay_bottom_left"
        else -> "lay_bottom_right"
    }

    /** null while the mode is enabled. */
    fun reasonName(raw: String): String? = when (LayoutModeReason.init(rawValue = raw) ?: LayoutModeReason.none) {
        LayoutModeReason.none -> null
        LayoutModeReason.attendee -> "lay_reason_attendee"
    }
}
