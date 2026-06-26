import SwiftUI
import Observation

struct ActiveAppLayoutView: View {
    @Bindable var viewModel: MeetingViewModel
    let isCompact: Bool

    private let controlsOverlap: CGFloat = 8
    private var detachedSelfEdgeInsets: EdgeInsets {
        MeetingDetachedSelfLayout.edgeInsets(isCompact: isCompact)
    }

    private var canUseAppHostControls: Bool {
        viewModel.state.isAdmin
            && viewModel.state.connectionState == .joined
            && !viewModel.state.isWebinarAttendee
    }

    var body: some View {
        GeometryReader { geo in
            if isCompact {
                compactLayout(size: geo.size)
            } else {
                regularLayout
            }
        }
    }

    private func compactLayout(size: CGSize) -> some View {
        let availableHeight = MeetingStageLayout.visibleHeight(
            containerHeight: size.height,
            controlsOverlap: controlsOverlap
        )
        let strip = viewModel.state.tileStripSnapshot()
        return VStack(spacing: 8) {
            appStage
                .frame(maxWidth: .infinity)
                .frame(height: availableHeight * 0.74)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    if strip.shouldShowSelfTile {
                        localThumbnail
                    }
                    ForEach(strip.participants) { participant in
                        remoteThumbnail(participant: participant)
                    }
                }
                .padding(.horizontal, 8)
            }
            .frame(height: 84)
        }
        .frame(width: size.width, height: availableHeight, alignment: .top)
        .padding(8)
    }

    private var regularLayout: some View {
        let strip = viewModel.state.tileStripSnapshot()
        return HStack(spacing: 8) {
            appStage

            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 8) {
                    if strip.shouldShowSelfTile {
                        localThumbnail
                    }
                    ForEach(strip.participants) { participant in
                        remoteThumbnail(participant: participant)
                    }
                }
                .padding(8)
            }
            .frame(width: 148)
            .acmColorBackground(ACMColors.bgAlt)
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
        }
        .padding(8)
    }

    private var appStage: some View {
        VStack(spacing: 0) {
            appToolbar

            ZStack {
                if viewModel.state.isWhiteboardActive {
                    whiteboardSurface
                } else {
                    genericAppSurface
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .acmColorBackground(ACMColors.surface)
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.lg)
                .strokeBorder(lineWidth: 1)
                .foregroundStyle(ACMColors.border)
        }
        .overlay {
            if viewModel.state.shouldShowDetachedSelfView && !viewModel.state.shouldShowSelfTile {
                DetachedSelfViewOverlay(viewModel: viewModel, isCompact: isCompact, edgeInsets: detachedSelfEdgeInsets)
            }
        }
    }

    private var appToolbar: some View {
        HStack(spacing: ACMSpacing.sm) {
            Circle()
                .fill(ACMColors.primaryOrangeFaint)
                .frame(width: 36, height: 36)
                .overlay {
                    ACMSystemIcon.icon(appIcon.ios, android: appIcon.android, size: 17, tint: "accent")
                        .foregroundStyle(ACMColors.primaryOrange)
                }

            VStack(alignment: .leading, spacing: 2) {
                Text(activeAppName)
                    .font(ACMFont.trial(15, weight: .semibold))
                    .foregroundStyle(ACMColors.text)
                    .lineLimit(1)
                Text(toolbarStatusText)
                    .font(ACMFont.trial(12))
                    .foregroundStyle(ACMColors.textFaint)
                    .lineLimit(1)
            }

            Spacer(minLength: ACMSpacing.sm)

            if canUseAppHostControls {
                appToolbarControls
            }
        }
        .padding(.horizontal, ACMSpacing.sm)
        .padding(.vertical, ACMSpacing.xs)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(ACMColors.border)
                .frame(height: 1)
        }
    }

    private var appToolbarControls: some View {
        HStack(spacing: ACMSpacing.xs) {
            appToolbarButton(
                title: viewModel.state.isAppsLocked ? "Unlock" : "Lock",
                icon: viewModel.state.isAppsLocked ? "lock.open.fill" : "lock.fill",
                androidIcon: viewModel.state.isAppsLocked ? "lock.open" : "lock",
                tint: viewModel.state.isAppsLocked ? ACMColors.primaryOrange : ACMColors.text,
                androidTint: viewModel.state.isAppsLocked ? "accent" : "text",
                isDisabled: !canUseAppHostControls
            ) {
                viewModel.toggleAppsLock()
            }

            appToolbarButton(
                title: "Close",
                icon: "xmark",
                androidIcon: "close",
                tint: ACMColors.error,
                androidTint: "error",
                isDisabled: !canUseAppHostControls
            ) {
                viewModel.closeActiveApp()
            }
        }
    }

    private func appToolbarButton(
        title: String,
        icon: String,
        androidIcon: String,
        tint: Color,
        androidTint: String,
        isDisabled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        let disabled = isDisabled || viewModel.state.isAppsActionInFlight

        return Button(action: action) {
            HStack(spacing: 6) {
                ACMSystemIcon.icon(icon, android: androidIcon, size: 13, tint: androidTint)
                    .foregroundStyle(disabled ? ACMColors.textFaint : tint)
                Text(title)
                    .font(ACMFont.trial(12, weight: .medium))
            }
            .foregroundStyle(disabled ? ACMColors.textFaint : tint)
            .padding(.horizontal, 12)
            .frame(height: 34)
            .acmGlassCapsule(interactive: true)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1.0)
    }

    private var whiteboardSurface: some View {
        GeometryReader { geo in
            ZStack {
                ACMColors.bg
                WhiteboardGridView(size: geo.size)
                    .equatable()

                if viewModel.state.isAppsLocked {
                    lockedOverlay
                }
            }
        }
    }

    private var lockedOverlay: some View {
        VStack(spacing: ACMSpacing.xs) {
            ACMSystemIcon.icon("lock.fill", android: "lock", size: 18, tint: "accent")
                .foregroundStyle(ACMColors.primaryOrange)
            Text("Locked by host")
                .font(ACMFont.trial(13, weight: .medium))
                .foregroundStyle(ACMColors.text)
                .lineLimit(1)
        }
        .padding(.horizontal, ACMSpacing.md)
        .padding(.vertical, ACMSpacing.sm)
        .acmGlassRoundedRect(cornerRadius: ACMRadius.sm)
    }

    private var genericAppSurface: some View {
        VStack(spacing: ACMSpacing.md) {
            Circle()
                .fill(ACMColors.primaryOrangeFaint)
                .frame(width: 72, height: 72)
                .overlay {
                    ACMSystemIcon.icon(appIcon.ios, android: appIcon.android, size: 30, tint: "accent")
                        .foregroundStyle(ACMColors.primaryOrange)
                }

            VStack(spacing: ACMSpacing.xs) {
                Text(activeAppName)
                    .font(ACMFont.trial(21, weight: .semibold))
                    .foregroundStyle(ACMColors.text)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                Text(toolbarStatusText)
                    .font(ACMFont.trial(13))
                    .foregroundStyle(ACMColors.textMuted)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
            }
        }
        .padding(ACMSpacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .acmColorBackground(ACMColors.bg)
    }

    private var activeAppName: String {
        viewModel.state.activeAppName ?? "Shared app"
    }

    private var toolbarStatusText: String {
        if viewModel.state.isAppsLocked {
            return "Editing locked"
        }
        return hasActiveAppSyncSnapshot ? "Synced with room" : "Live in room"
    }

    private var hasActiveAppSyncSnapshot: Bool {
        guard let activeAppId = viewModel.state.activeAppId else { return false }
        return viewModel.state.latestAppYjsUpdate?.appId == activeAppId ||
            viewModel.state.latestAppAwarenessUpdate?.appId == activeAppId
    }

    private var appIcon: (ios: String, android: String) {
        switch viewModel.state.activeAppId {
        case "whiteboard":
            return ("pencil", "forum")
        case "dev-playground":
            return ("chevron.left.forwardslash.chevron.right", "info")
        default:
            return ("app.fill", "info")
        }
    }

    private var thumbnailWidth: CGFloat { isCompact ? 120.0 : 124.0 }
    private var thumbnailHeight: CGFloat { isCompact ? 68.0 : 70.0 }

    private var localThumbnail: some View {
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
            isThumbnail: true,
            avatarSizeOverride: 34.0,
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
            isGhost: participant.isGhost,
            isSpeaking: viewModel.state.isEffectiveActiveSpeaker(participant.id),
            isLocal: false,
            connectionStatus: participant.connectionStatus,
            isThumbnail: true,
            avatarSizeOverride: 34.0,
            trackWrapper: viewModel.webRTCClient.remoteVideoTrack(forUserId: participant.id)
        )
        .frame(width: thumbnailWidth, height: thumbnailHeight)
    }
}

private struct WhiteboardGridView: View, Equatable {
    let size: CGSize

    var body: some View {
        ZStack {
            ForEach(gridOffsets(upTo: size.width, step: 24), id: \.self) { x in
                Rectangle()
                    .fill(ACMColors.creamGhost)
                    .frame(width: 1)
                    .position(x: x, y: size.height / 2)
            }
            ForEach(gridOffsets(upTo: size.height, step: 24), id: \.self) { y in
                Rectangle()
                    .fill(ACMColors.creamGhost)
                    .frame(height: 1)
                    .position(x: size.width / 2, y: y)
            }
            ForEach(gridOffsets(upTo: size.width, step: 120), id: \.self) { x in
                Rectangle()
                    .fill(ACMColors.border)
                    .frame(width: 1)
                    .position(x: x, y: size.height / 2)
            }
            ForEach(gridOffsets(upTo: size.height, step: 120), id: \.self) { y in
                Rectangle()
                    .fill(ACMColors.border)
                    .frame(height: 1)
                    .position(x: size.width / 2, y: y)
            }
        }
    }

    private func gridOffsets(upTo length: CGFloat, step: CGFloat) -> [CGFloat] {
        guard length > 0, step > 0 else { return [] }
        var offsets: [CGFloat] = []
        var current: CGFloat = 0
        while current <= length {
            offsets.append(current)
            current += step
        }
        return offsets
    }
}
