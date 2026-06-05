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

    var body: some View {
        GeometryReader { geo in
            let count = viewModel.state.participantCount
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
                // Solo: camera-on fills the stage (FaceTime self-view); camera-off
                // shows an invite affordance (Meet "you're the only one here")
                // instead of a lone avatar in an empty tile.
                Group {
                    if viewModel.state.isCameraOff {
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
                nonScrollingGrid(layout: layout, count: count)
                    // Top-aligned so the reserved controlsOverlap stays clear at
                    // the bottom (the floating controls bar never covers a tile).
                    .frame(width: geo.size.width, height: geo.size.height, alignment: .top)
                    // Smooth Meet-style reflow: persistent tiles animate their
                    // frame as the grid re-packs on join/leave.
                    .animation(.easeInOut(duration: 0.22), value: count)
            } else {
                scrollingGrid(containerWidth: geo.size.width)
            }
        }
    }

    @ViewBuilder
    func nonScrollingGrid(layout: TileLayout, count: Int) -> some View {
        VStack(spacing: spacing) {
            ForEach(0..<layout.rows, id: \.self) { row in
                HStack(spacing: spacing) {
                    let startIndex = row * layout.columns
                    let endIndex = min(startIndex + layout.columns, count)
                    let tilesInRow = endIndex - startIndex

                    ForEach(0..<tilesInRow, id: \.self) { col in
                        let index = startIndex + col
                        Button {
                            viewModel.togglePin(userIdAt(index: index))
                        } label: {
                            tileAt(index: index)
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
    func scrollingGrid(containerWidth: CGFloat) -> some View {
        let colCount = isCompact ? 2 : 3
        let tileW = (containerWidth - 2 * padding - CGFloat(colCount - 1) * spacing) / CGFloat(colCount)
        let tileH = tileW * 9.0 / 16.0
        let columns = Array(repeating: GridItem(.flexible(), spacing: spacing), count: colCount)

        ScrollView {
            LazyVGrid(columns: columns, spacing: spacing) {
                Button {
                    viewModel.togglePin(viewModel.state.userId)
                } label: {
                    localTile().frame(height: tileH)
                }
                .buttonStyle(.plain)

                ForEach(viewModel.state.sortedParticipants) { participant in
                    Button {
                        viewModel.togglePin(participant.id)
                    } label: {
                        remoteTile(participant: participant).frame(height: tileH)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(padding)
        }
    }

    @ViewBuilder
    func tileAt(index: Int) -> some View {
        if index == 0 {
            localTile()
        } else {
            let participants = viewModel.state.sortedParticipants
            if index - 1 < participants.count {
                remoteTile(participant: participants[index - 1])
            }
        }
    }

    // Maps a grid slot to its participant id (slot 0 = local) for tap-to-pin.
    func userIdAt(index: Int) -> String {
        if index == 0 { return viewModel.state.userId }
        let participants = viewModel.state.sortedParticipants
        if index - 1 < participants.count {
            return participants[index - 1].id
        }
        return viewModel.state.userId
    }

    func localTile(fill: Bool = false) -> some View {
        VideoGridItem(
            displayName: viewModel.state.displayName,
            isMuted: viewModel.state.isMuted,
            isCameraOff: viewModel.state.isCameraOff,
            isHandRaised: viewModel.state.isHandRaised,
            isGhost: viewModel.state.isGhostMode,
            isSpeaking: viewModel.state.activeSpeakerId == viewModel.state.userId,
            isLocal: true,
            fillStage: fill,
            captureSession: viewModel.webRTCClient.getCaptureSession(),
            localVideoTrack: viewModel.webRTCClient.getLocalVideoTrack()
        )
    }

    func remoteTile(participant: Participant) -> some View {
        VideoGridItem(
            displayName: viewModel.displayNameForUser(participant.id),
            isMuted: participant.isMuted,
            isCameraOff: participant.isCameraOff,
            isHandRaised: participant.isHandRaised,
            isGhost: participant.isGhost,
            isSpeaking: viewModel.state.activeSpeakerId == participant.id,
            isLocal: false,
            trackWrapper: viewModel.webRTCClient.remoteVideoTracks[participant.id]
        )
        .opacity(participant.isLeaving ? 0.5 : 1.0)
        .animation(Animation.easeOut(duration: 0.2), value: participant.isLeaving)
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
                    Text("Share this code to invite others")
                        .font(ACMFont.trial(14))
                        .foregroundStyle(ACMColors.textMuted)
                }

                Button {
                    copyRoomCode()
                } label: {
                    HStack(spacing: 8) {
                        Text(viewModel.state.roomId)
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
            .padding(ACMSpacing.xl)
        }
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.lg)
                .strokeBorder(ACMColors.border, lineWidth: 1.0)
        }
    }

    func copyRoomCode() {
        #if !SKIP
#if canImport(UIKit)
        UIPasteboard.general.string = viewModel.state.roomId
#endif
        HapticManager.shared.trigger(.success)
        #endif
        didCopyCode = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            didCopyCode = false
        }
    }
}

