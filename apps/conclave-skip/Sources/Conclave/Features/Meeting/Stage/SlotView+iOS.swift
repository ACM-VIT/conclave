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
            StageActivityCard(kind: stage.layout.activityKind)
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
/// speaking state (inside `ConclaveTileChrome`).
struct ParticipantTile: View {
    let slot: StageSlot
    let entry: TileChromeEntry
    let speaking: TileSpeakingState
    let binding: RendererBinding
    let stage: StagePresenter
    let renderers: StageRendererProvider

    var body: some View {
        let isShare = slot.id.hasPrefix("share:")
        let model = StageSlotViewModel.model(entry.model, isShare: isShare)
        // `stage.recompose.<slotId>` (SL14): the fixture ledger counts tile bodies; production passes no ledger.
        let _ = renderers.ledger?.composed(key: slot.id)
        ConclaveTileChrome(model: model, speaking: speaking, variant: slot.role.isSelfView ? .selfView : .grid,
                           isSpotlight: slot.role == .spotlightMain, cornerRadius: StageSlotViewModel.cornerRadius(slot.role),
                           actions: [], identifier: "stage.tile." + slot.id) {
            RendererSlotView(slotId: slot.id, userId: slot.userId, isLocal: model.isLocal, isShare: isShare, fit: slot.fit,
                             binding: binding, stage: stage, renderers: renderers)
                .opacity(slot.role == .selfMinimized ? 0 : 1)
        } selfViewAccessory: {
            SelfViewFlipButton(stage: stage, isLocal: model.isLocal)
        }
        .overlay {
            // The minimized self view keeps its renderer attached at opacity 0 and shows a chip face above it.
            MinimizedSelfFace(stage: stage, isMinimized: slot.role == .selfMinimized)
        }
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

/// The activity card placeholder (S20 11): a flat raised surface; STG-9 hosts the game, app and browser content here.
struct StageActivityCard: View {
    let kind: String

    var body: some View {
        RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusTile), style: .continuous)
            .fill(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised))
            .overlay {
                RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusTile), style: .continuous)
                    .strokeBorder(HostingTheme.inCallBorder, lineWidth: 1)
            }
            .accessibilityIdentifier("stage.activity." + kind)
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
