#if os(iOS) && !SKIP
import SwiftUI

extension View {

    func reactionsTray(isPresented: Binding<Bool>, controls: CallControlsPresenter, onSent: @escaping () -> Void) -> some View {
        modifier(ReactionsTrayPresenter(isPresented: isPresented, controls: controls, onSent: onSent))
    }
}

private struct ReactionsTrayPresenter: ViewModifier {
    @Binding var isPresented: Bool
    let controls: CallControlsPresenter
    let onSent: () -> Void
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @State private var trayHeight: CGFloat = 132

    func body(content: Content) -> some View {
        Group {
            if horizontalSizeClass == .regular {
                content.popover(isPresented: $isPresented, arrowEdge: .bottom) {
                    ReactionsTray(controls: controls, onSent: onSent)
                        .preferredColorScheme(.dark)
                }
            } else {
                content.sheet(isPresented: $isPresented) {
                    ReactionsTray(controls: controls, onSent: onSent)
                        .onGeometryChange(for: CGFloat.self) { proxy in proxy.size.height } action: { height in
                            let next = height + 24
                            if abs(next - trayHeight) > 0.5 { trayHeight = next }
                        }
                        .presentationDetents([.height(trayHeight)])
                        .presentationBackgroundInteraction(.enabled(upThrough: .height(trayHeight)))
                        .presentationDragIndicator(.visible)
                        .preferredColorScheme(.dark)
                }
            }
        }
        .onChange(of: isPresented) { _, open in

            controls.stage.setTransientChrome(id: ChromeAutoHidePolicy.reactionsTray, open: open)
        }
    }
}

struct ReactionsTray: View {
    let controls: CallControlsPresenter
    let onSent: () -> Void
    @State private var sendCounter = 0

    var body: some View {
        let reactions = controls.reactions
        VStack(spacing: 8) {
            ReactionsTrayRow(options: reactions.emoji, isEnabled: reactions.isAvailable, identifier: "palette.reactions.tray.emoji",
                             send: send)
            if !reactions.art.isEmpty {
                ReactionsTrayRow(options: reactions.art, isEnabled: reactions.isAvailable, identifier: "palette.reactions.tray.art",
                                 send: send)
            }
            if let reason = MoreCopy.reactionsReason(reactions) {
                Text(reason)
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallTextSecondary))
            }
        }
        .padding(12)
        .conclaveGestureFeedback(.reactionSent, trigger: sendCounter)
        .accessibilityIdentifier("palette.reactions.tray")
    }

    private func send(_ id: String) {
        if controls.sendReaction(id: id) == ControlTapResult.dispatched {
            sendCounter += 1
            onSent()
        }
    }
}

private struct ReactionsTrayRow: View {
    let options: [ReactionOptionModel]
    let isEnabled: Bool
    let identifier: String
    let send: (String) -> Void

    var body: some View {
        HStack(spacing: 4) {
            ForEach(options) { option in
                Button {
                    send(option.id)
                } label: {
                    ReactionGlyph(option: option)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!isEnabled)
                .accessibilityLabel(MoreCopy.reactionLabel(option))
                .accessibilityIdentifier(identifier + "." + option.nameKey)
            }
        }
    }
}

struct ReactionGlyph: View {
    let option: ReactionOptionModel

    var body: some View {
        if option.kind == ReactionKind.asset.rawValue {
            Image(ReactionArtAssets.assetName(option.id))
                .resizable()
                .scaledToFit()
                .frame(width: 32, height: 32)
                .accessibilityHidden(true)
        } else {
            Text(option.id)
                .font(.title2)
                .accessibilityHidden(true)
        }
    }
}

enum ReactionArtAssets {
    static func assetName(_ id: String) -> String {
        "reaction-" + ReactionPalettePolicy.nameKey(id)
    }
}
#endif
