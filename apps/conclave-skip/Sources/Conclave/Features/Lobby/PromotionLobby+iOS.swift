#if os(iOS) && !SKIP
import SwiftUI
import UIKit

struct PromotionLobbySheet: ViewModifier {
    let premeeting: PremeetingPresenter

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

                if !shown && premeeting.promotionRoute != nil { premeeting.cancelPromotion() }
            })) {
                PromotionLobbyContent(premeeting: premeeting)
                    .presentationDetents([.large])
                    .preferredColorScheme(sceneScheme ?? inheritedScheme)
            }
    }
}

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
