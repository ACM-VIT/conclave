package conclave.module

import android.app.UiModeManager
import android.content.Context
import android.database.ContentObserver
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.HapticFeedbackConstants
import androidx.annotation.RequiresApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.util.Locale

/*
 * Debug-only component gallery for the hosting preview (TG 4.1): typography, haptic and contrast self-checks
 * as flat lazy items with stable keys, never a nested scrolling list. Rows come from cached immutable DTOs
 * built once from the shared catalog and contract (R14). It is inert: no call, media, socket, route,
 * permission or session effect, and no animation or effect loop, so idle frames stay quiet. Haptic specimens
 * use the gesture route without a view, so a tap records the decision and nothing reaches the hardware.
 * Strings are Android string resources in sentence case (owner decisions Q13 and Q14).
 */

internal data class NativeGalleryTypeRow(val id: String, val style: ConclaveTextStyle, val weight: ConclaveTextWeight)

internal data class NativeGalleryHapticRow(
    val id: String, val kind: FeedbackKind, val gesture: Boolean, val constant: String, val contract: String,
)

internal data class NativeGalleryContrastRow(
    val id: String, val caption: String, val foreground: Long, val background: Long,
    val requirement: ContrastRequirement, val expected: Double, val ratio: Double,
)

/** A theme role pair resolved live in both columns; `caption` is a string resource name. */
internal class NativeGalleryLiveRole(
    val name: String, val caption: String, val foreground: (ColorScheme) -> Color, val background: (ColorScheme) -> Color,
)

internal val nativeGalleryLiveRoles: List<NativeGalleryLiveRole> = listOf(
    NativeGalleryLiveRole("onPrimary", "native_gallery_live_on_primary", { it.onPrimary }, { it.primary }),
    NativeGalleryLiveRole("onPrimaryContainer", "native_gallery_live_on_primary_container", { it.onPrimaryContainer }, { it.primaryContainer }),
    NativeGalleryLiveRole("primary", "native_gallery_live_primary", { it.primary }, { it.surface }),
    NativeGalleryLiveRole("onSurface", "native_gallery_live_on_surface", { it.onSurface }, { it.surface }),
    NativeGalleryLiveRole("onSurfaceVariant", "native_gallery_live_on_surface_variant", { it.onSurfaceVariant }, { it.surface }),
    NativeGalleryLiveRole("onSecondaryContainer", "native_gallery_live_on_secondary_container",
        { it.onSecondaryContainer }, { it.secondaryContainer }),
    NativeGalleryLiveRole("error", "native_gallery_live_error", { it.error }, { it.surface }),
)

/** One snapshot per API level. Gesture rows come first, then outcomes, each in contract order. */
internal class NativeComponentGalleryRows(val api: Int) {
    val type: List<NativeGalleryTypeRow> = buildList {
        for (style in ConclaveTextStyle.values()) {
            for (weight in ConclaveTextWeight.values()) {
                add(NativeGalleryTypeRow(ComponentGalleryCatalog.typeSpecimenID(style, weight), style, weight))
            }
        }
    }
    val haptics: List<NativeGalleryHapticRow> = buildList {
        for (gesture in listOf(true, false)) {
            for (row in FeedbackHapticContract.rows) {
                if (row.kind.isAsyncOutcome == gesture) continue
                add(NativeGalleryHapticRow(ComponentGalleryCatalog.hapticSpecimenID(row.kind), row.kind, gesture,
                    hapticConstantName(ConclaveHaptics.constant(row.kind, api)), FeedbackHapticContract.android(row.kind, api)))
            }
        }
    }
    val gestureCount: Int = haptics.count { it.gesture }
    val contrast: List<NativeGalleryContrastRow> = buildList {
        for (pair in ComponentGalleryCatalog.contrastPairs) {
            add(NativeGalleryContrastRow(pair.id, pair.caption, pair.foreground, pair.background,
                pair.requirement, pair.expectedRatio, pair.ratio))
        }
    }

    /** Every specimen with a clipping probe on its main text, so the readout can show coverage. */
    val specimenIDs: Set<String> = buildSet {
        for (row in type) add(row.id)
        for (row in haptics) add(row.id)
        for (row in contrast) add(row.id)
        for (inCall in listOf(false, true)) {
            for (role in nativeGalleryLiveRoles) add(ComponentGalleryCatalog.liveContrastID(role.name, inCall = inCall))
        }
    }

    /** The live mapper against the contract at this API. */
    fun hapticMatches(): Int = haptics.count { hapticConstantName(ConclaveHaptics.constant(it.kind, api)) == it.contract }
}

/** One cache per preview lifetime: repeated reads return the identical snapshot. */
internal class NativeComponentGalleryRowsCache(private val api: Int = Build.VERSION.SDK_INT) {
    private var cached: NativeComponentGalleryRows? = null

    fun current(): NativeComponentGalleryRows = cached ?: NativeComponentGalleryRows(api).also { cached = it }
}

/** Names of the constants the mapper returns, as the contract spells them. */
internal fun hapticConstantName(constant: Int?): String = when (constant) {
    null -> "none"
    HapticFeedbackConstants.LONG_PRESS -> "LONG_PRESS"
    HapticFeedbackConstants.VIRTUAL_KEY -> "VIRTUAL_KEY"
    HapticFeedbackConstants.CLOCK_TICK -> "CLOCK_TICK"
    HapticFeedbackConstants.CONTEXT_CLICK -> "CONTEXT_CLICK"
    HapticFeedbackConstants.GESTURE_END -> "GESTURE_END"
    HapticFeedbackConstants.CONFIRM -> "CONFIRM"
    HapticFeedbackConstants.REJECT -> "REJECT"
    HapticFeedbackConstants.TOGGLE_ON -> "TOGGLE_ON"
    HapticFeedbackConstants.TOGGLE_OFF -> "TOGGLE_OFF"
    HapticFeedbackConstants.GESTURE_THRESHOLD_ACTIVATE -> "GESTURE_THRESHOLD_ACTIVATE"
    HapticFeedbackConstants.SEGMENT_TICK -> "SEGMENT_TICK"
    else -> String.format(Locale.ROOT, "UNKNOWN_%d", constant)
}

/**
 * Clipped and measured specimens, both counted over the same specimen set. A text line counts for the specimen
 * it is reported for (a clipped caption or verdict counts against its row); text outside a specimen is never
 * reported. Clipping is `TextLayoutResult.hasVisualOverflow`. A measurement belongs to one layout configuration
 * (`nativeGalleryConfigurationKey`); measurements from another configuration never count. A specimen keeps its
 * last measurement while its item is scrolled away or its section is collapsed, so scrolling back up to read
 * the count cannot hide a clipped specimen. "No clipped text" means 0 with every specimen measured. Writes
 * happen only when a line's state really changes.
 */
internal class NativeGalleryOverflow {
    // "configuration|line" to the specimen the line belongs to.
    private val clipped = mutableStateMapOf<String, String>()
    private val measured = mutableStateMapOf<String, String>()

    /** Specimens in `specimens` with a clipped line in this configuration. */
    fun count(configuration: String, specimens: Set<String>): Int = specimensIn(clipped, configuration, specimens)

    /** Specimens in `specimens` measured in this configuration; 0 clipped means something only at full coverage. */
    fun measuredCount(configuration: String, specimens: Set<String>): Int = specimensIn(measured, configuration, specimens)

    fun report(configuration: String, specimen: String, line: String, overflow: Boolean) {
        val key = "$configuration|$line"
        if (measured[key] != specimen) measured[key] = specimen
        if (overflow) {
            if (clipped[key] != specimen) clipped[key] = specimen
        } else if (clipped.containsKey(key)) {
            clipped.remove(key)
        }
    }

    private fun specimensIn(lines: Map<String, String>, configuration: String, specimens: Set<String>): Int {
        val prefix = "$configuration|"
        return lines.entries.filter { it.key.startsWith(prefix) && it.value in specimens }.map { it.value }.toSet().size
    }
}

/**
 * What a measurement is filed under: every setting that changes text layout while the activity keeps running.
 * The activity handles font scale, density, Bold Text (font weight adjustment), locale and layout direction
 * itself (`configChanges` in AndroidManifest.xml), so none of them recreates the gallery state. Numbers, the
 * language tag and the enum name print the same in every locale.
 */
internal fun nativeGalleryConfigurationKey(
    fontScale: Float, density: Float, widthDp: Int, fontWeightAdjustment: Int, localeTag: String,
    layoutDirection: LayoutDirection, longText: Boolean,
): String = listOf(fontScale, density, widthDp, fontWeightAdjustment, localeTag, layoutDirection.name, longText)
    .joinToString(",")

@Composable
private fun galleryConfiguration(state: NativeComponentGalleryState): String {
    val density = LocalDensity.current
    val configuration = LocalConfiguration.current
    return nativeGalleryConfigurationKey(
        fontScale = density.fontScale, density = density.density, widthDp = configuration.screenWidthDp,
        fontWeightAdjustment = if (Build.VERSION.SDK_INT >= 31) configuration.fontWeightAdjustment else 0,
        localeTag = configuration.locales[0].toLanguageTag(), layoutDirection = LocalLayoutDirection.current,
        longText = state.longText,
    )
}

/** Counts that scripts parse print ASCII digits in every locale (TG 4.1). A `%d` in a string resource follows
 *  the per-app locale, which writes Arabic-Indic digits for ar-EG; `Int.toString` never localizes. */
internal fun asciiCount(value: Int): String = value.toString()

private const val HIGH_TEXT_CONTRAST = "high_text_contrast_enabled"

/** The header's contrast settings: the contrast level (API 34 and later, else null) and high contrast text. */
internal data class NativeGalleryContrast(val level: Float?, val highTextContrast: Boolean) {
    companion object {
        fun read(context: Context): NativeGalleryContrast = NativeGalleryContrast(
            level = if (Build.VERSION.SDK_INT >= 34) GalleryContrastApi34.level(context) else null,
            highTextContrast = Settings.Secure.getInt(context.contentResolver, HIGH_TEXT_CONTRAST, 0) == 1,
        )
    }
}

/**
 * Neither contrast setting is a configuration change, so the header would keep a stale value after a change made
 * while the preview is open or in the background. The watcher re-reads both on every change of high contrast
 * text (ContentObserver) or, from API 34, of the contrast level (contrast change listener); the gallery also
 * calls `refresh` on ON_RESUME, the way `rememberReduceMotion` does.
 */
internal class NativeGalleryContrastWatcher(private val context: Context, private val onChange: (NativeGalleryContrast) -> Unit) {
    private val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) = refresh()
    }
    private var stopListening: (() -> Unit)? = null

    fun refresh() = onChange(NativeGalleryContrast.read(context))

    fun start() {
        context.contentResolver.registerContentObserver(Settings.Secure.getUriFor(HIGH_TEXT_CONTRAST), false, observer)
        if (Build.VERSION.SDK_INT >= 34) stopListening = GalleryContrastApi34.listen(context) { refresh() }
    }

    fun stop() {
        context.contentResolver.unregisterContentObserver(observer)
        stopListening?.invoke()
        stopListening = null
    }
}

/** API 34 calls in their own class, so older devices never load the listener interface. */
@RequiresApi(34)
private object GalleryContrastApi34 {
    fun level(context: Context): Float? = context.getSystemService(UiModeManager::class.java)?.contrast

    fun listen(context: Context, onChange: () -> Unit): () -> Unit {
        val manager = context.getSystemService(UiModeManager::class.java) ?: return {}
        val listener = UiModeManager.ContrastChangeListener { onChange() }
        manager.addContrastChangeListener(context.mainExecutor, listener)
        return { manager.removeContrastChangeListener(listener) }
    }
}

@Composable
private fun rememberGalleryContrast(): NativeGalleryContrast {
    val context = LocalContext.current.applicationContext
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var contrast by remember(context) { mutableStateOf(NativeGalleryContrast.read(context)) }
    DisposableEffect(context, lifecycle) {
        val watcher = NativeGalleryContrastWatcher(context) { contrast = it }
        val resumed = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) watcher.refresh()
        }
        watcher.start()
        lifecycle.addObserver(resumed)
        onDispose {
            lifecycle.removeObserver(resumed)
            watcher.stop()
        }
    }
    return contrast
}

internal class NativeComponentGalleryState {
    val rows = NativeComponentGalleryRowsCache()
    val overflow = NativeGalleryOverflow()
    var typeExpanded by mutableStateOf(false)
    var hapticsExpanded by mutableStateOf(false)
    var contrastExpanded by mutableStateOf(false)
    var longText by mutableStateOf(false)
    var verified by mutableStateOf<Int?>(null)
    var recorded by mutableIntStateOf(0)
        private set
    var outcomeRoute by mutableIntStateOf(0)
        private set
    var silent by mutableIntStateOf(0)
        private set
    var lastTap by mutableStateOf<Pair<FeedbackKind, GestureHapticDecision>?>(null)
        private set

    fun isExpanded(section: GallerySection): Boolean = when (section) {
        GallerySection.typography -> typeExpanded
        GallerySection.haptics -> hapticsExpanded
        GallerySection.contrast -> contrastExpanded
        GallerySection.systemProminent -> false
    }

    fun toggle(section: GallerySection) {
        when (section) {
            GallerySection.typography -> typeExpanded = !typeExpanded
            GallerySection.haptics -> hapticsExpanded = !hapticsExpanded
            GallerySection.contrast -> contrastExpanded = !contrastExpanded
            GallerySection.systemProminent -> Unit
        }
    }

    fun record(kind: FeedbackKind, decision: GestureHapticDecision) {
        when (decision) {
            GestureHapticDecision.Played, GestureHapticDecision.Recorded -> recorded++
            GestureHapticDecision.OutcomeRoute -> outcomeRoute++
            GestureHapticDecision.Silent -> silent++
        }
        lastTap = kind to decision
    }

    fun text(value: String): String = if (longText) ComponentGalleryCatalog.expanded(value) else value

    companion object {
        val Saver: Saver<NativeComponentGalleryState, Any> = listSaver<NativeComponentGalleryState, Boolean>(
            save = { listOf(it.typeExpanded, it.hapticsExpanded, it.contrastExpanded, it.longText) },
            restore = { saved ->
                NativeComponentGalleryState().apply {
                    typeExpanded = saved[0]
                    hapticsExpanded = saved[1]
                    contrastExpanded = saved[2]
                    longText = saved[3]
                }
            },
        )
    }
}

@Composable
internal fun rememberNativeComponentGalleryState(): NativeComponentGalleryState =
    rememberSaveable(saver = NativeComponentGalleryState.Saver) { NativeComponentGalleryState() }

@Composable
internal fun NativeComponentGalleryToggle(expanded: Boolean, onExpandedChange: (Boolean) -> Unit) {
    val state = if (expanded) conclaveString("native_gallery_expanded") else conclaveString("native_gallery_collapsed")
    TextButton(onClick = { onExpandedChange(!expanded) },
        modifier = Modifier.heightIn(min = 48.dp).testTag(ComponentGalleryCatalog.galleryToggleID)
            .semantics { stateDescription = state }) {
        Text(if (expanded) conclaveString("native_gallery_hide") else conclaveString("native_gallery_show"))
    }
}

/** Emits nothing while collapsed. Sections emit their rows only while expanded. */
internal fun LazyListScope.nativeComponentGalleryItems(expanded: Boolean, state: NativeComponentGalleryState) {
    if (!expanded) return
    val rows = state.rows.current()
    item(key = ComponentGalleryCatalog.environmentID) { GalleryEnvironment(rows, state) }
    item(key = ComponentGalleryCatalog.longTextToggleID) { GalleryLongTextToggle(state) }
    item(key = ComponentGalleryCatalog.sectionID(GallerySection.typography)) { GallerySectionToggle(GallerySection.typography, state) }
    if (state.typeExpanded) {
        items(count = rows.type.size, key = { rows.type[it].id }) { index -> GalleryTypeRow(rows.type[index], state) }
    }
    item(key = ComponentGalleryCatalog.sectionID(GallerySection.haptics)) { GallerySectionToggle(GallerySection.haptics, state) }
    if (state.hapticsExpanded) {
        item(key = ComponentGalleryCatalog.hapticVerifyID) { GalleryHapticControls(rows, state) }
        items(count = rows.haptics.size, key = { rows.haptics[it].id }) { index ->
            GalleryHapticRow(rows.haptics[index], first = index == 0 || index == rows.gestureCount, state)
        }
    }
    item(key = ComponentGalleryCatalog.sectionID(GallerySection.contrast)) { GallerySectionToggle(GallerySection.contrast, state) }
    if (state.contrastExpanded) {
        item(key = ComponentGalleryCatalog.columnID("contrast.live", inCall = false)) { GalleryLiveContrast(inCall = false, state) }
        item(key = ComponentGalleryCatalog.columnID("contrast.live", inCall = true)) { GalleryLiveContrast(inCall = true, state) }
        items(count = rows.contrast.size, key = { rows.contrast[it].id }) { index -> GalleryContrastRow(rows.contrast[index], state) }
    }
}

/** Gallery text. A line of a specimen reports its clipping for that specimen; other text is not counted. */
@Composable
private fun GalleryText(
    text: String, state: NativeComponentGalleryState, modifier: Modifier = Modifier,
    style: TextStyle = MaterialTheme.typography.bodyMedium, color: Color = Color.Unspecified,
    specimen: String? = null, line: String? = specimen,
) {
    if (specimen == null || line == null) {
        Text(text, modifier = modifier, style = style, color = color)
        return
    }
    val configuration = galleryConfiguration(state)
    Text(text, modifier = modifier, style = style, color = color,
        onTextLayout = { state.overflow.report(configuration, specimen, line, it.hasVisualOverflow) })
}

@Composable
private fun GalleryEnvironment(rows: NativeComponentGalleryRows, state: NativeComponentGalleryState) {
    val density = LocalDensity.current
    val reduceMotion = rememberReduceMotion()
    val contrast = rememberGalleryContrast()
    val on = conclaveString("native_gallery_on")
    val off = conclaveString("native_gallery_off")
    val contrastLevel = contrast.level?.let { String.format(Locale.getDefault(), "%.1f", it) }
    Column(Modifier.fillMaxWidth().testTag(ComponentGalleryCatalog.environmentID).padding(vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(conclaveString("native_gallery_title"), style = MaterialTheme.typography.titleSmall,
            modifier = Modifier.semantics { heading() })
        GalleryText(state.text(conclaveString("native_gallery_intro")), state,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        GalleryText(conclaveString("native_gallery_api", Build.VERSION.SDK_INT), state)
        GalleryText(conclaveString("native_gallery_appearance",
            if (isSystemInDarkTheme()) conclaveString("native_gallery_dark") else conclaveString("native_gallery_light")), state)
        GalleryText(conclaveString("native_gallery_font", density.fontScale, density.density,
            LocalConfiguration.current.screenWidthDp), state)
        GalleryText(conclaveString("native_gallery_direction",
            if (LocalLayoutDirection.current == LayoutDirection.Rtl) conclaveString("native_gallery_rtl")
            else conclaveString("native_gallery_ltr")), state)
        GalleryText(conclaveString("native_gallery_motion", if (reduceMotion) on else off), state)
        GalleryText(conclaveString("native_gallery_contrast_level",
            contrastLevel ?: conclaveString("native_gallery_contrast_level_unavailable")), state)
        GalleryText(conclaveString("native_gallery_text_contrast", if (contrast.highTextContrast) on else off), state)
        val configuration = galleryConfiguration(state)
        GalleryText(conclaveString("native_gallery_clipped", asciiCount(state.overflow.count(configuration, rows.specimenIDs)),
            asciiCount(state.overflow.measuredCount(configuration, rows.specimenIDs)), asciiCount(rows.specimenIDs.size)),
            state, modifier = Modifier.testTag(ComponentGalleryCatalog.overflowID))
    }
}

@Composable
private fun GalleryLongTextToggle(state: NativeComponentGalleryState) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(ComponentGalleryCatalog.longTextToggleID)
        .toggleable(value = state.longText, role = Role.Switch, onValueChange = { state.longText = it }),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        GalleryText(conclaveString("native_gallery_long_text"), state, modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.bodyLarge)
        Switch(checked = state.longText, onCheckedChange = null)
    }
}

/** A heading that is also the section's one show or hide control, with its state spoken. */
@Composable
private fun GallerySectionToggle(section: GallerySection, state: NativeComponentGalleryState) {
    val expanded = state.isExpanded(section)
    val title = when (section) {
        GallerySection.typography -> conclaveString("native_gallery_typography")
        GallerySection.haptics -> conclaveString("native_gallery_haptics")
        GallerySection.contrast -> conclaveString("native_gallery_contrast")
        // iOS only; never emitted on Android.
        GallerySection.systemProminent -> ""
    }
    val action = if (expanded) conclaveString("native_gallery_section_hide") else conclaveString("native_gallery_section_show")
    val stateText = if (expanded) conclaveString("native_gallery_expanded") else conclaveString("native_gallery_collapsed")
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(ComponentGalleryCatalog.sectionID(section))
        .clickable(role = Role.Button, onClickLabel = action) { state.toggle(section) }
        .semantics(mergeDescendants = true) { heading(); stateDescription = stateText },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        GalleryText(title, state, modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
        Text(action, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
    }
}

@Composable
private fun GalleryTypeRow(row: NativeGalleryTypeRow, state: NativeComponentGalleryState) {
    val style = row.style.textStyle(row.weight)
    val density = LocalDensity.current
    val pixels = with(density) { style.fontSize.toPx() }
    Column(Modifier.fillMaxWidth().testTag(row.id).semantics(mergeDescendants = true) {}.padding(vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        GalleryText(state.text(conclaveString("native_gallery_type_sample")), state, style = style, specimen = row.id)
        GalleryText(state.text(conclaveString("native_gallery_type_caption", row.style.androidRole, row.weight.displayName,
            style.fontSize.value, pixels)), state, style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, specimen = row.id, line = row.id + ".caption")
    }
}

@Composable
private fun GalleryHapticControls(rows: NativeComponentGalleryRows, state: NativeComponentGalleryState) {
    val verified = state.verified
    val last = state.lastTap
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        TextButton(onClick = { state.verified = rows.hapticMatches() },
            modifier = Modifier.heightIn(min = 48.dp).testTag(ComponentGalleryCatalog.hapticVerifyID)) {
            Text(conclaveString("native_gallery_verify"))
        }
        GalleryText(if (verified == null) conclaveString("native_gallery_not_run")
            else conclaveString("native_gallery_match", asciiCount(verified), asciiCount(rows.haptics.size), asciiCount(rows.api)),
            state, modifier = Modifier.testTag(ComponentGalleryCatalog.hapticResultID))
        GalleryText(conclaveString("native_gallery_taps", asciiCount(state.recorded), asciiCount(state.outcomeRoute),
            asciiCount(state.silent)), state, modifier = Modifier.testTag(ComponentGalleryCatalog.hapticRecordID))
        GalleryText(if (last == null) conclaveString("native_gallery_last_none")
            else conclaveString("native_gallery_last", last.first.rawValue, decisionText(last.second)), state)
    }
}

@Composable
private fun decisionText(decision: GestureHapticDecision): String = when (decision) {
    GestureHapticDecision.Played -> conclaveString("native_gallery_played")
    GestureHapticDecision.Recorded -> conclaveString("native_gallery_recorded")
    GestureHapticDecision.OutcomeRoute -> conclaveString("native_gallery_outcome_only")
    GestureHapticDecision.Silent -> conclaveString("native_gallery_silent_word")
}

@Composable
private fun GalleryHapticRow(row: NativeGalleryHapticRow, first: Boolean, state: NativeComponentGalleryState) {
    val context = LocalContext.current
    // No view: the real route decides, and nothing reaches the hardware.
    val route = remember(context) { ConclaveGestureHaptics(view = null, debuggable = isDebuggableApp(context)) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (first) {
            Text(if (row.gesture) conclaveString("native_gallery_gesture_route") else conclaveString("native_gallery_outcome_route"),
                style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp).semantics { heading() })
        }
        Column(Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(row.id)
            .clickable(role = Role.Button) {
                state.record(row.kind, if (row.gesture) route.gesture(row.kind) else route.decide(row.kind))
            }
            .padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            GalleryText(row.kind.rawValue, state, style = MaterialTheme.typography.bodyLarge, specimen = row.id)
            GalleryText(state.text(conclaveString("native_gallery_haptic_row", row.constant, row.contract)), state,
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                specimen = row.id, line = row.id + ".detail")
            if (row.constant == "none") {
                GalleryText(state.text(conclaveString("native_gallery_silent")), state, style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, specimen = row.id, line = row.id + ".silent")
            }
        }
    }
}

private fun argb(color: Color): Long = color.toArgb().toLong() and 0xFFFFFFFFL

@Composable
private fun requirementText(requirement: ContrastRequirement): String = when (requirement) {
    ContrastRequirement.text -> conclaveString("native_gallery_class_text")
    ContrastRequirement.largeText -> conclaveString("native_gallery_class_large")
    ContrastRequirement.nonText -> conclaveString("native_gallery_class_non_text")
    ContrastRequirement.decorative -> conclaveString("native_gallery_class_decorative")
    ContrastRequirement.forbiddenText -> conclaveString("native_gallery_class_forbidden")
}

@Composable
private fun verdictText(ratio: Double, requirement: ContrastRequirement): String {
    val verdict = when (ContrastRatio.verdict(ratio, requirement)) {
        ContrastVerdict.passes -> conclaveString("native_gallery_passes")
        ContrastVerdict.fails -> conclaveString("native_gallery_fails")
        ContrastVerdict.decorativeOnly -> conclaveString("native_gallery_decorative_only")
    }
    return conclaveString("native_gallery_verdict", ratio, requirementText(requirement), verdict)
}

@Composable
private fun GallerySwatch(foreground: Color, background: Color) {
    val shape = RoundedCornerShape(8.dp)
    Box(Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).background(background, shape)
        .border(Dp.Hairline, MaterialTheme.colorScheme.outlineVariant, shape).clearAndSetSemantics { },
        contentAlignment = Alignment.Center) {
        Text(conclaveString("native_gallery_swatch"), color = foreground, style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(4.dp))
    }
}

/** Theme roles resolved live with `toArgb()` in each column: "App" follows the system, "In call" is always dark.
 *  HostingTheme no longer touches the system bars, so this column cannot flip them. */
@Composable
private fun GalleryLiveContrast(inCall: Boolean, state: NativeComponentGalleryState) {
    HostingTheme(inCall = inCall) {
        val scheme = MaterialTheme.colorScheme
        Surface(color = scheme.surface, contentColor = scheme.onSurface, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(if (inCall) conclaveString("native_gallery_live_in_call") else conclaveString("native_gallery_live_app"),
                    style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(horizontal = 8.dp).semantics { heading() })
                for (role in nativeGalleryLiveRoles) {
                    GalleryLiveRow(role.name, inCall, conclaveString(role.caption), role.foreground(scheme), role.background(scheme), state)
                }
            }
        }
    }
}

@Composable
private fun GalleryLiveRow(name: String, inCall: Boolean, caption: String, foreground: Color, background: Color,
                           state: NativeComponentGalleryState) {
    val id = ComponentGalleryCatalog.liveContrastID(name, inCall = inCall)
    val ratio = ContrastRatio.wcag(foreground = argb(foreground), background = argb(background))
    Row(Modifier.fillMaxWidth().testTag(id).semantics(mergeDescendants = true) {}.padding(horizontal = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        GallerySwatch(foreground, background)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            GalleryText(state.text(caption), state, specimen = id)
            GalleryText(state.text(verdictText(ratio, ContrastRequirement.text)), state, style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, specimen = id, line = "$id.verdict")
        }
    }
}

@Composable
private fun GalleryContrastRow(row: NativeGalleryContrastRow, state: NativeComponentGalleryState) {
    Row(Modifier.fillMaxWidth().testTag(row.id).semantics(mergeDescendants = true) {}.padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        GallerySwatch(Color(row.foreground), Color(row.background))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            GalleryText(state.text(row.caption), state, specimen = row.id)
            GalleryText(state.text(verdictText(row.ratio, row.requirement)), state, style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, specimen = row.id, line = row.id + ".verdict")
            GalleryText(state.text(conclaveString("native_gallery_expected", row.expected)), state,
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                specimen = row.id, line = row.id + ".expected")
        }
    }
}
