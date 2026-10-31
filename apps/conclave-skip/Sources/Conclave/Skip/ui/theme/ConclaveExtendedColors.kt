package conclave.module

import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

internal data class ConclaveExtendedColors(
    val success: Color,
    val warning: Color,
    val live: Color,
    val onWarning: Color,
    val onLive: Color,
    val handRaised: Color,

    val speaking: Color,

    val callEnd: Color,
    val onCallEnd: Color,
    val stage: Color,
    val tile: Color,

    val labelScrim: Color,
    val toolbar: Color,
    val toggleOnContainer: Color,
    val onToggleOn: Color,
    val toggleOffContainer: Color,
    val onToggleOff: Color,
    val toggleEngagedContainer: Color,
    val onToggleEngaged: Color,

    val border: Color,

    val gameBoardLight: Color,
    val gameBoardDark: Color,
)

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
        gameBoardLight = Color(DesignTokens.androidExtendedGameBoardLight),
        gameBoardDark = Color(DesignTokens.androidExtendedGameBoardDark),
    )

internal val ConclaveExtendedColorsLight = conclaveExtendedColors(dark = false)
internal val ConclaveExtendedColorsDark = conclaveExtendedColors(dark = true)

internal val LocalConclaveExtendedColors = staticCompositionLocalOf { ConclaveExtendedColorsLight }
