package conclave.module

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color

private val HostingLightColors = lightColorScheme(
    primary = Color(DesignTokens.androidLightPrimary),
    onPrimary = Color(DesignTokens.androidLightOnPrimary),
    primaryContainer = Color(DesignTokens.androidLightPrimaryContainer),
    onPrimaryContainer = Color(DesignTokens.androidLightOnPrimaryContainer),
    inversePrimary = Color(DesignTokens.androidLightInversePrimary),
    secondary = Color(DesignTokens.androidLightSecondary),
    onSecondary = Color(DesignTokens.androidLightOnSecondary),
    secondaryContainer = Color(DesignTokens.androidLightSecondaryContainer),
    onSecondaryContainer = Color(DesignTokens.androidLightOnSecondaryContainer),
    tertiary = Color(DesignTokens.androidLightTertiary),
    onTertiary = Color(DesignTokens.androidLightOnTertiary),
    tertiaryContainer = Color(DesignTokens.androidLightTertiaryContainer),
    onTertiaryContainer = Color(DesignTokens.androidLightOnTertiaryContainer),
    background = Color(DesignTokens.androidLightBackground),
    onBackground = Color(DesignTokens.androidLightOnBackground),
    surface = Color(DesignTokens.androidLightSurface),
    onSurface = Color(DesignTokens.androidLightOnSurface),
    surfaceVariant = Color(DesignTokens.androidLightSurfaceVariant),
    onSurfaceVariant = Color(DesignTokens.androidLightOnSurfaceVariant),
    surfaceTint = Color(DesignTokens.androidLightSurfaceTint),
    inverseSurface = Color(DesignTokens.androidLightInverseSurface),
    inverseOnSurface = Color(DesignTokens.androidLightInverseOnSurface),
    error = Color(DesignTokens.androidLightError),
    onError = Color(DesignTokens.androidLightOnError),
    errorContainer = Color(DesignTokens.androidLightErrorContainer),
    onErrorContainer = Color(DesignTokens.androidLightOnErrorContainer),
    outline = Color(DesignTokens.androidLightOutline),
    outlineVariant = Color(DesignTokens.androidLightOutlineVariant),
    scrim = Color(DesignTokens.androidLightScrim),
    surfaceBright = Color(DesignTokens.androidLightSurfaceBright),
    surfaceDim = Color(DesignTokens.androidLightSurfaceDim),
    surfaceContainerLowest = Color(DesignTokens.androidLightSurfaceContainerLowest),
    surfaceContainerLow = Color(DesignTokens.androidLightSurfaceContainerLow),
    surfaceContainer = Color(DesignTokens.androidLightSurfaceContainer),
    surfaceContainerHigh = Color(DesignTokens.androidLightSurfaceContainerHigh),
    surfaceContainerHighest = Color(DesignTokens.androidLightSurfaceContainerHighest),
    primaryFixed = Color(DesignTokens.androidLightPrimaryFixed),
    primaryFixedDim = Color(DesignTokens.androidLightPrimaryFixedDim),
    onPrimaryFixed = Color(DesignTokens.androidLightOnPrimaryFixed),
    onPrimaryFixedVariant = Color(DesignTokens.androidLightOnPrimaryFixedVariant),
    secondaryFixed = Color(DesignTokens.androidLightSecondaryFixed),
    secondaryFixedDim = Color(DesignTokens.androidLightSecondaryFixedDim),
    onSecondaryFixed = Color(DesignTokens.androidLightOnSecondaryFixed),
    onSecondaryFixedVariant = Color(DesignTokens.androidLightOnSecondaryFixedVariant),
    tertiaryFixed = Color(DesignTokens.androidLightTertiaryFixed),
    tertiaryFixedDim = Color(DesignTokens.androidLightTertiaryFixedDim),
    onTertiaryFixed = Color(DesignTokens.androidLightOnTertiaryFixed),
    onTertiaryFixedVariant = Color(DesignTokens.androidLightOnTertiaryFixedVariant),
)

private val HostingDarkColors = darkColorScheme(
    primary = Color(DesignTokens.androidDarkPrimary),
    onPrimary = Color(DesignTokens.androidDarkOnPrimary),
    primaryContainer = Color(DesignTokens.androidDarkPrimaryContainer),
    onPrimaryContainer = Color(DesignTokens.androidDarkOnPrimaryContainer),
    inversePrimary = Color(DesignTokens.androidDarkInversePrimary),
    secondary = Color(DesignTokens.androidDarkSecondary),
    onSecondary = Color(DesignTokens.androidDarkOnSecondary),
    secondaryContainer = Color(DesignTokens.androidDarkSecondaryContainer),
    onSecondaryContainer = Color(DesignTokens.androidDarkOnSecondaryContainer),
    tertiary = Color(DesignTokens.androidDarkTertiary),
    onTertiary = Color(DesignTokens.androidDarkOnTertiary),
    tertiaryContainer = Color(DesignTokens.androidDarkTertiaryContainer),
    onTertiaryContainer = Color(DesignTokens.androidDarkOnTertiaryContainer),
    background = Color(DesignTokens.androidDarkBackground),
    onBackground = Color(DesignTokens.androidDarkOnBackground),
    surface = Color(DesignTokens.androidDarkSurface),
    onSurface = Color(DesignTokens.androidDarkOnSurface),
    surfaceVariant = Color(DesignTokens.androidDarkSurfaceVariant),
    onSurfaceVariant = Color(DesignTokens.androidDarkOnSurfaceVariant),
    surfaceTint = Color(DesignTokens.androidDarkSurfaceTint),
    inverseSurface = Color(DesignTokens.androidDarkInverseSurface),
    inverseOnSurface = Color(DesignTokens.androidDarkInverseOnSurface),
    error = Color(DesignTokens.androidDarkError),
    onError = Color(DesignTokens.androidDarkOnError),
    errorContainer = Color(DesignTokens.androidDarkErrorContainer),
    onErrorContainer = Color(DesignTokens.androidDarkOnErrorContainer),
    outline = Color(DesignTokens.androidDarkOutline),
    outlineVariant = Color(DesignTokens.androidDarkOutlineVariant),
    scrim = Color(DesignTokens.androidDarkScrim),
    surfaceBright = Color(DesignTokens.androidDarkSurfaceBright),
    surfaceDim = Color(DesignTokens.androidDarkSurfaceDim),
    surfaceContainerLowest = Color(DesignTokens.androidDarkSurfaceContainerLowest),
    surfaceContainerLow = Color(DesignTokens.androidDarkSurfaceContainerLow),
    surfaceContainer = Color(DesignTokens.androidDarkSurfaceContainer),
    surfaceContainerHigh = Color(DesignTokens.androidDarkSurfaceContainerHigh),
    surfaceContainerHighest = Color(DesignTokens.androidDarkSurfaceContainerHighest),
    primaryFixed = Color(DesignTokens.androidDarkPrimaryFixed),
    primaryFixedDim = Color(DesignTokens.androidDarkPrimaryFixedDim),
    onPrimaryFixed = Color(DesignTokens.androidDarkOnPrimaryFixed),
    onPrimaryFixedVariant = Color(DesignTokens.androidDarkOnPrimaryFixedVariant),
    secondaryFixed = Color(DesignTokens.androidDarkSecondaryFixed),
    secondaryFixedDim = Color(DesignTokens.androidDarkSecondaryFixedDim),
    onSecondaryFixed = Color(DesignTokens.androidDarkOnSecondaryFixed),
    onSecondaryFixedVariant = Color(DesignTokens.androidDarkOnSecondaryFixedVariant),
    tertiaryFixed = Color(DesignTokens.androidDarkTertiaryFixed),
    tertiaryFixedDim = Color(DesignTokens.androidDarkTertiaryFixedDim),
    onTertiaryFixed = Color(DesignTokens.androidDarkOnTertiaryFixed),
    onTertiaryFixedVariant = Color(DesignTokens.androidDarkOnTertiaryFixedVariant),
)

private val HostingInCallColors = darkColorScheme(
    primary = Color(DesignTokens.androidInCallPrimary),
    onPrimary = Color(DesignTokens.androidInCallOnPrimary),
    primaryContainer = Color(DesignTokens.androidInCallPrimaryContainer),
    onPrimaryContainer = Color(DesignTokens.androidInCallOnPrimaryContainer),
    inversePrimary = Color(DesignTokens.androidInCallInversePrimary),
    secondary = Color(DesignTokens.androidInCallSecondary),
    onSecondary = Color(DesignTokens.androidInCallOnSecondary),
    secondaryContainer = Color(DesignTokens.androidInCallSecondaryContainer),
    onSecondaryContainer = Color(DesignTokens.androidInCallOnSecondaryContainer),
    tertiary = Color(DesignTokens.androidInCallTertiary),
    onTertiary = Color(DesignTokens.androidInCallOnTertiary),
    tertiaryContainer = Color(DesignTokens.androidInCallTertiaryContainer),
    onTertiaryContainer = Color(DesignTokens.androidInCallOnTertiaryContainer),
    background = Color(DesignTokens.androidInCallBackground),
    onBackground = Color(DesignTokens.androidInCallOnBackground),
    surface = Color(DesignTokens.androidInCallSurface),
    onSurface = Color(DesignTokens.androidInCallOnSurface),
    surfaceVariant = Color(DesignTokens.androidInCallSurfaceVariant),
    onSurfaceVariant = Color(DesignTokens.androidInCallOnSurfaceVariant),
    surfaceTint = Color(DesignTokens.androidInCallSurfaceTint),
    inverseSurface = Color(DesignTokens.androidInCallInverseSurface),
    inverseOnSurface = Color(DesignTokens.androidInCallInverseOnSurface),
    error = Color(DesignTokens.androidInCallError),
    onError = Color(DesignTokens.androidInCallOnError),
    errorContainer = Color(DesignTokens.androidInCallErrorContainer),
    onErrorContainer = Color(DesignTokens.androidInCallOnErrorContainer),
    outline = Color(DesignTokens.androidInCallOutline),
    outlineVariant = Color(DesignTokens.androidInCallOutlineVariant),
    scrim = Color(DesignTokens.androidInCallScrim),
    surfaceBright = Color(DesignTokens.androidInCallSurfaceBright),
    surfaceDim = Color(DesignTokens.androidInCallSurfaceDim),
    surfaceContainerLowest = Color(DesignTokens.androidInCallSurfaceContainerLowest),
    surfaceContainerLow = Color(DesignTokens.androidInCallSurfaceContainerLow),
    surfaceContainer = Color(DesignTokens.androidInCallSurfaceContainer),
    surfaceContainerHigh = Color(DesignTokens.androidInCallSurfaceContainerHigh),
    surfaceContainerHighest = Color(DesignTokens.androidInCallSurfaceContainerHighest),
    primaryFixed = Color(DesignTokens.androidInCallPrimaryFixed),
    primaryFixedDim = Color(DesignTokens.androidInCallPrimaryFixedDim),
    onPrimaryFixed = Color(DesignTokens.androidInCallOnPrimaryFixed),
    onPrimaryFixedVariant = Color(DesignTokens.androidInCallOnPrimaryFixedVariant),
    secondaryFixed = Color(DesignTokens.androidInCallSecondaryFixed),
    secondaryFixedDim = Color(DesignTokens.androidInCallSecondaryFixedDim),
    onSecondaryFixed = Color(DesignTokens.androidInCallOnSecondaryFixed),
    onSecondaryFixedVariant = Color(DesignTokens.androidInCallOnSecondaryFixedVariant),
    tertiaryFixed = Color(DesignTokens.androidInCallTertiaryFixed),
    tertiaryFixedDim = Color(DesignTokens.androidInCallTertiaryFixedDim),
    onTertiaryFixed = Color(DesignTokens.androidInCallOnTertiaryFixed),
    onTertiaryFixedVariant = Color(DesignTokens.androidInCallOnTertiaryFixedVariant),
)

private val HostingShapes = Shapes()

@Composable
internal fun HostingTheme(inCall: Boolean = false, content: @Composable () -> Unit) {
    val dark = conclaveUsesDarkAppearance() || inCall
    CompositionLocalProvider(LocalConclaveExtendedColors provides if (dark) ConclaveExtendedColorsDark else ConclaveExtendedColorsLight) {
        MaterialTheme(
            colorScheme = when {
                inCall -> HostingInCallColors
                dark -> HostingDarkColors
                else -> HostingLightColors
            },
            typography = ConclaveTypography,
            shapes = HostingShapes,
            content = content,
        )
    }
}

@Composable
internal fun conclaveUsesDarkAppearance(): Boolean =
    AppearancePreference.shared.mode.usesDarkAppearance(systemIsDark = isSystemInDarkTheme())
