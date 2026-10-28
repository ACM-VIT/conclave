#if os(iOS) && !SKIP
import SwiftUI
import UIKit

// S50 PH20, S10 6 promotion (PPL-7; RECONCILE R30): the S10 lobby with `LobbyIntent.promotion` presented over the
// still-playing attendee viewer. iOS: a `.sheet` at the large detent in the system appearance with the dark preview
// card, never `fullScreenCover` (which would detach the viewer's renderer), so the viewer keeps playing underneath.
// The content is the one `LobbyView` (title and primary "Join as a Speaker", no presence row, no Share, no name; the
// toggles start off). Cancel, and the swipe down, decline while still an attendee (`webinar:declineStage`). The
// preview is the one `LocalPreviewController` with its publish latch (RECONCILE R22): nothing is published while the
// viewer plays. Mounted on the native call root by the premeeting root's call branch (behind the native call flag).

struct PromotionLobbySheet: ViewModifier {
    let premeeting: PremeetingPresenter
    /// The window scene's own style: the call root darkens the window on iOS 17 to 26, and this sheet follows the
    /// system appearance (Default Q8 (6)).
    @State private var sceneScheme: ColorScheme? = nil
    @Environment(\.colorScheme) private var inheritedScheme

    func body(content: Content) -> some View {
        content
            .background {
                PromotionSceneSchemeReader { scheme in
                    if sceneScheme != scheme { sceneScheme = scheme }
                }
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
            }
            .sheet(isPresented: Binding(get: { premeeting.promotionRoute != nil }, set: { shown in
                // The swipe down equals Cancel; a close the core started (Join as a Speaker) is already gone.
                if !shown && premeeting.promotionRoute != nil { premeeting.cancelPromotion() }
            })) {
                PromotionLobbyContent(premeeting: premeeting)
                    .presentationDetents([.large])
                    .preferredColorScheme(sceneScheme ?? inheritedScheme)
            }
    }
}

/// The lobby in its own NavigationStack (the title, Cancel and the bottom primary come from `LobbyView`).
private struct PromotionLobbyContent: View {
    let premeeting: PremeetingPresenter

    var body: some View {
        if let route = premeeting.promotionRoute {
            NavigationStack {
                LobbyView(route: route, premeeting: premeeting)
            }
            .accessibilityIdentifier("lobby.promotion")
        }
    }
}

/// Reports the window scene's interface style through the shared `ConclaveSceneSchemeView`.
private struct PromotionSceneSchemeReader: UIViewRepresentable {
    let onChange: (ColorScheme) -> Void

    func makeUIView(context: Context) -> ConclaveSceneSchemeView {
        let view = ConclaveSceneSchemeView()
        view.onChange = onChange
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ uiView: ConclaveSceneSchemeView, context: Context) {
        uiView.onChange = onChange
    }
}
#endif
