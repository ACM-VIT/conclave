//  Native design tokens aligned with the web Carbon palette.
//  Keep this file close to the TypeScript token tree so web, iOS, and Android
//  stay visually consistent.
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

// MARK: - Colors

enum ACMColors {
    static let primaryOrange = acmColor(red: 249.0, green: 95.0, blue: 74.0)   // accent  #F95F4A
    static let primaryPink = acmColor(red: 255.0, green: 0.0, blue: 122.0)     // accent2 #FF007A

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

    // Legacy aliases kept for existing views.
    static let cream = text                                                    // primary text → #fafafa
    static let dark = bg                                                       // app background
    static let darkAlt = bgAlt
    static let surface = acmColor(red: 24.0, green: 24.0, blue: 27.0)          // #18181b
    static let surfaceLight = surfaceRaised
    static let surfaceHover = acmColor(red: 46.0, green: 46.0, blue: 51.0)     // #2e2e33
    static let lobbyPanel = acmColor(red: 14.0, green: 14.0, blue: 16.0)       // #0e0e10
    static let lobbyPreview = acmColor(red: 18.0, green: 18.0, blue: 20.0)     // #121214
    static let fieldBackground = acmColor(red: 250.0, green: 250.0, blue: 250.0, opacity: 0.03)
    static let subtleFill = acmColor(red: 250.0, green: 250.0, blue: 250.0, opacity: 0.04)
    static let subtleFillHover = acmColor(red: 250.0, green: 250.0, blue: 250.0, opacity: 0.08)
    static let borderSubtle = acmColor(red: 250.0, green: 250.0, blue: 250.0, opacity: 0.10)

    // White-based text tints.
    static let creamLight = acmColor(red: 250.0, green: 250.0, blue: 250.0, opacity: 0.74)
    static let creamDim = acmColor(red: 250.0, green: 250.0, blue: 250.0, opacity: 0.56)
    static let creamMuted = acmColor(red: 250.0, green: 250.0, blue: 250.0, opacity: 0.40)
    static let creamSubtle = acmColor(red: 250.0, green: 250.0, blue: 250.0, opacity: 0.14)
    static let creamFaint = acmColor(red: 250.0, green: 250.0, blue: 250.0, opacity: 0.10)
    static let creamGhost = acmColor(red: 250.0, green: 250.0, blue: 250.0, opacity: 0.05)

    static let primaryOrangeDim = acmColor(red: 249.0, green: 95.0, blue: 74.0, opacity: 0.6)
    static let primaryOrangeFaint = acmColor(red: 249.0, green: 95.0, blue: 74.0, opacity: 0.15)
    static let primaryOrangeGhost = acmColor(red: 249.0, green: 95.0, blue: 74.0, opacity: 0.2)
    static let primaryPinkFaint = acmColor(red: 255.0, green: 0.0, blue: 122.0, opacity: 0.3)
    static let primaryPinkGhost = acmColor(red: 255.0, green: 0.0, blue: 122.0, opacity: 0.2)

    // Compatibility aliases. Intentionally clear to avoid old glow shadows.
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

    // Mirrors `@conclave/ui-tokens` AVATAR_PALETTE so users keep the same
    // avatar color across web and native.
    /// Deterministic identity color; delegates to the facehash palette so
    /// color dots and face avatars always agree with the web app.
    static func avatarColor(for key: String) -> Color {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return FacehashPresentation.palette[0] }
        return FacehashPresentation.color(for: trimmed)
    }

    // MARK: - Hand Raised Colors
    static let handRaised = acmColor(red: 251.0, green: 191.0, blue: 36.0, opacity: 0.95)        // amber-400
    static let handRaisedBackground = acmColor(red: 251.0, green: 191.0, blue: 36.0, opacity: 0.2)
    static let handRaisedBorder = acmColor(red: 251.0, green: 191.0, blue: 36.0, opacity: 0.4)
    static let handRaisedShadow = Color.clear // neutralised - no glow
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

// MARK: - Motion

/// Layout motion matches the web app's FLIP system (GridLayout.tsx):
/// cubic-bezier(0.22, 1, 0.36, 1), 220ms for tile glides on identity
/// changes, 280ms for stage-level reflows and surface swaps.
enum ACMMotion {
    static let tileGlide = Animation.timingCurve(0.22, 1.0, 0.36, 1.0, duration: 0.22)
    static let stageSwap = Animation.timingCurve(0.22, 1.0, 0.36, 1.0, duration: 0.28)
}

// MARK: - Typography

enum ACMFont {
    #if SKIP
    static let regular = "polysans_neutral"
    static let medium = "polysans_median"
    static let bold = "polysans_bulky"
    static let wideBold = "polysans_bulkywide"
    #else
    static let regular = "PolySans Trial Neutral"
    static let medium = "PolySans Trial Median"
    static let bold = "PolySans Trial Bulky"
    static let wideBold = "PolySans Trial Bulky Wide"
    #endif

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

    /// Retained for call-site compatibility; routes to the sans family.
    static func mono(_ size: CGFloat, weight: Font.Weight = .medium) -> Font {
        return trial(size, weight: weight)
    }

    static func wide(_ size: CGFloat) -> Font {
        custom(wideBold, size: size, fallback: .system(size: size, weight: .bold, design: .default))
    }

    static func custom(_ name: String, size: CGFloat, fallback: Font) -> Font {
        #if SKIP
        return .custom(name, size: size)
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

    /// Preferred for meeting glyphs. iOS uses SF Symbols; Android uses the
    /// Kotlin `MeetingIcon` bridge because SkipUI only resolves a small core
    /// glyph set through `Image(systemName:)`.
    @ViewBuilder
    static func icon(_ iosName: String, android key: String, size: CGFloat = 18, tint: String = "text") -> some View {
        #if SKIP
        // Compose needs explicit tint and size inside Skip-hosted buttons/sheets.
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
    EmptyView()
}
#endif

// MARK: - Control Button Styles (Carbon - filled circles, Meet semantics)
//  default = white@10% fill · active = solid accent · muted = solid danger
//  (Meet's red mic-off) · danger = solid danger. No borders, no shadows.

#if !SKIP
struct ACMControlButtonStyle: ButtonStyle {
    var isActive: Bool = false
    var isMuted: Bool = false
    var isDisabledDimmed: Bool = false
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
            .opacity(isDisabledDimmed ? 0.35 : 1.0)
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
        isDisabledDimmed: Bool = false,
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
            .opacity(isDisabledDimmed ? 0.35 : 1.0)
        #else
        return self.buttonStyle(
            ACMControlButtonStyle(
                isActive: isActive,
                isMuted: isMuted,
                isDisabledDimmed: isDisabledDimmed,
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

// MARK: - Video Tile Style (flat - speaking = 2px solid accent, NO glow)

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

// MARK: - Label Style (sans - no monospace, no uppercase tracking gimmick)

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
