package conclave.module

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight

internal val ConclaveTypography = Typography()

internal fun ConclaveTextStyle.role(typography: Typography): TextStyle = when (this) {
    ConclaveTextStyle.largeTitle -> typography.headlineLarge
    ConclaveTextStyle.title -> typography.headlineMedium
    ConclaveTextStyle.title2 -> typography.headlineSmall
    ConclaveTextStyle.title3 -> typography.titleLarge
    ConclaveTextStyle.headline -> typography.titleMedium
    ConclaveTextStyle.body -> typography.bodyLarge
    ConclaveTextStyle.callout -> typography.bodyLarge
    ConclaveTextStyle.subheadline -> typography.bodyMedium
    ConclaveTextStyle.footnote -> typography.bodySmall
    ConclaveTextStyle.caption -> typography.bodySmall
    ConclaveTextStyle.caption2 -> typography.labelSmall
}

internal val ConclaveTextWeight.fontWeight: FontWeight
    get() = when (this) {
        ConclaveTextWeight.regular -> FontWeight.W400
        ConclaveTextWeight.medium -> FontWeight.W500
        ConclaveTextWeight.semibold -> FontWeight.W600
        ConclaveTextWeight.bold -> FontWeight.W700
    }

internal fun ConclaveTextStyle.textStyle(typography: Typography, weight: ConclaveTextWeight): TextStyle {
    val role = role(typography)
    val target = weight.fontWeight
    return if (role.fontWeight == target) role else role.copy(fontWeight = target)
}

@Composable
internal fun ConclaveTextStyle.textStyle(weight: ConclaveTextWeight = ConclaveTextWeight.regular): TextStyle {
    val typography = MaterialTheme.typography
    return remember(this, weight, typography) { textStyle(typography, weight) }
}

internal fun TextStyle.tabular(): TextStyle = copy(fontFeatureSettings = "tnum")

internal fun TextStyle.monospaced(): TextStyle = copy(fontFamily = FontFamily.Monospace)

@Composable
internal fun rememberTabular(style: TextStyle): TextStyle = remember(style) { style.tabular() }
