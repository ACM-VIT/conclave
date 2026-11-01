#if os(iOS) && !SKIP
import SwiftUI

extension View {
    func conclaveFloatingActionBar<Bar: View>(shaded: Bool = true, isVisible: Bool = true, @ViewBuilder _ bar: () -> Bar) -> some View {
        modifier(ConclaveFloatingActionBar(bar: bar(), shaded: shaded, isVisible: isVisible))
    }

    func conclaveFloatingActionBar<Bar: View>(shaded: Bool, over surface: Color, @ViewBuilder _ bar: () -> Bar) -> some View {
        modifier(ConclaveFloatingActionBar(bar: bar(), shaded: shaded, surface: surface))
    }
}

private enum ConclaveFloatingActionVeil {
    static let fadeHeight: CGFloat = 24
}

private struct ConclaveFloatingActionBar<Bar: View>: ViewModifier {
    let bar: Bar
    let shaded: Bool
    var isVisible = true
    var surface: Color? = nil
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    private var needsOpaqueSurface: Bool { reduceTransparency || contrast == .increased }
    private var ground: Color { surface ?? Color(uiColor: .systemBackground) }

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .scrollEdgeEffectStyle(.soft, for: .bottom)
                .safeAreaBar(edge: .bottom, spacing: 0) {
                    if isVisible {
                        bar.background {
                            if needsOpaqueSurface {
                                ground.ignoresSafeArea(edges: .bottom)
                            }
                        }
                    }
                }
        } else {
            content.safeAreaInset(edge: .bottom, spacing: 0) {
                if isVisible {
                    bar.background {
                        if needsOpaqueSurface {
                            ground.ignoresSafeArea(edges: .bottom)
                        } else if shaded {
                            fadedGround
                        } else {
                            Rectangle().fill(.ultraThinMaterial).ignoresSafeArea(edges: .bottom)
                        }
                    }
                    .padding(.top, shaded && !needsOpaqueSurface ? ConclaveFloatingActionVeil.fadeHeight : 0)
                }
            }
        }
    }

    private var fadedGround: some View {
        ground
            .mask {
                VStack(spacing: 0) {
                    LinearGradient(colors: [.black.opacity(0), .black], startPoint: .top, endPoint: .bottom)
                        .frame(height: ConclaveFloatingActionVeil.fadeHeight)
                    Color.black
                }
            }
            .padding(.top, -ConclaveFloatingActionVeil.fadeHeight)
            .ignoresSafeArea(edges: .bottom)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

struct ConclaveFloatingActionButton: View {
    let title: String
    var isEnabled = true
    var isPending = false
    var fillsWidth = false
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
                    .frame(maxWidth: fillsWidth ? .infinity : nil)
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
