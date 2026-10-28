#if os(iOS) && !SKIP
import SwiftUI

// S60 9 c B1 (ACT-3) on iOS: the Reaction pad. One button that fills the card's width: pointer-down sends exactly one
// tap (a zero-distance drag, latched until the next phase, so a held touch or a second finger never sends twice);
// VoiceOver activation and the Space and Return keys call the same action. Arming is the raised surface with "Wait for
// Green"; go is the in-call success fill with dark ink "Tap Now" (text and state, never color alone, and never white on
// green, INM G8); an early tap reads "Too Soon" with a warning glyph. Color and text change in one frame (no fade, so
// timing is fair). `tapValid` plays only for a tap sent while the pad showed go; the go transition is announced once,
// assertively, so screen reader players can play.

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

    /// One tap per phase: the latch is set only when the tap was actually sent, so a press during another pending move
    /// can still send on the next press.
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
