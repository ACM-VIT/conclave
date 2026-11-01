#if os(iOS) && !SKIP
import SwiftUI

private struct StageRenderTargetResizeKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    var stageRenderTargetResize: (() -> Void)? {
        get { self[StageRenderTargetResizeKey.self] }
        set { self[StageRenderTargetResizeKey.self] = newValue }
    }
}

@MainActor
@Observable
final class ShareZoomState {

    var live = ShareZoomValue.identity

    private(set) var settled = ShareZoomValue.identity

    private(set) var layoutScale = 1.0

    @ObservationIgnored private var gestureStart = ShareZoomValue.identity
    @ObservationIgnored private var magnification = 1.0
    @ObservationIgnored private var anchor = CGPoint.zero
    @ObservationIgnored private var translation = CGSize.zero
    @ObservationIgnored private var isPinching = false
    @ObservationIgnored private var isPanning = false

    @ObservationIgnored private var token = 0
    @ObservationIgnored private(set) var slotSize = CGSize.zero

    @ObservationIgnored private var videoWidth = 0.0
    @ObservationIgnored private var videoHeight = 0.0

    var isGestureActive: Bool { isPinching || isPanning }

    func updateVideoSize(_ size: RendererFrameSize) {
        videoWidth = Double(size.width)
        videoHeight = Double(size.height)
    }

    func pinchChanged(magnification next: CGFloat, anchor start: CGPoint) {
        beginIfIdle()
        isPinching = true
        magnification = Double(next)
        anchor = start
        recompute()
    }

    func panChanged(_ next: CGSize) {
        beginIfIdle()
        isPanning = true
        translation = next
        recompute()
    }

    func pinchEnded() -> Bool {
        isPinching = false
        return !isGestureActive
    }

    func panEnded() -> Bool {
        isPanning = false
        return !isGestureActive
    }

    func settleTarget() -> ShareZoomValue {
        ShareZoomPolicy.settled(live, slotWidth: width, slotHeight: height, videoWidth: videoWidth, videoHeight: videoHeight)
    }

    func doubleTapTarget(at point: CGPoint) -> ShareZoomValue {
        ShareZoomPolicy.doubleTapped(live, atX: Double(point.x), atY: Double(point.y), slotWidth: width, slotHeight: height,
                                     videoWidth: videoWidth, videoHeight: videoHeight)
    }

    func steppedTarget(zoomIn: Bool) -> ShareZoomValue {
        ShareZoomPolicy.stepped(live, zoomIn: zoomIn, slotWidth: width, slotHeight: height, videoWidth: videoWidth,
                                videoHeight: videoHeight)
    }

    func beginSettle() -> Int {
        token += 1
        return token
    }

    func commit(_ value: ShareZoomValue, token expected: Int, pixelsPerPoint: Double) -> Bool {
        guard expected == token else { return false }
        if live != value { live = value }
        if settled != value { settled = value }
        let next = ShareZoomPolicy.layoutScale(scale: value.scale, slotWidth: width, slotHeight: height,
                                               pixelsPerUnit: pixelsPerPoint, videoWidth: videoWidth, videoHeight: videoHeight)
        guard next != layoutScale else { return false }
        layoutScale = next
        return true
    }

    func slotSizeChanged(_ size: CGSize) -> Bool {
        let first = slotSize == .zero
        if size == slotSize { return false }
        slotSize = size
        if first { return false }
        return reset()
    }

    func reset() -> Bool {
        token += 1
        isPinching = false
        isPanning = false
        if live != ShareZoomValue.identity { live = ShareZoomValue.identity }
        if settled != ShareZoomValue.identity { settled = ShareZoomValue.identity }
        guard layoutScale != 1.0 else { return false }
        layoutScale = 1.0
        return true
    }

    private var width: Double { Double(slotSize.width) }
    private var height: Double { Double(slotSize.height) }

    private func beginIfIdle() {
        guard !isGestureActive else { return }
        token += 1
        gestureStart = live
        magnification = 1.0
        translation = .zero
        anchor = CGPoint(x: slotSize.width / 2, y: slotSize.height / 2)
    }

    private func recompute() {
        let next = ShareZoomPolicy.live(start: gestureStart, magnification: magnification, anchorX: Double(anchor.x),
                                        anchorY: Double(anchor.y), translationX: Double(translation.width),
                                        translationY: Double(translation.height), slotWidth: width, slotHeight: height,
                                        videoWidth: videoWidth, videoHeight: videoHeight)
        if next != live { live = next }
    }
}

@MainActor
enum ShareZoomDriver {
    static func settle(_ zoom: ShareZoomState, to target: ShareZoomValue, reduceMotion: Bool, pixelsPerPoint: Double,
                       onResize: (() -> Void)?) {
        let token = zoom.beginSettle()
        let commit = {
            if zoom.commit(target, token: token, pixelsPerPoint: pixelsPerPoint) { onResize?() }
        }
        if reduceMotion || target == zoom.live {
            commit()
            return
        }
        withAnimation(ConclaveMotion.zoomSnap, completionCriteria: .removed) {
            zoom.live = target
        } completion: {
            commit()
        }
    }
}

struct ShareZoomContainer<Content: View>: View {
    let zoom: ShareZoomState
    let isZoomable: Bool
    let slotId: String
    let stage: StagePresenter
    @ViewBuilder let content: () -> Content
    @Environment(StageChromeVisibility.self) private var chrome: StageChromeVisibility?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var displayScale
    @Environment(\.stageRenderTargetResize) private var renderTargetResize

    var body: some View {
        let live = zoom.live
        let layoutScale = CGFloat(zoom.layoutScale)
        let mask: GestureMask = isZoomable ? .all : .subviews
        let panMask: GestureMask = isZoomable && zoom.settled.isZoomed ? .all : .subviews
        GeometryReader { proxy in
            content()
                .frame(width: proxy.size.width * layoutScale, height: proxy.size.height * layoutScale)
                .scaleEffect(CGFloat(live.scale) / layoutScale)
                .offset(x: CGFloat(live.panX), y: CGFloat(live.panY))
                .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .clipped()
        .contentShape(Rectangle())
        .gesture(taps, including: mask)
        .simultaneousGesture(pinch, including: mask)
        .simultaneousGesture(pan, including: panMask)
        .onGeometryChange(for: CGSize.self) { proxy in
            proxy.size
        } action: { size in
            if zoom.slotSizeChanged(size) { renderTargetResize?() }
        }
        .environment(\.layoutDirection, .leftToRight)
    }

    private var taps: some Gesture {
        SpatialTapGesture(count: 2)
            .onEnded { value in
                refreshVideoSize()
                settle(zoom.doubleTapTarget(at: value.location))
            }
            .exclusively(before: TapGesture(count: 1).onEnded {

                stage.stageTapped()
                chrome?.send(ChromeVisibilityEvent.tap)
            })
    }

    private var pinch: some Gesture {
        MagnifyGesture(minimumScaleDelta: 0.01)
            .onChanged { value in
                if !zoom.isGestureActive { refreshVideoSize() }
                zoom.pinchChanged(magnification: value.magnification, anchor: value.startLocation)
            }
            .onEnded { _ in
                if zoom.pinchEnded() { settle(zoom.settleTarget()) }
            }
    }

    private var pan: some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { value in
                if !zoom.isGestureActive { refreshVideoSize() }
                zoom.panChanged(value.translation)
            }
            .onEnded { _ in
                if zoom.panEnded() { settle(zoom.settleTarget()) }
            }
    }

    private func refreshVideoSize() {
        zoom.updateVideoSize(stage.frameSizes.size(slotId: slotId))
    }

    private func settle(_ target: ShareZoomValue) {
        ShareZoomDriver.settle(zoom, to: target, reduceMotion: reduceMotion, pixelsPerPoint: Double(displayScale),
                               onResize: renderTargetResize)
    }
}

struct SharePlaceholder: View {
    let model: TileChromeModel
    let binding: RendererBinding
    let isShare: Bool

    var body: some View {
        if isShare {
            if model.isLocal {
                SharePlaceholderFace(title: ConclaveStrings.text("You’re presenting"), avatarSeed: nil)
            } else if binding.videoKey.isEmpty {
                SharePlaceholderFace(title: ConclaveStrings.format("%@ is presenting", model.displayName), avatarSeed: model.avatarSeed)
            }
        }
    }
}

private struct SharePlaceholderFace: View {
    let title: String
    let avatarSeed: String?

    var body: some View {
        VStack(spacing: 12) {
            if let seed = avatarSeed {
                ConclaveAvatar(identity: ConclaveAvatarIdentity.fromSeed(seed), size: .lobby)
            } else {
                Image(systemName: ConclaveSymbols.rectangleInsetFilledOnRectangle)
                    .font(.title)
                    .accessibilityHidden(true)
            }
            Text(title)
                .font(.headline)
                .multilineTextAlignment(.center)
                .lineLimit(3)
                .minimumScaleFactor(0.6)
        }
        .padding(.horizontal, 16)
        .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(HostingTheme.token(DesignTokens.iosInCallSurface))
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

struct ShareSlotOverlays: View {
    let zoom: ShareZoomState
    let model: TileChromeModel
    let stage: StagePresenter
    let isZoomable: Bool
    let slotId: String

    var body: some View {
        ZStack(alignment: .topTrailing) {
            ShareSlotAccessibilityElement(zoom: zoom, model: model, stage: stage, isZoomable: isZoomable, slotId: slotId)
            ShareZoomResetChip(zoom: zoom, stage: stage, isZoomable: isZoomable)
        }
    }
}

private struct ShareSlotAccessibilityElement: View {
    let zoom: ShareZoomState
    let model: TileChromeModel
    let stage: StagePresenter
    let isZoomable: Bool
    let slotId: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var displayScale
    @Environment(\.stageRenderTargetResize) private var renderTargetResize

    var body: some View {
        let settled = zoom.settled
        Color.clear
            .allowsHitTesting(false)
            .accessibilityElement()
            .accessibilityLabel(ShareZoomText.label(model))
            .accessibilityValue(isZoomable && settled.isZoomed ? ShareZoomText.value(settled.scale) : "")
            .accessibilityZoomAction { action in
                guard isZoomable else { return }
                zoom.updateVideoSize(stage.frameSizes.size(slotId: slotId))
                ShareZoomDriver.settle(zoom, to: zoom.steppedTarget(zoomIn: action.direction == .zoomIn), reduceMotion: reduceMotion,
                                       pixelsPerPoint: Double(displayScale), onResize: renderTargetResize)
            }
            .accessibilityIdentifier("stage.share")
    }
}

private struct ShareZoomResetChip: View {
    let zoom: ShareZoomState
    let stage: StagePresenter
    let isZoomable: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var displayScale
    @Environment(\.stageRenderTargetResize) private var renderTargetResize

    var body: some View {
        if isZoomable && zoom.settled.isZoomed {

            let viewport = stage.viewport
            ConclaveStageChip(title: ConclaveStrings.text("Reset Zoom"), identifier: "stage.share.resetZoom", onTap: {
                ShareZoomDriver.settle(zoom, to: ShareZoomValue.identity, reduceMotion: reduceMotion,
                                       pixelsPerPoint: Double(displayScale), onResize: renderTargetResize)
            })
            .padding(.top, CGFloat(viewport.insetTop) + 8)
            .padding(.trailing, CGFloat(viewport.insetTrailing) + 8)
        }
    }
}

struct ShareStripFade: ViewModifier {
    let stage: StagePresenter
    let role: StageSlotRole
    @Environment(StageChromeVisibility.self) private var chrome: StageChromeVisibility?
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        let hides = role == .rail
            && ShareZoomPolicy.railHidesWithChrome(kind: stage.kind, role: role, isCompactHeight: verticalSizeClass == .compact)
        let hidden = hides && (chrome?.state.isHidden ?? false)
        content
            .opacity(hidden ? 0 : 1)
            .allowsHitTesting(!hidden)
            .accessibilityHidden(hidden)
            .animation(ConclaveMotion.fade(ConclaveMotion.chromeFade, reduceMotion: reduceMotion, instantWhenReduced: true), value: hidden)
    }
}

enum ShareZoomText {

    static func label(_ model: TileChromeModel) -> String {
        model.isLocal ? ConclaveStrings.text("You’re presenting") : ConclaveStrings.format("Shared Screen from %@", model.displayName)
    }

    static func announcement(_ announcement: StageAnnouncement) -> String? {
        guard announcement.kind == ShareAnnouncementPolicy.presentingKind else { return nil }
        return ConclaveStrings.format("%@ started presenting", announcement.name)
    }

    static func value(_ scale: Double) -> String {
        let spoken = ShareZoomPolicy.spokenScale(scale)
        let digits = ShareZoomPolicy.isWholeScale(scale) ? 0 : 1
        return ConclaveStrings.format("Zoom %@x", spoken.formatted(.number.precision(.fractionLength(digits))))
    }
}
#endif
