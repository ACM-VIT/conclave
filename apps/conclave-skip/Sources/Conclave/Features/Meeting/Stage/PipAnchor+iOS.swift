#if os(iOS) && !SKIP
import SwiftUI
import UIKit

private struct RendererFrameSizesKey: EnvironmentKey {
    static let defaultValue: RendererFrameSizeStore? = nil
}

extension EnvironmentValues {

    var rendererFrameSizes: RendererFrameSizeStore? {
        get { self[RendererFrameSizesKey.self] }
        set { self[RendererFrameSizesKey.self] = newValue }
    }
}

@MainActor
final class StagePipAnchorRegistry {
    static let shared = StagePipAnchorRegistry()

    private(set) weak var view: UIView?

    private(set) var createdCount = 0

    func register(_ anchor: UIView) {
        if view === anchor { return }
        view = anchor
        createdCount += 1

        VideoCallPictureInPicture.shared.anchorDidChange()
    }

    func unregister(_ anchor: UIView) {
        if view === anchor {
            view = nil
            VideoCallPictureInPicture.shared.anchorDidChange()
        }
    }
}

struct StagePipAnchor: View {
    let stage: StagePresenter
    @State private var size: CGSize = .zero
    @Environment(\.layoutDirection) private var layoutDirection

    var body: some View {
        let choice = stage.pipTarget

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

            .environment(\.layoutDirection, .leftToRight)
            .onGeometryChange(for: CGSize.self) { proxy in proxy.size } action: { next in
                if next != size { size = next }
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

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
