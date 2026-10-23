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
