import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

// MARK: - Tile Layout Algorithm

struct TileLayout {
    let columns: Int
    let rows: Int
    let tileWidth: CGFloat
    let tileHeight: CGFloat
}

enum MeetingStageLayout {
    static func visibleHeight(containerHeight: CGFloat, controlsOverlap: CGFloat) -> CGFloat {
        max(0.0, containerHeight - controlsOverlap)
    }
}

enum MeetingInviteFeedbackPolicy {
    static let copyFeedbackNanoseconds = UInt64(1_500_000_000)
    static let shareFeedbackNanoseconds = UInt64(2_400_000_000)

    static func shouldApply(generation: Int, currentGeneration: Int) -> Bool {
        generation == currentGeneration
    }
}

enum MeetingGridSizing {
    static func positiveFinite(_ value: CGFloat, minimum: CGFloat = 1.0) -> CGFloat {
        guard value.isFinite else { return minimum }
        return max(minimum, value)
    }

    static func availableLength(_ value: CGFloat, padding: CGFloat) -> CGFloat {
        positiveFinite(value - 2.0 * padding)
    }

    static func scrollTileWidth(
        containerWidth: CGFloat,
        columnCount: Int,
        spacing: CGFloat,
        padding: CGFloat
    ) -> CGFloat {
        let columns = max(1, columnCount)
        let gaps = CGFloat(max(0, columns - 1)) * spacing
        return positiveFinite((availableLength(containerWidth, padding: padding) - gaps) / CGFloat(columns))
    }
}

func computeOptimalTileLayout(
    participantCount: Int,
    containerWidth: CGFloat,
    containerHeight: CGFloat,
    spacing: CGFloat = 12,
    padding: CGFloat = 16
) -> TileLayout {
    let availW = MeetingGridSizing.availableLength(containerWidth, padding: padding)
    let availH = MeetingGridSizing.availableLength(containerHeight, padding: padding)
    let count = max(1, participantCount)

    // Landscape / tablet: the shared Meet packer balances wide containers well.
    if availW >= availH {
        let result = computeGridLayout(
            count: count,
            width: availW,
            height: availH,
            options: GridLayoutOptions(
                gap: spacing,
                maxCols: 6,
                maxTilesPerPage: 49,
                targetAspect: 16.0 / 9.0
            )
        )
        return TileLayout(
            columns: result.cols,
            rows: result.rows,
            tileWidth: max(result.tileWidth, 1.0),
            tileHeight: max(result.tileHeight, 1.0)
        )
    }

    // Phone portrait: match web's fixed two-column mobile gallery. Do not shrink
    // tiles to cram everyone into the viewport, and do not stack two-person calls
    // into a tall single column.
    let cols = min(count, 2)
    let rows = Int(ceil(Double(count) / Double(cols)))
    let tileWidth = floor((availW - CGFloat(cols - 1) * spacing) / CGFloat(cols))
    var tileHeight = tileWidth
    let squareContentHeight = CGFloat(rows) * tileHeight + CGFloat(max(0, rows - 1)) * spacing
    if squareContentHeight < availH {
        let fitHeight = floor((availH - CGFloat(max(0, rows - 1)) * spacing) / CGFloat(rows))
        let maxHeightRatio = count == 1 ? 1.0 : 1.5
        let maxHeight = floor(tileWidth * maxHeightRatio)
        tileHeight = max(tileWidth, min(fitHeight, maxHeight))
    }
    return TileLayout(
        columns: cols,
        rows: rows,
        tileWidth: max(1.0, tileWidth),
        tileHeight: max(1.0, tileHeight)
    )
}

// MARK: - Grid Layout

struct GridLayoutView: View {
    @Bindable var viewModel: MeetingViewModel
    let isCompact: Bool

    private let spacing: CGFloat = 12
    private let padding: CGFloat = 16
    // Small gap above the in-flow controls bar.
    private let controlsOverlap: CGFloat = 8
    private var detachedSelfEdgeInsets: EdgeInsets {
        MeetingDetachedSelfLayout.edgeInsets(isCompact: isCompact, top: padding, horizontal: padding)
    }
    @State private var didCopyCode = false
    @State private var didShareInvite = false
    @State private var copyFeedbackGeneration = 0
    @State private var shareFeedbackGeneration = 0
    @State private var copyFeedbackTask: Task<Void, Never>?
    @State private var shareFeedbackTask: Task<Void, Never>?

    var body: some View {
        GeometryReader { geo in
            let gridSnapshot = viewModel.state.visibleGridSnapshot()
            let ids = gridSnapshot.userIds
            let count = gridSnapshot.tileCount
            let visibleHeight = MeetingStageLayout.visibleHeight(
                containerHeight: geo.size.height,
                controlsOverlap: controlsOverlap
            )
            let layout = computeOptimalTileLayout(
                participantCount: count,
                containerWidth: geo.size.width,
                containerHeight: visibleHeight,
                spacing: spacing,
                padding: padding
            )

            let scrollThreshold = isCompact ? 7 : 10
            let packedContentHeight = CGFloat(layout.rows) * layout.tileHeight +
                CGFloat(max(0, layout.rows - 1)) * spacing +
                padding * 2.0
            let shouldScrollGrid = count > scrollThreshold ||
                (isCompact && packedContentHeight > visibleHeight)

            Group {
                if count <= 1 {
                    Group {
                        if let onlyUserId = ids.first,
                           !viewModel.state.isLocalIdentityUserId(onlyUserId),
                           onlyUserId != MeetingState.overflowTileId {
                            Button {
                                viewModel.togglePin(onlyUserId)
                            } label: {
                                tileFor(userId: onlyUserId)
                                    .frame(width: layout.tileWidth, height: layout.tileHeight)
                            }
                            .buttonStyle(.plain)
                        } else {
                            localTile(fill: true)
                                .overlay(alignment: .topLeading) {
                                    if viewModel.shouldShowSoloWaitingTile {
                                        soloWaitingView
                                            .padding(12)
                                    } else if viewModel.shouldShowSoloInvitePill {
                                        soloInvitePill
                                            .padding(12)
                                    }
                                }
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(.horizontal, padding)
                    .padding(.top, padding)
                    .padding(.bottom, controlsOverlap)
                } else if !shouldScrollGrid {
                    nonScrollingGrid(
                        layout: layout,
                        ids: ids,
                        hiddenParticipantCount: gridSnapshot.hiddenParticipantCount
                    )
                        .frame(width: geo.size.width, height: visibleHeight, alignment: .center)
                } else {
                    scrollingGrid(
                        containerWidth: geo.size.width,
                        ids: ids,
                        hiddenParticipantCount: gridSnapshot.hiddenParticipantCount,
                        preferredTileHeight: isCompact ? layout.tileHeight : nil
                    )
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .top)
            .overlay {
                if gridSnapshot.shouldShowDetachedSelfView &&
                    !gridSnapshot.includesLocalParticipant {
                    DetachedSelfViewOverlay(viewModel: viewModel, isCompact: isCompact, edgeInsets: detachedSelfEdgeInsets)
                }
            }
        }
        .onDisappear {
            resetInviteFeedback()
        }
    }

    @ViewBuilder
    func nonScrollingGrid(layout: TileLayout, ids: [String], hiddenParticipantCount: Int) -> some View {
        VStack(spacing: spacing) {
            ForEach(0..<layout.rows, id: \.self) { row in
                HStack(spacing: spacing) {
                    let startIndex = row * layout.columns
                    let endIndex = min(startIndex + layout.columns, ids.count)

                    if startIndex < endIndex {
                        ForEach(startIndex..<endIndex, id: \.self) { index in
                            let userId = ids[index]
                            Button {
                                if userId != MeetingState.overflowTileId {
                                    viewModel.togglePin(userId)
                                }
                            } label: {
                                tileFor(userId: userId, hiddenParticipantCount: hiddenParticipantCount)
                                    .frame(width: layout.tileWidth, height: layout.tileHeight)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .padding(padding)
    }

    @ViewBuilder
    func tileFor(userId: String, hiddenParticipantCount: Int? = nil) -> some View {
        if userId == MeetingState.overflowTileId {
            overflowTile(hiddenParticipantCount: hiddenParticipantCount ?? viewModel.state.hiddenGridParticipantsCount)
        } else if viewModel.state.isLocalIdentityUserId(userId) {
            localTile()
        } else if let participant = viewModel.state.participant(for: userId) {
            remoteTile(participant: participant)
        } else {
            staleParticipantTile(userId: userId)
        }
    }

    @ViewBuilder
    func scrollingGrid(
        containerWidth: CGFloat,
        ids: [String],
        hiddenParticipantCount: Int,
        preferredTileHeight: CGFloat? = nil
    ) -> some View {
        let colCount = isCompact ? 2 : 3
        let tileW = MeetingGridSizing.scrollTileWidth(
            containerWidth: containerWidth,
            columnCount: colCount,
            spacing: spacing,
            padding: padding
        )
        let tileH = MeetingGridSizing.positiveFinite(preferredTileHeight ?? tileW * 9.0 / 16.0)
        let columns = Array(repeating: GridItem(.fixed(tileW), spacing: spacing), count: colCount)

        ScrollView {
            LazyVGrid(columns: columns, spacing: spacing) {
                ForEach(ids, id: \.self) { userId in
                    Button {
                        if userId != MeetingState.overflowTileId {
                            viewModel.togglePin(userId)
                        }
                    } label: {
                        tileFor(userId: userId, hiddenParticipantCount: hiddenParticipantCount)
                            .frame(width: tileW, height: tileH)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(padding)
            .frame(maxWidth: .infinity)
        }
    }

    func localTile(fill: Bool = false) -> some View {
        let localVideoTrack = viewModel.webRTCClient.getLocalVideoTrack()
        let captureSession = (!viewModel.state.isCameraOff && localVideoTrack == nil) ? viewModel.webRTCClient.getCaptureSession() : nil
        return VideoGridItem(
            displayName: viewModel.displayNameForUser(viewModel.state.userId),
            isMuted: viewModel.state.isMuted,
            isCameraOff: viewModel.state.isCameraOff,
            isHandRaised: viewModel.state.isHandRaised,
            isGhost: viewModel.state.isGhostMode,
            isSpeaking: viewModel.state.isEffectiveActiveSpeaker(viewModel.state.userId),
            isLocal: true,
            fillStage: fill,
            localCameraFacing: viewModel.localCameraFacing,
            captureSession: captureSession,
            localVideoTrack: localVideoTrack
        )
    }

    func remoteTile(participant: Participant) -> some View {
        VideoGridItem(
            displayName: viewModel.displayNameForUser(participant.id),
            isMuted: participant.isMuted,
            isCameraOff: participant.isCameraOff,
            isHandRaised: participant.isHandRaised,
            isGhost: participant.isGhost,
            isSpeaking: viewModel.state.isEffectiveActiveSpeaker(participant.id),
            isLocal: false,
            connectionStatus: participant.connectionStatus,
            trackWrapper: viewModel.webRTCClient.remoteVideoTrack(forUserId: participant.id)
        )
        .opacity(participant.isLeaving ? 0.5 : 1.0)
        .animation(Animation.easeOut(duration: 0.2), value: participant.isLeaving)
    }

    func staleParticipantTile(userId: String) -> some View {
        VideoGridItem(
            displayName: viewModel.displayNameForUser(userId),
            isMuted: true,
            isCameraOff: true,
            isHandRaised: false,
            isGhost: false,
            isSpeaking: false,
            isLocal: false
        )
        .opacity(0.75)
    }

    func overflowTile(hiddenParticipantCount: Int) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: ACMRadius.lg)
                .fill(ACMColors.bgAlt)

            VStack(spacing: 8) {
                Text("+\(hiddenParticipantCount)")
                    .font(ACMFont.trial(30, weight: .bold))
                    .foregroundStyle(ACMColors.text)
                    .lineLimit(1)

                HStack(spacing: 6) {
                    ACMSystemIcon.icon("person.2.fill", android: "group", size: 14, tint: "muted")
                        .foregroundStyle(ACMColors.textMuted)
                    Text("More")
                        .font(ACMFont.trial(12, weight: .medium))
                        .foregroundStyle(ACMColors.textMuted)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .acmColorBackground(ACMColors.surface)
                .clipShape(Capsule())
            }
            .padding(12)
        }
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.lg)
                .strokeBorder(style: StrokeStyle(lineWidth: 1.0, dash: [6.0, 5.0]))
                .foregroundStyle(ACMColors.border)
        }
    }

    @ViewBuilder
    var soloWaitingView: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 10) {
                Circle()
                    .fill(ACMColors.creamGhost)
                    .frame(width: 36, height: 36)
                    .overlay {
                        ACMSystemIcon.icon("person.2.fill", android: "participants", size: 17, tint: "text")
                            .foregroundStyle(ACMColors.text)
                    }

                VStack(alignment: .leading, spacing: 3) {
                    Text("You are the only one here")
                        .font(ACMFont.trial(15, weight: .semibold))
                        .foregroundStyle(ACMColors.text)
                        .lineLimit(1)
                    Text("Invite people to join this room.")
                        .font(ACMFont.trial(12.5))
                        .foregroundStyle(ACMColors.textMuted)
                        .lineLimit(2)
                }
            }

            HStack(spacing: 8) {
                Button {
                    shareMeetingLink()
                } label: {
                    HStack(spacing: 7) {
                        ACMSystemIcon.icon("person.badge.plus", android: "link", size: 15, tint: "white")
                            .foregroundStyle(Color.white)
                        Text(didShareInvite ? "Invite sent" : "Invite people")
                            .font(ACMFont.trial(13, weight: .medium))
                            .foregroundStyle(Color.white)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 38)
                    .padding(.horizontal, 10)
                    .acmColorBackground(ACMColors.primaryOrange)
                    .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
                }
                .buttonStyle(.plain)

                Button {
                    copyMeetingLink()
                } label: {
                    HStack(spacing: 7) {
                        ACMSystemIcon.icon("doc.on.doc", android: "copy", size: 14, tint: didCopyCode ? "success" : "muted")
                            .foregroundStyle(didCopyCode ? ACMColors.success : ACMColors.textMuted)
                        Text(didCopyCode ? "Copied" : "Copy link")
                            .font(ACMFont.trial(13, weight: .medium))
                            .foregroundStyle(ACMColors.text)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 38)
                    .padding(.horizontal, 10)
                    .acmColorBackground(ACMColors.surfaceRaised)
                    .overlay {
                        RoundedRectangle(cornerRadius: ACMRadius.sm)
                            .strokeBorder(didCopyCode ? ACMColors.success : ACMColors.border, lineWidth: 1.0)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(14)
        .frame(maxWidth: 304, alignment: .leading)
        .acmColorBackground(ACMColors.surface)
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.md)
                .strokeBorder(ACMColors.border, lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
        #if !SKIP
        .shadow(color: ACMColors.blackOverlay(0.24), radius: 18, x: 0, y: 10)
        #endif
    }

    var soloInvitePill: some View {
        Button {
            shareMeetingLink()
        } label: {
            HStack(spacing: 8) {
                ACMSystemIcon.icon("person.badge.plus", android: "link", size: 14, tint: "accent")
                    .foregroundStyle(ACMColors.primaryOrange)
                Text(didShareInvite ? "Invite sent" : "Invite people")
                    .font(ACMFont.trial(13, weight: .medium))
                    .foregroundStyle(ACMColors.text)
                    .lineLimit(1)
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 9)
            .acmColorBackground(ACMColors.scrim)
            .overlay {
                Capsule()
                    .strokeBorder(ACMColors.creamFaint, lineWidth: 1)
            }
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    func copyMeetingLink() {
        MeetingShare.copyMeetingLink(viewModel.state.meetingLink)
        copyFeedbackTask?.cancel()
        copyFeedbackGeneration += 1
        let generation = copyFeedbackGeneration
        didCopyCode = true
        copyFeedbackTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: MeetingInviteFeedbackPolicy.copyFeedbackNanoseconds)
            guard !Task.isCancelled,
                  MeetingInviteFeedbackPolicy.shouldApply(
                    generation: generation,
                    currentGeneration: copyFeedbackGeneration
                  ) else { return }
            didCopyCode = false
            copyFeedbackTask = nil
        }
    }

    func shareMeetingLink() {
        guard MeetingShare.shareMeetingLink(viewModel.state.meetingLink, roomId: viewModel.state.roomId) else {
            return
        }
        shareFeedbackTask?.cancel()
        shareFeedbackGeneration += 1
        let generation = shareFeedbackGeneration
        didShareInvite = true
        shareFeedbackTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: MeetingInviteFeedbackPolicy.shareFeedbackNanoseconds)
            guard !Task.isCancelled,
                  MeetingInviteFeedbackPolicy.shouldApply(
                    generation: generation,
                    currentGeneration: shareFeedbackGeneration
                  ) else { return }
            didShareInvite = false
            shareFeedbackTask = nil
        }
    }

    private func resetInviteFeedback() {
        copyFeedbackTask?.cancel()
        copyFeedbackTask = nil
        shareFeedbackTask?.cancel()
        shareFeedbackTask = nil
        copyFeedbackGeneration += 1
        shareFeedbackGeneration += 1
        didCopyCode = false
        didShareInvite = false
    }
}
