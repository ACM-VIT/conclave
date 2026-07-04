import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

struct MeetingControlsBarMetrics {
    let itemSpacing: CGFloat
    let horizontalPadding: CGFloat
    let verticalPadding: CGFloat
    let separatorHorizontalPadding: CGFloat
    let contentMaxWidth: CGFloat
}

enum MeetingControlsBarLayout {
    static let buttonSize: CGFloat = 44.0
    static let separatorWidth: CGFloat = 1.0

    static func metrics(availableWidth: CGFloat, isCompact: Bool) -> MeetingControlsBarMetrics {
        let horizontalPadding = horizontalPadding(availableWidth: availableWidth, isCompact: isCompact)
        return MeetingControlsBarMetrics(
            itemSpacing: itemSpacing(availableWidth: availableWidth, isCompact: isCompact),
            horizontalPadding: horizontalPadding,
            verticalPadding: 10.0,
            separatorHorizontalPadding: separatorHorizontalPadding(
                availableWidth: availableWidth,
                isCompact: isCompact
            ),
            contentMaxWidth: contentMaxWidth(
                availableWidth: availableWidth,
                isCompact: isCompact,
                resolvedHorizontalPadding: horizontalPadding
            )
        )
    }

    static func itemSpacing(availableWidth: CGFloat, isCompact: Bool) -> CGFloat {
        guard isCompact else { return 4.0 }
        if availableWidth < 300.0 { return 4.0 }
        if availableWidth < 340.0 { return 6.0 }
        return 8.0
    }

    static func horizontalPadding(availableWidth: CGFloat, isCompact: Bool) -> CGFloat {
        guard isCompact else { return 12.0 }
        return availableWidth < 300.0 ? 8.0 : 12.0
    }

    static func separatorHorizontalPadding(availableWidth: CGFloat, isCompact: Bool) -> CGFloat {
        guard isCompact else { return 4.0 }
        return availableWidth < 320.0 ? 1.0 : 2.0
    }

    static func outerMaxWidth(availableWidth: CGFloat, isCompact: Bool) -> CGFloat {
        let width = max(0.0, availableWidth)
        return isCompact ? min(384.0, width) : width
    }

    static func contentMaxWidth(
        availableWidth: CGFloat,
        isCompact: Bool,
        resolvedHorizontalPadding: CGFloat? = nil
    ) -> CGFloat {
        let padding = resolvedHorizontalPadding ?? horizontalPadding(
            availableWidth: availableWidth,
            isCompact: isCompact
        )
        return max(0.0, outerMaxWidth(availableWidth: availableWidth, isCompact: isCompact) - (padding * 2.0))
    }

    static func minimumOuterWidth(
        controlButtonCount: Int,
        includesSeparator: Bool,
        availableWidth: CGFloat,
        isCompact: Bool
    ) -> CGFloat {
        let metrics = metrics(availableWidth: availableWidth, isCompact: isCompact)
        let separatorFootprint = includesSeparator
            ? separatorWidth + (metrics.separatorHorizontalPadding * 2.0)
            : 0.0
        let visibleItemCount = controlButtonCount + (includesSeparator ? 1 : 0)
        let gapCount = max(0, visibleItemCount - 1)

        return (CGFloat(max(0, controlButtonCount)) * buttonSize) +
            separatorFootprint +
            (CGFloat(gapCount) * metrics.itemSpacing) +
            (metrics.horizontalPadding * 2.0)
    }
}

enum MeetingControlsBarCopy {
    static func webinarAttendeeStatus(count: Int) -> String {
        let safeCount = max(0, count)
        let noun = safeCount == 1 ? "attendee" : "attendees"
        return "\(safeCount) \(noun) watching"
    }
}

// MARK: - Controls Bar

struct ControlsBarView: View {
    @Bindable var viewModel: MeetingViewModel
    let availableWidth: CGFloat
    let onParticipantsPressed: () -> Void
    let onSettingsPressed: () -> Void
    var onMorePressed: () -> Void = {}
    @State private var showReactionPicker = false

#if !os(macOS) && !SKIP
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
#endif

    private var isRegularSizeClass: Bool {
#if SKIP
        return false
#elseif os(macOS)
        return true
#else
        return horizontalSizeClass == UserInterfaceSizeClass.regular
#endif
    }

    var body: some View {
        let isCompact = !isRegularSizeClass
        let layout = MeetingControlsBarLayout.metrics(
            availableWidth: availableWidth,
            isCompact: isCompact
        )
        let participantsIcon: String = {
            #if SKIP
            return "participants"
            #else
            return "person.2.fill"
            #endif
        }()
        let lockIcon: String = {
            #if SKIP
            return viewModel.state.isRoomLocked ? "lock" : "lock.open"
            #else
            return viewModel.state.isRoomLocked ? "lock.fill" : "lock.open.fill"
            #endif
        }()
        let micIcon: String = {
            #if SKIP
            return viewModel.state.isMuted ? "mic.off" : "mic"
            #else
            return viewModel.state.isMuted ? "mic.slash.fill" : "mic.fill"
            #endif
        }()
        let cameraIcon: String = {
            #if SKIP
            return viewModel.state.isCameraOff ? "video.off" : "video"
            #else
            return viewModel.state.isCameraOff ? "video.slash.fill" : "video.fill"
            #endif
        }()
        let screenShareIcon: String = {
            #if SKIP
            return "screen.share"
            #else
            return "rectangle.on.rectangle"
            #endif
        }()
        let handRaiseIcon: String = {
            #if SKIP
            return "raise.hand"
            #else
            return "hand.raised.fill"
            #endif
        }()
        let chatIcon: String = {
            #if SKIP
            return "chat"
            #else
            return "message.fill"
            #endif
        }()
        let reactionIcon: String = {
            #if SKIP
            return "reactions"
            #else
            return "face.smiling"
            #endif
        }()
        let settingsIcon: String = {
            #if SKIP
            return "settings"
            #else
            return "gearshape.fill"
            #endif
        }()
        let moreIcon: String = {
            #if SKIP
            return "more"
            #else
            return "ellipsis"
            #endif
        }()
        let isJoinedCall = viewModel.state.connectionState == .joined
        let mediaControlsDisabled = !isJoinedCall || viewModel.state.mediaPublishingDisabled
        let isWebinarAttendee = viewModel.state.isWebinarAttendee
        let canUseParticipantActions = isJoinedCall
            && !isWebinarAttendee
        let isScreenShareDisabled = mediaControlsDisabled ||
            viewModel.state.hasActiveRemoteScreenShare

        HStack(spacing: layout.itemSpacing) {
            if !isWebinarAttendee {
                if !isCompact {
                    ControlButton(
                        icon: participantsIcon,
                        isActive: false,
                        badge: viewModel.state.pendingUsersCount > 0 ? viewModel.state.pendingUsersCount : nil,
                        accessibilityLabel: "Participants"
                    ) {
                        onParticipantsPressed()
                    }

                    if viewModel.state.isAdmin {
                        ControlButton(
                            icon: lockIcon,
                            isActive: viewModel.state.isRoomLocked,
                            activeColor: ACMColors.primaryOrange,
                            accessibilityLabel: viewModel.state.isRoomLocked ? "Unlock room" : "Lock room"
                        ) {
                            viewModel.toggleRoomLock()
                        }
                    }
                }

                    ControlButton(
                        icon: micIcon,
                        isMuted: viewModel.state.isMuted,
                        isDisabledDimmed: mediaControlsDisabled,
                        accessibilityLabel: viewModel.state.isMuted ? "Unmute microphone" : "Mute microphone"
                    ) {
                    viewModel.toggleMute()
                }
                .disabled(mediaControlsDisabled)

                    ControlButton(
                        icon: cameraIcon,
                        isMuted: viewModel.state.isCameraOff,
                        isDisabledDimmed: mediaControlsDisabled,
                        accessibilityLabel: viewModel.state.isCameraOff ? "Turn camera on" : "Turn camera off"
                    ) {
                    viewModel.toggleCamera()
                }
                .disabled(mediaControlsDisabled)

                if viewModel.state.isScreenShareSupported {
                    ControlButton(
                        icon: screenShareIcon,
                        isActive: viewModel.state.isScreenSharing,
                        isDisabledDimmed: isScreenShareDisabled,
                        accessibilityLabel: viewModel.state.isScreenSharing ? "Stop screen sharing" : "Share screen"
                    ) {
                        viewModel.toggleScreenShare()
                    }
                    .disabled(isScreenShareDisabled)
                }

                if isCompact {
                    // Chat is a first-class action on the phone bar; burying it
                    // in More made the most-used surface two taps away.
                    ControlButton(
                        icon: chatIcon,
                        isActive: viewModel.state.isChatOpen,
                        badge: viewModel.state.unreadChatCount > 0 ? viewModel.state.unreadChatCount : nil,
                        accessibilityLabel: "Chat"
                    ) {
                        withAnimation(.easeInOut(duration: 0.12)) {
                            viewModel.toggleChat()
                        }
                    }

                    ControlButton(
                        icon: moreIcon,
                        isActive: false,
                        badge: viewModel.state.pendingUsersCount > 0 ? viewModel.state.pendingUsersCount : nil,
                        accessibilityLabel: "More controls"
                    ) {
                        onMorePressed()
                    }
                } else {
                    ControlButton(
                        icon: handRaiseIcon,
                        isActive: viewModel.state.isHandRaised,
                        activeColor: ACMColors.handRaised,
                        isDisabledDimmed: !canUseParticipantActions,
                        accessibilityLabel: viewModel.state.isHandRaised ? "Lower hand" : "Raise hand"
                    ) {
                        viewModel.toggleHandRaise()
                    }
                    .disabled(!canUseParticipantActions)

                    if !viewModel.state.isReactionsDisabled || viewModel.state.isAdmin {
                        ControlButton(
                            icon: reactionIcon,
                            isActive: showReactionPicker,
                            isDisabledDimmed: !canUseParticipantActions,
                            accessibilityLabel: "Reactions"
                        ) {
                            showReactionPicker = !showReactionPicker
                        }
                        .disabled(!canUseParticipantActions)
                        .overlay(alignment: .top) {
                            if showReactionPicker {
                                ReactionPickerView { option in
                                    viewModel.sendReaction(option)
                                    showReactionPicker = false
                                }
                                .offset(y: -64)
#if !SKIP
                                .transition(.scale(scale: 0.9, anchor: UnitPoint.bottom).combined(with: AnyTransition.opacity))
#else
                                .transition(AnyTransition.opacity)
#endif
                            }
                        }
                        .animation(Animation.easeOut(duration: 0.12), value: showReactionPicker)
                    }

                    ControlButton(
                        icon: chatIcon,
                        isActive: viewModel.state.isChatOpen,
                        badge: viewModel.state.unreadChatCount > 0 ? viewModel.state.unreadChatCount : nil,
                        accessibilityLabel: "Chat"
                    ) {
                        withAnimation(.easeInOut(duration: 0.12)) {
                            viewModel.toggleChat()
                        }
                    }

                    ControlButton(
                        icon: settingsIcon,
                        isActive: false,
                        accessibilityLabel: "Settings"
                    ) {
                        onSettingsPressed()
                    }
                }

                Rectangle()
                    .fill(ACMColors.creamFaint)
                    .frame(width: 1, height: 24)
                    .padding(.horizontal, layout.separatorHorizontalPadding)
            } else {
                Text(MeetingControlsBarCopy.webinarAttendeeStatus(count: viewModel.state.webinarAttendeeCount))
                    .font(ACMFont.trial(11, weight: .medium))
                    .foregroundStyle(ACMColors.textMuted)
                    .lineLimit(1)
                    .padding(.leading, 4)
            }

            Button {
                viewModel.leaveRoom()
            } label: {
                ZStack {
                    ACMSystemIcon.icon("phone.down.fill", android: "hangup", size: 18)
#if SKIP
                    ACMAndroidSemanticText("Hang Up")
#endif
                }
                .frame(width: 44, height: 44)
            }
            .acmControlButtonStyle(isDanger: true)
            .accessibilityLabel("Hang Up")
        }
        .frame(maxWidth: layout.contentMaxWidth)
        .padding(.horizontal, layout.horizontalPadding)
        .padding(.vertical, layout.verticalPadding)
        .acmGlassCapsule()
#if SKIP
        .onChange(of: canUseParticipantActions ? "enabled" : "disabled") {
            if !canUseParticipantActions {
                showReactionPicker = false
            }
        }
        #else
        .onChange(of: canUseParticipantActions) { _, canUse in
            if !canUse {
                showReactionPicker = false
            }
        }
        #endif
    }
}

// MARK: - Control Button

struct ControlButton: View {
    let icon: String
    var isActive: Bool = false
    var isMuted: Bool = false
    var activeColor: Color = ACMColors.primaryOrange
    var isDisabledDimmed: Bool = false
    var badge: Int? = nil
    var accessibilityLabel: String? = nil
    var accessibilityHint: String? = nil
    let action: () -> Void
    
    var body: some View {
        let label = accessibilityLabel ?? icon

        Button(action: action) {
            ZStack {
                ACMSystemIcon.icon(icon, android: icon, size: 18)
                    .overlay(alignment: .topTrailing) {
                        if let badge = badge {
                            Text(badge > 9 ? "9+" : "\(badge)")
                                .font(ACMFont.trial(10, weight: .bold))
                                .foregroundStyle(Color.white)
                                .frame(minWidth: 16, minHeight: 16)
                                .acmColorBackground(ACMColors.primaryOrange)
                                .clipShape(Circle())
                                .offset(x: 10, y: -10)
                        }
                    }
#if SKIP
                ACMAndroidSemanticText(label)
#endif
            }
        }
        .acmControlButtonStyle(
            isActive: isActive,
            isMuted: isMuted,
            isDisabledDimmed: isDisabledDimmed,
            isHandRaised: isActive && activeColor == ACMColors.handRaised
        )
        .accessibilityLabel(label)
        #if !SKIP
        .accessibilityHint(accessibilityHint ?? "")
        #endif
    }
}
