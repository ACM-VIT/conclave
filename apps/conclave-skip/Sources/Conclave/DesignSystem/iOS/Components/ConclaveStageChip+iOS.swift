#if os(iOS) && !SKIP
import SwiftUI

/// The compact stage status capsule (S20 SR3; F00 C03 f variant) for Hand Raised, Now Playing, Share Invite and the
/// minimized self view: an optional glyph, the text and an optional trailing text action. Flat on every OS
/// version: the in-call label scrim (80% under Increase Contrast) with a 1 pt border, never glass and never inside
/// the chrome cluster's glass container, because chips stay on screen while chrome hides. The chip text is one element; the
/// action is its own element after it. Capped at xxxLarge with the Large Content Viewer.
struct ConclaveStageChip: View {
    let title: String
    let systemImage: String?
    let actionTitle: String?
    let identifier: String
    let onTap: (() -> Void)?
    let onAction: (() -> Void)?

    init(title: String, systemImage: String? = nil, actionTitle: String? = nil, identifier: String,
         onTap: (() -> Void)? = nil, onAction: (() -> Void)? = nil) {
        self.title = title
        self.systemImage = systemImage
        self.actionTitle = actionTitle
        self.identifier = identifier
        self.onTap = onTap
        self.onAction = onAction
    }

    var body: some View {
        HStack(spacing: 8) {
            chipText
            if let actionTitle, let onAction {
                Button(actionTitle, action: onAction)
                    .buttonStyle(.borderless)
                    .font(.subheadline.weight(.semibold))
                    .tint(HostingTheme.inCallCoralText)
                    .frame(minHeight: ConclaveStageChipMetrics.targetHeight)
                    .accessibilityIdentifier(identifier + ".action")
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: ConclaveStageChipMetrics.height)
        .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
        .background(HostingTheme.inCallLabelScrim, in: Capsule())
        .overlay { Capsule().strokeBorder(HostingTheme.inCallBorder, lineWidth: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    @ViewBuilder
    private var chipText: some View {
        let label = HStack(spacing: 6) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.subheadline)
                    .accessibilityHidden(true)
            }
            Text(title)
                .font(.subheadline)
                .lineLimit(1)
        }
        if let onTap {
            Button(action: onTap) { label.frame(minHeight: ConclaveStageChipMetrics.targetHeight).contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .accessibilityLabel(title)
                .accessibilityShowsLargeContentViewer { Text(title) }
        } else {
            label
                .accessibilityElement(children: .combine)
                .accessibilityShowsLargeContentViewer { Text(title) }
        }
    }
}

enum ConclaveStageChipMetrics {
    /// The visual chip height; a tappable chip or action keeps a 44 pt target.
    static let height: CGFloat = 36
    static let targetHeight: CGFloat = 44
}
#endif
