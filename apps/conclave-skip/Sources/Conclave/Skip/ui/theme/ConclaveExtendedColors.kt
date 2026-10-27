package conclave.module

import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/*
 * Extended color roles (F00 2.5, 2.6 A4): the functional and in-call colors Material 3 has no role for. Screens
 * read LocalConclaveExtendedColors.current, which HostingTheme(inCall:) provides, so a screen never picks a
 * ...Light or ...Dark token itself. Every value is a generated DesignTokens constant. In-call equals dark. The
 * high-contrast border and scrim exist in the tokens and are selected here only when WP4 maps the contrast reader
 * (owner Q10); HostingTheme passes highContrast = false until then.
 */

internal data class ConclaveExtendedColors(
    val success: Color,
    val warning: Color,
    val live: Color,
    val onWarning: Color,
    val onLive: Color,
    val handRaised: Color,
    /** The 2 dp speaking stroke. */
    val speaking: Color,
    /** Leave: white glyph on callEnd is 3.923, glyph only. */
    val callEnd: Color,
    val onCallEnd: Color,
    val stage: Color,
    val tile: Color,
    /** Flat translucent black behind text and chrome over video (64%, 80% high contrast). */
    val labelScrim: Color,
    val toolbar: Color,
    val toggleOnContainer: Color,
    val onToggleOn: Color,
    val toggleOffContainer: Color,
    val onToggleOff: Color,
    val toggleEngagedContainer: Color,
    val onToggleEngaged: Color,
    /** 1 dp decorative borders: 8% black light, 14% paper dark (32% each under high contrast). */
    val border: Color,
)

/** The resolved set for one appearance. In-call surfaces pass dark = true. */
internal fun conclaveExtendedColors(dark: Boolean, highContrast: Boolean = false): ConclaveExtendedColors =
    ConclaveExtendedColors(
        success = Color(if (dark) DesignTokens.androidExtendedSuccessDark else DesignTokens.androidExtendedSuccessLight),
        warning = Color(if (dark) DesignTokens.androidExtendedWarningDark else DesignTokens.androidExtendedWarningLight),
        live = Color(if (dark) DesignTokens.androidExtendedLiveDark else DesignTokens.androidExtendedLiveLight),
        onWarning = Color(if (dark) DesignTokens.androidExtendedOnWarningDark else DesignTokens.androidExtendedOnWarningLight),
        onLive = Color(if (dark) DesignTokens.androidExtendedOnLiveDark else DesignTokens.androidExtendedOnLiveLight),
        handRaised = Color(if (dark) DesignTokens.androidExtendedHandRaisedDark else DesignTokens.androidExtendedHandRaisedLight),
        speaking = Color(DesignTokens.androidExtendedSpeaking),
        callEnd = Color(DesignTokens.androidExtendedCallEnd),
        onCallEnd = Color(DesignTokens.androidExtendedOnCallEnd),
        stage = Color(DesignTokens.androidExtendedStage),
        tile = Color(DesignTokens.androidExtendedTile),
        labelScrim = Color(if (highContrast) DesignTokens.androidExtendedLabelScrimHighContrast else DesignTokens.androidExtendedLabelScrim),
        toolbar = Color(DesignTokens.androidExtendedToolbarContainer),
        toggleOnContainer = Color(DesignTokens.androidExtendedToggleOnContainer),
        onToggleOn = Color(DesignTokens.androidExtendedOnToggleOn),
        toggleOffContainer = Color(DesignTokens.androidExtendedToggleOffContainer),
        onToggleOff = Color(DesignTokens.androidExtendedOnToggleOff),
        toggleEngagedContainer = Color(DesignTokens.androidExtendedToggleEngagedContainer),
        onToggleEngaged = Color(DesignTokens.androidExtendedOnToggleEngaged),
        border = Color(when {
            dark && highContrast -> DesignTokens.androidExtendedBorderDarkHighContrast
            dark -> DesignTokens.androidExtendedBorderDark
            highContrast -> DesignTokens.androidExtendedBorderLightHighContrast
            else -> DesignTokens.androidExtendedBorderLight
        }),
    )

internal val ConclaveExtendedColorsLight = conclaveExtendedColors(dark = false)
internal val ConclaveExtendedColorsDark = conclaveExtendedColors(dark = true)

/** Provided by HostingTheme; the light set outside any theme (previews and host tests). */
internal val LocalConclaveExtendedColors = staticCompositionLocalOf { ConclaveExtendedColorsLight }
