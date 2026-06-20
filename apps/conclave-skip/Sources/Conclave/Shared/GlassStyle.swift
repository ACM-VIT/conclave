//
//  GlassStyle.swift
//  Conclave
//
//  Cross-platform Liquid Glass surface layer. iOS/macOS 26+ uses native
//  `glassEffect`; older Apple OS and Android keep compatible material/scrim
//  fallbacks. Keep iOS 26 symbols behind `#if compiler(>=6.2)` because
//  `#available` alone cannot hide missing SDK symbols from older Xcode builds.
//

import SwiftUI

// Android/Compose fallback fill for glass-like controls over video.
private let acmGlassFill = acmColor(red: 24.0, green: 24.0, blue: 27.0, opacity: 0.72)

#if !SKIP
#if compiler(>=6.2)
@available(iOS 26.0, macOS 26.0, *)
private func acmGlassStyle(tint: Color?, interactive: Bool) -> Glass {
    var style: Glass = .regular
    if let tint {
        style = style.tint(tint)
    }
    if interactive {
        style = style.interactive()
    }
    return style
}
#endif
#endif

extension View {
    /// Capsule-shaped liquid-glass surface (floating bars, pills, chips).
    @ViewBuilder
    public func acmGlassCapsule(tint: Color? = nil, interactive: Bool = false) -> some View {
        #if SKIP
        self
            .acmColorBackground(acmGlassFill)
            .overlay {
                Capsule().strokeBorder(lineWidth: 1).foregroundStyle(ACMColors.border)
            }
            .clipShape(Capsule())
        #else
        #if compiler(>=6.2)
        if #available(iOS 26.0, macOS 26.0, *) {
            self.glassEffect(acmGlassStyle(tint: tint, interactive: interactive), in: Capsule())
        } else {
            self.acmMaterialGlassCapsule()
        }
        #else
        self.acmMaterialGlassCapsule()
        #endif
        #endif
    }

    /// Rounded-rect liquid-glass surface (cards, sheets, overlays).
    @ViewBuilder
    public func acmGlassRoundedRect(cornerRadius: CGFloat, tint: Color? = nil, interactive: Bool = false) -> some View {
        #if SKIP
        self
            .acmColorBackground(acmGlassFill)
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius)
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(ACMColors.border)
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
        #else
        #if compiler(>=6.2)
        if #available(iOS 26.0, macOS 26.0, *) {
            self.glassEffect(
                acmGlassStyle(tint: tint, interactive: interactive),
                in: RoundedRectangle(cornerRadius: cornerRadius)
            )
        } else {
            self.acmMaterialGlassRoundedRect(cornerRadius: cornerRadius)
        }
        #else
        self.acmMaterialGlassRoundedRect(cornerRadius: cornerRadius)
        #endif
        #endif
    }

    #if !SKIP
    @ViewBuilder
    fileprivate func acmMaterialGlassCapsule() -> some View {
        self
            .background(.ultraThinMaterial, in: Capsule())
            .overlay {
                Capsule().strokeBorder(lineWidth: 1).foregroundStyle(ACMColors.border)
            }
    }

    @ViewBuilder
    fileprivate func acmMaterialGlassRoundedRect(cornerRadius: CGFloat) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: cornerRadius))
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius)
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(ACMColors.border)
            }
    }
    #endif
}

/// Groups sibling glass elements so iOS 26 can blend/morph them with correct
/// spacing. On older Apple OS and on Android it is a transparent pass-through.
struct ACMGlassGroup<Content: View>: View {
    var spacing: CGFloat = 12
    @ViewBuilder let content: Content

    var body: some View {
        #if !SKIP
        #if compiler(>=6.2)
        if #available(iOS 26.0, macOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) {
                content
            }
        } else {
            content
        }
        #else
        content
        #endif
        #else
        content
        #endif
    }
}
