#if os(iOS) && !SKIP
import SwiftUI
import UIKit

enum HostingTheme {
    static let coralFill = Color(uiColor: color(DesignTokens.coral))
    static let onCoral = Color(uiColor: UIColor { traits in
        color(traits.accessibilityContrast == .high ? DesignTokens.iosAppOnCoralHighContrast : DesignTokens.iosAppOnCoral)
    })
    static let coralText = Color(uiColor: UIColor { traits in
        let highContrast = traits.accessibilityContrast == .high
        let argb: Int64
        if traits.userInterfaceStyle == .dark {
            argb = highContrast ? DesignTokens.coralBrightHighContrast : DesignTokens.coralBright
        } else {
            argb = highContrast ? DesignTokens.coralDeepHighContrast : DesignTokens.coralDeep
        }
        return color(argb)
    })
    static let secondaryText = Color(uiColor: UIColor { traits in
        if traits.userInterfaceStyle == .dark { return .secondaryLabel }
        return color(traits.accessibilityContrast == .high ? DesignTokens.iosAppTextSecondaryLightHighContrast : DesignTokens.iosAppTextSecondaryLight)
    })

    static let inCallTextSecondary = contrastPair(DesignTokens.iosInCallTextSecondary, DesignTokens.iosInCallTextSecondaryHighContrast)

    static let inCallTextTertiary = contrastPair(DesignTokens.iosInCallTextTertiary, DesignTokens.iosInCallTextTertiaryHighContrast)

    static let inCallBorder = contrastPair(DesignTokens.iosInCallBorder, DesignTokens.iosInCallBorderHighContrast)

    static let inCallBorderStrong = contrastPair(DesignTokens.iosInCallBorderStrong, DesignTokens.iosInCallBorderStrongHighContrast)

    static let inCallLabelScrim = contrastPair(DesignTokens.iosInCallLabelScrim, DesignTokens.iosInCallLabelScrimHighContrast)

    static let inCallOnCoral = contrastPair(DesignTokens.iosInCallOnCoral, DesignTokens.iosInCallOnCoralHighContrast)

    static let inCallCoralText = contrastPair(DesignTokens.iosInCallCoralText, DesignTokens.iosInCallCoralTextHighContrast)

    static let inCallLeave = Color(uiColor: UIColor { traits in
        if traits.accessibilityContrast == .high { return color(DesignTokens.iosInCallLeaveHighContrast) }
        return UIColor.systemRed.resolvedColor(with: traits)
    })

    static let statusSuccess = appearancePair(light: DesignTokens.successLight, dark: DesignTokens.successDark)
    static let statusWarning = appearancePair(light: DesignTokens.warningLight, dark: DesignTokens.warningDark)

    static let statusLive = appearancePair(light: DesignTokens.liveLight, dark: DesignTokens.liveDark)

    static let disabledOpacity = ConclaveDisabledOpacity.ios

    static func token(_ argb: Int64) -> Color {
        Color(uiColor: color(argb))
    }

    private static func contrastPair(_ standard: Int64, _ highContrast: Int64) -> Color {
        Color(uiColor: UIColor { traits in
            color(traits.accessibilityContrast == .high ? highContrast : standard)
        })
    }

    private static func appearancePair(light: Int64, dark: Int64) -> Color {
        Color(uiColor: UIColor { traits in
            color(traits.userInterfaceStyle == .dark ? dark : light)
        })
    }

    private static func color(_ argb: Int64) -> UIColor {
        UIColor(
            red: CGFloat((argb >> 16) & 0xFF) / 255,
            green: CGFloat((argb >> 8) & 0xFF) / 255,
            blue: CGFloat(argb & 0xFF) / 255,
            alpha: CGFloat((argb >> 24) & 0xFF) / 255
        )
    }
}
#endif
