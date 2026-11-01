#if os(iOS) && !SKIP
import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass
import ReplayKit

enum ScreenSharePickerSupport {
    static var isAvailable: Bool {
        UIDevice.current.userInterfaceIdiom == .pad && !ProcessInfo.processInfo.isiOSAppOnMac
            && !ProcessInfo.processInfo.isMacCatalystApp
    }
}

struct ScreenSharePickerControl: View {
    let model: CallControlModel
    let controls: CallControlsPresenter
    let diameter: CGFloat
    let mode: ScreenSharePickerMode
    @State private var isPressed = false

    var body: some View {
        let holding = mode == ScreenSharePickerMode.holding
        CallControlSurfaceBody(
            label: ZStack {
                ScreenShareBroadcastPicker(isInteractive: !holding,
                                           title: CallControlsCopy.title(CallControlKind.screenShare),
                                           value: CallControlsCopy.value(model),
                                           inputLabels: CallControlsCopy.inputLabels(CallControlKind.screenShare),
                                           onPress: { pressed in isPressed = pressed },
                                           onArm: { ScreenCaptureManager.shared.armSystemPicker() },
                                           onActivate: { _ = controls.beginSystemSharePicker() })
                    .frame(width: diameter, height: diameter)
                CallControlGlyph(systemImage: CallControlsCopy.glyph(model), showsSpinner: holding, visual: model.visual)
                    .allowsHitTesting(false)
            },
            isPressed: isPressed && !holding, visual: model.visual, isBlocked: false, diameter: diameter)
        .help(CallControlsCopy.title(CallControlKind.screenShare))
    }
}

private struct ScreenShareBroadcastPicker: UIViewRepresentable {
    let isInteractive: Bool
    let title: String
    let value: String
    let inputLabels: [String]
    let onPress: (Bool) -> Void
    let onArm: () -> Void
    let onActivate: () -> Void

    func makeUIView(context: Context) -> ScreenSharePickerHostView {
        let view = ScreenSharePickerHostView(frame: .zero)
        configure(view)
        return view
    }

    func updateUIView(_ uiView: ScreenSharePickerHostView, context: Context) {
        configure(uiView)
    }

    private func configure(_ view: ScreenSharePickerHostView) {
        view.onPress = onPress
        view.onArm = onArm
        view.onActivate = onActivate
        view.isUserInteractionEnabled = isInteractive
        view.accessibilityLabel = title
        view.accessibilityValue = value
        view.accessibilityTraits = isInteractive ? .button : [.button, .notEnabled]
        view.accessibilityUserInputLabels = inputLabels
        view.largeContentTitle = title
    }
}

final class ScreenSharePickerHostView: UIView, UIGestureRecognizerDelegate {
    static let accessibilityIdentifierValue = "control.screenShare.picker"

    let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 52, height: 52))
    var onPress: ((Bool) -> Void)?
    var onArm: (() -> Void)?
    var onActivate: (() -> Void)?
    private weak var observedButton: UIButton?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        picker.preferredExtension = ScreenCaptureManager.broadcastExtensionBundleId
        picker.showsMicrophoneButton = false
        picker.tintColor = .clear
        picker.backgroundColor = .clear
        picker.frame = bounds
        picker.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        picker.accessibilityElementsHidden = true
        addSubview(picker)

        isAccessibilityElement = true
        accessibilityIdentifier = Self.accessibilityIdentifierValue
        showsLargeContentViewer = true
        largeContentImage = UIImage(systemName: ConclaveSymbols.rectangleOnRectangle)
        addInteraction(UILargeContentViewerInteraction())

        let observer = ScreenSharePickerTouchObserver(
            onBegan: { [weak self] in
                self?.onArm?()
                self?.onPress?(true)
            },
            onEnded: { [weak self] in
                self?.onPress?(false)
            },
            onCancelled: { [weak self] in
                self?.onPress?(false)
            })
        observer.delegate = self
        addGestureRecognizer(observer)
    }

    required init?(coder: NSCoder) {
        return nil
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        picker.frame = bounds
        for case let button as UIButton in picker.subviews {
            button.frame = picker.bounds
            if observedButton !== button {
                observedButton?.removeTarget(self, action: #selector(buttonActivated), for: .touchUpInside)
                button.addTarget(self, action: #selector(buttonActivated), for: .touchUpInside)
                observedButton = button
            }
        }
    }

    @objc private func buttonActivated() {
        onActivate?()
    }

    override func accessibilityActivate() -> Bool {
        false
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        let radius = min(bounds.width, bounds.height) / 2
        let dx = point.x - bounds.midX
        let dy = point.y - bounds.midY
        return dx * dx + dy * dy <= radius * radius
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        true
    }
}

final class ScreenSharePickerTouchObserver: UIGestureRecognizer {
    private let onBegan: () -> Void
    private let onEnded: () -> Void
    private let onCancelled: () -> Void
    private var isTracking = false

    init(onBegan: @escaping () -> Void, onEnded: @escaping () -> Void, onCancelled: @escaping () -> Void) {
        self.onBegan = onBegan
        self.onEnded = onEnded
        self.onCancelled = onCancelled
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        if touches.count > 1 || (event.allTouches?.count ?? 0) > 1 {
            if isTracking { onCancelled() }
            isTracking = false
            state = .failed
            return
        }
        isTracking = true
        onBegan()
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesEnded(touches, with: event)
        guard isTracking else {
            state = .failed
            return
        }
        isTracking = false
        onEnded()
        state = .failed
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesCancelled(touches, with: event)
        if isTracking { onCancelled() }
        isTracking = false
        state = .failed
    }

    override func reset() {
        super.reset()
        if isTracking { onCancelled() }
        isTracking = false
    }
}
#endif
