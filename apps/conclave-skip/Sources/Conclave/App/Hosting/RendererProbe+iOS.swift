#if DEBUG && os(iOS) && !SKIP
import QuartzCore
import SwiftUI
import UIKit
#if canImport(WebRTC)
import WebRTC
#endif

/// Tier A renderer-host probe (PS 7.5, 10.1): the production surface type in a counting container, with no
/// track, capture or audio session. Creation and dismantling report to the preview's ledger, and window
/// detach and reattach count as surface loss and restore, which never change identity. Smart Invert never
/// inverts it, as production video views should not be inverted either (A18).
///
/// STG-1 (S20 SL14): an optional test pattern. `staticPattern` draws flat token-colored bars once and then no frames
/// (the idle cells); `livePattern` moves a marker at 15 frames per second through a display link while the probe is
/// in a window (the renderer-driven frame cells). Both report to the same ledger; the pattern is fixed at creation.
struct RendererProbe: View {
    let key: String
    let slot: RendererSlot
    let ledger: RendererIdentityLedger
    var pattern: RendererProbePattern = .none

    var body: some View {
        RendererProbeHost(key: key, slot: slot, ledger: ledger, pattern: pattern)
            .accessibilityHidden(true)
            .accessibilityIgnoresInvertColors()
    }
}

private struct RendererProbeHost: UIViewRepresentable {
    let key: String
    let slot: RendererSlot
    let ledger: RendererIdentityLedger
    let pattern: RendererProbePattern

    func makeUIView(context: Context) -> RendererProbeView {
        RendererProbeView(key: key, slot: slot, ledger: ledger, pattern: pattern)
    }

    func updateUIView(_ uiView: RendererProbeView, context: Context) {}

    static func dismantleUIView(_ uiView: RendererProbeView, coordinator: ()) {
        uiView.release()
    }
}

final class RendererProbeView: UIView {
    private let key: String
    private let slot: RendererSlot
    private var ledger: RendererIdentityLedger?
    let serial: Int
    private var attachedOnce = false
    private var detached = false
    private let patternView: RendererProbePatternView?

    init(key: String, slot: RendererSlot, ledger: RendererIdentityLedger, pattern: RendererProbePattern = .none) {
        self.key = key
        self.slot = slot
        self.ledger = ledger
        patternView = pattern == .none ? nil : RendererProbePatternView(pattern: pattern)
        serial = ledger.created(key: key, slot: slot)
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        accessibilityIgnoresInvertColors = true
        #if canImport(WebRTC)
        let surface = RTCMTLVideoView(frame: .zero)
        surface.isUserInteractionEnabled = false
        surface.accessibilityIgnoresInvertColors = true
        addSubview(surface)
        #endif
        if let patternView {
            addSubview(patternView)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        for surface in subviews where surface.frame != bounds {
            surface.frame = bounds
        }
    }

    func release() {
        patternView?.stop()
        ledger?.released(key: key, serial: serial, slot: slot)
        ledger = nil
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            patternView?.stop()
        } else {
            patternView?.start()
        }
        guard let ledger else { return }
        if window == nil {
            if attachedOnce && !detached {
                detached = true
                ledger.surfaceLost(key: key, serial: serial, slot: slot)
            }
        } else {
            if detached {
                detached = false
                ledger.surfaceRestored(key: key, serial: serial, slot: slot)
            }
            attachedOnce = true
        }
    }
}

/// The flat test pattern (solid token colors only): four bars from the avatar palette, plus a paper marker
/// that a display link moves in the live pattern.
private final class RendererProbePatternView: UIView {
    private let pattern: RendererProbePattern
    private var bars: [CALayer] = []
    private let marker = CALayer()
    private var link: CADisplayLink?
    private var phase: CGFloat = 0

    init(pattern: RendererProbePattern) {
        self.pattern = pattern
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        accessibilityIgnoresInvertColors = true
        let palette = DesignTokens.avatarPalette
        var index = 0
        while index < 4 {
            let bar = CALayer()
            bar.backgroundColor = UIColor(HostingTheme.token(palette[index % palette.count])).cgColor
            layer.addSublayer(bar)
            bars.append(bar)
            index += 1
        }
        if pattern == .livePattern {
            marker.backgroundColor = UIColor(HostingTheme.token(DesignTokens.iosInCallText)).cgColor
            layer.addSublayer(marker)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let width = bounds.width / CGFloat(max(1, bars.count))
        for (index, bar) in bars.enumerated() {
            bar.frame = CGRect(x: CGFloat(index) * width, y: 0, width: width, height: bounds.height)
        }
        placeMarker()
        CATransaction.commit()
    }

    func start() {
        guard pattern == .livePattern, link == nil else { return }
        let target = RendererProbeLinkTarget(view: self)
        let next = CADisplayLink(target: target, selector: #selector(RendererProbeLinkTarget.step))
        next.preferredFrameRateRange = CAFrameRateRange(minimum: 10, maximum: 15, preferred: 15)
        next.add(to: .main, forMode: .common)
        link = next
    }

    func stop() {
        link?.invalidate()
        link = nil
    }

    fileprivate func advance() {
        phase += 0.02
        if phase > 1 { phase = 0 }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        placeMarker()
        CATransaction.commit()
    }

    private func placeMarker() {
        guard pattern == .livePattern else { return }
        let size = max(8, min(bounds.width, bounds.height) * 0.08)
        marker.frame = CGRect(x: (bounds.width - size) * phase, y: (bounds.height - size) / 2, width: size, height: size)
    }
}

/// Breaks the display link's strong reference to its target.
private final class RendererProbeLinkTarget: NSObject {
    weak var view: RendererProbePatternView?

    init(view: RendererProbePatternView) {
        self.view = view
    }

    @objc func step() {
        view?.advance()
    }
}
#endif
