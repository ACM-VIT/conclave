#if os(iOS) && !SKIP
import Accessibility
import SwiftUI
import UIKit

struct SlotView: View {
    let slot: StageSlot
    let stage: StagePresenter
    let viewport: StageViewport
    let renderers: StageRendererProvider
    let overflowCount: Int
    let overflowSeeds: [String]

    var body: some View {
        if slot.id == StageSlot.overflowId {
            ConclaveOverflowTile(count: overflowCount, identities: StageSlotViewModel.identities(overflowSeeds),
                                 identifier: "stage.overflow") {
                stage.openPeople(destination: PanelDestination.none)
            }
        } else if slot.id == StageSlot.activityId {
            ActivityStageContainer(stage: stage)
        } else {
            ParticipantTile(slot: slot, entry: stage.tileChrome.entry(for: slot.userId),
                            speaking: stage.speaking.state(for: slot.userId), binding: stage.bindings.binding(for: slot.id),
                            stage: stage, viewport: viewport, renderers: renderers)
        }
    }
}

enum StageSlotViewModel {
    static func identities(_ seeds: [String]) -> [ConclaveAvatarIdentity] {
        var result: [ConclaveAvatarIdentity] = []
        for seed in seeds {
            result.append(ConclaveAvatarIdentity.fromSeed(seed))
        }
        return result
    }

    static func cornerRadius(_ role: StageSlotRole) -> CGFloat {
        switch role {
        case .spotlightMain, .share, .programFeed:
            return 0
        case .selfMinimized:
            return CGFloat(StageLayoutPolicy.selfMinimizedHeight / 2.0)
        default:
            return CGFloat(DesignTokens.radiusTile)
        }
    }

    @MainActor
    static func pausedModel(_ model: TileChromeModel, slot: StageSlot, stage: StagePresenter) -> TileChromeModel {
        if !model.isLocal || slot.id.hasPrefix("share:") || model.isCameraOff { return model }
        if !stage.chrome.isCameraPaused { return model }
        return TileChromeModel(userId: model.userId, displayName: model.displayName, avatarSeed: model.avatarSeed,
                               isLocal: true, isMuted: model.isMuted, isCameraOff: true, isHandRaised: model.isHandRaised,
                               isPinned: model.isPinned, isPresenting: model.isPresenting,
                               isWeakConnection: model.isWeakConnection, isReconnecting: model.isReconnecting,
                               reconnectReason: model.reconnectReason, isHost: model.isHost, isVoiceAgent: model.isVoiceAgent)
    }

    static func model(_ model: TileChromeModel, isShare: Bool) -> TileChromeModel {
        if !isShare { return model }
        return TileChromeModel(userId: model.userId, displayName: model.displayName, avatarSeed: model.avatarSeed,
                               isLocal: model.isLocal, isMuted: false, isCameraOff: false, isHandRaised: false, isPinned: false,
                               isPresenting: true, isWeakConnection: model.isWeakConnection, isReconnecting: false,
                               reconnectReason: "", isHost: model.isHost, isVoiceAgent: false)
    }
}

struct ParticipantTile: View {
    let slot: StageSlot
    let entry: TileChromeEntry
    let speaking: TileSpeakingState
    let binding: RendererBinding
    let stage: StagePresenter
    let viewport: StageViewport
    let renderers: StageRendererProvider

    @State private var menuFlips = 0

    @State private var zoom = ShareZoomState()
    @Environment(\.layoutDirection) private var layoutDirection

    var body: some View {
        let isShare = slot.id.hasPrefix("share:")
        let insets = StageViewportPolicy.tileInsets(kind: stage.kind, role: slot.role, viewport: viewport)
        let model = StageSlotViewModel.model(entry.model, isShare: isShare)

        let _ = renderers.ledger?.composed(key: slot.id)

        let extraSections = SelfViewMoveText.sections(slot: slot, model: model, layoutDirection: layoutDirection)
        let menu = TileMenuModel.make(slot: slot, model: model, stage: stage, people: extraSections)
        let zoomable = ShareZoomPolicy.isZoomable(slotId: slot.id, role: slot.role, isLocal: model.isLocal)
        ConclaveTileChrome(model: StageSlotViewModel.pausedModel(model, slot: slot, stage: stage), speaking: speaking,
                           variant: slot.role.isSelfView ? .selfView : .grid,
                           isSpotlight: slot.role == .spotlightMain, cornerRadius: StageSlotViewModel.cornerRadius(slot.role),
                           actions: menu.accessibilityActions(stage: stage, onDispatched: noteDispatch),
                           identifier: "stage.tile." + slot.id,

                           accessibilityName: slot.role == .programFeed
                               ? AttendeeViewerCopy.feedLabel(isShare: isShare, name: model.displayName) : nil,
                           isSolo: stage.kind == .solo && model.isLocal && !isShare,
                           showsHandBadge: !model.isLocal,
                           overlayInsets: EdgeInsets(top: CGFloat(insets.top), leading: CGFloat(insets.leading),
                                                    bottom: CGFloat(insets.bottom), trailing: CGFloat(insets.trailing))) {
            ShareZoomContainer(zoom: zoom, isZoomable: zoomable, slotId: slot.id, stage: stage) {
                RendererSlotView(slotId: slot.id, userId: slot.userId, isLocal: model.isLocal, isShare: isShare, fit: slot.fit,
                                 binding: binding, stage: stage, renderers: renderers)
            }
            .overlay { SharePlaceholder(model: model, binding: binding, isShare: isShare) }
            .opacity(slot.role == .selfMinimized ? 0 : 1)
        } selfViewAccessory: {

            EmptyView()
        }

        .accessibilityHidden(isShare)

        .accessibilityAddTraits(slot.role == .selfMinimized ? .isButton : [])
        .stageTileMenu(menu, model: model, speaking: speaking, stage: stage, onDispatched: noteDispatch)
        .conclaveGestureFeedback(.selectionChanged, trigger: menuFlips)
        .overlay {

            MinimizedSelfFace(stage: stage, isMinimized: slot.role == .selfMinimized)
        }
        .overlay { CameraPausedCaption(slot: slot, entry: entry, stage: stage, isShare: isShare) }
        .overlay { TileReconnectDetail(entry: entry, isShare: isShare) }
        .overlay { OneOnOneCameraOffCaption(slot: slot, entry: entry, stage: stage, isShare: isShare) }
        .overlay(alignment: .topTrailing) { TileUnpinTarget(slot: slot, entry: entry, stage: stage, isShare: isShare) }
        .overlay { OwnTileFlipControl(slot: slot, entry: entry, stage: stage, isShare: isShare) }
        .overlay { FloatingSelfFlipControl(slot: slot, entry: entry, stage: stage) }
        .overlay {
            if isShare {
                ShareSlotOverlays(zoom: zoom, model: model, stage: stage, isZoomable: zoomable, slotId: slot.id)
            }
        }
        .modifier(ShareStripFade(stage: stage, role: slot.role))
        .modifier(SelfViewDragModifier(slot: slot, stage: stage))
    }

    private func noteDispatch(_ itemId: String) {
        if itemId == TileMenuItemId.flipCamera.rawValue {
            menuFlips += 1
        }
    }
}

struct StageChromeFade: ViewModifier {
    @Environment(StageChromeVisibility.self) private var chrome: StageChromeVisibility?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        let hidden = chrome?.state.isHidden ?? false
        content
            .opacity(ChromeAutoHidePolicy.chromeOpacity(chrome?.state ?? ChromeVisibilityState.initial))
            .allowsHitTesting(!hidden)
            .accessibilityHidden(hidden)
            .animation(ConclaveMotion.fade(ConclaveMotion.chromeFade, reduceMotion: reduceMotion, instantWhenReduced: true), value: hidden)
    }
}

struct OwnTileFlipControl: View {
    let slot: StageSlot
    let entry: TileChromeEntry
    let stage: StagePresenter
    let isShare: Bool

    var body: some View {
        if !isShare && !slot.role.isSelfView && entry.model.isLocal && !entry.model.isCameraOff {
            GeometryReader { proxy in
                let density = TileChromePolicy.density(width: Double(proxy.size.width), height: Double(proxy.size.height),
                                                       isSpotlight: slot.role == .spotlightMain)
                if TileFeaturePolicy.showsFlipControl(isLocal: true, isShare: false, role: slot.role,
                                                      canFlipCamera: stage.chrome.canFlipCamera, density: density) {
                    SelfViewFlipButton(stage: stage, isLocal: true)
                        .modifier(StageChromeFade())
                        .padding(8)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                }
            }
        }
    }
}

struct FloatingSelfFlipControl: View {
    let slot: StageSlot
    let entry: TileChromeEntry
    let stage: StagePresenter

    var body: some View {
        if slot.role == .selfFloating && entry.model.isLocal && !entry.model.isCameraOff {
            SelfViewFlipButton(stage: stage, isLocal: true)
                .modifier(StageChromeFade())
                .padding(4)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
        }
    }
}

struct CameraPausedCaption: View {
    let slot: StageSlot
    let entry: TileChromeEntry
    let stage: StagePresenter
    let isShare: Bool

    var body: some View {
        if !isShare && entry.model.isLocal && !entry.model.isCameraOff && slot.role != .selfMinimized
            && stage.chrome.isCameraPaused {
            Text(ConclaveStrings.text("Camera paused"))
                .font(.caption2)
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .background(HostingTheme.inCallLabelScrim, in: Capsule())
                .padding(.bottom, 8)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }
}

struct TileUnpinTarget: View {
    let slot: StageSlot
    let entry: TileChromeEntry
    let stage: StagePresenter
    let isShare: Bool

    var body: some View {
        if slot.role == .spotlightMain && TileFeaturePolicy.showsUnpinTarget(role: slot.role, isPinned: entry.model.isPinned,
                                                                                isShare: isShare) {
            let model = entry.model
            let size = TileFeaturePolicy.unpinTargetIos
            Button {
                stage.clearPin()
            } label: {
                Color.clear
                    .frame(width: CGFloat(size), height: CGFloat(size))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(ConclaveStrings.format("Unpin %@", model.displayName))
            .accessibilityIdentifier("stage.tile.unpin")
            .padding(.top, CGFloat(TileFeaturePolicy.unpinTargetTopInset(density: .spotlight, targetSize: size)))
            .padding(.trailing, CGFloat(TileFeaturePolicy.unpinTargetTrailingInset(model: model, density: .spotlight,
                                                                                    targetSize: size)))
        }
    }
}

struct OneOnOneCameraOffCaption: View {
    let slot: StageSlot
    let entry: TileChromeEntry
    let stage: StagePresenter
    let isShare: Bool

    var body: some View {
        if slot.role == .spotlightMain && !isShare && !entry.model.isLocal && entry.model.isCameraOff
            && TileFeaturePolicy.showsOneOnOneCaption(kind: stage.kind, role: slot.role, isLocal: entry.model.isLocal,
                                                      isCameraOff: entry.model.isCameraOff) {
            Color.clear
                .overlay(alignment: .center) {
                    VStack(spacing: 8) {
                        Text(entry.model.displayName)
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                            .multilineTextAlignment(.center)
                            .lineLimit(2)
                        Text(ConclaveStrings.text("Camera off"))
                            .font(.subheadline)
                            .foregroundStyle(HostingTheme.inCallTextSecondary)
                    }
                    .padding(.horizontal, 16)

                    .alignmentGuide(VerticalAlignment.center) { _ in -(OneOnOneCameraOffCaption.avatarHalf + 8) }
                }
                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }

    static let avatarHalf = CGFloat(TileChromePolicy.avatarSize(.spotlight) / 2.0)
}

struct TileReconnectDetail: View {
    let entry: TileChromeEntry
    let isShare: Bool
    @State private var backOnline = false
    @State private var wasReconnecting = false
    @State private var hasRun = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let model = entry.model
        let reconnecting = model.isReconnecting && !model.isLocal && !isShare
        ZStack {
            if reconnecting {
                TileReconnectReason(text: TileReconnectText.reason(model.reconnectReason))
            } else if backOnline {
                TileStatusPill(text: ConclaveStrings.text("Back Online"))
            }
        }
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .animation(ConclaveMotion.fade(ConclaveMotion.fast, reduceMotion: reduceMotion), value: backOnline)
        .task(id: reconnecting) {
            let firstRun = !hasRun
            hasRun = true
            if reconnecting {
                wasReconnecting = true
                backOnline = false
                if !firstRun {
                    TileReconnectText.announce([model.displayName, ConclaveStrings.text("Reconnecting"),
                                                TileReconnectText.reason(model.reconnectReason)])
                }
                return
            }
            guard wasReconnecting else { return }
            wasReconnecting = false
            backOnline = true
            TileReconnectText.announce([model.displayName, ConclaveStrings.text("Back Online")])
            try? await Task.sleep(for: .milliseconds(Int(TileFeaturePolicy.backOnlineMillis)))
            if Task.isCancelled { return }
            backOnline = false
        }
    }
}

enum TileReconnectText {

    static func reason(_ raw: String) -> String {
        switch TileFeaturePolicy.reconnectReasonKind(raw) {
        case "timeout": return ConclaveStrings.text("Connection timed out")
        case "network": return ConclaveStrings.text("Network interrupted")
        default: return ConclaveStrings.text("Connection interrupted")
        }
    }

    static func announce(_ parts: [String]) {
        var words: [String] = []
        for part in parts where !part.isEmpty {
            words.append(part)
        }
        AccessibilityNotification.Announcement(words.joined(separator: ", ")).post()
    }
}

private struct TileReconnectReason: View {
    let text: String

    @ScaledMetric(relativeTo: .footnote) private var pillHalfHeight: CGFloat = 13

    var body: some View {
        Color.clear
            .overlay(alignment: .center) {
                Text(text)
                    .font(.caption2)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .lineLimit(1)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(HostingTheme.inCallLabelScrim, in: Capsule())
                    .alignmentGuide(VerticalAlignment.center) { _ in -(pillHalfHeight + 4) }
            }
    }
}

private struct TileStatusPill: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(HostingTheme.inCallLabelScrim, in: Capsule())
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct RendererSlotView: View {
    let slotId: String
    let userId: String
    let isLocal: Bool
    let isShare: Bool
    let fit: StageVideoFit
    let binding: RendererBinding
    let stage: StagePresenter
    let renderers: StageRendererProvider

    var body: some View {
        let videoKey = binding.videoKey

        let mirror = isLocal && !isShare
            ? LocalVideoMirrorPolicy.mirrors(isFront: stage.chrome.isFrontCamera, preference: LocalVideoMirrorPreference.shared.isOn)
            : false
        Group {
            if renderers.usesProbes {
                probe
            } else {
                StageLiveVideo(slotId: slotId, userId: userId, isLocal: isLocal, isShare: isShare, videoKey: videoKey,
                               fit: fit, isMirrored: mirror)
            }
        }
        .transaction { transaction in transaction.animation = nil }
        .accessibilityHidden(true)
        .accessibilityIgnoresInvertColors()
    }

    @ViewBuilder
    private var probe: some View {
        #if DEBUG
        if let ledger = renderers.ledger {
            RendererProbe(key: slotId, slot: .stage, ledger: ledger, pattern: renderers.pattern)
        } else {
            Color.clear
        }
        #else
        Color.clear
        #endif
    }
}

struct SelfViewFlipButton: View {
    let stage: StagePresenter
    let isLocal: Bool
    @State private var flips = 0

    var body: some View {
        let chrome = stage.chrome
        if isLocal && chrome.canFlipCamera {
            ConclaveChromeButton(title: ConclaveStrings.text("Flip Camera"),
                                 value: chrome.isFrontCamera ? ConclaveStrings.text("Camera Front") : ConclaveStrings.text("Camera Back"),
                                 systemImage: ConclaveSymbols.arrowTriangle2CirclepathCamera, identifier: "stage.selfView.flip") {
                if StageCameraFlip.perform(stage) {
                    flips += 1
                }
            }
            .disabled(chrome.isFlipInFlight)
            .opacity(chrome.isFlipInFlight ? HostingTheme.disabledOpacity : 1)
            .conclaveGestureFeedback(.selectionChanged, trigger: flips)
        }
    }
}

struct MinimizedSelfFace: View {
    let stage: StagePresenter
    let isMinimized: Bool

    var body: some View {
        if isMinimized {
            ConclaveStageChip(title: ConclaveStrings.text("You"), identifier: "stage.selfView.minimized",
                              onTap: { stage.setSelfViewMode(TileFeaturePolicy.floatingSelfViewMode) })
                .accessibilityHidden(true)
        }
    }
}

enum SelfViewMoveText {
    static func titles() -> SelfViewMoveTitles {
        SelfViewMoveTitles(topLeft: ConclaveStrings.text("Move to Top Left"), topRight: ConclaveStrings.text("Move to Top Right"),
                           bottomLeft: ConclaveStrings.text("Move to Bottom Left"),
                           bottomRight: ConclaveStrings.text("Move to Bottom Right"))
    }

    static func sections(slot: StageSlot, model: TileChromeModel, layoutDirection: LayoutDirection) -> [MenuSectionModel] {
        if !SelfViewSnapPolicy.offersMove(role: slot.role, isLocal: model.isLocal) { return [] }
        return SelfViewSnapPolicy.moveSections(role: slot.role, isLocal: model.isLocal, titles: titles(),
                                               isRightToLeft: layoutDirection == .rightToLeft)
    }

}

struct SelfViewDragModifier: ViewModifier {
    let slot: StageSlot
    let stage: StagePresenter
    @State private var offset = CGSize.zero
    @State private var snaps = 0
    @Environment(\.layoutDirection) private var layoutDirection
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        let movable = slot.role.isSelfMovable
        content
            .environment(\.layoutDirection, layoutDirection)
            .offset(movable ? offset : .zero)
            .gesture(drag, including: movable ? .all : .subviews)
            .conclaveGestureFeedback(.selfViewSnapped, trigger: snaps)
            .environment(\.layoutDirection, .leftToRight)
    }

    private var drag: some Gesture {
        DragGesture(minimumDistance: CGFloat(SelfViewSnapPolicy.dragMinimumDistance), coordinateSpace: .global)
            .onChanged { value in
                offset = value.translation
            }
            .onEnded { value in
                drop(value)
            }
    }

    private func drop(_ value: DragGesture.Value) {
        let viewport = stage.viewport
        let previous = stage.layout.selfCorner
        let isRightToLeft = layoutDirection == .rightToLeft
        guard !viewport.isEmpty, let frame = StageLayoutPolicy.find(slot.id, in: stage.currentFrames()) else {
            springBack()
            return
        }
        let target = SelfViewSnapPolicy.dropCorner(
            frame: frame,
            leadingTranslationX: SelfViewSnapPolicy.leadingX(Double(value.predictedEndTranslation.width), isRightToLeft: isRightToLeft),
            translationY: Double(value.predictedEndTranslation.height), viewport: viewport)
        var instant = Transaction(animation: nil)
        instant.disablesAnimations = true
        withTransaction(instant) {
            stage.moveSelfView(toCorner: target)
        }
        guard stage.layout.selfCorner == target, target != previous,
              let next = StageLayoutPolicy.find(slot.id, in: stage.currentFrames()) else {

            springBack()
            return
        }
        if SelfViewSnapPolicy.playsSnapFeedback(previousCorner: previous, nextCorner: target) {
            snaps += 1
        }
        if reduceMotion {
            withTransaction(instant) { offset = .zero }
            return
        }

        let shiftX = SelfViewSnapPolicy.physicalShiftX(fromFrame: frame, toFrame: next, isRightToLeft: isRightToLeft)
        let shiftY = SelfViewSnapPolicy.shiftY(fromFrame: frame, toFrame: next)
        withTransaction(instant) {
            offset = CGSize(width: value.translation.width - CGFloat(shiftX), height: value.translation.height - CGFloat(shiftY))
        }
        Task { @MainActor in
            withAnimation(ConclaveMotion.snap) { offset = .zero }
        }
    }

    private func springBack() {
        withAnimation(ConclaveMotion.travel(ConclaveMotion.snap, reduceMotion: reduceMotion)) { offset = .zero }
    }
}

#endif
