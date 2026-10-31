#if os(iOS) && !SKIP
import SwiftUI

extension View {
    func conclaveFloatingActionBar<Bar: View>(shaded: Bool = true, @ViewBuilder _ bar: () -> Bar) -> some View {
        modifier(ConclaveFloatingActionBar(bar: bar(), shaded: shaded))
    }

    func conclaveFloatingActionBar<Bar: View>(shaded: Bool, over surface: Color, @ViewBuilder _ bar: () -> Bar) -> some View {
        modifier(ConclaveFloatingActionBar(bar: bar(), shaded: shaded, surface: surface))
    }
}

private enum ConclaveFloatingActionVeil {
    static let fadeHeight: CGFloat = 32
    static let lightOpacity = 0.2
    static let darkOpacity = 1.0
}

private struct ConclaveFloatingActionBar<Bar: View>: ViewModifier {
    let bar: Bar
    let shaded: Bool
    var surface: Color? = nil
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.colorScheme) private var colorScheme

    private var needsOpaqueSurface: Bool { reduceTransparency || contrast == .increased }
    private var veil: Color { HostingTheme.token(DesignTokens.neutralStage) }
    private var veilOpacity: Double {
        colorScheme == .dark ? ConclaveFloatingActionVeil.darkOpacity : ConclaveFloatingActionVeil.lightOpacity
    }
    private var veilClearance: CGFloat {
        shaded && !needsOpaqueSurface ? ConclaveFloatingActionVeil.fadeHeight : 0
    }

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .scrollEdgeEffectStyle(.soft, for: .bottom)
                .safeAreaBar(edge: .bottom, spacing: 0) {
                    bar.background {
                        if needsOpaqueSurface {
                            Color(uiColor: .systemBackground).ignoresSafeArea(edges: .bottom)
                        } else if shaded {
                            shadedBackdrop
                        }
                    }
                    .padding(.top, veilClearance)
                }
        } else {
            content.safeAreaInset(edge: .bottom, spacing: 0) {
                bar.background {
                    if needsOpaqueSurface {
                        Color(uiColor: .systemBackground)
                    } else if shaded {
                        shadedBackdrop
                    } else {
                        Rectangle().fill(.ultraThinMaterial).ignoresSafeArea(edges: .bottom)
                    }
                }
                .padding(.top, veilClearance)
            }
        }
    }

    private var shadedBackdrop: some View {
        shadedFill
            .mask {
                VStack(spacing: 0) {
                    LinearGradient(colors: [veil.opacity(0), veil], startPoint: .top, endPoint: .bottom)
                        .frame(height: ConclaveFloatingActionVeil.fadeHeight)
                    veil
                }
            }
            .padding(.top, -ConclaveFloatingActionVeil.fadeHeight)
            .ignoresSafeArea(edges: .bottom)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var shadedFill: some View {
        if let surface {
            Rectangle().fill(veil.opacity(veilOpacity)).background(surface)
        } else if #available(iOS 26.0, *) {
            Rectangle().fill(veil.opacity(veilOpacity))
        } else {
            Rectangle().fill(veil.opacity(veilOpacity)).background(.ultraThinMaterial)
        }
    }
}

struct ConclaveFloatingActionButton: View {
    let title: String
    var isEnabled = true
    var isPending = false
    let identifier: String
    let action: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let pendingOnOneLine = isPending && dynamicTypeSize.isAccessibilitySize
        ConclaveGlassAvailabilityReader { allowsGlass in
            if #available(iOS 26.0, *), allowsGlass {
                Button(action: action) {
                    HStack(spacing: 8) {
                        if isPending {
                            ProgressView().tint(HostingTheme.floatingActionLabel).accessibilityHidden(true)
                                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                        }
                        Text(title)
                            .multilineTextAlignment(.center)
                            .lineLimit(pendingOnOneLine ? 1 : nil)
                            .minimumScaleFactor(pendingOnOneLine ? 0.5 : 1)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .foregroundStyle(HostingTheme.floatingActionLabel)
                    .opacity(isEnabled ? 1 : ConclaveButtonMetrics.disabledOpacity)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.capsule)
                .controlSize(.large)
                .tint(HostingTheme.coralText)
                .disabled(!isEnabled || isPending)
                .accessibilityValue(isPending ? ConclaveStrings.text("In Progress") : "")
                .accessibilityIdentifier(identifier)
            } else {
                ConclaveButton(title, role: .primary, isEnabled: isEnabled, isPending: isPending,
                               identifier: identifier, action: action)
            }
        }
    }
}

struct ConclaveGlassAvailabilityReader<Content: View>: View {
    @ViewBuilder let content: (Bool) -> Content
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    #if DEBUG
    @Environment(\.conclaveForceOpaqueControls) private var forceOpaqueSetting
    #endif

    private var forceOpaque: Bool {
        #if DEBUG
        return forceOpaqueSetting
        #else
        return false
        #endif
    }

    private var allowsGlass: Bool {
        if #available(iOS 26.0, *) {
            return !reduceTransparency && contrast != .increased && !forceOpaque
        }
        return false
    }

    var body: some View {
        if #available(iOS 27.0, *) {
            ConclaveReducedResourceReader { prefersReducedResourceUsage in
                content(allowsGlass && !prefersReducedResourceUsage)
            }
        } else {
            content(allowsGlass)
        }
    }
}

@available(iOS 27.0, *)
private struct ConclaveReducedResourceReader<Content: View>: View {
    @Environment(\.systemPrefersReducedResourceUsage) private var prefersReducedResourceUsage
    @ViewBuilder let content: (Bool) -> Content

    var body: some View { content(prefersReducedResourceUsage) }
}
#endif
