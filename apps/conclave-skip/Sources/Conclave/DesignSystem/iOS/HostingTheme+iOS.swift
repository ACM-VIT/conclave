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

    // MARK: In-call members with an Increase Contrast twin (F00 2.6 A1)

    // `token(_:)` is fixed and ignores Increase Contrast, so every in-call token with a high-contrast twin gets a
    // trait-resolving member here. In-call surfaces are always dark, so only the contrast trait selects.

    /// Subtitles: 74% paper, 90% under Increase Contrast (10.420 on the stage).
    static let inCallTextSecondary = contrastPair(DesignTokens.iosInCallTextSecondary, DesignTokens.iosInCallTextSecondaryHighContrast)
    /// Timestamps and hints: 56% paper, 74% under Increase Contrast (6.279 on the stage).
    static let inCallTextTertiary = contrastPair(DesignTokens.iosInCallTextTertiary, DesignTokens.iosInCallTextTertiaryHighContrast)
    /// Decorative 1 pt borders and inner strokes: 14%, 32% under Increase Contrast.
    static let inCallBorder = contrastPair(DesignTokens.iosInCallBorder, DesignTokens.iosInCallBorderHighContrast)
    /// Dividers that must read under Increase Contrast: 24%, 40%.
    static let inCallBorderStrong = contrastPair(DesignTokens.iosInCallBorderStrong, DesignTokens.iosInCallBorderStrongHighContrast)
    /// Flat translucent black behind text over video: 64%, 80% under Increase Contrast.
    static let inCallLabelScrim = contrastPair(DesignTokens.iosInCallLabelScrim, DesignTokens.iosInCallLabelScrimHighContrast)
    /// Ink on the in-call coral fill: ink, black under Increase Contrast.
    static let inCallOnCoral = contrastPair(DesignTokens.iosInCallOnCoral, DesignTokens.iosInCallOnCoralHighContrast)
    /// Coral as text or a small glyph on the dark stage (toast actions, links): 6.246 on the raised surface.
    static let inCallCoralText = contrastPair(DesignTokens.iosInCallCoralText, DesignTokens.iosInCallCoralTextHighContrast)

    // MARK: Leave (F00 2.6 A2, owner OQ4)

    /// The Leave fill: dynamic system red at standard contrast (3.433 for the white glyph on iOS 26 dark), and the
    /// approved fixed `iosInCallLeaveHighContrast` `#E9152D` under Increase Contrast (white glyph 4.555, boundary
    /// against the stage 4.344), because the dynamic high-contrast red gives the glyph only 2.937.
    static let inCallLeave = Color(uiColor: UIColor { traits in
        if traits.accessibilityContrast == .high { return color(DesignTokens.iosInCallLeaveHighContrast) }
        return UIColor.systemRed.resolvedColor(with: traits)
    })

    // MARK: Status colors (F00 2.6 A3)

    /// Functional status glyphs and text in system-appearance screens: the light tokens on light backgrounds
    /// (7.090 to 7.130 on white), the dark tokens in dark mode. Neither needs a separate high-contrast value.
    static let statusSuccess = appearancePair(light: DesignTokens.successLight, dark: DesignTokens.successDark)
    static let statusWarning = appearancePair(light: DesignTokens.warningLight, dark: DesignTokens.warningDark)
    /// The webinar Live tag (S10 R5).
    static let statusLive = appearancePair(light: DesignTokens.liveLight, dark: DesignTokens.liveDark)

    // MARK: Disabled opacity (F00 2.6 A6)

    /// R02: the one iOS disabled opacity.
    static let disabledOpacity = ConclaveDisabledOpacity.ios

    /// A fixed generated token as a SwiftUI color. This file stays the single token-to-color adapter.
    static func token(_ argb: Int64) -> Color {
        Color(uiColor: color(argb))
    }

    /// A token pair selected by the Increase Contrast trait only.
    private static func contrastPair(_ standard: Int64, _ highContrast: Int64) -> Color {
        Color(uiColor: UIColor { traits in
            color(traits.accessibilityContrast == .high ? highContrast : standard)
        })
    }

    /// A token pair selected by the light or dark appearance.
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
