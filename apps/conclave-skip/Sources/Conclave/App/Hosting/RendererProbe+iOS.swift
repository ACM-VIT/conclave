#if DEBUG && os(iOS) && !SKIP
import SwiftUI
import UIKit
#if canImport(WebRTC)
import WebRTC
#endif

/// Tier A renderer-host probe (PS 7.5, 10.1): the production surface type in a counting container, with no
/// track, capture or audio session. Creation and dismantling report to the preview's ledger, and window
/// detach and reattach count as surface loss and restore, which never change identity. Smart Invert never
/// inverts it, as production video views should not be inverted either (A18).
struct RendererProbe: View {
    let key: String
    let slot: RendererSlot
    let ledger: RendererIdentityLedger

    var body: some View {
        RendererProbeHost(key: key, slot: slot, ledger: ledger)
            .accessibilityHidden(true)
            .accessibilityIgnoresInvertColors()
    }
}

private struct RendererProbeHost: UIViewRepresentable {
    let key: String
    let slot: RendererSlot
    let ledger: RendererIdentityLedger

    func makeUIView(context: Context) -> RendererProbeView {
        RendererProbeView(key: key, slot: slot, ledger: ledger)
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

    init(key: String, slot: RendererSlot, ledger: RendererIdentityLedger) {
        self.key = key
        self.slot = slot
        self.ledger = ledger
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
        ledger?.released(key: key, serial: serial, slot: slot)
        ledger = nil
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
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
#endif
