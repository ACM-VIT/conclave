#if os(iOS) && !SKIP
import SwiftUI
import UIKit

// S20 13 j and S70 3 c (STG-7; RECONCILE R28, S70 R70-10): the stage root hosts ONE stable Picture in Picture anchor, a
// transparent `UIView` created once per call root and positioned and sized to the PiP target slot (`PipTargetFrame` in
// pt) on every target or layout change. The WP3 `AVPictureInPictureController` (SYS-4) uses it as its
// `activeVideoCallSourceView`; chrome fades, panel opens and rotations move it but never recreate it, so the controller's
// source never changes. It takes no touches and is never an accessibility element. The renderer frame sizes reach
// the target frame through `EnvironmentValues.rendererFrameSizes` (the live renderer's delegate reports them).

private struct RendererFrameSizesKey: EnvironmentKey {
    static let defaultValue: RendererFrameSizeStore? = nil
}

extension EnvironmentValues {
    /// The stage's renderer frame-size store (`StagePresenter.frameSizes`), injected by the call root; nil outside it,
    /// where renderers report nothing.
    var rendererFrameSizes: RendererFrameSizeStore? {
        get { self[RendererFrameSizesKey.self] }
        set { self[RendererFrameSizesKey.self] = newValue }
    }
}

/// Where SYS-4 finds the anchor: the one live anchor view of the current call root (weak, main thread only).
@MainActor
final class StagePipAnchorRegistry {
    static let shared = StagePipAnchorRegistry()
    /// The anchor view; nil when no native call root is mounted.
    private(set) weak var view: UIView?
    /// How many anchors were created (the identity readout: one per call root, never per chrome or panel change).
    private(set) var createdCount = 0

    func register(_ anchor: UIView) {
        if view === anchor { return }
        view = anchor
        createdCount += 1
        // SYS-4: one controller per call; a new anchor only updates its source.
        VideoCallPictureInPicture.shared.anchorDidChange()
    }

    func unregister(_ anchor: UIView) {
        if view === anchor {
            view = nil
            VideoCallPictureInPicture.shared.anchorDidChange()
        }
    }
}

/// Mounted once as a sibling of the canvas (full bleed, like the canvas). Reads `stage.pipTarget` and `stage.layout`
/// only, so speaker and reaction churn never reach it.
struct StagePipAnchor: View {
    let stage: StagePresenter
    @State private var size: CGSize = .zero
    @Environment(\.layoutDirection) private var layoutDirection

    var body: some View {
        let choice = stage.pipTarget
        // `size` re-evaluates the anchor on a rotation that keeps the slot list; frames follow the viewport the
        // canvas just reported (both in canvas points, measured from the leading edge).
        let target = PipTargetPolicy.frame(choice: choice, frames: stage.currentFrames(), canvasWidth: Double(size.width),
                                           originX: 0, originY: 0, scale: 1,
                                           isRightToLeft: layoutDirection == .rightToLeft, frameSize: RendererFrameSize.zero)
        let width = max(1, CGFloat((target?.right ?? 1) - (target?.left ?? 0)))
        let height = max(1, CGFloat((target?.bottom ?? 1) - (target?.top ?? 0)))
        Color.clear
            .overlay(alignment: .topLeading) {
                StagePipAnchorView()
                    .frame(width: width, height: height)
                    .offset(x: CGFloat(target?.left ?? 0), y: CGFloat(target?.top ?? 0))
            }
            // Absolute window coordinates: the policy already mirrored x for right-to-left.
            .environment(\.layoutDirection, .leftToRight)
            .onGeometryChange(for: CGSize.self) { proxy in proxy.size } action: { next in
                if next != size { size = next }
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

/// The anchor itself: created once by SwiftUI for the call root's lifetime; registers with the registry.
struct StagePipAnchorView: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        view.accessibilityIdentifier = "stage.pipAnchor"
        StagePipAnchorRegistry.shared.register(view)
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {}

    static func dismantleUIView(_ uiView: UIView, coordinator: ()) {
        StagePipAnchorRegistry.shared.unregister(uiView)
    }
}
#endif
