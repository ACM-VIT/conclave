#if os(iOS) && !SKIP
import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

extension View {

    func callControlsBarTouchHold(_ stage: StagePresenter) -> some View {
        background {
            BarTouchObserver(onTouchInside: {
                stage.setTransientChrome(id: ChromeAutoHidePolicy.barHold, open: true)
            })
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }
}

private struct BarTouchObserver: UIViewRepresentable {
    let onTouchInside: () -> Void

    func makeUIView(context: Context) -> BarTouchHostView {
        let view = BarTouchHostView(frame: .zero)
        view.onTouchInside = onTouchInside
        return view
    }

    func updateUIView(_ uiView: BarTouchHostView, context: Context) {
        uiView.onTouchInside = onTouchInside
    }
}

private final class BarTouchHostView: UIView {
    var onTouchInside: (() -> Void)?
    private var recognizer: BarTouchRecognizer?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        backgroundColor = .clear
    }

    required init?(coder: NSCoder) {
        return nil
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        detach()
        guard let window else { return }
        let next = BarTouchRecognizer(host: self)
        window.addGestureRecognizer(next)
        recognizer = next
    }

    private func detach() {
        if let recognizer {
            recognizer.view?.removeGestureRecognizer(recognizer)
        }
        recognizer = nil
    }

    func noteTouchesBegan(_ touches: Set<UITouch>) {
        for touch in touches where bounds.contains(touch.location(in: self)) {
            onTouchInside?()
            return
        }
    }
}

private final class BarTouchRecognizer: UIGestureRecognizer, UIGestureRecognizerDelegate {
    private weak var host: BarTouchHostView?

    init(host: BarTouchHostView) {
        self.host = host
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
        delegate = self
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        host?.noteTouchesBegan(touches)
        state = .failed
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        true
    }
}
#endif
