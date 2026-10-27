#if os(iOS) && !SKIP
import SwiftUI

// ENT-5 (S10 8 c, h, k; 0.6 L10, R3): the iOS entry transition plumbing. The lobby card writes its global frame into a
// non-observed anchor store (no view invalidates when it moves); when the root flips to the call, the call branch
// reads that frame once and grows a flat stage-colored shape from the card to the window with
// `ConclaveMotion.entryExpand`, then the stage is revealed under it and the shape dissolves. The animation moves a
// shape and opacity only: no renderer is created, resized or scaled for it, and the call content is measured once at
// full size. An anchor preference is not used: preferences set inside a pushed NavigationStack destination are not
// reliably visible to the stack's ancestors (S10 8 c). Reduce Motion, the cross-fade preference, no recorded frame
// and the interim legacy call root use `ConclaveMotion.crossFade` instead.

/// The lobby card's last global frame (S10 0.6 L10), an `@ObservationIgnored`-style plain reference owned by the root.
final class EntryTransitionAnchorStore {
    private(set) var routeId = 0
    private(set) var frame = CGRect.zero
    /// Debug readout (S10 8 l8): how many frames the card reported, and the last frame an expansion consumed.
    private(set) var recordCount = 0
    private(set) var lastConsumedFrame = CGRect.zero

    func record(routeId: Int, frame: CGRect) {
        self.routeId = routeId
        self.frame = frame
        recordCount += 1
    }

    /// The recorded frame for the lobby on top, or nil (another route, nothing recorded, no size).
    func frame(forRoute lobbyRouteId: Int) -> CGRect? {
        guard EntryTransitionPolicy.isUsableCardFrame(recordedRouteId: routeId, lobbyRouteId: lobbyRouteId,
                                                      width: Double(frame.width), height: Double(frame.height)) else {
            return nil
        }
        return frame
    }

    /// The call covered the premeeting stack: the frame is spent (kept for the readout).
    func clear() {
        if routeId != 0 {
            lastConsumedFrame = frame
        }
        routeId = 0
        frame = .zero
    }

    /// ASCII readout for the fixture route: the last consumed frame, else the current one, as "x,y,w,h" rounded to
    /// points; "none" when nothing was recorded.
    var readout: String {
        let shown = lastConsumedFrame != .zero ? lastConsumedFrame : frame
        guard shown != .zero else { return "none" }
        return [shown.minX, shown.minY, shown.width, shown.height]
            .map { String(Int($0.rounded())) }
            .joined(separator: ",")
    }
}

private struct EntryTransitionAnchorsKey: EnvironmentKey {
    static let defaultValue: EntryTransitionAnchorStore? = nil
}

extension EnvironmentValues {
    /// The root's anchor store, injected above the premeeting NavigationStack; nil outside the native root.
    var entryTransitionAnchors: EntryTransitionAnchorStore? {
        get { self[EntryTransitionAnchorsKey.self] }
        set { self[EntryTransitionAnchorsKey.self] = newValue }
    }
}

extension View {
    /// The lobby card reports its global frame for the entry expansion (S10 8 c start frame).
    func entryTransitionAnchor(routeId: Int) -> some View {
        modifier(EntryTransitionAnchorRecorder(routeId: routeId))
    }

    /// The call content's entry: the card expansion when `start` is a frame, else the cross-fade the caller's
    /// transition draws. `onCovered` runs once the call content fully covers the premeeting stack.
    func entryExpansion(start: CGRect?, onCovered: @escaping () -> Void) -> some View {
        modifier(EntryExpansion(start: start, onCovered: onCovered))
    }
}

private struct EntryTransitionAnchorRecorder: ViewModifier {
    let routeId: Int
    @Environment(\.entryTransitionAnchors) private var anchors

    func body(content: Content) -> some View {
        // A plain reference write: nothing observes the store, so a frame change never re-renders a view.
        content.onGeometryChange(for: CGRect.self) { proxy in
            proxy.frame(in: .global)
        } action: { frame in
            anchors?.record(routeId: routeId, frame: frame)
        }
    }
}

/// S10 8 c: the call content stays hidden while the shape grows from the card, is revealed from 70% of the spring
/// over 0.16 s while the shape dissolves, and the shape is removed when the reveal ends. The start frame is read once,
/// when the call content is inserted (the state's initial value).
private struct EntryExpansion: ViewModifier {
    let onCovered: () -> Void
    @State private var start: CGRect?
    @State private var expanded = false
    @State private var revealed = false
    @State private var finished = false

    init(start: CGRect?, onCovered: @escaping () -> Void) {
        self.onCovered = onCovered
        _start = State(initialValue: start)
    }

    func body(content: Content) -> some View {
        content
            .opacity(start == nil || revealed ? 1 : 0)
            .overlay {
                if let start, !finished {
                    EntryExpansionShape(start: start, expanded: expanded)
                        .opacity(revealed ? 0 : 1)
                }
            }
            // `.task` runs once per insertion; a body re-run never restarts it (appearance callbacks may re-fire).
            .task {
                await run()
            }
    }

    @MainActor
    private func run() async {
        guard !expanded, !finished else { return }
        guard start != nil else {
            // The cross-fade: the caller's opacity transition runs; report coverage when it ends.
            try? await Task.sleep(nanoseconds: UInt64(ConclaveMotionDurations.crossFadeMillis) * 1_000_000)
            guard !Task.isCancelled else { return }
            finished = true
            onCovered()
            return
        }
        withAnimation(ConclaveMotion.entryExpand) {
            expanded = true
        }
        let reveal = Animation.easeOut(duration: Double(EntryTransitionPolicy.revealDurationMillis) / 1000.0)
            .delay(EntryTransitionPolicy.iosRevealDelaySeconds)
        withAnimation(reveal, completionCriteria: .removed) {
            revealed = true
        } completion: {
            finished = true
            onCovered()
        }
    }
}

/// The flat stage-colored shape (`iosInCallStage`), from the card's frame and tile radius to the window with radius 0.
private struct EntryExpansionShape: View {
    let start: CGRect
    let expanded: Bool

    var body: some View {
        GeometryReader { proxy in
            let container = proxy.frame(in: .global)
            let from = start.offsetBy(dx: -container.minX, dy: -container.minY)
            let to = CGRect(origin: .zero, size: proxy.size)
            let rect = expanded ? to : from
            RoundedRectangle(cornerRadius: expanded ? 0 : CGFloat(DesignTokens.radiusTile), style: .continuous)
                .fill(HostingTheme.token(DesignTokens.iosInCallStage))
                .frame(width: rect.width, height: rect.height)
                .position(x: rect.midX, y: rect.midY)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
#endif
