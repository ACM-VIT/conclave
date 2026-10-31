#if os(iOS) && !SKIP
import SwiftUI
import UIKit

struct ReactionBurstLayer: View {
    let stage: StagePresenter
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var layer = ReactionLayerGeometry.zero

    var body: some View {
        let kind = stage.kind
        if kind != .attendeeWaiting && kind != .attendeeLive {
            ReactionBurstColumn(stage: stage, reduceMotion: reduceMotion, bottomInset: bottomInset, slots: reducedSlots)
                .onGeometryChange(for: ReactionLayerGeometry.self) { proxy in
                    ReactionLayerGeometry(width: Double(proxy.size.width), height: Double(proxy.size.height),
                                          top: Double(proxy.safeAreaInsets.top), bottom: Double(proxy.safeAreaInsets.bottom),
                                          leading: Double(proxy.safeAreaInsets.leading), trailing: Double(proxy.safeAreaInsets.trailing))
                } action: { next in
                    if next != layer { layer = next }
                }
        }
    }

    private var bottomInset: CGFloat {
        let tileLabelSize = min(dynamicTypeSize, DynamicTypeSize.xxxLarge)
        let tileLabel = UIFont.preferredFont(forTextStyle: .footnote,
                                             compatibleWith: UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(tileLabelSize)))
        let defaultLabel = UIFont.preferredFont(forTextStyle: .footnote,
                                                compatibleWith: UITraitCollection(preferredContentSizeCategory: .large))
        return CGFloat(StageReactionPolicy.layerBottomInset(barReserve: Double(StageCanvasMetrics.barReserve),
                                                            labelLineHeight: Double(tileLabel.lineHeight),
                                                            defaultLabelLineHeight: Double(defaultLabel.lineHeight)))
    }

    private var reducedSlots: ReactionSlotGeometry {
        let cappedTraits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(min(dynamicTypeSize, DynamicTypeSize.xxxLarge)))
        let tileLine = UIFont.preferredFont(forTextStyle: .footnote, compatibleWith: cappedTraits).lineHeight
        let pillLine = UIFont.preferredFont(forTextStyle: .caption2, compatibleWith: cappedTraits).lineHeight
        let viewport = StageViewportPolicy.iOS(
            contentWidth: layer.width, contentHeight: layer.height,
            safeArea: StageChromeInsets(top: layer.top, bottom: layer.bottom, leading: layer.leading, trailing: layer.trailing),
            regularWidth: horizontalSizeClass == .regular, compactHeight: verticalSizeClass == .compact,
            topReserve: Double(StageCanvasMetrics.topReserve), barReserve: Double(StageCanvasMetrics.barReserve),
            trailingReserve: Double(StageCanvasMetrics.trailingReserve),
            chipRowReserve: stage.chipRowVisible ? Double(StageCanvasMetrics.chipRowReserve) : 0
        )
        return ReactionSlotGeometry(slotHeight: StageReactionPolicy.reducedSlotHeight(pillLineHeight: Double(pillLine)),
                                    labelBand: StageReactionPolicy.tileLabelBand(lineHeight: Double(tileLine)),
                                    viewport: viewport, safeBottom: layer.bottom)
    }
}

private struct ReactionLayerGeometry: Equatable, Sendable {
    let width: Double
    let height: Double
    let top: Double
    let bottom: Double
    let leading: Double
    let trailing: Double

    static let zero = ReactionLayerGeometry(width: 0, height: 0, top: 0, bottom: 0, leading: 0, trailing: 0)
}

private struct ReactionSlotGeometry: Equatable {
    let slotHeight: Double
    let labelBand: Double
    let viewport: StageViewport
    let safeBottom: Double
}

private struct ReactionBurstColumn: View {
    let stage: StagePresenter
    let reduceMotion: Bool
    let bottomInset: CGFloat
    let slots: ReactionSlotGeometry

    var body: some View {
        let events = StageReactionPolicy.visibleEvents(stage.reactions, reduceMotion: reduceMotion)
        let placement = reduceMotion ? reducedPlacement : StageReactionSlotPlacement(bottomInset: Double(bottomInset), shape: .row)
        ZStack(alignment: .bottomLeading) {
            ForEach(events) { event in
                ReactionBubble(event: event, reduceMotion: reduceMotion, slotShape: placement.shape, slotHeight: slots.slotHeight)
                    .zIndex(event.isLocal ? 1 : 0)
            }
        }
        .padding(.leading, CGFloat(StageReactionPolicy.leadingInset))

        .padding(.bottom, CGFloat(placement.bottomInset))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var reducedPlacement: StageReactionSlotPlacement {
        let viewport = slots.viewport
        let layout = stage.layout
        let metrics = StageReactionSlotMetrics(defaultBottomInset: Double(bottomInset), layerLeading: viewport.insetLeading,
                                               layerBottom: slots.safeBottom, slotHeight: slots.slotHeight, labelBand: slots.labelBand,
                                               barMaxWidth: StageLayoutPolicy.isCompactHeight(viewport) ? 0.0 : viewport.width)
        let frames = StageLayoutPolicy.frames(viewport: viewport, kind: layout.kind, slots: layout.slots, selfCorner: layout.selfCorner)
        return StageReactionPolicy.reducedPlacement(viewport: viewport, kind: layout.kind, slots: layout.slots, frames: frames,
                                                    metrics: metrics)
    }
}

private final class ReactionStartBox {
    var started = false
}

private struct ReactionBubble: View {
    let event: ReactionEvent
    let reduceMotion: Bool
    let slotShape: StageReactionSlotShape
    let slotHeight: Double
    @State private var rise: CGFloat = 0
    @State private var drift: CGFloat = 0
    @State private var popScale: CGFloat
    @State private var appear: Double = 0
    @State private var fade: Double = 1
    @State private var box = ReactionStartBox()

    init(event: ReactionEvent, reduceMotion: Bool, slotShape: StageReactionSlotShape, slotHeight: Double) {
        self.event = event
        self.reduceMotion = reduceMotion
        self.slotShape = slotShape
        self.slotHeight = slotHeight
        _popScale = State(initialValue: reduceMotion ? 1 : CGFloat(StageReactionPolicy.popFromScale))
    }

    private var name: String {
        if event.isLocal { return ConclaveStrings.text("You") }
        return event.senderName.isEmpty ? ConclaveStrings.text("Someone") : event.senderName
    }

    var body: some View {
        let lane = StageReactionPolicy.lane(for: event.id)
        let slotX = CGFloat(StageReactionPolicy.slotOffsetX(lane: lane, reduceMotion: reduceMotion, shape: slotShape))
        let slotY = CGFloat(StageReactionPolicy.slotOffsetY(lane: lane, shape: slotShape, slotHeight: slotHeight))
        let diameter = CGFloat(StageReactionPolicy.bubbleDiameter)
        VStack(spacing: 4) {
            Text(event.kind == "emoji" ? event.value : event.label)
                .font(.system(size: 28))
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .frame(width: diameter, height: diameter)
                .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), in: Circle())
                .overlay { Circle().strokeBorder(HostingTheme.inCallBorder, lineWidth: 1) }
            if reduceMotion {
                namePill
                    .truncationMode(.tail)
                    .frame(maxWidth: CGFloat(StageReactionPolicy.reducedSlotWidth))
                    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            } else {
                namePill
            }
        }
        .scaleEffect(popScale)
        .offset(x: slotX + drift, y: -rise - slotY)
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
