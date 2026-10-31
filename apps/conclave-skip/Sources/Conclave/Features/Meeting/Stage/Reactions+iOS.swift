#if os(iOS) && !SKIP
import SwiftUI

struct ReactionBurstLayer: View {
    let stage: StagePresenter
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let kind = stage.kind
        if kind != .attendeeWaiting && kind != .attendeeLive {
            ReactionBurstColumn(stage: stage, reduceMotion: reduceMotion)
        }
    }
}

private struct ReactionBurstColumn: View {
    let stage: StagePresenter
    let reduceMotion: Bool

    var body: some View {
        let events = StageReactionPolicy.visibleEvents(stage.reactions)
        ZStack(alignment: .bottomLeading) {
            ForEach(events) { event in
                ReactionBubble(event: event, reduceMotion: reduceMotion)
                    .zIndex(event.isLocal ? 1 : 0)
            }
        }
        .padding(.leading, CGFloat(StageReactionPolicy.leadingInset))

        .padding(.bottom, StageCanvasMetrics.barReserve + 64)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private final class ReactionStartBox {
    var started = false
}

private struct ReactionBubble: View {
    let event: ReactionEvent
    let reduceMotion: Bool
    @State private var rise: CGFloat = 0
    @State private var drift: CGFloat = 0
    @State private var popScale: CGFloat
    @State private var appear: Double = 0
    @State private var fade: Double = 1
    @State private var box = ReactionStartBox()

    init(event: ReactionEvent, reduceMotion: Bool) {
        self.event = event
        self.reduceMotion = reduceMotion
        _popScale = State(initialValue: reduceMotion ? 1 : CGFloat(StageReactionPolicy.popFromScale))
    }

    private var name: String {
        if event.isLocal { return ConclaveStrings.text("You") }
        return event.senderName.isEmpty ? ConclaveStrings.text("Someone") : event.senderName
    }

    var body: some View {
        let lane = CGFloat(StageReactionPolicy.lane(for: event.id))
        let diameter = CGFloat(StageReactionPolicy.bubbleDiameter)
        VStack(spacing: 4) {
            Text(event.kind == "emoji" ? event.value : event.label)
                .font(.system(size: 28))
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .frame(width: diameter, height: diameter)
                .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), in: Circle())
                .overlay { Circle().strokeBorder(HostingTheme.inCallBorder, lineWidth: 1) }
            namePill
        }
        .scaleEffect(popScale)
        .offset(x: lane * CGFloat(StageReactionPolicy.laneOffset) + drift, y: -rise)
        .opacity(appear * fade)
        .onAppear(perform: start)
    }

    @ViewBuilder
    private var namePill: some View {
        let label = Text(name)
            .font(.caption2)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
        if event.isLocal {
            label
                .foregroundStyle(HostingTheme.inCallCoralText)
                .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), in: Capsule())
                .overlay { Capsule().strokeBorder(HostingTheme.inCallBorder, lineWidth: 1) }
        } else {
            label
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .background(HostingTheme.inCallLabelScrim, in: Capsule())
        }
    }

    private func start() {
        guard !box.started else { return }
        box.started = true
        let riseSeconds = StageReactionPolicy.riseMillis / 1000.0
        let lifetime = StageReactionPolicy.lifetimeMillis / 1000.0
        if reduceMotion {

            withAnimation(.easeIn(duration: StageReactionPolicy.reducedFadeInMillis / 1000.0)) { appear = 1 }
            let fadeOut = StageReactionPolicy.reducedFadeOutMillis / 1000.0
            withAnimation(.easeOut(duration: fadeOut).delay(lifetime - fadeOut)) { fade = 0 }
        } else {
            appear = 1
            withAnimation(.smooth(duration: StageReactionPolicy.popMillis / 1000.0)) { popScale = 1 }
            withAnimation(.easeOut(duration: riseSeconds)) {
                rise = CGFloat(StageReactionPolicy.riseDistance)
                drift = CGFloat(StageReactionPolicy.driftDistance * StageReactionPolicy.driftDirection(eventId: event.id))
            }
            let fadeStart = riseSeconds * StageReactionPolicy.fadeStartFraction
            withAnimation(.easeIn(duration: riseSeconds - fadeStart).delay(fadeStart)) { fade = 0 }
        }
    }
}
#endif
