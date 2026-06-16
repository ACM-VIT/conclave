//
//  Theme.swift
//  Conclave
//
//  Design System — "Carbon" palette, shared 1:1 with the web app
//  (packages/ui-tokens). Flat surfaces, brand hues, NO gradients / glows /
//  monospace. Active speaker = 2px solid accent border (no halo). This file is
//  the single source of truth for native color/spacing/type, mirroring the
//  TypeScript token tree so web and native render identically.
//

import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

func acmColor(red: Double, green: Double, blue: Double, opacity: Double = 1.0) -> Color {
    Color(red: red / 255.0, green: green / 255.0, blue: blue / 255.0, opacity: opacity)
}

func acmColor01(red: Double, green: Double, blue: Double, opacity: Double = 1.0) -> Color {
    Color(red: red, green: green, blue: blue, opacity: opacity)
}

// MARK: - Colors (Carbon — mirrors @conclave/ui-tokens `color`)

enum ACMColors {
    // Brand hues (kept).
    static let primaryOrange = acmColor(red: 249.0, green: 95.0, blue: 74.0)   // accent  #F95F4A
    static let primaryPink = acmColor(red: 255.0, green: 0.0, blue: 122.0)     // accent2 #FF007A

    // Semantic Carbon aliases (preferred names — match the web token tree).
    static let accent = primaryOrange
    static let accentSecondary = primaryPink
    static let bg = acmColor(red: 10.0, green: 10.0, blue: 11.0)               // #0a0a0b
    static let bgAlt = acmColor(red: 19.0, green: 19.0, blue: 22.0)            // #131316 (tile)
    static let surfaceRaised = acmColor(red: 35.0, green: 35.0, blue: 39.0)    // #232327
    static let text = acmColor(red: 250.0, green: 250.0, blue: 250.0)         // #fafafa
    static let textMuted = acmColor(red: 250.0, green: 250.0, blue: 250.0, opacity: 0.74)
    static let textFaint = acmColor(red: 250.0, green: 250.0, blue: 250.0, opacity: 0.56)
    static let border = acmColor(red: 250.0, green: 250.0, blue: 250.0, opacity: 0.14)
    static let borderStrong = acmColor(red: 250.0, green: 250.0, blue: 250.0, opacity: 0.24)
    static let scrim = acmColor(red: 0.0, green: 0.0, blue: 0.0, opacity: 0.7)
    static let speaking = primaryOrange

    // Legacy names (kept so existing views compile) — repointed onto Carbon.
    static let cream = text                                                    // primary text → #fafafa
    static let dark = bg                                                       // app background
    static let darkAlt = bgAlt
    static let surface = acmColor(red: 24.0, green: 24.0, blue: 27.0)          // #18181b
    static let surfaceLight = surfaceRaised
    static let surfaceHover = acmColor(red: 46.0, green: 46.0, blue: 51.0)     // #2e2e33

    // Text tints (white-based, descending opacity — replaces the old cream tints).
    static let creamLight = acmColor(red: 250.0, green: 250.0, blue: 250.0, opacity: 0.74)
    static let creamDim = acmColor(red: 250.0, green: 250.0, blue: 250.0, opacity: 0.56)
    static let creamMuted = acmColor(red: 250.0, green: 250.0, blue: 250.0, opacity: 0.40)
    static let creamSubtle = acmColor(red: 250.0, green: 250.0, blue: 250.0, opacity: 0.14)
    static let creamFaint = acmColor(red: 250.0, green: 250.0, blue: 250.0, opacity: 0.10)
    static let creamGhost = acmColor(red: 250.0, green: 250.0, blue: 250.0, opacity: 0.05)

    // Accent tints.
    static let primaryOrangeDim = acmColor(red: 249.0, green: 95.0, blue: 74.0, opacity: 0.6)
    static let primaryOrangeFaint = acmColor(red: 249.0, green: 95.0, blue: 74.0, opacity: 0.15)
    static let primaryOrangeGhost = acmColor(red: 249.0, green: 95.0, blue: 74.0, opacity: 0.2)
    static let primaryPinkFaint = acmColor(red: 255.0, green: 0.0, blue: 122.0, opacity: 0.3)
    static let primaryPinkGhost = acmColor(red: 255.0, green: 0.0, blue: 122.0, opacity: 0.2)

    // Glow tints — kept for source compatibility but NEUTRALISED (fully clear)
    // so any lingering `.shadow(color:)` renders nothing. Flat design: no halos.
    static let primaryOrangeSoft = Color.clear
    static let primaryPinkSoft = Color.clear

    static let error = acmColor(red: 234.0, green: 67.0, blue: 53.0)           // danger #ea4335
    static let errorDim = acmColor(red: 234.0, green: 67.0, blue: 53.0, opacity: 0.6)
    static let success = acmColor(red: 34.0, green: 197.0, blue: 94.0)         // #22c55e
    static let black = acmColor(red: 0.0, green: 0.0, blue: 0.0)
    static let white = acmColor(red: 255.0, green: 255.0, blue: 255.0)
    static let overlay50 = acmColor(red: 0.0, green: 0.0, blue: 0.0, opacity: 0.5)

    static func blackOverlay(_ opacity: Double) -> Color {
        acmColor(red: 0.0, green: 0.0, blue: 0.0, opacity: opacity)
    }

    // Avatar palette — mirrors `@conclave/ui-tokens` AVATAR_PALETTE EXACTLY so
    // web + native give each person the same colour family. Flat solids only.
    static let avatarPalette: [Color] = [
        acmColor(red: 249.0, green: 95.0, blue: 74.0),    // #F95F4A orange
        acmColor(red: 255.0, green: 0.0, blue: 122.0),    // #FF007A pink
        acmColor(red: 124.0, green: 92.0, blue: 255.0),   // #7C5CFF violet
        acmColor(red: 45.0, green: 168.0, blue: 168.0),   // #2DA8A8 teal
        acmColor(red: 79.0, green: 134.0, blue: 247.0),   // #4F86F7 blue
        acmColor(red: 63.0, green: 166.0, blue: 106.0),   // #3FA66A green
        acmColor(red: 224.0, green: 145.0, blue: 58.0),   // #E0913A amber
        acmColor(red: 196.0, green: 78.0, blue: 207.0)    // #C44ECF magenta
    ]

    /// Deterministic avatar fill. Ports the EXACT `@conclave/ui-tokens`
    /// `avatarColor` algorithm so web + native map a given string to the same
    /// palette index: trim the key, hash each UTF-16 code unit with the classic
    /// `hash = (hash << 5) - hash + code` (forced to 32-bit signed after every
    /// step, mirroring JS `hash |= 0`), then `abs(hash) % palette.count`.
    /// Overflow-safe in Swift via `Int32` wrapping operators (`&<<`/`&-`/`&+`),
    /// which truncate to 32 bits identically to JS `|0`.
    static func avatarColor(for key: String) -> Color {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if avatarPalette.isEmpty { return primaryOrange }
        if trimmed.isEmpty { return avatarPalette[0] }
        var hash: Int32 = 0
        for unit in trimmed.utf16 {
            // (hash << 5) - hash == hash * 31, kept 32-bit signed via wrapping
            // (`&*`/`&+` truncate to 32 bits identically to JS `hash |= 0`).
            hash = hash &* 31 &+ Int32(unit)
        }
        // Math.abs(hash) % len, widened to 64-bit so Int32.min maps to
        // 2147483648 (as JS does) instead of trapping on a 32-bit negate.
        let magnitude: Int64 = abs(Int64(hash))
        let index = Int(magnitude % Int64(avatarPalette.count))
        return avatarPalette[index]
    }

    // MARK: - Hand Raised Colors (amber accent, matches web)
    static let handRaised = acmColor(red: 251.0, green: 191.0, blue: 36.0, opacity: 0.95)        // amber-400
    static let handRaisedBackground = acmColor(red: 251.0, green: 191.0, blue: 36.0, opacity: 0.2)
    static let handRaisedBorder = acmColor(red: 251.0, green: 191.0, blue: 36.0, opacity: 0.4)
    static let handRaisedShadow = Color.clear // neutralised — no glow
}

// MARK: - Spacing Scale (4pt grid system)

enum ACMSpacing {
    static let xxs: CGFloat = 4
    static let xs: CGFloat = 8
    static let sm: CGFloat = 12
    static let md: CGFloat = 16
    static let lg: CGFloat = 20
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
    static let xxxl: CGFloat = 48
}

// MARK: - Corner Radius Scale

enum ACMRadius {
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 28
    static let full: CGFloat = 999
}

// MARK: - Gradients (flattened to solids — no gradient fills anywhere)

enum ACMGradients {
    static let primary: Color = ACMColors.primaryOrange
    static let avatarBackground: Color = ACMColors.surface
    static let cardBackground: Color = ACMColors.surface
}

// MARK: - Typography (single sans family — NO monospace)

enum ACMFont {
    static let regular = "PolySans Trial Neutral"
    static let medium = "PolySans Trial Median"
    static let bold = "PolySans Trial Bulky"
    static let wideBold = "PolySans Trial Bulky Wide"

    static func trial(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let name: String
        switch weight {
        case .medium, .semibold:
            name = medium
        case .bold, .heavy, .black:
            name = bold
        default:
            name = regular
        }
        return custom(name, size: size, fallback: .system(size: size, weight: weight, design: .default))
    }

    /// Retained signature for call-site compatibility, but routes to the SANS
    /// family (design: .default) — there is no monospace in the product.
    static func mono(_ size: CGFloat, weight: Font.Weight = .medium) -> Font {
        return trial(size, weight: weight)
    }

    static func wide(_ size: CGFloat) -> Font {
        custom(wideBold, size: size, fallback: .system(size: size, weight: .bold, design: .default))
    }

    static func custom(_ name: String, size: CGFloat, fallback: Font) -> Font {
        #if SKIP
        return fallback
        #elseif canImport(UIKit)
        if UIFont(name: name, size: size) != nil {
            return .custom(name, size: size)
        }
        return fallback
        #else
        return .custom(name, size: size)
        #endif
    }
}

// MARK: - System Symbol Helpers

enum ACMSystemIcon {
    static func image(_ iosName: String, androidName: String? = nil) -> Image {
        #if SKIP
        return Image(systemName: androidName ?? iosName)
        #else
        return Image(systemName: iosName)
        #endif
    }

    /// Preferred for meeting glyphs. iOS → SF Symbol; Android → a REAL
    /// material-icons-extended ImageVector via the Kotlin `MeetingIcon`
    /// composable (SkipUI's `Image(systemName:)` only resolves a core glyph set,
    /// so mic/cam/share/chat/etc. otherwise render wrong or as a warning
    /// triangle). Android callers must pass an explicit semantic `tint`; SwiftUI
    /// `.foregroundStyle(...)` is kept for iOS and does not cross the ComposeView.
    @ViewBuilder
    static func icon(_ iosName: String, android key: String, size: CGFloat = 18, tint: String = "text") -> some View {
        #if SKIP
        // Android Compose Icon needs an EXPLICIT tint — inherited LocalContentColor
        // is dark inside .plain Buttons / sheets. iOS keeps using the caller's
        // trailing `.foregroundStyle(...)`. The explicit `.frame` gives the
        // ComposeView a definite size so Skip places it at its laid-out position
        // (without it, icons inside a bottom-anchored overlay ghosted at the top).
        ComposeView { context in
            MeetingIcon(name: key, size: Double(size), tint: tint, modifier: context.modifier)
        }
        .frame(width: size, height: size)
        #else
        Image(systemName: iosName)
            .font(.system(size: size, weight: .medium))
        #endif
    }
}

#if SKIP
@ViewBuilder
func ACMAndroidSemanticText(_ label: String) -> some View {
    Text(label)
        .font(Font.system(size: 1))
        .foregroundStyle(Color.white.opacity(0.01))
        .frame(width: 1, height: 1)
        .lineLimit(1)
}
#endif

// MARK: - Control Button Styles (Carbon — filled circles, Meet semantics)
//  default = white@10% fill · active = solid accent · muted = solid danger
//  (Meet's red mic-off) · danger = solid danger. No borders, no shadows.

#if !SKIP
struct ACMControlButtonStyle: ButtonStyle {
    var isActive: Bool = false
    var isMuted: Bool = false
    var isGhostDisabled: Bool = false
    var isDanger: Bool = false
    var isHandRaised: Bool = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Font.system(size: 18, weight: .medium))
            .foregroundStyle(foregroundColor)
            .frame(width: 44, height: 44)
            .background(backgroundColor)
            .clipShape(Circle())
            .scaleEffect(configuration.isPressed ? 0.96 : 1.0)
            .animation(Animation.easeInOut(duration: 0.1), value: configuration.isPressed)
            .opacity(isGhostDisabled ? 0.35 : 1.0)
    }

    var foregroundColor: Color {
        if isDanger || isMuted { return ACMColors.white }
        if isHandRaised { return ACMColors.black }
        if isActive { return ACMColors.white }
        return ACMColors.text
    }

    var backgroundColor: Color {
        if isHandRaised { return ACMColors.handRaised }
        if isDanger || isMuted { return ACMColors.error }       // Meet: mic-off = red
        if isActive { return ACMColors.primaryOrange }
        return acmColor(red: 255.0, green: 255.0, blue: 255.0, opacity: 0.1)
    }
}

// MARK: - Primary Button Style

struct ACMPrimaryButtonStyle: ButtonStyle {
    var isLoading: Bool = false

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 8) {
            if isLoading {
                ProgressView()
                    .progressViewStyle(CircularProgressViewStyle(tint: Color.white))
                    .scaleEffect(0.8)
            }
            configuration.label
        }
            .font(ACMFont.trial(14, weight: .medium))
            .foregroundStyle(ACMColors.white)
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .background(ACMColors.primaryOrange)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .scaleEffect(configuration.isPressed ? 0.98 : 1.0)
            .animation(Animation.easeInOut(duration: 0.1), value: configuration.isPressed)
    }
}
#endif

extension View {
    public func acmControlButtonStyle(
        isActive: Bool = false,
        isMuted: Bool = false,
        isGhostDisabled: Bool = false,
        isDanger: Bool = false,
        isHandRaised: Bool = false
    ) -> some View {
        #if SKIP
        let foreground: Color
        if isDanger || isMuted {
            foreground = ACMColors.white
        } else if isHandRaised {
            foreground = Color.black
        } else if isActive {
            foreground = ACMColors.white
        } else {
            foreground = ACMColors.text
        }

        let background: Color
        if isHandRaised {
            background = ACMColors.handRaised
        } else if isDanger || isMuted {
            background = ACMColors.error
        } else if isActive {
            background = ACMColors.primaryOrange
        } else {
            background = acmColor(red: 255.0, green: 255.0, blue: 255.0, opacity: 0.1)
        }

        return self
            .font(Font.system(size: 18, weight: .medium))
            .foregroundStyle(foreground)
            .frame(width: 44, height: 44)
            .background { Circle().fill(background) }
            .opacity(isGhostDisabled ? 0.35 : 1.0)
        #else
        return self.buttonStyle(
            ACMControlButtonStyle(
                isActive: isActive,
                isMuted: isMuted,
                isGhostDisabled: isGhostDisabled,
                isDanger: isDanger,
                isHandRaised: isHandRaised
            )
        )
        #endif
    }

    public func acmPrimaryButtonStyle(isLoading: Bool = false) -> some View {
        #if SKIP
        return self
            .font(ACMFont.trial(14, weight: .medium))
            .foregroundStyle(ACMColors.white)
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .acmColorBackground(ACMColors.primaryOrange)
            .clipShape(RoundedRectangle(cornerRadius: 10))
        #else
        return self.buttonStyle(ACMPrimaryButtonStyle(isLoading: isLoading))
        #endif
    }
}

// MARK: - Input Field Style

extension View {
    public func acmInputStyle() -> some View {
        self
            .font(ACMFont.trial(14))
            .foregroundStyle(ACMColors.text)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .acmColorBackground(ACMColors.bgAlt)
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(ACMColors.border)
            }
            .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - Video Tile Style (flat — speaking = 2px solid accent, NO glow)

extension View {
    public func acmVideoTile(isSpeaking: Bool = false) -> some View {
        self
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay {
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(lineWidth: isSpeaking ? 2.0 : 1.0)
                    .foregroundStyle(isSpeaking ? ACMColors.speaking : ACMColors.border)
            }
    }
}

// MARK: - Label Style (sans — no monospace, no uppercase tracking gimmick)

extension View {
    public func acmLabel() -> some View {
        self
            .font(ACMFont.trial(12, weight: .medium))
            .foregroundStyle(ACMColors.textMuted)
    }
}

// MARK: - Convenience Extensions

extension View {
    public func acmColorBackground(_ color: Color) -> some View {
        #if SKIP
        return self.background { color }
        #else
        return self.background(color)
        #endif
    }

    public func acmBackground() -> some View {
        self.acmColorBackground(ACMColors.bg)
    }

    public func acmPill() -> some View {
        self
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .acmColorBackground(ACMColors.scrim)
            .acmMaterialBackground(opacity: 0.3)
            .overlay {
                Capsule()
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(ACMColors.border)
            }
            .clipShape(Capsule())
    }
}

extension View {
    /// Frosted-glass backing. On iOS this is a real material (the closest thing
    /// to Liquid Glass available pre-availability-gating); on Android/Skip it
    /// falls back to a translucent scrim.
    public func acmMaterialBackground(opacity: Double = 0.3) -> some View {
        #if SKIP
        return self.acmColorBackground(Color(red: 0, green: 0, blue: 0, opacity: opacity))
        #else
        return self.background(.ultraThinMaterial.opacity(opacity))
        #endif
    }
}
