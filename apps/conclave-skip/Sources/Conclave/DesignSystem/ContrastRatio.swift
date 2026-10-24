import Foundation

/// Contrast classes for the component gallery's labels (TG 4.2).
enum ContrastRequirement: String, CaseIterable {
    /// Normal-size text: at least 4.5.
    case text
    /// At least 18 pt regular or 14 pt bold: at least 3.0.
    case largeText
    /// Component boundaries and glyphs: at least 3.0.
    case nonText
    /// No requirement. The swatch is labeled decorative and is never a control's only affordance.
    case decorative
    /// Deliberately below 4.5 and labeled as not for text.
    case forbiddenText
}

/// What a gallery row says about a pair. A pair labeled not for text that stays below 4.5 is decorative only;
/// it never reads as passing.
enum ContrastVerdict: String, CaseIterable {
    case passes
    case fails
    case decorativeOnly
}

/// WCAG 2.x contrast in sRGB over ARGB colors stored as Int64, as in DesignTokens. A translucent
/// foreground is composited over the background first; the background is treated as opaque, so a
/// translucent background must be composited over its own base before it is passed in.
enum ContrastRatio {
    static func wcag(foreground: Int64, background: Int64) -> Double {
        let top = composite(foreground, over: background)
        let a = luminance(top)
        let b = luminance(background)
        let lighter = a > b ? a : b
        let darker = a > b ? b : a
        return (lighter + 0.05) / (darker + 0.05)
    }

    /// Source-over compositing onto an opaque background. Channels round to whole values, as an 8-bit display
    /// draws the composite. The archived Appendix C values (6.279, 10.420, 9.985, 1.419, 2.742) come out only
    /// this way; unrounded compositing gives 6.248 for the 56% case. No catalog pair with alpha sits near a
    /// class threshold, so the rounding never decides a verdict there.
    static func composite(_ argb: Int64, over background: Int64) -> Int64 {
        let alpha = component(argb, shift: 24)
        if alpha >= 255 { return argb }
        let opacity = Double(alpha) / 255.0
        let red = blend(component(argb, shift: 16), component(background, shift: 16), opacity)
        let green = blend(component(argb, shift: 8), component(background, shift: 8), opacity)
        let blue = blend(component(argb, shift: 0), component(background, shift: 0), opacity)
        return 4278190080 + red * 65536 + green * 256 + blue
    }

    static func meets(_ ratio: Double, _ requirement: ContrastRequirement) -> Bool {
        switch requirement {
        case .text: return ratio >= 4.5
        case .largeText, .nonText: return ratio >= 3.0
        case .decorative: return true
        case .forbiddenText: return ratio < 4.5
        }
    }

    static func verdict(_ ratio: Double, _ requirement: ContrastRequirement) -> ContrastVerdict {
        if !meets(ratio, requirement) { return .fails }
        return requirement == .forbiddenText ? .decorativeOnly : .passes
    }

    /// Relative luminance of the color's RGB channels; alpha is ignored.
    static func luminance(_ argb: Int64) -> Double {
        let red = linear(component(argb, shift: 16))
        let green = linear(component(argb, shift: 8))
        let blue = linear(component(argb, shift: 0))
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue
    }

    /// Division and remainder instead of bit operators keep the transpiled Kotlin in Long arithmetic.
    private static func component(_ argb: Int64, shift: Int) -> Int64 {
        var value = argb
        if shift == 24 { value = value / 16777216 }
        if shift == 16 { value = value / 65536 }
        if shift == 8 { value = value / 256 }
        return value % 256
    }

    private static func blend(_ top: Int64, _ bottom: Int64, _ opacity: Double) -> Int64 {
        let mixed = Double(top) * opacity + Double(bottom) * (1.0 - opacity)
        return Int64(mixed + 0.5)
    }

    private static func linear(_ channel: Int64) -> Double {
        let value = Double(channel) / 255.0
        if value <= 0.04045 { return value / 12.92 }
        return pow((value + 0.055) / 1.055, 2.4)
    }
}
