//
//  Theme.swift
//  Conclave
//
//  Design System
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
    static let primaryOrange = acmColor(red: 249.0, green: 95.0, blue: 74.0)
    static let primaryPink = acmColor(red: 255.0, green: 0.0, blue: 122.0)
    static let cream = acmColor(red: 254.0, green: 252.0, blue: 217.0)
    static let dark = acmColor(red: 6.0, green: 6.0, blue: 6.0)
    static let darkAlt = acmColor(red: 13.0, green: 14.0, blue: 13.0)
    static let surface = acmColor(red: 26.0, green: 26.0, blue: 26.0)
    static let surfaceLight = acmColor(red: 37.0, green: 37.0, blue: 37.0)
    static let surfaceHover = acmColor(red: 42.0, green: 42.0, blue: 42.0)
    
    static let creamDim = acmColor(red: 254.0, green: 252.0, blue: 217.0, opacity: 0.4)
    static let creamMuted = acmColor(red: 254.0, green: 252.0, blue: 217.0, opacity: 0.3)
    static let creamSubtle = acmColor(red: 254.0, green: 252.0, blue: 217.0, opacity: 0.15)
    static let creamFaint = acmColor(red: 254.0, green: 252.0, blue: 217.0, opacity: 0.1)
    static let creamGhost = acmColor(red: 254.0, green: 252.0, blue: 217.0, opacity: 0.05)

    static let primaryOrangeDim = acmColor(red: 249.0, green: 95.0, blue: 74.0, opacity: 0.6)
    static let primaryOrangeSoft = acmColor(red: 249.0, green: 95.0, blue: 74.0, opacity: 0.3)
    static let primaryOrangeFaint = acmColor(red: 249.0, green: 95.0, blue: 74.0, opacity: 0.15)
    static let primaryOrangeGhost = acmColor(red: 249.0, green: 95.0, blue: 74.0, opacity: 0.2)

    static let primaryPinkSoft = acmColor(red: 255.0, green: 0.0, blue: 122.0, opacity: 0.5)
    static let primaryPinkFaint = acmColor(red: 255.0, green: 0.0, blue: 122.0, opacity: 0.3)
    static let primaryPinkGhost = acmColor(red: 255.0, green: 0.0, blue: 122.0, opacity: 0.2)

    static let creamLight = acmColor(red: 254.0, green: 252.0, blue: 217.0, opacity: 0.7)
    static let error = acmColor(red: 239.0, green: 68.0, blue: 68.0)
    static let errorDim = acmColor(red: 239.0, green: 68.0, blue: 68.0, opacity: 0.6)
    static let success = acmColor(red: 34.0, green: 197.0, blue: 94.0)
    static let black = acmColor(red: 0.0, green: 0.0, blue: 0.0)
    static let white = acmColor(red: 255.0, green: 255.0, blue: 255.0)
    static let overlay50 = acmColor(red: 0.0, green: 0.0, blue: 0.0, opacity: 0.5)

    static func blackOverlay(_ opacity: Double) -> Color {
        acmColor(red: 0.0, green: 0.0, blue: 0.0, opacity: opacity)
    }

    // MARK: - Hand Raised Colors (Orange accent)
    static let handRaised = acmColor01(red: 1.0, green: 0.5, blue: 0.0, opacity: 0.9)
    static let handRaisedBackground = acmColor01(red: 1.0, green: 0.5, blue: 0.0, opacity: 0.2)
    static let handRaisedBorder = acmColor01(red: 1.0, green: 0.5, blue: 0.0, opacity: 0.4)
    static let handRaisedShadow = acmColor01(red: 1.0, green: 0.5, blue: 0.0, opacity: 0.3)
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

// MARK: - Gradients

enum ACMGradients {
    static let primary: Color = ACMColors.primaryOrange
    static let avatarBackground: Color = ACMColors.primaryOrangeGhost
    static let cardBackground: Color = ACMColors.surface
}

// MARK: - Typography

enum ACMFont {
    static let regular = "PolySans Trial Neutral"
    static let medium = "PolySans Trial Median"
    static let bold = "PolySans Trial Bulky"
    static let wideBold = "PolySans Trial Bulky Wide"
    static let monoRegular = "PolySans Trial Neutral Mono"
    static let monoMedium = "PolySans Trial Median Mono"
    static let monoBold = "PolySans Trial Bulky Mono"

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

    static func mono(_ size: CGFloat, weight: Font.Weight = .medium) -> Font {
        let name: String
        switch weight {
        case .bold, .heavy, .black:
            name = monoBold
        case .regular:
            name = monoRegular
        default:
            name = monoMedium
        }
        return custom(name, size: size, fallback: .system(size: size, weight: weight, design: .monospaced))
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
}

// MARK: - Control Button Styles

#if !SKIP
struct ACMControlButtonStyle: ButtonStyle {
    var isActive: Bool = false
    var isMuted: Bool = false
    var isGhostDisabled: Bool = false
    var isDanger: Bool = false
    var isHandRaised: Bool = false
    
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Font.system(size: 16))
            .foregroundStyle(foregroundColor)
            .frame(width: 44, height: 44)
            .background(backgroundColor)
            .clipShape(Circle())
            .overlay(
                Circle()
                    .strokeBorder(borderColor, lineWidth: 1)
            )
            .scaleEffect(configuration.isPressed ? 0.95 : 1.0)
            .animation(Animation.easeInOut(duration: 0.1), value: configuration.isPressed)
            .opacity(isGhostDisabled ? 0.3 : 1.0)
    }
    
    var foregroundColor: Color {
        if isDanger {
            return acmColor01(red: 1.0, green: 0.0, blue: 0.0, opacity: 0.9)
        }
        if isHandRaised {
            return .black
        }
        if isActive {
            return ACMColors.cream
        }
        if isMuted {
            return ACMColors.primaryOrange
        }
        return acmColor(red: 254.0, green: 252.0, blue: 217.0, opacity: 0.8)
    }
    
    var backgroundColor: Color {
        if isHandRaised {
            return acmColor01(red: 1.0, green: 1.0, blue: 0.0, opacity: 0.9)
        }
        if isActive {
            return ACMColors.primaryOrange
        }
        if isMuted {
            return ACMColors.primaryOrangeFaint
        }
        return .clear
    }
    
    var borderColor: Color {
        if isActive || isMuted || isHandRaised {
            return .clear
        }
        return ACMColors.creamSubtle
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
                        .foregroundStyle(ACMColors.cream)
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .background(ACMColors.primaryOrange)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .scaleEffect(configuration.isPressed ? 0.98 : 1.0)
        .animation(Animation.easeInOut(duration: 0.1), value: configuration.isPressed)
    }
}
#endif

extension View {
    func acmControlButtonStyle(
        isActive: Bool = false,
        isMuted: Bool = false,
        isGhostDisabled: Bool = false,
        isDanger: Bool = false,
        isHandRaised: Bool = false
    ) -> some View {
        #if SKIP
        let foreground: Color
        if isDanger {
            foreground = acmColor01(red: 1.0, green: 0.0, blue: 0.0, opacity: 0.9)
        } else if isHandRaised {
            foreground = Color.black
        } else if isActive {
            foreground = ACMColors.cream
        } else if isMuted {
            foreground = ACMColors.primaryOrange
        } else {
            foreground = acmColor(red: 254.0, green: 252.0, blue: 217.0, opacity: 0.8)
        }

        let background: Color
        if isHandRaised {
            background = acmColor01(red: 1.0, green: 1.0, blue: 0.0, opacity: 0.9)
        } else if isActive {
            background = ACMColors.primaryOrange
        } else if isMuted {
            background = ACMColors.primaryOrangeFaint
        } else {
            background = Color.clear
        }

        let border: Color = (isActive || isMuted || isHandRaised) ? Color.clear : ACMColors.creamSubtle

        return self
            .font(Font.system(size: 16))
            .foregroundStyle(foreground)
            .frame(width: 44, height: 44)
            .background { Circle().fill(background) }
            .overlay {
                Circle()
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(border)
            }
            .opacity(isGhostDisabled ? 0.3 : 1.0)
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

    func acmPrimaryButtonStyle(isLoading: Bool = false) -> some View {
        #if SKIP
        return self
            .font(ACMFont.trial(14, weight: .medium))
            .foregroundStyle(ACMColors.cream)
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .acmColorBackground(ACMColors.primaryOrange)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        #else
        return self.buttonStyle(ACMPrimaryButtonStyle(isLoading: isLoading))
        #endif
    }
}

// MARK: - Input Field Style

extension View {
    func acmInputStyle() -> some View {
        self
            .font(ACMFont.trial(14))
            .foregroundStyle(ACMColors.cream)
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
            .acmColorBackground(ACMColors.surface)
            .overlay {
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(ACMColors.creamFaint)
            }
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - Video Tile Style

extension View {
    func acmVideoTile(isSpeaking: Bool = false) -> some View {
        self
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay {
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(lineWidth: isSpeaking ? 2.0 : 1.0)
                    .foregroundStyle(isSpeaking ? ACMColors.primaryOrange : ACMColors.creamFaint)
            }
            .shadow(
                color: isSpeaking ? ACMColors.primaryOrangeSoft : Color.clear,
                radius: isSpeaking ? 15.0 : 0.0
            )
    }
}

// MARK: - Label Style

extension View {
    func acmLabel() -> some View {
        self
            .font(ACMFont.mono(10))
            .textCase(.uppercase)
            .tracking(1.5)
            .foregroundStyle(ACMColors.creamDim)
    }
}

// MARK: - Color Hex Extension

// MARK: - Convenience Extensions

extension View {
    func acmColorBackground(_ color: Color) -> some View {
        #if SKIP
        return self.background { color }
        #else
        return self.background(color)
        #endif
    }

    func acmBackground() -> some View {
        self.acmColorBackground(ACMColors.dark)
    }
    
    func acmPill() -> some View {
        self
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .acmColorBackground(Color(red: 0, green: 0, blue: 0, opacity: 0.5))
            .acmMaterialBackground(opacity: 0.3)
            .overlay {
                Capsule()
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(ACMColors.creamFaint)
            }
            .clipShape(Capsule())
    }
}

extension View {
    func acmMaterialBackground(opacity: Double = 0.3) -> some View {
        #if SKIP
        return self.acmColorBackground(Color(red: 0, green: 0, blue: 0, opacity: opacity))
        #else
        return self.background(.ultraThinMaterial.opacity(opacity))
        #endif
    }
}
