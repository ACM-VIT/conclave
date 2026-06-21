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

func computeOptimalTileLayout(
    participantCount: Int,
    containerWidth: CGFloat,
    containerHeight: CGFloat,
    spacing: CGFloat = 12,
    padding: CGFloat = 16
) -> TileLayout {
    let availW = containerWidth - 2.0 * padding
    let availH = containerHeight - 2.0 * padding
    let count = max(1, participantCount)

    // Landscape / tablet: the shared Meet packer (Core/Layout/GridLayout.swift)
    // balances wide containers well — let it choose columns and 16:9 tile sizes.
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

    // Phone portrait: Meet/FaceTime use a balanced grid that FILLS the canvas —
    // never a tall single-column stack (which is what pure area-maximising picks
    // on a tall container). Pick columns by count, then size tiles to fill each
    // cell (video crops via scaleAspectFill; avatars centre) so there are no
    // dead letterbox gaps.
    let cols: Int
    if count <= 2 {
        cols = 1
    } else if count <= 6 {
        cols = 2
    } else {
        cols = 3
    }
    let rows = Int(ceil(Double(count) / Double(cols)))
    let cellW = (availW - CGFloat(cols - 1) * spacing) / CGFloat(cols)
    let cellH = (availH - CGFloat(max(0, rows - 1)) * spacing) / CGFloat(rows)
    return TileLayout(
        columns: cols,
        rows: rows,
        tileWidth: max(1.0, floor(cellW)),
        tileHeight: max(1.0, floor(cellH))
    )
}

// MARK: - Grid Layout

struct GridLayoutView: View {
    @Bindable var viewModel: MeetingViewModel
    let isCompact: Bool

    private let spacing: CGFloat = 12
    private let padding: CGFloat = 16
    // Clearance for the floating controls capsule (~64pt) + home-indicator safe
    // area (~34pt) so the bottom grid row / filmstrip never hides behind it.
    private let controlsOverlap: CGFloat = 8
    @State private var didCopyCode = false
    @State private var didShareInvite = false
    @State private var copyFeedbackGeneration = 0
    @State private var shareFeedbackGeneration = 0

    var body: some View {
        GeometryReader { geo in
            let ids = viewModel.state.visibleGridUserIds
            let count = viewModel.state.visibleGridTileCount
            let visibleHeight = geo.size.height - controlsOverlap
            let layout = computeOptimalTileLayout(
                participantCount: count,
                containerWidth: geo.size.width,
                containerHeight: visibleHeight,
                spacing: spacing,
                padding: padding
            )

            let scrollThreshold = isCompact ? 7 : 10

            if count <= 1 {
                Group {
                    if let onlyUserId = ids.first,
                       !viewModel.state.isLocalParticipantUserId(onlyUserId),
                       onlyUserId != MeetingState.overflowTileId {
                        Button {
                            viewModel.togglePin(onlyUserId)
                        } label: {
                            tileFor(userId: onlyUserId)
                        }
                        .buttonStyle(.plain)
                    } else if viewModel.state.participantCount <= 1 && viewModel.state.isCameraOff {
                        soloWaitingView
                    } else {
                        localTile(fill: true)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.horizontal, padding)
                .padding(.top, padding)
                .padding(.bottom, controlsOverlap)
            } else if count <= scrollThreshold {
                nonScrollingGrid(layout: layout, ids: ids)
                    // Top-aligned so the reserved controlsOverlap stays clear at
                    // the bottom (the floating controls bar never covers a tile).
                    .frame(width: geo.size.width, height: geo.size.height, alignment: .top)
                    // Smooth Meet-style reflow: persistent tiles animate their
                    // frame as the grid re-packs on join/leave.
                    .animation(.easeInOut(duration: 0.22), value: count)
            } else {
                scrollingGrid(containerWidth: geo.size.width, ids: ids)
            }
        }
        .overlay {
            if viewModel.state.shouldShowDetachedSelfView &&
                !viewModel.state.visibleGridUserIds.contains(viewModel.state.userId) {
                DetachedSelfViewOverlay(viewModel: viewModel)
                    .padding(.horizontal, padding)
                    .padding(.top, padding)
                    .padding(.bottom, controlsOverlap + padding)
            }
        }
        .onDisappear {
            copyFeedbackGeneration += 1
            shareFeedbackGeneration += 1
            didCopyCode = false
            didShareInvite = false
        }
    }

    @ViewBuilder
    func nonScrollingGrid(layout: TileLayout, ids: [String]) -> some View {
        VStack(spacing: spacing) {
            ForEach(0..<layout.rows, id: \.self) { row in
                HStack(spacing: spacing) {
                    let startIndex = row * layout.columns
                    let endIndex = min(startIndex + layout.columns, ids.count)
                    let rowIds = startIndex < endIndex
                        ? Array(ids[startIndex..<endIndex])
                        : [String]()

                    ForEach(rowIds, id: \.self) { userId in
                        Button {
                            if userId != MeetingState.overflowTileId {
                                viewModel.togglePin(userId)
                            }
                        } label: {
                            tileFor(userId: userId)
                                .frame(width: layout.tileWidth, height: layout.tileHeight)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(padding)
    }

    @ViewBuilder
    func tileFor(userId: String) -> some View {
        if userId == MeetingState.overflowTileId {
            overflowTile
        } else if viewModel.state.isLocalParticipantUserId(userId) {
            localTile()
        } else if let participant = viewModel.state.participants[userId] {
            remoteTile(participant: participant)
        }
    }

    @ViewBuilder
    func scrollingGrid(containerWidth: CGFloat, ids: [String]) -> some View {
        let colCount = isCompact ? 2 : 3
        let tileW = (containerWidth - 2 * padding - CGFloat(colCount - 1) * spacing) / CGFloat(colCount)
        let tileH = tileW * 9.0 / 16.0
        let columns = Array(repeating: GridItem(.flexible(), spacing: spacing), count: colCount)

        ScrollView {
            LazyVGrid(columns: columns, spacing: spacing) {
                ForEach(ids, id: \.self) { userId in
                    Button {
                        if userId != MeetingState.overflowTileId {
                            viewModel.togglePin(userId)
                        }
                    } label: {
                        tileFor(userId: userId).frame(height: tileH)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(padding)
        }
    }

    func localTile(fill: Bool = false) -> some View {
        let localVideoTrack = viewModel.webRTCClient.getLocalVideoTrack()
        let captureSession = (!viewModel.state.isCameraOff && localVideoTrack == nil) ? viewModel.webRTCClient.getCaptureSession() : nil
        return VideoGridItem(
            displayName: viewModel.state.displayName,
            isMuted: viewModel.state.isMuted,
            isCameraOff: viewModel.state.isCameraOff,
            isHandRaised: viewModel.state.isHandRaised,
            isGhost: viewModel.state.isGhostMode,
            isSpeaking: viewModel.state.effectiveActiveSpeakerId.map { viewModel.state.isLocalParticipantUserId($0) } == true,
            isLocal: true,
            fillStage: fill,
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
            isSpeaking: viewModel.state.effectiveActiveSpeakerId == participant.id,
            isLocal: false,
            connectionStatus: participant.connectionStatus,
            trackWrapper: viewModel.webRTCClient.remoteVideoTracks[participant.id]
        )
        .opacity(participant.isLeaving ? 0.5 : 1.0)
        .animation(Animation.easeOut(duration: 0.2), value: participant.isLeaving)
    }

    var overflowTile: some View {
        ZStack {
            RoundedRectangle(cornerRadius: ACMRadius.lg)
                .fill(ACMColors.bgAlt)

            VStack(spacing: 8) {
                Text("+\(viewModel.state.hiddenGridParticipantsCount)")
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

    // Solo, camera-off: an invite affordance instead of a lone avatar in an
    // empty tile (Meet "you're the only one here" + a copyable room code).
    @ViewBuilder
    var soloWaitingView: some View {
        ZStack {
            RoundedRectangle(cornerRadius: ACMRadius.lg)
                .fill(ACMColors.bgAlt)

            VStack(spacing: ACMSpacing.lg) {
                Circle()
                    .fill(ACMColors.avatarColor(for: viewModel.state.displayName))
                    .frame(width: 96, height: 96)
                    .overlay {
                        Text(String(viewModel.state.displayName.prefix(1)).uppercased())
                            .font(.system(size: 38, weight: .bold))
                            .foregroundStyle(Color.white)
                    }

                VStack(spacing: 6) {
                    Text("You're the only one here")
                        .font(ACMFont.trial(18, weight: .bold))
                        .foregroundStyle(ACMColors.text)
                    Text("Share this link to invite others")
                        .font(ACMFont.trial(14))
                        .foregroundStyle(ACMColors.textMuted)
                }

                VStack(spacing: ACMSpacing.sm) {
                    Button {
                        shareMeetingLink()
                    } label: {
                        HStack(spacing: 8) {
                            ACMSystemIcon.icon("person.badge.plus", android: "link", size: 15, tint: "white")
                                .foregroundStyle(Color.white)
                            Text(didShareInvite ? "Invite ready" : "Invite people")
                                .font(ACMFont.trial(15, weight: .medium))
                                .foregroundStyle(Color.white)
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 18)
                        .padding(.vertical, 12)
                        .acmColorBackground(ACMColors.primaryOrange)
                        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
                    }
                    .buttonStyle(.plain)

                    Button {
                        copyMeetingLink()
                    } label: {
                        HStack(spacing: 8) {
                            Text(didCopyCode ? "Copied" : viewModel.state.roomId)
                                .font(ACMFont.trial(15, weight: .medium))
                                .foregroundStyle(ACMColors.text)
                                .lineLimit(1)
                            ACMSystemIcon.icon("doc.on.doc", android: "copy", size: 13, tint: didCopyCode ? "success" : "muted")
                                .foregroundStyle(didCopyCode ? ACMColors.success : ACMColors.textMuted)
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                        .acmColorBackground(ACMColors.surface)
                        .overlay {
                            RoundedRectangle(cornerRadius: ACMRadius.md)
                                .strokeBorder(didCopyCode ? ACMColors.success : ACMColors.border, lineWidth: 1.0)
                        }
                        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(ACMSpacing.xl)
        }
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.lg)
                .strokeBorder(ACMColors.border, lineWidth: 1.0)
        }
    }

    func copyMeetingLink() {
        MeetingShare.copyMeetingLink(viewModel.state.meetingLink)
        copyFeedbackGeneration += 1
        let generation = copyFeedbackGeneration
        didCopyCode = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard copyFeedbackGeneration == generation else { return }
            didCopyCode = false
        }
    }

    func shareMeetingLink() {
        MeetingShare.shareMeetingLink(viewModel.state.meetingLink, roomId: viewModel.state.roomId)
        shareFeedbackGeneration += 1
        let generation = shareFeedbackGeneration
        didShareInvite = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 2_400_000_000)
            guard shareFeedbackGeneration == generation else { return }
            didShareInvite = false
        }
    }
}
