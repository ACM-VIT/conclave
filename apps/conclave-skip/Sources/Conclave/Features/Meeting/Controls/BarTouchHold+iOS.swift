#if os(iOS) && !SKIP
import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

// S30 1 c and CC16 (CTL-2): the auto-hide hold for system menus opened from the bar. SwiftUI `Menu` and `contextMenu`
// report no open or close, so a touch that begins inside the bar sets the stage's `bar.hold` transient id, which keeps
// chrome visible while the host Leave menu (and later the Mic, Camera and More menus) is open. The controls presenter
// clears it on its next action (`StagePresenter.noteControlAction()`), and a stage tap or a panel open clears it too; a
// menu dismissed without a choice keeps chrome up until the next stage tap, the safe failure (1 c).
//
// One window-level recognizer per bar: it never cancels, delays or claims a touch (`cancelsTouchesInView` false, both
// delays off, simultaneous with every recognizer) and fails right after `touchesBegan`. The bar installs it from a
// zero-interaction background view with the bar's own frame, so "inside the bar" needs no global geometry.

extension View {
    /// Installs the bar touch hold behind this view (the control bar row or column).
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

/// Takes no touches itself; attaches the recognizer to its window while it is in one.
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
