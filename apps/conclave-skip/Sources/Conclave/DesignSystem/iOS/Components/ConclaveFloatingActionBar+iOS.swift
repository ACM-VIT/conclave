#if os(iOS) && !SKIP
import SwiftUI

extension View {
    func conclaveFloatingActionBar<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        modifier(ConclaveFloatingActionBar(bar: bar()))
    }
}

private struct ConclaveFloatingActionBar<Bar: View>: ViewModifier {
    let bar: Bar
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    private var needsOpaqueSurface: Bool { reduceTransparency || contrast == .increased }

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .scrollEdgeEffectStyle(.soft, for: .bottom)
                .safeAreaBar(edge: .bottom, spacing: 0) {
                    bar.background {
                        if needsOpaqueSurface { Color(uiColor: .systemBackground) }
                    }
                }
        } else {
            content.safeAreaInset(edge: .bottom, spacing: 0) {
                bar.background {
                    if needsOpaqueSurface {
                        Color(uiColor: .systemBackground)
                    } else {
                        Rectangle().fill(.ultraThinMaterial).ignoresSafeArea(edges: .bottom)
                    }
                }
            }
        }
    }
}

struct ConclaveFloatingActionButton: View {
    let title: String
    var isEnabled = true
    var isPending = false
    let identifier: String
    let action: () -> Void

    var body: some View {
        ConclaveGlassAvailabilityReader { allowsGlass in
            if #available(iOS 26.0, *), allowsGlass {
                Button(action: action) {
                    HStack(spacing: 8) {
                        if isPending {
                            ProgressView().tint(HostingTheme.coralText).accessibilityHidden(true)
                        }
                        Text(title)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .foregroundStyle(HostingTheme.coralText)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.capsule)
                .controlSize(.large)
                .tint(HostingTheme.coralText)
                .disabled(!isEnabled || isPending)
                .opacity(isEnabled ? 1 : ConclaveButtonMetrics.disabledOpacity)
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
