import SwiftUI
import Observation

// The active game owns the meeting stage: a full game surface framed like the
// shared-app stage, with the room kept visible in a thumbnail strip. The games
// sheet only launches games; play happens here.

struct GameStageLayoutView: View {
    @Bindable var viewModel: MeetingViewModel
    let isCompact: Bool

    private let controlsOverlap: CGFloat = 8

    var body: some View {
        // This body intentionally reads no high-frequency state: the game card
        // and the tile strip each observe their own slice, so a game move does
        // not recompute the strip and an active-speaker tick does not rebuild
        // the game body.
        GeometryReader { geo in
            if isCompact {
                let availableHeight = MeetingStageLayout.visibleHeight(
                    containerHeight: geo.size.height,
                    controlsOverlap: controlsOverlap
                )
                VStack(spacing: 8) {
                    GameStageCardView(viewModel: viewModel, isCompact: isCompact)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)

                    GameStageTileStrip(viewModel: viewModel, axis: .horizontal, isCompact: isCompact)
                        .frame(height: 64)
                }
                .padding(8)
                .frame(width: geo.size.width, height: availableHeight, alignment: .top)
            } else {
                HStack(spacing: 8) {
                    GameStageCardView(viewModel: viewModel, isCompact: isCompact)

                    GameStageTileStrip(viewModel: viewModel, axis: .vertical, isCompact: isCompact)
                        .frame(width: 148)
                        .acmColorBackground(ACMColors.bgAlt)
                        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
                }
                .padding(8)
            }
        }
    }
}

/// The framed game surface. Observes only game state (+ the detached-self flag),
/// so it rebuilds on moves and phase changes, not on tile churn.
struct GameStageCardView: View {
    @Bindable var viewModel: MeetingViewModel
    let isCompact: Bool

#if !SKIP
#if canImport(UIKit)
    // The meeting column ignores the keyboard (a call never compresses); the
    // card instead pads its scrollable body by the actual keyboard overlap so
    // game inputs (Wordle guess, bluff answers) stay reachable while typing.
    @StateObject private var keyboardObserver = KeyboardFrameObserver()
#endif
#endif

    var body: some View {
        let _ = PerformanceDiagnostics.render("GameStageCardView") {
            "game=\(viewModel.state.gamePublicState?.gameId ?? "none") phase=\(viewModel.state.gamePublicState?.phase ?? "-")"
        }
        VStack(spacing: 0) {
            if let activeGame = viewModel.state.gamePublicState {
                GameStageChromeView(viewModel: viewModel, activeGame: activeGame)

                Rectangle()
                    .fill(ACMColors.border)
                    .frame(height: 1)

                if let errorMessage = viewModel.state.gameErrorMessage {
                    GameStageErrorLine(message: errorMessage)
                }

                GameStageBodyView(viewModel: viewModel, activeGame: activeGame)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
#if !SKIP
#if canImport(UIKit)
                    .modifier(KeyboardOverlapAvoidance(keyboardTopY: keyboardObserver.keyboardTopY))
#endif
#endif
            }
        }
        .acmColorBackground(ACMColors.surface)
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.lg)
                .strokeBorder(lineWidth: 1)
                .foregroundStyle(ACMColors.border)
        }
        // No floating self view over a game: the tile strip force-includes the
        // local user (see tileStripSnapshot(forceSelfTile:)), so game controls
        // are never obscured and self-presence has a stable, predictable home.
    }
}

/// The room-presence strip beside/under the game. Observes only tile state, so
/// speaking/mute changes never touch the game body.
struct GameStageTileStrip: View {
    @Bindable var viewModel: MeetingViewModel
    let axis: Axis
    let isCompact: Bool

    private var thumbnailWidth: CGFloat { isCompact ? 100.0 : 124.0 }
    private var thumbnailHeight: CGFloat { isCompact ? 56.0 : 70.0 }

    var body: some View {
        let strip = viewModel.state.tileStripSnapshot(forceSelfTile: true)
        if axis == .horizontal {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    tiles(strip)
                }
                .padding(.horizontal, 8)
            }
        } else {
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 8) {
                    tiles(strip)
                }
                .padding(8)
            }
        }
    }

    @ViewBuilder
    private func tiles(_ strip: MeetingTileStripSnapshot) -> some View {
        if strip.shouldShowSelfTile {
            localThumbnail
        }
        ForEach(strip.participants) { participant in
            remoteThumbnail(participant: participant)
        }
    }

    private var localThumbnail: some View {
        let localVideoTrack = viewModel.webRTCClient.getLocalVideoTrack()
        let captureSession = (!viewModel.state.isCameraOff && localVideoTrack == nil) ? viewModel.webRTCClient.getCaptureSession() : nil
        return VideoGridItem(
            displayName: viewModel.displayNameForUser(viewModel.state.userId),
            isMuted: viewModel.state.isMuted,
            isCameraOff: viewModel.state.isCameraOff,
            isHandRaised: viewModel.state.isHandRaised,
            isSpeaking: viewModel.state.isEffectiveActiveSpeaker(viewModel.state.userId),
            isLocal: true,
            identityId: viewModel.state.userId,
            isThumbnail: true,
            avatarSizeOverride: 30.0,
            localCameraFacing: viewModel.localCameraFacing,
            captureSession: captureSession,
            localVideoTrack: localVideoTrack
        )
        .frame(width: thumbnailWidth, height: thumbnailHeight)
    }

    private func remoteThumbnail(participant: Participant) -> some View {
        VideoGridItem(
            displayName: viewModel.displayNameForUser(participant.id),
            isMuted: participant.isMuted,
            isCameraOff: participant.isCameraOff,
            isHandRaised: participant.isHandRaised,
            isSpeaking: viewModel.state.isEffectiveActiveSpeaker(participant.id),
            isLocal: false,
            identityId: participant.id,
            connectionStatus: participant.connectionStatus,
            isThumbnail: true,
            avatarSizeOverride: 30.0,
            trackWrapper: viewModel.webRTCClient.remoteVideoTrack(forUserId: participant.id)
        )
        .frame(width: thumbnailWidth, height: thumbnailHeight)
    }
}

// MARK: - Chrome

/// Compact top bar of the stage: identity, live status, seat state, and the
/// host's end control (armed, so one stray tap cannot kill the round).
struct GameStageChromeView: View {
    @Bindable var viewModel: MeetingViewModel
    let activeGame: GamePublicState

    private var endArmed: Bool {
        viewModel.state.isGameEndArmed
    }

    private var canManage: Bool {
        viewModel.state.isAdmin
            && viewModel.state.connectionState == .joined
            && !viewModel.state.isWebinarAttendee
    }

    private var isPlayer: Bool {
        viewModel.state.hasLocalGamePlayer(in: activeGame.players)
    }

    private var isPendingJoiner: Bool {
        guard let pending = activeGame.pendingJoiners else { return false }
        return viewModel.state.hasLocalGamePlayer(in: pending)
    }

    private var statusLine: String {
        var parts = [GameStageTextPolicy.playersLine(count: activeGame.players.count)]
        if let pending = activeGame.pendingJoiners, !pending.isEmpty {
            parts.append("+\(pending.count) joining")
        }
        parts.append(GameStageTextPolicy.phaseLabel(activeGame.phase))
        return parts.joined(separator: " · ")
    }

    var body: some View {
        let visual = GameCatalogPresentationPolicy.visual(for: activeGame.gameId)
        HStack(spacing: ACMSpacing.sm) {
            Circle()
                .fill(ACMColors.primaryOrangeFaint)
                .frame(width: 34, height: 34)
                .overlay {
                    ACMSystemIcon.icon(visual.icon, android: visual.androidIcon, size: 16, tint: "accent")
                        .foregroundStyle(ACMColors.primaryOrange)
                }

            VStack(alignment: .leading, spacing: 2) {
                Text(activeGame.name)
                    .font(ACMFont.trial(15, weight: .semibold))
                    .foregroundStyle(ACMColors.text)
                    .lineLimit(1)
                Text(statusLine)
                    .font(ACMFont.trial(11))
                    .foregroundStyle(ACMColors.textFaint)
                    .lineLimit(1)
            }

            Spacer(minLength: ACMSpacing.xs)

            if !isPlayer {
                seatStateView
            }

            if canManage {
                endButton
            }
        }
        .padding(.horizontal, ACMSpacing.sm)
        .padding(.vertical, ACMSpacing.xs)
    }

    @ViewBuilder
    private var seatStateView: some View {
        if isPendingJoiner {
            MeetingSheetStatusPill(
                "Joining next round",
                tint: ACMColors.primaryOrange,
                background: ACMColors.primaryOrange.opacity(0.14),
                border: ACMColors.primaryOrange.opacity(0.34)
            )
        } else if activeGame.canJoinLate == true && !viewModel.state.isWebinarAttendee {
            Button {
                viewModel.joinActiveGame()
            } label: {
                Text("Join")
                    .font(ACMFont.trial(13, weight: .semibold))
                    .foregroundStyle(Color.white)
                    .padding(.horizontal, 14)
                    .frame(height: 32)
                    .background(ACMColors.primaryOrange, in: Capsule())
            }
            .buttonStyle(.plain)
            .disabled(viewModel.state.isGameActionInFlight)
            .opacity(viewModel.state.isGameActionInFlight ? 0.6 : 1.0)
            .accessibilityLabel("Join the game")
        } else {
            MeetingSheetStatusPill("Watching")
        }
    }

    private var endButton: some View {
        Button {
            debugLog("[GameStage] end tapped armed=\(endArmed)")
            viewModel.armOrConfirmEndGame()
        } label: {
            HStack(spacing: 5) {
                ACMSystemIcon.icon("xmark", android: "close", size: 11, tint: "error")
                    .foregroundStyle(ACMColors.error)
                Text(endArmed ? "Sure?" : "End")
                    .font(ACMFont.trial(12, weight: .semibold))
                    .foregroundStyle(ACMColors.error)
            }
            .padding(.horizontal, 12)
            .frame(height: 32)
            .acmGlassCapsule(
                tint: endArmed ? ACMColors.error.opacity(0.28) : nil,
                interactive: true
            )
        }
        .buttonStyle(.plain)
        .disabled(viewModel.state.isGameActionInFlight)
        .accessibilityLabel(endArmed ? "Confirm end game" : "End game")
    }
}

struct GameStageErrorLine: View {
    let message: String

    var body: some View {
        HStack(spacing: 8) {
            ACMSystemIcon.icon("exclamationmark.triangle.fill", android: "warning", size: 12, tint: "error")
                .foregroundStyle(ACMColors.error)
            Text(message)
                .font(ACMFont.trial(12, weight: .medium))
                .foregroundStyle(ACMColors.error)
                .lineLimit(2)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, ACMSpacing.md)
        .padding(.vertical, 6)
        .acmColorBackground(ACMColors.error.opacity(0.10))
    }
}

// MARK: - Body dispatch

/// Picks the right surface for the current game and phase. Kept narrow so a
/// phase change only rebuilds the game area, never the whole stage frame.
struct GameStageBodyView: View {
    @Bindable var viewModel: MeetingViewModel
    let activeGame: GamePublicState

    private var isPlayer: Bool {
        viewModel.state.hasLocalGamePlayer(in: activeGame.players)
    }

    private var playerView: GameJSONValue? {
        guard viewModel.state.gamePlayerView?.gameId == activeGame.gameId else { return nil }
        return viewModel.state.gamePlayerView?.view
    }

    private var canPlay: Bool {
        viewModel.state.connectionState == .joined
            && !viewModel.state.isWebinarAttendee
            && isPlayer
    }

    private var canManage: Bool {
        viewModel.state.isAdmin
            && viewModel.state.connectionState == .joined
            && !viewModel.state.isWebinarAttendee
    }

    var body: some View {
        if activeGame.phase == "lobby" {
            GameStageLobbyView(viewModel: viewModel, activeGame: activeGame, canManage: canManage)
        } else if !isPlayer && activeGame.view == nil {
            // This game keeps its state secret from spectators (imposter).
            GameStageNotice(
                icon: "eye.slash",
                androidIcon: "ghost",
                title: "Round in progress",
                subtitle: "This game hides its round from spectators. You can join the next one."
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            switch activeGame.gameId {
            case "trivia":
                TriviaStageView(viewModel: viewModel, activeGame: activeGame, playerView: playerView, canPlay: canPlay, canManage: canManage)
            case "reaction":
                ReactionStageView(viewModel: viewModel, activeGame: activeGame, playerView: playerView, canPlay: canPlay, canManage: canManage)
            case "most-likely-to":
                MostLikelyStageView(viewModel: viewModel, activeGame: activeGame, playerView: playerView, canPlay: canPlay, canManage: canManage)
            case "would-you-rather":
                WouldYouRatherStageView(viewModel: viewModel, activeGame: activeGame, playerView: playerView, canPlay: canPlay, canManage: canManage)
            case "bluff":
                BluffStageView(viewModel: viewModel, activeGame: activeGame, playerView: playerView, canPlay: canPlay, canManage: canManage)
            case "imposter":
                ImposterStageView(viewModel: viewModel, activeGame: activeGame, playerView: playerView, canPlay: canPlay, canManage: canManage)
            case "wordle":
                WordleStageView(viewModel: viewModel, activeGame: activeGame, playerView: playerView, canPlay: canPlay, canManage: canManage)
            case "chess":
                ChessStageView(viewModel: viewModel, activeGame: activeGame, playerView: playerView, canPlay: canPlay, canManage: canManage)
            default:
                GenericGameStageView(viewModel: viewModel, activeGame: activeGame, canManage: canManage)
            }
        }
    }
}

// MARK: - Lobby

struct GameStageLobbyView: View {
    @Bindable var viewModel: MeetingViewModel
    let activeGame: GamePublicState
    let canManage: Bool

    private var players: [GamePlayer] {
        activeGame.players
    }

    private var pendingJoiners: [GamePlayer] {
        activeGame.pendingJoiners ?? []
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: ACMSpacing.md) {
                    GameStagePrompt(
                        kicker: "Lobby",
                        title: "Waiting to start",
                        subtitle: canManage
                            ? "Start when everyone is in."
                            : "The host starts the game."
                    )

                    if !players.isEmpty {
                        playerChipGrid
                    }
                }
                .padding(ACMSpacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if canManage {
                GameStageBottomBar {
                    GameStageActionButton(
                        title: "Start game",
                        isDisabled: viewModel.state.isGameActionInFlight
                    ) {
                        viewModel.sendGameMove(type: "start")
                    }
                }
            }
        }
    }

    private var playerChipGrid: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 130), spacing: 8, alignment: .leading)],
            alignment: .leading,
            spacing: 8
        ) {
            ForEach(players) { player in
                GameStagePlayerChip(id: player.id, name: player.name)
            }
            ForEach(pendingJoiners) { player in
                GameStagePlayerChip(id: player.id, name: player.name, isPending: true)
            }
        }
    }
}

// MARK: - Generic fallback

struct GenericGameStageView: View {
    @Bindable var viewModel: MeetingViewModel
    let activeGame: GamePublicState
    let canManage: Bool

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: ACMSpacing.md) {
                    GameStagePrompt(
                        kicker: activeGame.name,
                        title: GameStageTextPolicy.phaseLabel(activeGame.phase),
                        subtitle: GameStageTextPolicy.playersLine(count: activeGame.players.count)
                    )
                }
                .padding(ACMSpacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            GameStageHostRoundBar(viewModel: viewModel, phase: activeGame.phase, canManage: canManage)
        }
    }
}

// MARK: - Shared bars

/// Pinned bottom action area of the stage card.
struct GameStageBottomBar<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        HStack(spacing: ACMSpacing.sm) {
            content
        }
        .padding(.horizontal, ACMSpacing.md)
        .padding(.vertical, ACMSpacing.sm)
        .frame(maxWidth: .infinity)
        .overlay(alignment: .top) {
            Rectangle().fill(ACMColors.border).frame(height: 1)
        }
    }
}

/// Standard host controls for question/vote/choose/reveal round flows.
struct GameStageHostRoundBar: View {
    @Bindable var viewModel: MeetingViewModel
    let phase: String
    let canManage: Bool
    var skipTitle: String? = nil

    var body: some View {
        if canManage {
            if phase == "question" || phase == "vote" || phase == "choose" {
                GameStageBottomBar {
                    GameStageActionButton(
                        title: skipTitle ?? (phase == "question" ? "Skip question" : "Reveal now"),
                        isPrimary: false,
                        tint: ACMColors.text,
                        isDisabled: viewModel.state.isGameActionInFlight
                    ) {
                        viewModel.sendGameMove(type: "skip")
                    }
                }
            } else if phase == "reveal" {
                GameStageBottomBar {
                    GameStageActionButton(
                        title: "Next",
                        isDisabled: viewModel.state.isGameActionInFlight
                    ) {
                        viewModel.sendGameMove(type: "next")
                    }
                }
            }
        }
    }
}

/// Results bar: the host can run it back or close it out.
struct GameStageResultsBar: View {
    @Bindable var viewModel: MeetingViewModel
    let canManage: Bool

    var body: some View {
        if canManage {
            GameStageBottomBar {
                GameStageActionButton(
                    title: "Play again",
                    isDisabled: viewModel.state.isGameActionInFlight
                ) {
                    viewModel.rematchActiveGame()
                }
            }
        }
    }
}
