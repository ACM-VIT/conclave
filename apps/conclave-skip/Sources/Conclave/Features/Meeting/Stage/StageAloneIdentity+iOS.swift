#if os(iOS) && !SKIP
import SwiftUI
import UIKit

struct StageAloneIdentity: View {
    let alone: StageAloneSnapshot
    let viewport: StageViewport

    var body: some View {
        if StageAlonePolicy.usesCenteredLayout(viewport) {
            StageAloneCenteredComposition(alone: alone, viewport: viewport)
                .dynamicTypeSize(...DynamicTypeSize.accessibility2)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("stage.alone")
        } else {
            StageAloneComposition(alone: alone, viewport: viewport)
                .dynamicTypeSize(...DynamicTypeSize.accessibility2)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("stage.alone")
        }
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

private struct StageAloneCenteredComposition: View {
    let alone: StageAloneSnapshot
    let viewport: StageViewport
    @Environment(CallControlsPresenter.self) private var controls: CallControlsPresenter?

    var body: some View {
        VStack(spacing: CGFloat(StageAlonePolicy.centeredSpacing)) {
            ConclaveAvatar(identity: ConclaveAvatarIdentity.fromSeed(alone.seed), size: .lobby,
                           diameter: CGFloat(StageAlonePolicy.centeredAvatarDiameter))
                .accessibilityHidden(true)
            VStack(spacing: CGFloat(StageAlonePolicy.lineSpacing) + 2) {
                Text(verbatim: alone.roomLabel)
                    .font(.title.weight(.semibold))
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .lineLimit(2)
                    .truncationMode(.middle)
                Text(ConclaveStrings.text("Waiting for others"))
                    .font(.body)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .lineLimit(1)
            }
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
            if let controls {
                StageAloneInviteActions(controls: controls)
                    .padding(.top, 4)
            }
        }
        .frame(maxWidth: CGFloat(StageAlonePolicy.centeredMaxWidth))
        .padding(.top, CGFloat(StageAlonePolicy.topPadding(viewport)))
        .padding(.leading, CGFloat(viewport.insetLeading + StageAlonePolicy.edgeInset))
        .padding(.trailing, CGFloat(viewport.insetTrailing + StageAlonePolicy.edgeInset))
        .padding(.bottom, CGFloat(StageAlonePolicy.bottomPadding(viewport)))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }
}

private struct StageAloneInviteActions: View {
    let controls: CallControlsPresenter
    @State private var copies = 0
    @State private var showsCopied = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let more = controls.more
        let link = more.meetingLink
        let canCopy = more.item(MoreItemID.copyLink)?.isEnabled ?? false
        if !link.isEmpty, let url = URL(string: link) {
            HStack(spacing: 12) {
                Button {
                    copy(link)
                } label: {
                    Label(showsCopied ? ConclaveStrings.text("Copied") : ConclaveStrings.text("Copy Link"),
                          systemImage: showsCopied ? ConclaveSymbols.checkmark : ConclaveSymbols.docOnDoc)
                        .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace))
                }
                .buttonStyle(StageAloneActionStyle(isEnabled: canCopy))
                .disabled(!canCopy)
                .accessibilityIdentifier("stage.alone.copyLink")
                ShareLink(item: url, subject: Text(ConclaveStrings.text("Join My Conclave Meeting")),
                          message: Text(ConclaveStrings.text("Join me in this Conclave meeting.")),
                          preview: SharePreview(Text(more.roomLabel))) {
                    Label(ConclaveStrings.text("Invite"), systemImage: ConclaveSymbols.squareAndArrowUp)
                }
                .buttonStyle(StageAloneActionStyle(isEnabled: true))
                .accessibilityLabel(ConclaveStrings.text("Share Invite"))
                .accessibilityIdentifier("stage.alone.invite")
            }
            .conclaveGestureFeedback(.linkCopied, trigger: copies)
            .task(id: copies) {
                guard copies > 0 else { return }
                try? await Task.sleep(for: .milliseconds(Int(MeetingInfoPolicy.copiedMillis)))
                if Task.isCancelled { return }
                showsCopied = false
            }
        }
    }

    private func copy(_ link: String) {
        if let url = URL(string: link) {
            UIPasteboard.general.url = url
        } else {
            UIPasteboard.general.string = link
        }
        if controls.copyLink(postsToast: true) == ControlTapResult.dispatched {
            copies += 1
            withAnimation(ConclaveMotion.travel(ConclaveMotion.snap, reduceMotion: reduceMotion)) { showsCopied = true }
        }
    }
}

private struct StageAloneActionStyle: ButtonStyle {
    let isEnabled: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .labelStyle(.titleAndIcon)
            .padding(.horizontal, 20)
            .frame(minHeight: 44)
            .contentShape(Capsule())
            .conclaveControlSurface(ConclaveControlState.on, isEnabled: isEnabled, shape: .capsule)
            .conclaveControlPressed(configuration.isPressed)
            .conclavePointerHover(shape: .capsule)
    }
}
#endif
