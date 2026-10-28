#if os(iOS) && !SKIP
import SwiftUI
import UIKit

// The composer cluster (F00 C19 a, c, l; S40 6 c, Q14, R40-10; RECONCILE R32; owner OQ2, 2026-10-26). This is the
// second and last sanctioned glass file beside ConclaveCallControl+iOS.swift: one component for the Chat, Transcript
// Ask and Q&A composers. On iOS 26 and later, with Reduce Transparency off, no Debug force and no iOS 27 reduced
// resource usage, the attach circle and the field container share one GlassEffectContainer. The attach control is
// regular and interactive (it is a Menu label, so the glass button style does not apply); the field container is
// regular and never interactive, so a press never scales the caret or the selection handles, and it keeps a 22 pt
// continuous radius at every height up to six lines. Send stays a solid coralText glyph inside the field container
// (never glass on glass, never coral-tinted glass). Text and placeholder keep the system colors. Increase Contrast
// adds a 1 pt separator stroke to both shapes. Every other case draws the R32 opaque bordered field (system
// background, 1 pt separator border, radiusBubble) with the attach control as a plain 44 pt button. Accessory rows
// above the field, the counter and the bar host live in ConclaveFields+iOS.swift and are never glass. Geometry (T3
// borrow P5): one line of text is one 44 pt row in both branches, level with the attach circle; the shape counts and
// the material rule are unchanged.

/// The composer field row: an optional attach control, the field and Send. Keystrokes stay in the caller's local
/// state (F00 C19 k); this view never reads a presenter.
struct ConclaveComposerField<Attach: View, Field: View, Send: View>: View {
    let identifier: String
    let showsAttach: Bool
    let attach: Attach
    let field: Field
    let send: Send

    /// Chat: the attach control (a `Menu` whose label is the add-attachment glyph) joins the cluster.
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
    /// Transcript Ask and Q&A: no attach control, so the cluster holds the field container alone.
    init(identifier: String, @ViewBuilder field: () -> Field, @ViewBuilder send: () -> Send) {
        self.identifier = identifier
        self.showsAttach = false
        self.attach = EmptyView()
        self.field = field()
        self.send = send()
    }
}

extension ConclaveComposerField where Attach == EmptyView, Field == ConclaveComposerInput, Send == ConclaveSendButton {
    /// The plain composer (FND-1 API): a vertical field growing to six lines and the Send glyph. The field is
    /// `identifier.field`, Send is `identifier.send`.
    init(_ prompt: String, text: Binding<String>, isSendEnabled: Bool, identifier: String, onSend: @escaping () -> Void) {
        self.init(identifier: identifier,
                  field: { ConclaveComposerInput(prompt, text: text, identifier: identifier + ".field") },
                  send: { ConclaveSendButton(isEnabled: isSendEnabled, identifier: identifier + ".send", action: onSend) })
    }
}

/// Reads the settings that pick the material and draws one branch.
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

    /// The field and Send in one container, one 44 pt row (T3 borrow P5, a recorded C19 c deviation): the 12 by 8
    /// padding wraps the text only, so a single line is centred in 44 pt, the same height as the attach circle. Send
    /// is never padded: its 44 pt target fills the row at the trailing edge, so the glyph sits concentric with the
    /// container's trailing corner. Multi-line text grows the container upward and the bottom alignment keeps Send
    /// on the last line. Shared by both material branches (Chat, Transcript Ask and Q&A).
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

/// The 1 pt separator stroke Increase Contrast adds to each glass shape (F00 C19 c, 4 "Increase Contrast").
private struct ConclaveComposerContrastStroke<Outline: InsettableShape>: View {
    let shape: Outline
    let isIncreased: Bool

    var body: some View {
        if isIncreased {
            shape.strokeBorder(Color(uiColor: .separator), lineWidth: 1)
        }
    }
}

/// iOS 27: the opaque field also wins while the system prefers reduced resource usage (F00 4 "Resource pressure").
/// The value is read where it is drawn; nothing else runs on a change.
@available(iOS 27.0, *)
private struct ConclaveResourceUsageReader<Content: View>: View {
    @Environment(\.systemPrefersReducedResourceUsage) private var prefersReducedResourceUsage
    @ViewBuilder let content: (Bool) -> Content

    var body: some View {
        content(prefersReducedResourceUsage)
    }
}
#endif
