#if os(iOS) && !SKIP
import SwiftUI

struct ReactionPad: View {
    let scene: ReactionScene
    let games: GameStagePresenter
    @State private var sent = false
    @State private var validTaps = 0

    var body: some View {
        let state = scene.displayedPadState(locallySent: sent)
        let isGo = state == .go
        let title = PromptGameCopy.padTitle(state, ms: scene.reactionMs)
        ZStack {
            RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous)
                .fill(isGo ? HostingTheme.token(DesignTokens.iosInCallSuccess) : HostingTheme.token(DesignTokens.iosInCallSurfaceRaised))
            RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous)
                .strokeBorder(isGo ? HostingTheme.token(DesignTokens.iosInCallSuccess) : HostingTheme.inCallBorder, lineWidth: 1)
            VStack(spacing: 10) {
                if state == .early {
                    Image(systemName: ConclaveSymbols.exclamationmarkTriangleFill)
                        .font(.title2)
                        .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallWarning))
                        .accessibilityHidden(true)
                }
                Text(title)
                    .font(.largeTitle.weight(.bold))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(isGo ? HostingTheme.token(DesignTokens.iosInCallOnControlOff)
                                     : HostingTheme.token(DesignTokens.iosInCallText))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(20)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 0).onChanged { _ in fire() })
        .focusable(scene.canTap)
        .onKeyPress(.space) {
            fire()
            return .handled
        }
        .onKeyPress(.return) {
            fire()
            return .handled
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(PromptGameCopy.tapNow())
        .accessibilityValue(isGo ? "" : title)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { fire() }
        .accessibilityIdentifier("game.reaction.pad")
        .onChange(of: scene.phaseKey) {
            sent = false
        }
        .conclaveGestureFeedback(.tapValid, trigger: validTaps)
        .modifier(PromptAnnouncement(games: games, key: PromptScenePolicy.reactionGoKey(scene), text: PromptGameCopy.tapNow(),
                                     urgent: true))
        .transaction { transaction in
            transaction.animation = nil
        }
    }

    private func fire() {
        if sent || !scene.canTap { return }
        let showedGo = scene.displayedPadState(locallySent: false) == .go
        if games.send(GameMoveIntent.tap()) == .dispatched {
            sent = true
            if showedGo { validTaps += 1 }
        }
    }
}
#endif
