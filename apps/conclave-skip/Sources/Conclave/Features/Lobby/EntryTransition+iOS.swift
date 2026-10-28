#if os(iOS) && !SKIP
import SwiftUI

final class EntryTransitionAnchorStore {
    private(set) var routeId = 0
    private(set) var frame = CGRect.zero

    private(set) var recordCount = 0
    private(set) var lastConsumedFrame = CGRect.zero

    func record(routeId: Int, frame: CGRect) {
        self.routeId = routeId
        self.frame = frame
        recordCount += 1
    }

    func frame(forRoute lobbyRouteId: Int) -> CGRect? {
        guard EntryTransitionPolicy.isUsableCardFrame(recordedRouteId: routeId, lobbyRouteId: lobbyRouteId,
                                                      width: Double(frame.width), height: Double(frame.height)) else {
            return nil
        }
        return frame
    }

    func clear() {
        if routeId != 0 {
            lastConsumedFrame = frame
        }
        routeId = 0
        frame = .zero
    }

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

    var entryTransitionAnchors: EntryTransitionAnchorStore? {
        get { self[EntryTransitionAnchorsKey.self] }
        set { self[EntryTransitionAnchorsKey.self] = newValue }
    }
}

extension View {

    func entryTransitionAnchor(routeId: Int) -> some View {
        modifier(EntryTransitionAnchorRecorder(routeId: routeId))
    }

    func entryExpansion(start: CGRect?, onCovered: @escaping () -> Void) -> some View {
        modifier(EntryExpansion(start: start, onCovered: onCovered))
    }
}

private struct EntryTransitionAnchorRecorder: ViewModifier {
    let routeId: Int
    @Environment(\.entryTransitionAnchors) private var anchors

    func body(content: Content) -> some View {

        content.onGeometryChange(for: CGRect.self) { proxy in
            proxy.frame(in: .global)
        } action: { frame in
            anchors?.record(routeId: routeId, frame: frame)
        }
    }
}

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

            .task {
                await run()
            }
    }

    @MainActor
    private func run() async {
        guard !expanded, !finished else { return }
        guard start != nil else {

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
