#if os(iOS) && !SKIP
import SwiftUI

struct StageAloneIdentity: View {
    let alone: StageAloneSnapshot
    let viewport: StageViewport

    var body: some View {
        StageAloneComposition(alone: alone, viewport: viewport)
            .dynamicTypeSize(...DynamicTypeSize.accessibility2)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("stage.alone")
    }
}

private struct StageAloneComposition: View {
    let alone: StageAloneSnapshot
    let viewport: StageViewport
    @ScaledMetric(relativeTo: .title2) private var titleLine = StageAlonePolicy.titleLineHeight
    @ScaledMetric(relativeTo: .subheadline) private var statusLine = StageAlonePolicy.statusLineHeight

    var body: some View {
        let compact = StageAlonePolicy.usesCompactLayout(viewport, titleLine: titleLine, statusLine: statusLine)
        let titleLines = StageAlonePolicy.titleLineLimit(viewport, titleLine: titleLine, statusLine: statusLine)
        let layout = compact
            ? AnyLayout(HStackLayout(alignment: .center, spacing: CGFloat(StageAlonePolicy.avatarSpacing)))
            : AnyLayout(VStackLayout(alignment: .leading, spacing: CGFloat(StageAlonePolicy.avatarSpacing)))
        layout {
            ConclaveAvatar(identity: ConclaveAvatarIdentity.fromSeed(alone.seed), size: .lobby,
                           diameter: CGFloat(compact ? StageAlonePolicy.compactAvatarDiameter : StageAlonePolicy.avatarDiameter))
            VStack(alignment: .leading, spacing: CGFloat(StageAlonePolicy.lineSpacing)) {
                Text(verbatim: alone.roomLabel)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .lineLimit(titleLines)
                    .truncationMode(.middle)
                Text(ConclaveStrings.text("Waiting for others"))
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .lineLimit(1)
            }
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, CGFloat(StageAlonePolicy.topPadding(viewport)))
        .padding(.leading, CGFloat(viewport.insetLeading + StageAlonePolicy.edgeInset))
        .padding(.trailing, CGFloat(viewport.insetTrailing + StageAlonePolicy.edgeInset))
        .padding(.bottom, CGFloat(StageAlonePolicy.bottomPadding(viewport)))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
    }
}
#endif
