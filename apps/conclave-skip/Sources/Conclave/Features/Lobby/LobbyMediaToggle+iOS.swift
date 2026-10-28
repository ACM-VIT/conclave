#if os(iOS) && !SKIP
import SwiftUI

struct LobbyMediaToggle: View {
    let title: String
    let value: String
    let systemImage: String
    let state: ConclaveControlState
    var isEnabled = true
    var inputLabels: [String] = []
    var feedback: FeedbackKind? = nil
    let identifier: String
    let action: () -> Void
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    #if DEBUG
    @Environment(\.conclaveForceOpaqueControls) private var forceOpaqueSetting
    #endif
    @State private var taps = 0
    @State private var tappedKind = FeedbackKind.none
    @ScaledMetric(relativeTo: .body) private var diameter: CGFloat = 52

    private var forceOpaque: Bool {
        #if DEBUG
        return forceOpaqueSetting
        #else
        return false
        #endif
    }

    var body: some View {
        if #available(iOS 27.0, *) {
            LobbyReducedResourceReader { controls(prefersReducedResourceUsage: $0) }
        } else {
            controls(prefersReducedResourceUsage: false)
        }
    }

    @ViewBuilder
    private func controls(prefersReducedResourceUsage: Bool) -> some View {
        if #available(iOS 26.0, *), !reduceTransparency, contrast != .increased,
           !forceOpaque, !prefersReducedResourceUsage {
            VStack(spacing: 6) {
                Button {
                    if let feedback {
                        tappedKind = feedback
                        taps += 1
                    }
                    action()
                } label: {
                    Image(systemName: systemImage)
                        .font(.title3)
                        .symbolRenderingMode(.monochrome)
                        .foregroundStyle(HostingTheme.token(state == .on ? DesignTokens.iosInCallText : DesignTokens.iosInCallOnControlOff))
                        .frame(width: min(diameter, 64), height: min(diameter, 64))
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.tint(state == .on ? nil : HostingTheme.token(DesignTokens.iosInCallControlOff))
                    .interactive(isEnabled), in: Circle())
                .disabled(!isEnabled)
                .opacity(isEnabled ? 1 : HostingTheme.disabledOpacity)
                .conclaveGestureFeedback(tappedKind, trigger: taps)
                .accessibilityLabel(title)
                .accessibilityValue(value)
                .accessibilityAddTraits(.isToggle)
                .accessibilityInputLabels(inputLabels.isEmpty ? [title] : inputLabels)
                .accessibilityShowsLargeContentViewer { Label(title, systemImage: systemImage) }
                .accessibilityIdentifier(identifier)
                Text(value)
                    .font(.caption)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .accessibilityHidden(true)
            }
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        } else {
            ConclaveLabelledCallToggle(title: title, value: value, systemImage: systemImage, state: state,
                                       isEnabled: isEnabled, inputLabels: inputLabels, feedback: feedback,
                                       context: .onSurface, identifier: identifier, action: action)
        }
    }
}

@available(iOS 27.0, *)
private struct LobbyReducedResourceReader<Content: View>: View {
    @Environment(\.systemPrefersReducedResourceUsage) private var prefersReducedResourceUsage
    @ViewBuilder let content: (Bool) -> Content

    var body: some View {
        content(prefersReducedResourceUsage)
    }
}
#endif
