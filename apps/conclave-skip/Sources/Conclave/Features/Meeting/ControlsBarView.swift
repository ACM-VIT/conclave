import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

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
        // iOS = SF Symbol; Android (#if SKIP) = a semantic key the Kotlin
        // meetingIconVector maps to a real material-icons-extended glyph.
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
        let mediaPublishingDisabled = viewModel.state.mediaPublishingDisabled
        let isWebinarAttendee = viewModel.state.isWebinarAttendee
        let isScreenShareDisabled = mediaPublishingDisabled ||
            (viewModel.state.activeScreenShareUserId != nil && !viewModel.state.isScreenSharing)

        HStack(spacing: isCompact ? 12.0 : 4.0) {
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
                    isGhostDisabled: mediaPublishingDisabled,
                    accessibilityLabel: viewModel.state.isMuted ? "Unmute microphone" : "Mute microphone"
                ) {
                    viewModel.toggleMute()
                }
                .disabled(mediaPublishingDisabled)

                ControlButton(
                    icon: cameraIcon,
                    isMuted: viewModel.state.isCameraOff,
                    isGhostDisabled: mediaPublishingDisabled,
                    accessibilityLabel: viewModel.state.isCameraOff ? "Turn camera on" : "Turn camera off"
                ) {
                    viewModel.toggleCamera()
                }
                .disabled(mediaPublishingDisabled)

                if viewModel.state.isScreenShareSupported {
                    ControlButton(
                        icon: screenShareIcon,
                        isActive: viewModel.state.isScreenSharing,
                        isGhostDisabled: isScreenShareDisabled,
                        accessibilityLabel: viewModel.state.isScreenSharing ? "Stop screen sharing" : "Share screen"
                    ) {
                        viewModel.toggleScreenShare()
                    }
                    .disabled(isScreenShareDisabled)
                }

                if isCompact {
                    ControlButton(
                        icon: moreIcon,
                        isActive: false,
                        badge: viewModel.state.unreadChatCount > 0 ? viewModel.state.unreadChatCount : nil,
                        accessibilityLabel: "More controls"
                    ) {
                        onMorePressed()
                    }
                } else {
                    ControlButton(
                        icon: handRaiseIcon,
                        isActive: viewModel.state.isHandRaised,
                        activeColor: ACMColors.handRaised,
                        isGhostDisabled: viewModel.state.isGhostMode,
                        accessibilityLabel: viewModel.state.isHandRaised ? "Lower hand" : "Raise hand"
                    ) {
                        viewModel.toggleHandRaise()
                    }
                    .disabled(viewModel.state.isGhostMode)

                    ControlButton(
                        icon: reactionIcon,
                        isActive: showReactionPicker,
                        isGhostDisabled: viewModel.state.isGhostMode,
                        accessibilityLabel: "Reactions"
                    ) {
                        showReactionPicker = !showReactionPicker
                    }
                    .disabled(viewModel.state.isGhostMode)
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

                    ControlButton(
                        icon: chatIcon,
                        isActive: viewModel.state.isChatOpen,
                        badge: viewModel.state.unreadChatCount > 0 ? viewModel.state.unreadChatCount : nil,
                        accessibilityLabel: "Chat"
                    ) {
                        viewModel.toggleChat()
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
                    .padding(.horizontal, isCompact ? 2.0 : 4.0)
            } else {
                Text("\(viewModel.state.webinarAttendeeCount) watching")
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
        .frame(maxWidth: isCompact ? min(360.0, availableWidth - 24.0) : availableWidth - 24.0)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .acmGlassCapsule()
    }
}

// MARK: - Control Button

struct ControlButton: View {
    let icon: String
    var isActive: Bool = false
    var isMuted: Bool = false
    var activeColor: Color = ACMColors.primaryOrange
    var isGhostDisabled: Bool = false
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
            isGhostDisabled: isGhostDisabled,
            isHandRaised: isActive && activeColor == ACMColors.handRaised
        )
        .accessibilityLabel(label)
        #if !SKIP
        .accessibilityHint(accessibilityHint ?? "")
        #endif
    }
}
