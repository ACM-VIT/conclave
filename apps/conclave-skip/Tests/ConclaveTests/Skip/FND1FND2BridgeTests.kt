package conclave.module

import android.content.ContextWrapper
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.sp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * FND-1 and FND-2, the Android half (FND1FoundationPackTests and FND2InCallChromeTests are the Swift half): the
 * extended color roles (F00 2.6 A4), the motion specs (A5), plurals (S10 R11) and tabular digits (S60 R6-13), the
 * system accessibility reader's API gating (S70 13 d), the avatar parity and geometry (C07), the tile policy
 * (C08, S20 SR4), the route icons (S30 CL8) and the stage lifetime probe (S10 R12), through the transpiled shared
 * types. Composables are covered by their pure helpers.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class FND1FND2BridgeTests {
    @Test fun extendedColorsResolveByAppearance() {
        val light = conclaveExtendedColors(dark = false)
        val dark = conclaveExtendedColors(dark = true)
        assertEquals(Color(DesignTokens.androidExtendedWarningLight), light.warning)
        assertEquals(Color(DesignTokens.androidExtendedWarningDark), dark.warning)
        assertEquals(Color(DesignTokens.androidExtendedSuccessLight), light.success)
        assertEquals(Color(DesignTokens.androidExtendedHandRaisedDark), dark.handRaised)
        assertEquals(Color(DesignTokens.androidExtendedOnWarningDark), dark.onWarning)
        assertEquals(Color(DesignTokens.androidExtendedBorderLight), light.border)
        assertEquals(Color(DesignTokens.androidExtendedBorderDark), dark.border)
        assertEquals(Color(DesignTokens.androidExtendedBorderDarkHighContrast), conclaveExtendedColors(dark = true, highContrast = true).border)
        assertEquals(Color(DesignTokens.androidExtendedLabelScrimHighContrast), conclaveExtendedColors(dark = true, highContrast = true).labelScrim)
        // The R01 roles equal the pure call-control mapping (callToggleColorsMatchR01 checks the values).
        assertEquals(Color(conclaveCallToggleColors(ConclaveCallControlVisual.Off).container), dark.toggleOffContainer)
        assertEquals(Color(conclaveCallToggleColors(ConclaveCallControlVisual.Engaged).content), dark.onToggleEngaged)
        assertEquals(Color(conclaveLeaveColors.container), dark.callEnd)
        // Theme-independent roles are the same in both sets; the cached sets are the factory results.
        assertEquals(light.speaking, dark.speaking)
        assertEquals(light.stage, dark.stage)
        assertEquals(dark, ConclaveExtendedColorsDark)
        assertEquals(light, ConclaveExtendedColorsLight)
    }

    @Test fun motionSpecsReadTheSharedDurations() {
        assertEquals(120, ConclaveMotionDurations.fastMillis)
        assertEquals(120, ConclaveMotion.fast<Float>().durationMillis)
        assertEquals(200, ConclaveMotion.chromeFade<Float>().durationMillis)
        assertEquals(200, ConclaveMotion.crossFade<Float>().durationMillis)
        assertEquals(200, ConclaveMotion.stageSwap<Float>().durationMillis)
        assertEquals(0.9f, ConclaveMotion.spatialDefault<Float>().dampingRatio, 0.0001f)
        assertEquals(700f, ConclaveMotion.spatialDefault<Float>().stiffness, 0.0001f)
        assertEquals(8f, ConclaveMotion.bannerTravelDp, 0.0001f)
        assertEquals(120, ConclaveBannerMotion.DURATION_MILLIS)
        assertEquals(8, ConclaveBannerMotion.TRAVEL_DP)
        assertTrue(ConclaveMotion.reduceMotion(0f))
        assertFalse(ConclaveMotion.reduceMotion(0.5f))
    }

    @Test fun tabularStyleAddsOnlyTheFeature() {
        val base = TextStyle(fontSize = 14.sp)
        val tabular = base.tabular()
        assertEquals("tnum", tabular.fontFeatureSettings)
        assertEquals(base.fontSize, tabular.fontSize)
        assertNull(base.fontFeatureSettings)
    }

    @Test fun pluralLookupIsByNameAndByType() {
        val app = RuntimeEnvironment.getApplication()
        // The library test cannot see the app module's resources (like BrandResourceBridgeTests): a missing name shows
        // "[name]", and the lookup asks for the plurals type in the context's own package.
        assertEquals(0, conclavePluralId(app, "ds_more_participants"))
        assertEquals("[ds_more_participants]", conclavePluralOf(app, "ds_more_participants", 3, 3))
        val framework = object : ContextWrapper(app) {
            override fun getPackageName(): String = "android"
        }
        // A string name is not a plural: the type is part of the lookup.
        assertEquals(0, conclavePluralId(framework, "ok"))
    }

    @Test @Config(qualifiers = "en-rXA") fun pluralFallbackHoldsInThePseudolocale() {
        val app = RuntimeEnvironment.getApplication()
        assertEquals("en", app.resources.configuration.locales[0].language)
        assertEquals("XA", app.resources.configuration.locales[0].country)
        assertEquals("[ds_more_participants]", conclavePluralOf(app, "ds_more_participants", 1, 1))
    }

    @Test fun systemAccessibilityGatesByApiLevel() {
        val old = ConclaveSystemAccessibility.from(api = 28, touchExploration = false, anyServiceEnabled = false, fontScale = 2f,
            fontWeightAdjustment = 300, animatorDurationScale = 1f, contrastLevel = 1f, recommendedTimeoutMillis = 15000)
        assertNull(old.recommendedTimeoutMillis)
        assertNull(old.contrastLevel)
        assertEquals(0, old.fontWeightAdjustment)
        assertFalse(old.boldText)
        assertFalse(old.increasedContrast)
        assertEquals(5000.0, old.state().recommendedTimeoutMillis, 0.0)
        val current = ConclaveSystemAccessibility.from(api = 34, touchExploration = true, anyServiceEnabled = true, fontScale = 2f,
            fontWeightAdjustment = 300, animatorDurationScale = 0f, contrastLevel = 0.5f, recommendedTimeoutMillis = 15000)
        assertTrue(current.boldText)
        assertTrue(current.increasedContrast)
        assertTrue(current.removeAnimations)
        val state = current.state()
        assertTrue(state.isScreenReaderRunning)
        assertTrue(state.reduceMotion)
        assertTrue(state.blocksAutoHide)
        assertEquals(15000.0, state.recommendedTimeoutMillis, 0.0)
        assertFalse(state.isAssistiveAccessRunning)
        val api29 = ConclaveSystemAccessibility.from(api = 29, touchExploration = false, anyServiceEnabled = false, fontScale = 1f,
            fontWeightAdjustment = 300, animatorDurationScale = 1f, contrastLevel = 1f, recommendedTimeoutMillis = 9000)
        assertEquals(9000, api29.recommendedTimeoutMillis)
        assertEquals(0, api29.fontWeightAdjustment)
        assertNull(api29.contrastLevel)
    }

    @Test fun avatarIdentityMatchesTheWebVectors() {
        data class Vector(val name: String, val id: String?, val seed: String, val color: Int, val face: Int, val mouth: Int)
        val vectors = listOf(
            Vector("Guest", null, "Guest", 8, 0, 9),
            Vector("Avery", null, "Avery", 7, 3, 2),
            Vector("Avery", "user-1", "Avery:user-1", 14, 2, 9),
            Vector("", null, "?", 15, 3, 0),
            Vector("Ishaan", null, "Ishaan", 0, 0, 1),
            Vector("Zoë", null, "Zoë", 6, 2, 1),
            Vector("مريم", null, "مريم", 7, 3, 6),
            Vector("李雷", "abc123", "李雷:abc123", 15, 3, 6),
        )
        for (v in vectors) {
            val identity = ConclaveAvatarIdentity.make(name = v.name, id = v.id)
            assertEquals(v.seed, identity.seed)
            assertEquals(v.seed, v.color, identity.paletteIndex)
            assertEquals(v.seed, v.face, identity.faceIndex)
            assertEquals(v.seed, v.mouth, identity.mouthIndex)
        }
        // "Guest" is magenta on Android too (the legacy avatar drew teal).
        assertEquals(0xFFE879F9L, ConclaveAvatarIdentity.make(name = "Guest", id = null).fill)
    }

    @Test fun avatarGeometryCentersTheFace() {
        val layout = ConclaveAvatarGeometry.layout(diameter = 120f, faceIndex = 0, mouthIndex = 0, density = 3f)
        assertEquals(72f, layout.eyesWidth, 0.001f)
        assertEquals(72f / (63f / 15f), layout.eyesHeight, 0.001f)
        assertEquals((120f - 72f) / 2f, layout.eyesLeft, 0.001f)
        val total = layout.eyesHeight + 120f * 0.08f + layout.mouthHeight
        assertEquals((120f - total) / 2f, layout.eyesTop, 0.001f)
        assertEquals(120f * 0.32f, layout.mouthWidth, 0.001f)
        // Small avatars keep the 6 dp minimum mouth and the 1.4 dp minimum stroke, in pixels.
        val small = ConclaveAvatarGeometry.layout(diameter = 24f, faceIndex = 3, mouthIndex = 9, density = 3f)
        assertEquals(18f, small.mouthWidth, 0.001f)
        assertEquals(4.2f, small.strokeWidth, 0.001f)
        for (mouth in 0..9) {
            assertEquals(mouth == 0 || mouth == 3 || mouth == 5 || mouth == 6 || mouth == 7 || mouth == 8, ConclaveAvatarGeometry.strokesMouth(mouth))
        }
    }

    @Test fun tilePolicyMatchesTheSwiftTable() {
        assertEquals(TileChromeDensity.dense, TileChromePolicy.density(width = 160.0, height = 130.0, isSpotlight = false))
        assertEquals(TileChromeDensity.normal, TileChromePolicy.density(width = 167.0, height = 139.0, isSpotlight = false))
        assertEquals(TileChromeDensity.spotlight, TileChromePolicy.density(width = 80.0, height = 80.0, isSpotlight = true))
        assertEquals(30.0, TileChromePolicy.avatarSize(TileChromeDensity.dense), 0.0)
        assertEquals(16.0, TileChromePolicy.badgeSize(TileChromeDensity.dense), 0.0)
        val model = TileChromeModel(userId = "u1", displayName = "Avery", avatarSeed = "Avery:u1", isLocal = false, isMuted = true,
            isCameraOff = false, isHandRaised = true, isPinned = true, isPresenting = false, isWeakConnection = true,
            isReconnecting = false, reconnectReason = "", isHost = false, isVoiceAgent = false)
        val states = TileChromePolicy.states(model, isSpeaking = true)
        assertEquals(listOf(TileChromeStateKind.muted, TileChromeStateKind.speaking, TileChromeStateKind.handRaised,
            TileChromeStateKind.pinned, TileChromeStateKind.weakConnection), states.toList())
        assertEquals(listOf(ConclaveTileBadgeKind.pinned, ConclaveTileBadgeKind.weakConnection), TileChromePolicy.trailingBadges(model).toList())
        assertEquals("u1", model.id)
    }

    @Test fun badgeAndToastRulesHoldThroughTheTranspiledTypes() {
        assertFalse(ConclaveBadgeCount.isVisible(0))
        assertEquals(99, ConclaveBadgeCount.displayed(120))
        assertTrue(ConclaveBadgeCount.isCapped(120))
        assertEquals("99+", conclaveBadgeLabel(120))
        assertEquals(0.0, ConclaveToastTiming.durationMillis(hasAction = true, isScreenReaderRunning = true), 0.0)
        assertEquals(8000.0, ConclaveToastTiming.durationMillis(hasAction = true, isScreenReaderRunning = false), 0.0)
        assertEquals(4000.0, ConclaveToastTiming.durationMillis(hasAction = false, isScreenReaderRunning = true), 0.0)
    }

    @Test fun progressToastUsesAnIndefinitePlatformDuration() {
        fun item(progress: Boolean, action: Boolean) = ConclaveToastItem(
            id = "operation", message = "Ending meeting", actionTitle = if (action) "Retry" else "",
            actionId = if (action) "retry" else "", avatarName = "", avatarId = "",
            isFailure = false, isProgress = progress,
        )
        for (action in listOf(false, true)) {
            assertEquals(androidx.compose.material3.SnackbarDuration.Indefinite, conclaveToastDuration(item(true, action)))
            for (screenReader in listOf(false, true)) {
                assertEquals(0.0, ConclaveToastTiming.durationMillis(hasAction = action,
                    isScreenReaderRunning = screenReader, isProgress = true), 0.0)
            }
        }
        assertEquals(androidx.compose.material3.SnackbarDuration.Short, conclaveToastDuration(item(false, false)))
        assertEquals(androidx.compose.material3.SnackbarDuration.Long, conclaveToastDuration(item(false, true)))
    }

    @Test fun routeIconsFollowTheS30Kinds() {
        assertSame(ConclaveIcons.PhoneInTalkFill0, conclaveRouteIcon("receiver"))
        assertSame(ConclaveIcons.BluetoothFill0, conclaveRouteIcon("bluetooth"))
        assertSame(ConclaveIcons.HeadphonesFill0, conclaveRouteIcon("wired"))
        // CL11 fallback until the usb and hearing concepts land in the manifest.
        assertSame(ConclaveIcons.UsbFill0, conclaveRouteIcon("usb"))
        assertSame(ConclaveIcons.HearingFill0, conclaveRouteIcon("hearingAid"))
        for (kind in listOf("speaker", "unknown")) assertSame(kind, ConclaveIcons.VolumeUpFill0, conclaveRouteIcon(kind))
        assertSame(ConclaveIcons.FrontHandFill1, conclaveTileBadgeIcon(ConclaveTileBadgeKind.handRaised))
        assertNull(conclaveMenuIcon("not_a_concept"))
        assertSame(ConclaveIcons.PersonRemoveFill0, conclaveMenuIcon("remove_person"))
    }

    @Test fun stageLifetimeProbeCountsCreations() {
        val probe = NativeHostingStageLifetime()
        assertEquals(0, probe.creations)
        val first = probe.create()
        val second = probe.create()
        assertEquals(2, probe.creations)
        assertEquals(8, first.length)
        assertTrue(first != second)
    }

    @Test fun surfaceContextsAllowGlassOnTheStageOnly() {
        // The R02 mapping is iOS host code; the shared context rule is what Android sees.
        assertTrue(ConclaveSurfaceContext.stage.allowsGlass)
        assertFalse(ConclaveSurfaceContext.overVideo.allowsGlass)
        assertFalse(ConclaveSurfaceContext.onSurface.allowsGlass)
    }
}
