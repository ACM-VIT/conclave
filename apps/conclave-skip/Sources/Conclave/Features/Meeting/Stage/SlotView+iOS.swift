#if os(iOS) && !SKIP
import Accessibility
import SwiftUI
import UIKit

// S20 SL6 (STG-1): the one constant slot structure. A SwiftUI `if` or `switch` that swaps the wrapper around a renderer
// runs `dismantleUIView` and detaches the track, so every participant and share slot uses the same `ConclaveTileChrome`
// (F00 C08) for every role with the renderer as its first child; role differences are parameters and non-structural
// modifiers (variant, corner radius, renderer opacity for the minimized self view). The overflow and activity slots
// have their own ids, so their branch never changes for a given id. Hot state stays in leaves: the tile reads its own
// `TileChromeEntry`, the ring its `TileSpeakingState`, the renderer its `RendererBinding`.

struct SlotView: View {
    let slot: StageSlot
    let stage: StagePresenter
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
                            stage: stage, renderers: renderers)
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

    /// Full-bleed roles draw square corners (S20 2 e: radius 0 for full-bleed 1:1).
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

    /// A share slot shows the screen, never the presenter's camera-off face.
    static func model(_ model: TileChromeModel, isShare: Bool) -> TileChromeModel {
        if !isShare { return model }
        return TileChromeModel(userId: model.userId, displayName: model.displayName, avatarSeed: model.avatarSeed,
                               isLocal: model.isLocal, isMuted: false, isCameraOff: false, isHandRaised: false, isPinned: false,
                               isPresenting: true, isWeakConnection: model.isWeakConnection, isReconnecting: false,
                               reconnectReason: "", isHost: model.isHost, isVoiceAgent: false)
    }
}

/// One participant or share slot. The chrome observes only this tile's entry; the speaking ring observes only its
/// speaking state (inside `ConclaveTileChrome`). STG-2 adds the tile menu (system context menu with a chrome-only
/// preview, items mirrored as accessibility actions; S20 3 c) and the tile overlays: the Unpin target over the pinned
/// badge (4 c), your own flip control on non-dense tiles (3 c), the 1:1 camera-off caption (3 c) and the reconnect
/// reason with "Back Online" (3 c). Each overlay is a leaf that reads only what it shows, and every modifier is applied
/// for every role, so the structure around the renderer never changes (D15).
struct ParticipantTile: View {
    let slot: StageSlot
    let entry: TileChromeEntry
    let speaking: TileSpeakingState
    let binding: RendererBinding
    let stage: StagePresenter
    let renderers: StageRendererProvider
    /// Flips dispatched from the tile menu or its accessibility actions play `selectionChanged` (RECONCILE R13).
    @State private var menuFlips = 0

    var body: some View {
        let isShare = slot.id.hasPrefix("share:")
        let model = StageSlotViewModel.model(entry.model, isShare: isShare)
        // `stage.recompose.<slotId>` (SL14): the fixture ledger counts tile bodies; production passes no ledger.
        let _ = renderers.ledger?.composed(key: slot.id)
        let menu = TileMenuModel.make(slot: slot, model: model, stage: stage)
        ConclaveTileChrome(model: model, speaking: speaking, variant: slot.role.isSelfView ? .selfView : .grid,
                           isSpotlight: slot.role == .spotlightMain, cornerRadius: StageSlotViewModel.cornerRadius(slot.role),
                           actions: menu.accessibilityActions(stage: stage, onDispatched: noteDispatch),
                           identifier: "stage.tile." + slot.id) {
            RendererSlotView(slotId: slot.id, userId: slot.userId, isLocal: model.isLocal, isShare: isShare, fit: slot.fit,
                             binding: binding, stage: stage, renderers: renderers)
                .opacity(slot.role == .selfMinimized ? 0 : 1)
        } selfViewAccessory: {
            SelfViewFlipButton(stage: stage, isLocal: model.isLocal)
                .modifier(StageChromeFade())
        }
        .stageTileMenu(menu, model: model, speaking: speaking, stage: stage, onDispatched: noteDispatch)
        .conclaveGestureFeedback(.selectionChanged, trigger: menuFlips)
        .overlay {
            // The minimized self view keeps its renderer attached at opacity 0 and shows a chip face above it.
            MinimizedSelfFace(stage: stage, isMinimized: slot.role == .selfMinimized)
        }
        .overlay { TileReconnectDetail(entry: entry, isShare: isShare) }
        .overlay { OneOnOneCameraOffCaption(slot: slot, entry: entry, stage: stage, isShare: isShare) }
        .overlay(alignment: .topTrailing) { TileUnpinTarget(slot: slot, entry: entry, stage: stage, isShare: isShare) }
        .overlay { OwnTileFlipControl(slot: slot, entry: entry, stage: stage, isShare: isShare) }
    }

    private func noteDispatch(_ itemId: String) {
        if itemId == TileMenuItemId.flipCamera.rawValue {
            menuFlips += 1
        }
    }
}

/// Fades a tile control with chrome (S20 3 c, 6 c, 8): it reads the canvas's `StageChromeVisibility` from the
/// environment (StageCanvas injects it, HD/requests/B4-T5.md); without one the control stays visible.
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

/// Your own flip control on a grid, wide, spotlight main or roomy rail tile (S20 3 c): the same 44 pt C03 control as
/// the floating self view, bottom trailing, camera on, absent on dense tiles (spec 30 adds Flip Camera to More there),
/// fading with chrome. The floating self view draws it through the chrome's accessory instead.
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

/// The pinned badge on the spotlight main is itself a 44 pt Button "Unpin %@" (S20 4 c): an invisible target centered
/// on the badge the chrome draws, so the badge keeps one look and the tile keeps one element.
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

/// 1:1 with the remote camera off (S20 3 c, 3 l4): the chrome centers the 96 pt avatar; the name and "Camera off"
/// hang 8 pt below it. Decorative for VoiceOver: the tile label and value already say both.
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
                    // Top edge 8 pt below the centered 96 pt avatar.
                    .alignmentGuide(VerticalAlignment.center) { _ in -(OneOnOneCameraOffCaption.avatarHalf + 8) }
                }
                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }

    static let avatarHalf = CGFloat(TileChromePolicy.avatarSize(.spotlight) / 2.0)
}

/// The reconnect reason under the chrome's centered "Reconnecting" pill, then "Back Online" for 4.5 s once the person is
/// back (S20 3 c; F00 C08 f; web STG-15), each change announced once, politely. The pill fades 120 ms (opacity only,
/// also under Reduce Motion). Remote tiles only; the first appearance never announces.
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
    /// Web STG-15 reason copy from the SFU's raw reason (S20 3 g).
    static func reason(_ raw: String) -> String {
        switch TileFeaturePolicy.reconnectReasonKind(raw) {
        case "timeout": return ConclaveStrings.text("Connection timed out")
        case "network": return ConclaveStrings.text("Network interrupted")
        default: return ConclaveStrings.text("Connection interrupted")
        }
    }

    /// One polite announcement joined like the tile value.
    static func announce(_ parts: [String]) {
        var words: [String] = []
        for part in parts where !part.isEmpty {
            words.append(part)
        }
        AccessibilityNotification.Announcement(words.joined(separator: ", ")).post()
    }
}

/// The reason line: a caption on the label scrim whose top sits 4 pt below the chrome's centered pill.
private struct TileReconnectReason: View {
    let text: String
    /// Half the chrome's footnote pill (line plus 4 pt padding each side), scaled like it.
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

/// The centered status pill, drawn like the chrome's "Reconnecting" pill (paper on the label scrim).
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

/// The renderer leaf: the only reader of the slot's `RendererBinding` (SL4). Never inside a lazy container or a branch
/// that changes with the stage kind or slot role (D15); never an accessibility element; never inverted (14 i).
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
        // Only your own camera mirrors (front facing); only your tile reads the chrome snapshot.
        let mirror = isLocal && !isShare ? stage.chrome.isFrontCamera : false
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

/// iOS flip control on your own floating tile (S20 3 c, 6): hidden while it does not apply; plays `selectionChanged`
/// after a dispatched flip (RECONCILE R13).
struct SelfViewFlipButton: View {
    let stage: StagePresenter
    let isLocal: Bool
    @State private var flips = 0

    var body: some View {
        if isLocal && stage.chrome.canFlipCamera {
            ConclaveChromeButton(title: ConclaveStrings.text("Flip Camera"),
                                 value: stage.chrome.isFrontCamera ? ConclaveStrings.text("Camera Front") : ConclaveStrings.text("Camera Back"),
                                 systemImage: ConclaveSymbols.arrowTriangle2CirclepathCamera, identifier: "stage.selfView.flip") {
                stage.flipCamera()
                flips += 1
            }
            .conclaveGestureFeedback(.selectionChanged, trigger: flips)
        }
    }
}

/// The minimized self view's chip face (S20 6): tap restores the floating view.
struct MinimizedSelfFace: View {
    let stage: StagePresenter
    let isMinimized: Bool

    var body: some View {
        if isMinimized {
            ConclaveStageChip(title: ConclaveStrings.text("You"), identifier: "stage.selfView.minimized",
                              onTap: { stage.setSelfViewMode("floating") })
        }
    }
}

/// S20 2 c solo card (camera off, presence confirmed): Share Invite through `ShareLink` and Copy Link through the
/// pasteboard with the `linkCopied` gesture (never the legacy `MeetingShare`, SC21). Sits above the canvas and below
/// chrome, centered above the bar slot; with your camera on the chrome layer shows the Share Invite chip instead.
struct StageSoloLayer: View {
    let stage: StagePresenter

    var body: some View {
        let layout = stage.layout
        if layout.kind == .solo && layout.isAloneConfirmed, let localId = layout.slots.first?.userId {
            StageSoloCardGate(entry: stage.tileChrome.entry(for: localId), link: layout.meetingLink,
                              roomLabel: stage.capsule.title)
        }
    }
}

private struct StageSoloCardGate: View {
    let entry: TileChromeEntry
    let link: String
    let roomLabel: String

    var body: some View {
        if entry.model.isCameraOff, let url = URL(string: link), !link.isEmpty {
            StageSoloCard(url: url, roomLabel: roomLabel)
                .padding(.horizontal, 16)
                .padding(.bottom, StageCanvasMetrics.barReserve)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        }
    }
}

struct StageSoloCard: View {
    let url: URL
    let roomLabel: String
    @State private var copies = 0
    @State private var showsCopied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(ConclaveStrings.text("You’re the Only One Here"))
                .font(.headline)
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .accessibilityAddTraits(.isHeader)
            Text(ConclaveStrings.text("Share the link to invite people."))
                .font(.subheadline)
                .foregroundStyle(HostingTheme.inCallTextSecondary)
            HStack(spacing: 12) {
                ShareLink(item: url, subject: Text(ConclaveStrings.text("Join My Conclave Meeting")),
                          message: Text(ConclaveStrings.text("Join me in this Conclave meeting.")),
                          preview: SharePreview(Text(roomLabel))) {
                    Text(ConclaveStrings.text("Share Invite"))
                        .font(.body.weight(.semibold))
                        .foregroundStyle(HostingTheme.inCallOnCoral)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 44)
                        .background(HostingTheme.coralFill, in: Capsule())
                }
                .accessibilityIdentifier("stage.solo.share")
                Button {
                    UIPasteboard.general.url = url
                    copies += 1
                } label: {
                    Label(showsCopied ? ConclaveStrings.text("Copied") : ConclaveStrings.text("Copy Link"),
                          systemImage: showsCopied ? ConclaveSymbols.checkmark : ConclaveSymbols.docOnDoc)
                        .font(.body.weight(.semibold))
                        .frame(minHeight: 44)
                }
                .buttonStyle(.borderless)
                .tint(HostingTheme.inCallCoralText)
                .conclaveGestureFeedback(.linkCopied, trigger: copies)
                .accessibilityIdentifier("stage.solo.copy")
            }
        }
        .padding(16)
        .frame(maxWidth: 340, alignment: .leading)
        .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(HostingTheme.inCallBorder, lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("stage.solo")
        // "Copied" reads for 2 s after a copy (web STG-22), then the one-shot ends; nothing ticks while idle.
        .task(id: copies) {
            guard copies > 0 else { return }
            showsCopied = true
            AccessibilityNotification.Announcement(ConclaveStrings.text("Link copied")).post()
            try? await Task.sleep(for: .seconds(2))
            if Task.isCancelled { return }
            showsCopied = false
        }
    }
}
#endif
