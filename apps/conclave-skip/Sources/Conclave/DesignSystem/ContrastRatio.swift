import Foundation

enum ContrastRequirement: String, CaseIterable {

    case text

    case largeText

    case nonText

    case decorative

    case forbiddenText
}

enum ContrastVerdict: String, CaseIterable {
    case passes
    case fails
    case decorativeOnly
}

enum ContrastRatio {
    static func wcag(foreground: Int64, background: Int64) -> Double {
        let top = composite(foreground, over: background)
        let a = luminance(top)
        let b = luminance(background)
        let lighter = a > b ? a : b
        let darker = a > b ? b : a
        return (lighter + 0.05) / (darker + 0.05)
    }

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

    static func luminance(_ argb: Int64) -> Double {
        let red = linear(component(argb, shift: 16))
        let green = linear(component(argb, shift: 8))
        let blue = linear(component(argb, shift: 0))
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue
    }

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
