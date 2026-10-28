package conclave.module

import android.Manifest
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Looper
import android.provider.Settings
import android.view.View
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File
import java.nio.file.Files
import java.util.Locale

/** WP1-2a: typography, haptic contract and gesture route (H1a), contrast, gallery rows, system bars and the
 *  semantics exporter, through the transpiled shared types. Composables are covered by their pure helpers;
 *  the Conclave test classpath has no Compose UI test artifacts. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class TypographyHapticsGalleryBridgeTests {
    @Test fun conclaveTypographyIsMaterialDefaults() {
        assertEquals(Typography(), ConclaveTypography)
        val roles = with(ConclaveTypography) {
            listOf(displayLarge, displayMedium, displaySmall, headlineLarge, headlineMedium, headlineSmall,
                titleLarge, titleMedium, titleSmall, bodyLarge, bodyMedium, bodySmall, labelLarge, labelMedium, labelSmall)
        }
        for (role in roles) {
            // The Material default system sans-serif, never a bundled or custom family.
            assertEquals(FontFamily.SansSerif, role.fontFamily)
            assertTrue(role.fontSize.isSp)
        }
    }

    @Test fun everyStyleMapsToSpRole() {
        val typography = Typography()
        val names = mapOf(
            "headlineLarge" to typography.headlineLarge, "headlineMedium" to typography.headlineMedium,
            "headlineSmall" to typography.headlineSmall, "titleLarge" to typography.titleLarge,
            "titleMedium" to typography.titleMedium, "bodyLarge" to typography.bodyLarge,
            "bodyMedium" to typography.bodyMedium, "bodySmall" to typography.bodySmall, "labelSmall" to typography.labelSmall,
        )
        assertEquals(11, ConclaveTextStyle.values().size)
        for (style in ConclaveTextStyle.values()) {
            val role = style.role(typography)
            // The shared catalog's role names, sizes and weights are the pinned Material 3 values.
            assertSame(style.rawValue, names.getValue(style.androidRole), role)
            assertEquals(style.rawValue, style.androidRoleSp.toFloat(), role.fontSize.value, 0f)
            assertEquals(style.rawValue, FontWeight(style.androidRoleWeight), role.fontWeight)
            for (weight in ConclaveTextWeight.values()) {
                val result = style.textStyle(typography, weight)
                val label = "${style.rawValue} ${weight.rawValue}"
                assertTrue(label, result.fontSize.isSp)
                assertEquals(label, role.fontSize, result.fontSize)
                assertEquals(label, role.lineHeight, result.lineHeight)
                assertEquals(label, role.fontFamily, result.fontFamily)
                assertEquals(label, FontWeight(weight.numericWeight), result.fontWeight)
                if (role.fontWeight == result.fontWeight) assertSame(label, role, result)
                else assertEquals(label, role.copy(fontWeight = FontWeight(weight.numericWeight)), result)
            }
        }
    }

    @Test fun androidMapperMatchesContractTable() {
        assertEquals(66, FeedbackHapticContract.rows.count)
        for (api in listOf(28, 29, 30, 32, 33, 34, 36)) {
            for (kind in FeedbackKind.values()) {
                assertEquals("${kind.rawValue} at API $api", FeedbackHapticContract.android(kind, api),
                    hapticConstantName(ConclaveHaptics.constant(kind, api)))
            }
            assertEquals(66, NativeComponentGalleryRows(api).hapticMatches())
        }
        // Silent at the boundary APIs (TG 3.2): 16 from API 33, 15 at 30 to 32, 16 at 28 and 29.
        fun silent(api: Int) = FeedbackKind.values().count { FeedbackHapticContract.isSilentOnAndroid(it, api) }
        assertEquals(16, silent(36))
        assertEquals(16, silent(33))
        assertEquals(15, silent(32))
        assertEquals(15, silent(30))
        assertEquals(16, silent(28))
        // Q11 left the Android mapper alone: starts confirm, stops stay silent, becameHost is iOS-only (D5).
        assertEquals("CONFIRM", FeedbackHapticContract.android(FeedbackKind.shareStarted, 34))
        assertEquals("none", FeedbackHapticContract.android(FeedbackKind.transcriptionStopped, 34))
        assertEquals("none", FeedbackHapticContract.android(FeedbackKind.becameHost, 36))
    }

    @Test fun gesturePartitionMatchesSwift() {
        val gestures = FeedbackKind.values().filter { !it.isAsyncOutcome }
        assertEquals(21, gestures.size)
        assertEquals(45, FeedbackKind.values().size - gestures.size)
        val contractKinds = mutableListOf<FeedbackKind>()
        for (row in FeedbackHapticContract.rows) contractKinds += row.kind
        assertEquals(FeedbackKind.values().toList(), contractKinds)
        val rows = NativeComponentGalleryRows(api = 28)
        assertEquals(21, rows.gestureCount)
        assertEquals(gestures, rows.haptics.take(21).map { it.kind })
        assertTrue(rows.haptics.drop(21).none { it.gesture })
    }

    @Test fun gestureRouteUsesSingleArgumentCallAndRefusesOutcomes() {
        val single = mutableListOf<Int>()
        var flagged = 0
        val view = object : View(RuntimeEnvironment.getApplication()) {
            override fun performHapticFeedback(constant: Int): Boolean {
                single += constant
                return true // Recording view: never reaches the platform effect.
            }
            override fun performHapticFeedback(constant: Int, flags: Int): Boolean {
                flagged++
                return true
            }
        }
        val route = ConclaveGestureHaptics(view = view, debuggable = false)
        assertEquals(GestureHapticDecision.Played, route.gesture(FeedbackKind.micOn))
        assertEquals(listOf(ConclaveHaptics.constant(FeedbackKind.micOn)), single)
        assertEquals(GestureHapticDecision.OutcomeRoute, route.gesture(FeedbackKind.joined))
        assertEquals(GestureHapticDecision.Silent, route.gesture(FeedbackKind.none))
        assertEquals(1, single.size)
        assertEquals(0, flagged)
        // In debuggable builds an outcome on the gesture route is a wiring bug and fails loudly.
        val debug = ConclaveGestureHaptics(view = view, debuggable = true)
        assertThrows(IllegalStateException::class.java) { debug.gesture(FeedbackKind.joined) }
        assertEquals(GestureHapticDecision.OutcomeRoute, debug.decide(FeedbackKind.joined))
        assertEquals(1, single.size)
        // Without a view the route only records, which is all the gallery ever does.
        val recordOnly = ConclaveGestureHaptics(view = null, debuggable = true)
        for (kind in FeedbackKind.values().filter { !it.isAsyncOutcome }) {
            val expected = if (ConclaveHaptics.constant(kind) == null) GestureHapticDecision.Silent else GestureHapticDecision.Recorded
            assertEquals(kind.rawValue, expected, recordOnly.gesture(kind))
        }
        assertEquals(1, single.size)
        assertEquals(0, flagged)
    }

    @Test fun contrastFunctionParity() {
        fun ratio(foreground: Long, background: Long) = ContrastRatio.wcag(foreground = foreground, background = background)
        assertEquals(6.374, ratio(DesignTokens.ink, DesignTokens.coral), 0.001)
        assertEquals(3.105, ratio(DesignTokens.neutralWhite, DesignTokens.coral), 0.001)
        assertEquals(4.166, ratio(DesignTokens.coralBright, DesignTokens.neutralZinc700), 0.001)
        assertEquals(4.551, ratio(DesignTokens.coralDeep, DesignTokens.neutralLight4), 0.001)
        assertEquals(6.279, ratio(DesignTokens.iosInCallTextTertiary, DesignTokens.ink), 0.001)
        assertEquals(2.507, ratio(DesignTokens.neutralWhite, DesignTokens.coralBright), 0.001)
        assertEquals(2.268, ratio(DesignTokens.neutralWhite, DesignTokens.coralBrightHighContrast), 0.001)
        // WP1-2b adds the five F00 C12 i banner pairs.
        // FND-1 and FND-2 add 19 pairs (62 to 80); FND-3 adds 14 (81 to 94); ENT-4 adds 1 (95).
        assertEquals(95, ComponentGalleryCatalog.contrastPairs.count)
        for (pair in ComponentGalleryCatalog.contrastPairs) {
            assertEquals(pair.id, pair.expectedRatio, pair.ratio, 0.001)
            assertTrue(pair.id, ContrastRatio.meets(pair.ratio, pair.requirement))
            // Runtime A7: a pair labeled not for text reads "decorative only", never "passes".
            val verdict = if (pair.requirement == ContrastRequirement.forbiddenText) ContrastVerdict.decorativeOnly else ContrastVerdict.passes
            assertEquals(pair.id, verdict, ContrastRatio.verdict(pair.ratio, pair.requirement))
        }
        assertEquals(ContrastVerdict.fails, ContrastRatio.verdict(4.6, ContrastRequirement.forbiddenText))
        assertEquals(ContrastVerdict.fails, ContrastRatio.verdict(4.4, ContrastRequirement.text))
        // Live rows convert theme colors with toArgb(); the conversion keeps token values exact.
        for (token in listOf(DesignTokens.coral, DesignTokens.androidLightPrimary, DesignTokens.androidDarkOnSurfaceVariant)) {
            assertEquals(token, Color(token).toArgb().toLong() and 0xFFFFFFFFL)
        }
    }

    @Test fun galleryRowsAreCachedSnapshots() {
        val cache = NativeComponentGalleryRowsCache(api = 34)
        val first = cache.current()
        assertSame(first, cache.current())
        assertSame(first.type, cache.current().type)
        assertSame(first.haptics, cache.current().haptics)
        assertSame(first.contrast, cache.current().contrast)
        // WP1-2b: the component rows are cached snapshots too, one list per Show loading value.
        assertSame(first.components, cache.current().components)
        assertSame(first.componentsWithLoading, cache.current().componentsWithLoading)
        assertSame(first.specimenIDs, cache.current().specimenIDs)
        assertNotSame(first, NativeComponentGalleryRowsCache(api = 34).current())
        assertEquals(44, first.type.size)
        assertEquals(66, first.haptics.size)
        assertEquals(95, first.contrast.size)
        assertEquals(40, first.components.size)
        assertEquals(46, first.componentsWithLoading.size)
        val ids = first.type.map { it.id } + first.haptics.map { it.id } + first.contrast.map { it.id } + first.componentsWithLoading.map { it.id }
        assertEquals(ids.size, ids.toSet().size)
        // Call controls are In call only; everything else is drawn in both columns.
        for (row in first.componentsWithLoading) {
            assertEquals(row.id, ComponentGalleryCatalog.columnID(row.base, inCall = row.inCall))
            if (row.section == GallerySection.callControls) assertTrue(row.id, row.inCall)
        }
        assertEquals(21, first.componentsWithLoading.count { !it.inCall })
        // Spinner specimens appear only with Show loading on.
        val spinners = first.componentsWithLoading.map { it.id }.toSet() - first.components.map { it.id }.toSet()
        assertEquals(setOf("button.primary.pending.app", "button.primary.pending.inCall", "banner.reconnecting.app",
            "banner.reconnecting.inCall", "status.loading.app", "status.loading.inCall"), spinners)
        assertEquals(first.components.filter { it.section == GallerySection.status }, first.components(GallerySection.status, showLoading = false))
        assertEquals(6.374, first.contrast.first { it.id == "contrast.onCoral.ink" }.ratio, 0.001)
        assertEquals("TOGGLE_ON", first.haptics.first { it.kind == FeedbackKind.micOn }.constant)
        val state = NativeComponentGalleryState()
        assertSame(state.rows.current(), state.rows.current())
    }

    private class RecordingListScope : LazyListScope {
        val keys = mutableListOf<Any?>()

        override fun item(key: Any?, contentType: Any?, content: @Composable LazyItemScope.() -> Unit) {
            keys += key
        }

        override fun items(
            count: Int, key: ((index: Int) -> Any)?, contentType: (index: Int) -> Any?,
            itemContent: @Composable LazyItemScope.(index: Int) -> Unit,
        ) {
            for (index in 0 until count) keys += key?.invoke(index)
        }
    }

    @Test fun galleryEmitsNoItemsWhenCollapsed() {
        val state = NativeComponentGalleryState()
        val collapsed = RecordingListScope().apply { nativeComponentGalleryItems(expanded = false, state = state) }
        assertTrue(collapsed.keys.isEmpty())
        val sectionsClosed = RecordingListScope().apply { nativeComponentGalleryItems(expanded = true, state = state) }
        assertEquals(listOf(ComponentGalleryCatalog.environmentID, ComponentGalleryCatalog.longTextToggleID,
            ComponentGalleryCatalog.showLoadingToggleID,
            ComponentGalleryCatalog.sectionID(GallerySection.typography), ComponentGalleryCatalog.sectionID(GallerySection.haptics),
            ComponentGalleryCatalog.sectionID(GallerySection.contrast), ComponentGalleryCatalog.sectionID(GallerySection.buttons),
            ComponentGalleryCatalog.sectionID(GallerySection.callControls), ComponentGalleryCatalog.sectionID(GallerySection.rows),
            ComponentGalleryCatalog.sectionID(GallerySection.banners), ComponentGalleryCatalog.sectionID(GallerySection.status)),
            sectionsClosed.keys)
        state.typeExpanded = true
        state.hapticsExpanded = true
        state.contrastExpanded = true
        val twoA = RecordingListScope().apply { nativeComponentGalleryItems(expanded = true, state = state) }
        assertEquals(6 + 44 + 1 + 66 + 2 + 95 + 5, twoA.keys.size)
        for (section in nativeGalleryComponentSections) state.toggle(section)
        val open = RecordingListScope().apply { nativeComponentGalleryItems(expanded = true, state = state) }
        // Per component section: one header per column, then the specimens; the call controls add the taps
        // readout and the banners add the motion switch and the animated banner.
        val components = (2 + 8) + (1 + 1 + 4) + (2 + 14) + (2 + 8 + 2) + (2 + 6)
        assertEquals(6 + 44 + 1 + 66 + 2 + 95 + 5 + components, open.keys.size)
        assertTrue(open.keys.contains(ComponentGalleryCatalog.controlRecordID))
        assertTrue(open.keys.contains(ComponentGalleryCatalog.bannerMotionID))
        assertFalse(open.keys.contains("button.primary.pending.app"))
        state.showLoading = true
        val loading = RecordingListScope().apply { nativeComponentGalleryItems(expanded = true, state = state) }
        assertEquals(open.keys.size + 6, loading.keys.size)
        assertTrue(loading.keys.contains("status.loading.inCall"))
        for (keys in listOf(open.keys, loading.keys)) {
            assertEquals(keys.size, keys.toSet().size)
            for (key in keys) assertTrue("$key", key is String && key.all { it.code in 0x21..0x7E })
        }
        // Collapsing the gallery still emits nothing, whatever the sections hold.
        assertTrue(RecordingListScope().apply { nativeComponentGalleryItems(expanded = false, state = state) }.keys.isEmpty())
    }

    @Test fun galleryOverflowCountsBelongToOneConfiguration() {
        val overflow = NativeGalleryOverflow()
        val specimens = setOf("type.body.regular", "type.body.bold", "type.title.regular")
        val standard = nativeGalleryConfigurationKey(1f, 2.625f, 411, 0, "en-US", LayoutDirection.Ltr, false)
        val large = nativeGalleryConfigurationKey(2f, 2.625f, 411, 0, "en-US", LayoutDirection.Ltr, false)
        overflow.report(standard, "type.body.regular", "type.body.regular", true)
        overflow.report(standard, "type.body.bold", "type.body.bold", false)
        overflow.report(large, "type.body.regular", "type.body.regular", false)
        assertEquals(1, overflow.count(standard, specimens))
        assertEquals(0, overflow.count(large, specimens))
        // A configuration that is a prefix of another never counts the other's measurements.
        assertEquals(0, overflow.count(standard.dropLast(1), specimens))
        // A later measurement of the same line in the same configuration replaces the earlier one.
        overflow.report(standard, "type.body.regular", "type.body.regular", false)
        assertEquals(0, overflow.count(standard, specimens))
        // A clipped caption counts against its specimen, and a specimen counts once however many lines clip.
        overflow.report(standard, "type.body.regular", "type.body.regular.caption", true)
        assertEquals(1, overflow.count(standard, specimens))
        overflow.report(standard, "type.body.regular", "type.body.regular", true)
        assertEquals(1, overflow.count(standard, specimens))
        // Coverage counts listed specimens measured in this configuration.
        assertEquals(2, overflow.measuredCount(standard, specimens))
        assertEquals(1, overflow.measuredCount(large, specimens))
        // Review m1: both numbers count the same population, so text outside the specimen set never counts.
        overflow.report(standard, "environment.font", "environment.font", true)
        assertEquals(1, overflow.count(standard, specimens))
        assertEquals(2, overflow.measuredCount(standard, specimens))
        val rows = NativeComponentGalleryRows(api = 36)
        // WP1-2b: 40 component specimens (pairs: 95 since ENT-4); the six spinner specimens count only with
        // Show loading on.
        assertEquals(44 + 66 + 95 + 2 * nativeGalleryLiveRoles.size + 40, rows.specimenIDs.size)
        assertEquals(rows.specimenIDs.size + 6, rows.specimens(showLoading = true).size)
        assertSame(rows.specimenIDs, rows.specimens(showLoading = false))
        assertEquals(7, nativeGalleryLiveRoles.size)
    }

    /** Review m1: the activity handles Bold Text, the per-app locale and layout direction in place, so each
     *  must start a new set of measurements. */
    @Test fun galleryConfigurationKeyTracksInPlaceChanges() {
        val previous = Locale.getDefault()
        Locale.setDefault(Locale.forLanguageTag("ar-EG"))
        try {
            val base = nativeGalleryConfigurationKey(1f, 2.625f, 360, 0, "en-US", LayoutDirection.Ltr, false)
            // WP1-2b: Show loading is part of the key (default off).
            assertEquals("1.0,2.625,360,0,en-US,Ltr,false,false", base)
            val bold = nativeGalleryConfigurationKey(1f, 2.625f, 360, 300, "en-US", LayoutDirection.Ltr, false)
            val arabic = nativeGalleryConfigurationKey(1f, 2.625f, 360, 0, "ar-EG", LayoutDirection.Ltr, false)
            val rtl = nativeGalleryConfigurationKey(1f, 2.625f, 360, 0, "en-US", LayoutDirection.Rtl, false)
            val scaled = nativeGalleryConfigurationKey(1.15f, 2.625f, 360, 0, "en-US", LayoutDirection.Ltr, false)
            val long = nativeGalleryConfigurationKey(1f, 2.625f, 360, 0, "en-US", LayoutDirection.Ltr, true)
            val loading = nativeGalleryConfigurationKey(1f, 2.625f, 360, 0, "en-US", LayoutDirection.Ltr, false, showLoading = true)
            val keys = listOf(base, bold, arabic, rtl, scaled, long, loading)
            assertEquals(keys.size, keys.toSet().size)
            assertTrue(keys.all { key -> key.all { it.code in 0x20..0x7E } })
            // Full coverage measured before Bold Text was turned on does not carry over.
            val overflow = NativeGalleryOverflow()
            val specimens = setOf("type.body.regular", "type.body.bold")
            for (id in specimens) overflow.report(base, id, id, false)
            assertEquals(2, overflow.measuredCount(base, specimens))
            for (key in listOf(bold, arabic, rtl, loading)) assertEquals(key, 0, overflow.measuredCount(key, specimens))
        } finally {
            Locale.setDefault(previous)
        }
    }

    /** Review m4: counts that scripts parse stay ASCII under an Arabic default or per-app locale. */
    @Test fun scriptReadCountsAreAsciiInEveryLocale() {
        val previous = Locale.getDefault()
        Locale.setDefault(Locale.forLanguageTag("ar-EG"))
        try {
            // The hazard: a %d formatted for the locale writes Arabic-Indic digits.
            assertFalse(String.format(Locale.getDefault(), "%d", 180).all { it in '0'..'9' })
            assertEquals("180", asciiCount(180))
            assertEquals("0", asciiCount(0))
            assertEquals("66", asciiCount(66))
        } finally {
            Locale.setDefault(previous)
        }
    }

    /** Review m3: high contrast text is not a configuration change, so the header re-reads it on each change
     *  (and on resume). API 28 has no contrast level. */
    @Test fun contrastReadoutsRefreshThroughTheWatcher() {
        val context = RuntimeEnvironment.getApplication()
        val resolver = context.contentResolver
        val uri = Settings.Secure.getUriFor("high_text_contrast_enabled")
        Settings.Secure.putInt(resolver, "high_text_contrast_enabled", 0)
        assertEquals(NativeGalleryContrast(level = null, highTextContrast = false), NativeGalleryContrast.read(context))
        val seen = mutableListOf<NativeGalleryContrast>()
        val watcher = NativeGalleryContrastWatcher(context) { seen += it }
        watcher.start()
        Settings.Secure.putInt(resolver, "high_text_contrast_enabled", 1)
        resolver.notifyChange(uri, null)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(seen.isNotEmpty())
        assertEquals(NativeGalleryContrast(level = null, highTextContrast = true), seen.last())
        val delivered = seen.size
        watcher.refresh()
        assertEquals(delivered + 1, seen.size)
        // Stopped watchers deliver nothing.
        watcher.stop()
        Settings.Secure.putInt(resolver, "high_text_contrast_enabled", 0)
        resolver.notifyChange(uri, null)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(delivered + 1, seen.size)
    }

    @Test fun systemBarPolicyTruthTable() {
        // PS 8.7 written out as data, not computed: a visible full-screen overlay owns both bars, dark when it
        // is in call or the system is dark; without one the status bar shows the root, and the navigation bar
        // shows an in-call strip at the bottom edge, or else the root. Columns: rootDark, overlayVisible,
        // overlayInCall, bottomStripInCall, systemDark, then the expected statusDark and navigationDark.
        val table = listOf(
            intArrayOf(0, 0, 0, 0, 0, 0, 0), intArrayOf(1, 0, 0, 0, 0, 1, 1),
            intArrayOf(0, 1, 0, 0, 0, 0, 0), intArrayOf(1, 1, 0, 0, 0, 0, 0),
            intArrayOf(0, 0, 1, 0, 0, 0, 0), intArrayOf(1, 0, 1, 0, 0, 1, 1),
            intArrayOf(0, 1, 1, 0, 0, 1, 1), intArrayOf(1, 1, 1, 0, 0, 1, 1),
            intArrayOf(0, 0, 0, 1, 0, 0, 1), intArrayOf(1, 0, 0, 1, 0, 1, 1),
            intArrayOf(0, 1, 0, 1, 0, 0, 0), intArrayOf(1, 1, 0, 1, 0, 0, 0),
            intArrayOf(0, 0, 1, 1, 0, 0, 1), intArrayOf(1, 0, 1, 1, 0, 1, 1),
            intArrayOf(0, 1, 1, 1, 0, 1, 1), intArrayOf(1, 1, 1, 1, 0, 1, 1),
            intArrayOf(0, 0, 0, 0, 1, 0, 0), intArrayOf(1, 0, 0, 0, 1, 1, 1),
            intArrayOf(0, 1, 0, 0, 1, 1, 1), intArrayOf(1, 1, 0, 0, 1, 1, 1),
            intArrayOf(0, 0, 1, 0, 1, 0, 0), intArrayOf(1, 0, 1, 0, 1, 1, 1),
            intArrayOf(0, 1, 1, 0, 1, 1, 1), intArrayOf(1, 1, 1, 0, 1, 1, 1),
            intArrayOf(0, 0, 0, 1, 1, 0, 1), intArrayOf(1, 0, 0, 1, 1, 1, 1),
            intArrayOf(0, 1, 0, 1, 1, 1, 1), intArrayOf(1, 1, 0, 1, 1, 1, 1),
            intArrayOf(0, 0, 1, 1, 1, 0, 1), intArrayOf(1, 0, 1, 1, 1, 1, 1),
            intArrayOf(0, 1, 1, 1, 1, 1, 1), intArrayOf(1, 1, 1, 1, 1, 1, 1),
        )
        assertEquals(32, table.map { row -> row.take(5) }.toSet().size)
        for (row in table) {
            val result = SystemBarPolicy.resolve(rootDark = row[0] == 1, overlayVisible = row[1] == 1,
                overlayInCall = row[2] == 1, bottomStripInCall = row[3] == 1, systemDark = row[4] == 1)
            assertEquals(row.joinToString(""), SystemBarAppearance(statusDark = row[5] == 1, navigationDark = row[6] == 1), result)
        }
        // The 2a fixture: a system-themed root, no overlay and no strip, in system light.
        assertEquals(SystemBarAppearance(statusDark = false, navigationDark = false),
            SystemBarPolicy.resolve(rootDark = false, overlayVisible = false, overlayInCall = false,
                bottomStripInCall = false, systemDark = false))
    }

    @Test fun semanticsExportJsonIsAsciiAndStable() {
        val previous = Locale.getDefault()
        // Arabic-Indic digits in the default locale must never reach the machine-read file.
        Locale.setDefault(Locale.forLanguageTag("ar-EG"))
        try {
            val node = SemanticsExportNode(
                id = 7, parent = -1, depth = 0, testTag = "components.gallery.toggle", role = "Button",
                contentDescription = listOf("Café \"quoted\" \\ slash"),
                text = listOf("٣ من ٣", "emoji 😀", "tab\tline\n"),
                editableText = null, stateDescription = "Expanded", heading = true, paneTitle = null,
                liveRegion = "Polite", traversalGroup = true, traversalIndex = 1.5f, focusable = true,
                focused = false, clickable = true, disabled = false, selected = null, toggleState = "On",
                hidden = false, left = 0f, top = 12.5f, right = 1080f, bottom = 144.5f,
            )
            val header = listOf("schema" to NativeSemanticsJson.number(1), "fontScale" to NativeSemanticsJson.number(2.0f),
                "wallClockMs" to NativeSemanticsJson.number(1761300000000L))
            val first = NativeSemanticsJson.document(header, listOf("merged" to listOf(node), "unmerged" to emptyList()))
            val second = NativeSemanticsJson.document(header, listOf("merged" to listOf(node.copy()), "unmerged" to emptyList()))
            assertEquals(first, second)
            assertTrue(first.all { it == '\n' || it.code in 0x20..0x7E })
            assertTrue(first.contains("\"bounds\":[0.0,12.5,1080.0,144.5]"))
            assertTrue(first.contains("\"fontScale\": 2.0"))
            assertTrue(first.contains("\"wallClockMs\": 1761300000000"))
            assertTrue(first.indexOf("\"id\"") < first.indexOf("\"testTag\"") && first.indexOf("\"hidden\"") < first.indexOf("\"bounds\""))
            val parsed = JSONObject(first)
            val exported = parsed.getJSONArray("merged").getJSONObject(0)
            assertEquals("Café \"quoted\" \\ slash", exported.getJSONArray("contentDescription").getString(0))
            assertEquals("٣ من ٣", exported.getJSONArray("text").getString(0))
            assertEquals("emoji 😀", exported.getJSONArray("text").getString(1))
            assertEquals("tab\tline\n", exported.getJSONArray("text").getString(2))
            assertTrue(exported.isNull("selected") && exported.isNull("paneTitle"))
            assertEquals(0, parsed.getJSONArray("unmerged").length())
            assertEquals("null", NativeSemanticsJson.number(Float.NaN))
            // Review m5: one decimal merges the 0.85 and 1.15 font scale steps into 0.9 and 1.1; the header
            // scale keeps three, still ASCII under ar-EG.
            assertEquals(NativeSemanticsJson.number(0.9f), NativeSemanticsJson.number(0.85f))
            assertEquals(NativeSemanticsJson.number(1.1f), NativeSemanticsJson.number(1.15f))
            assertEquals("0.850", NativeSemanticsJson.scale(0.85f))
            assertEquals("1.150", NativeSemanticsJson.scale(1.15f))
            assertEquals("1.300", NativeSemanticsJson.scale(1.3f))
            assertEquals("2.000", NativeSemanticsJson.scale(2.0f))
            assertEquals("null", NativeSemanticsJson.scale(Float.POSITIVE_INFINITY))
        } finally {
            Locale.setDefault(previous)
        }
    }

    /** Review n1: the export directory keeps the newest exports, ordered by the numbers in their names, plus
     *  the latest pointer; other files stay. */
    @Test fun semanticsExportsArePruned() {
        val base = Files.createTempDirectory("wp1-semantics").toFile()
        try {
            File(base, "notes.txt").writeText("kept")
            for (index in 1..25) {
                val name = String.format(Locale.ROOT, "export-%d-%02d.json", 1761300000000L + index, index)
                NativeSemanticsExportFiles.write(base, name, "{\"n\":$index}".toByteArray(Charsets.US_ASCII), keep = 20)
            }
            fun exports() = base.list().orEmpty().filter { it.startsWith("export-") }.sorted()
            assertEquals(20, exports().size)
            assertEquals("export-1761300000006-06.json", exports().first())
            assertEquals("export-1761300000025-25.json", exports().last())
            assertEquals("{\"n\":25}", File(base, "latest.json").readText())
            assertTrue(File(base, "notes.txt").exists())
            assertFalse(File(base, "latest.json.tmp").exists())
            // Revision 100 is newer than revision 25 in the same millisecond, although it sorts first as text.
            NativeSemanticsExportFiles.write(base, "export-1761300000025-100.json", "{}".toByteArray(Charsets.US_ASCII), keep = 2)
            assertEquals(listOf("export-1761300000025-100.json", "export-1761300000025-25.json"), exports())
            assertEquals(20, NATIVE_SEMANTICS_EXPORTS_KEPT)
        } finally {
            base.deleteRecursively()
        }
    }

    /** The export receiver registers only in debuggable builds and only for senders that hold DUMP; the
     *  composable unregisters it on dispose. */
    @Test fun semanticsExportReceiverIsDebugOnlyAndDumpGuarded() {
        val app = RuntimeEnvironment.getApplication()
        val flags = app.applicationInfo.flags
        fun registered() = shadowOf(app).registeredReceivers.filter { it.intentFilter.hasAction(NATIVE_SEMANTICS_EXPORT_ACTION) }
        try {
            app.applicationInfo.flags = flags and ApplicationInfo.FLAG_DEBUGGABLE.inv()
            assertNull(registerNativeSemanticsExportReceiver(app) { })
            assertTrue(registered().isEmpty())
            app.applicationInfo.flags = flags or ApplicationInfo.FLAG_DEBUGGABLE
            var exports = 0
            val receiver = registerNativeSemanticsExportReceiver(app) { exports++ }
            assertNotNull(receiver)
            val wrappers = registered()
            assertEquals(1, wrappers.size)
            assertEquals(Manifest.permission.DUMP, wrappers[0].broadcastPermission)
            receiver!!.onReceive(app, Intent(NATIVE_SEMANTICS_EXPORT_ACTION))
            assertEquals(1, exports)
            app.unregisterReceiver(receiver)
            assertTrue(registered().isEmpty())
        } finally {
            app.applicationInfo.flags = flags
        }
    }

    @Test fun reduceMotionFollowsAnimatorScale() {
        val context = RuntimeEnvironment.getApplication()
        assertTrue(ConclaveMotion.reduceMotion(0f))
        assertFalse(ConclaveMotion.reduceMotion(1f))
        assertFalse(ConclaveMotion.reduceMotion(0.5f))
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        assertTrue(ConclaveMotion.reduceMotion(context))
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        assertFalse(ConclaveMotion.reduceMotion(context))
    }

    /** WP1-2b R01 (owner OQ1 kept it): the Android toggle colors through the pure mapping, exact token values. */
    @Test fun callToggleColorsMatchR01() {
        assertEquals(ConclaveCallToggleColors(0xFFF2B8B5L, 0xFF601410L), conclaveCallToggleColors(ConclaveCallControlVisual.Off))
        assertEquals(ConclaveCallToggleColors(0xFF2E2E33L, 0xFFFAFAFAL), conclaveCallToggleColors(ConclaveCallControlVisual.On))
        assertEquals(ConclaveCallToggleColors(0xFFF4F4F5L, 0xFF18181BL), conclaveCallToggleColors(ConclaveCallControlVisual.Engaged))
        assertEquals(ConclaveCallToggleColors(0xFFEA4335L, 0xFFFFFFFFL), conclaveLeaveColors)
        val expected = mapOf(ConclaveCallControlVisual.Off to 7.663, ConclaveCallControlVisual.On to 12.940, ConclaveCallControlVisual.Engaged to 16.118)
        for (visual in ConclaveCallControlVisual.values()) {
            val colors = conclaveCallToggleColors(visual)
            // Compose keeps the token values exact, and no toggle is ever coral.
            assertEquals(colors.container, Color(colors.container).toArgb().toLong() and 0xFFFFFFFFL)
            assertNotEquals(visual.name, DesignTokens.coral, colors.container)
            assertEquals(visual.name, expected.getValue(visual), ContrastRatio.wcag(foreground = colors.content, background = colors.container), 0.001)
        }
        assertEquals(3.923, ContrastRatio.wcag(foreground = conclaveLeaveColors.content, background = conclaveLeaveColors.container), 0.001)
        assertEquals(0.38f, CONCLAVE_CALL_DISABLED_ALPHA, 0f)
        // F00 C05 d: 56 dp from 385 dp available width, else 48 dp; never below 48 dp.
        assertEquals(48.dp, conclaveCallToggleWidth(360f))
        assertEquals(48.dp, conclaveCallToggleWidth(384.5f))
        assertEquals(56.dp, conclaveCallToggleWidth(385f))
        assertEquals(56.dp, conclaveCallToggleWidth(411f))
        val previous = Locale.getDefault()
        Locale.setDefault(Locale.US)
        try {
            assertEquals("3", conclaveBadgeLabel(3))
            assertEquals("99", conclaveBadgeLabel(99))
            assertEquals("99+", conclaveBadgeLabel(120))
        } finally {
            Locale.setDefault(previous)
        }
    }

    /** WP1-2b (recommended): the transpiled fit helper gives the Swift results on the stated compositions. */
    @Test fun compactBarFitParityWithSwift() {
        val toggles = ComponentGalleryCatalog.compactBarControls
        val order = ComponentGalleryCatalog.compactBarMoveOrder
        val narrow = CompactBarFit.androidPlan(toggleIDs = toggles, moveOrder = order, available = 360.0)
        assertEquals(48.0, narrow.targetWidth, 0.0)
        assertEquals(listOf("shareScreen"), narrow.moved.toList())
        assertTrue(narrow.fits && narrow.requiredWidth <= 360.0)
        val phone = CompactBarFit.androidPlan(toggleIDs = toggles, moveOrder = order, available = 411.0)
        assertEquals(56.0, phone.targetWidth, 0.0)
        assertEquals(listOf("shareScreen"), phone.moved.toList())
        assertTrue(phone.fits)
        assertTrue(CompactBarFit.androidPlan(toggleIDs = toggles, moveOrder = order, available = 600.0).moved.isEmpty)
        val ids = skip.lib.arrayOf("microphone", "camera", "shareScreen", "chat", "more", CompactBarFit.leaveControlID)
        assertEquals(listOf("microphone", "camera", "shareScreen", "chat", "more"), toggles.toList())
        val ios = CompactBarFit.iosPlan(controlIDs = ids, moveOrder = order, scaledDiameter = 52.0, available = 320.0)
        assertEquals(listOf("shareScreen"), ios.moved.toList())
        assertTrue(ios.fits && ios.targetWidth >= 44.0 && ios.spacing == 12.0)
        val tight = CompactBarFit.iosPlan(controlIDs = ids, moveOrder = order, scaledDiameter = 52.0, available = 340.0)
        assertTrue(tight.moved.isEmpty && tight.fits)
        assertEquals(8.0, tight.spacing, 0.0)
        val targets = skip.lib.arrayOf(48.0, 72.0)
        val withDivider = CompactBarFit.requiredWidth(targets = targets, spacing = 8.0, padding = 8.0, nonTargets = skip.lib.arrayOf(1.0))
        assertEquals(9.0, withDivider - CompactBarFit.requiredWidth(targets = targets, spacing = 8.0, padding = 8.0), 0.0)
    }

    @Test fun missingStringResourceIsVisibleNotSilent() {
        // The library test module has no app resources, so every name resolves to 0 and shows bracketed.
        val context = RuntimeEnvironment.getApplication()
        assertEquals(0, conclaveStringId(context, "native_gallery_title"))
        assertEquals("[native_gallery_title]", conclaveStringOf(context, "native_gallery_title"))
        assertEquals("[native_gallery_match]", conclaveStringOf(context, "native_gallery_match", 66, 66, 36))
    }
}
