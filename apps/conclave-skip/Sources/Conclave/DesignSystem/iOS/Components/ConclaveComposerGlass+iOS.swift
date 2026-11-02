#if os(iOS) && !SKIP
import SwiftUI
import UIKit

struct ConclaveComposerField<Attach: View, Field: View, Send: View>: View {
    let identifier: String
    let showsAttach: Bool
    let attach: Attach
    let field: Field
    let send: Send

    init(identifier: String, @ViewBuilder attach: () -> Attach, @ViewBuilder field: () -> Field,
         @ViewBuilder send: () -> Send) {
        self.identifier = identifier
        self.showsAttach = true
        self.attach = attach()
        self.field = field()
        self.send = send()
    }

    var body: some View {
        ConclaveComposerCluster(showsAttach: showsAttach, attach: attach, field: field, send: send)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(identifier)
    }
}

extension ConclaveComposerField where Attach == EmptyView {

    init(identifier: String, @ViewBuilder field: () -> Field, @ViewBuilder send: () -> Send) {
        self.identifier = identifier
        self.showsAttach = false
        self.attach = EmptyView()
        self.field = field()
        self.send = send()
    }
}

extension ConclaveComposerField where Attach == EmptyView, Field == ConclaveComposerInput, Send == ConclaveSendButton {

    init(_ prompt: String, text: Binding<String>, isSendEnabled: Bool, identifier: String, onSend: @escaping () -> Void) {
        self.init(identifier: identifier,
                  field: { ConclaveComposerInput(prompt, text: text, identifier: identifier + ".field") },
                  send: { ConclaveSendButton(isEnabled: isSendEnabled, identifier: identifier + ".send", action: onSend) })
    }
}

private struct ConclaveComposerCluster<Attach: View, Field: View, Send: View>: View {
    let showsAttach: Bool
    let attach: Attach
    let field: Field
    let send: Send
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

    var body: some View {
        if #available(iOS 27.0, *) {
            ConclaveResourceUsageReader { prefersReducedResourceUsage in
                cluster(prefersReducedResourceUsage: prefersReducedResourceUsage)
            }
        } else {
            cluster(prefersReducedResourceUsage: false)
        }
    }

    @ViewBuilder
    private func cluster(prefersReducedResourceUsage: Bool) -> some View {
        if #available(iOS 26.0, *), ConclaveComposerMaterialPolicy.material(glassAvailable: true, reduceTransparency: reduceTransparency, forceOpaque: forceOpaque, prefersReducedResourceUsage: prefersReducedResourceUsage) == .glass {
            GlassEffectContainer(spacing: CGFloat(ConclaveComposerMetrics.clusterSpacing)) {
                HStack(alignment: .bottom, spacing: CGFloat(ConclaveComposerMetrics.clusterSpacing)) {
                    if showsAttach {
                        attach
                            .frame(width: CGFloat(ConclaveComposerMetrics.attachDiameter),
                                   height: CGFloat(ConclaveComposerMetrics.attachDiameter))
                            .glassEffect(.regular.interactive(), in: .circle)
                            .overlay { ConclaveComposerContrastStroke(shape: Circle(), isIncreased: contrast == .increased) }
                    }
                    fieldContainer
                        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: CGFloat(ConclaveComposerMetrics.glassCornerRadius), style: .continuous))
                        .overlay {
                            ConclaveComposerContrastStroke(
                                shape: RoundedRectangle(cornerRadius: CGFloat(ConclaveComposerMetrics.glassCornerRadius), style: .continuous),
                                isIncreased: contrast == .increased)
                        }
                }
            }
        } else {
            HStack(alignment: .bottom, spacing: CGFloat(ConclaveComposerMetrics.clusterSpacing)) {
                if showsAttach {
                    attach
                        .frame(width: CGFloat(ConclaveComposerMetrics.attachDiameter),
                               height: CGFloat(ConclaveComposerMetrics.attachDiameter))
                }
                fieldContainer
                    .background(Color(uiColor: .systemBackground),
                                in: RoundedRectangle(cornerRadius: CGFloat(ConclaveComposerMetrics.opaqueCornerRadius), style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: CGFloat(ConclaveComposerMetrics.opaqueCornerRadius), style: .continuous)
                            .strokeBorder(Color(uiColor: .separator), lineWidth: 1)
                    }
            }
        }
    }

    private var fieldContainer: some View {
        HStack(alignment: .bottom, spacing: 0) {
            field
                .padding(.vertical, CGFloat(ConclaveComposerMetrics.fieldVerticalPadding))
                .frame(maxWidth: .infinity, minHeight: CGFloat(ConclaveComposerMetrics.minimumFieldHeight), alignment: .leading)
                .padding(.leading, CGFloat(ConclaveComposerMetrics.fieldHorizontalPadding))
                .padding(.trailing, CGFloat(ConclaveComposerMetrics.fieldTrailingGap))
            send
        }
        .frame(minHeight: CGFloat(ConclaveComposerMetrics.minimumFieldHeight))
    }
}

private struct ConclaveComposerContrastStroke<Outline: InsettableShape>: View {
    let shape: Outline
    let isIncreased: Bool

    var body: some View {
        if isIncreased {
            shape.strokeBorder(Color(uiColor: .separator), lineWidth: 1)
        }
    }
}

@available(iOS 27.0, *)
private struct ConclaveResourceUsageReader<Content: View>: View {
    @Environment(\.systemPrefersReducedResourceUsage) private var prefersReducedResourceUsage
    @ViewBuilder let content: (Bool) -> Content

    var body: some View {
        content(prefersReducedResourceUsage)
    }
}
#endif
