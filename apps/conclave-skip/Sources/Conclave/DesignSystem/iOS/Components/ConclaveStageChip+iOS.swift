#if os(iOS) && !SKIP
import SwiftUI

struct ConclaveStageChip: View {
    let title: String
    let systemImage: String?
    let actionTitle: String?
    let identifier: String
    let onTap: (() -> Void)?
    let onAction: (() -> Void)?

    let actionAccessibilityLabel: String?

    init(title: String, systemImage: String? = nil, actionTitle: String? = nil, identifier: String,
         onTap: (() -> Void)? = nil, onAction: (() -> Void)? = nil, actionAccessibilityLabel: String? = nil) {
        self.title = title
        self.systemImage = systemImage
        self.actionTitle = actionTitle
        self.identifier = identifier
        self.onTap = onTap
        self.onAction = onAction
        self.actionAccessibilityLabel = actionAccessibilityLabel
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
                    .accessibilityLabel(actionAccessibilityLabel ?? actionTitle)
                    .accessibilityInputLabels([actionAccessibilityLabel ?? actionTitle, actionTitle])
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

    static let height: CGFloat = 36
    static let targetHeight: CGFloat = 44
}
#endif
