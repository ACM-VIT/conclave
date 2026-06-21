import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif
#if SKIP
import androidx.compose.foundation.layout.__
#endif

struct MeetingView: View {
    @Bindable var viewModel: MeetingViewModel
    @State private var showMeetingSheet = false
    @State private var meetingSheetPage: MeetingSheetPage = .more

    private func openMeetingSheet(_ page: MeetingSheetPage) {
        meetingSheetPage = page
        showMeetingSheet = true
    }

    private func meetingSheetDetentHeight(for availableHeight: CGFloat) -> CGFloat {
        availableHeight * MeetingSheetView.detentFraction
    }

    private func chatOverlayWidth(for width: CGFloat) -> CGFloat {
        isRegularSizeClass ? 380.0 : min(340.0, width * 0.85)
    }

    private func chatOverlayMaxHeight(for height: CGFloat) -> CGFloat {
        min(560.0, max(280.0, height - 88.0))
    }

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
        GeometryReader { geometry in
            ZStack {
                ACMColors.dark
                    .ignoresSafeArea()

                ZStack {
                    VStack(spacing: 0) {
                        MeetingHeaderView(
                            roomId: viewModel.state.roomId,
                            isRoomLocked: viewModel.state.isRoomLocked,
                            connectionQuality: viewModel.state.connectionQuality,
                            participantCount: viewModel.state.participantCount,
                            showsParticipantsButton: !viewModel.state.isWebinarAttendee,
                            onParticipantsPressed: { openMeetingSheet(.participants) }
                        )

                        MeetingBannerOverlay(
                            viewModel: viewModel,
                            onShowParticipants: { openMeetingSheet(.participants) }
                        )

                        meetingStage(containerSize: geometry.size)

                        // Keep this in-flow. On Android, a bottom overlay can
                        // duplicate Skip's Compose-backed icons at the stage top.
                        ControlsBarView(
                            viewModel: viewModel,
                            availableWidth: geometry.size.width - geometry.safeAreaInsets.leading - geometry.safeAreaInsets.trailing,
                            onParticipantsPressed: {
                                if !viewModel.state.isWebinarAttendee {
                                    openMeetingSheet(.participants)
                                }
                            },
                            onSettingsPressed: {
                                if !viewModel.state.isWebinarAttendee {
                                    openMeetingSheet(.settings)
                                }
                            },
                            onMorePressed: {
                                if !viewModel.state.isWebinarAttendee {
                                    openMeetingSheet(.more)
                                }
                            }
                        )
                        .padding(.top, 8)
                        .padding(.bottom, max(12.0, geometry.safeAreaInsets.bottom))
                    }

                    if viewModel.state.isChatOpen && !viewModel.state.isWebinarAttendee {
                        HStack {
                            Spacer()

                            ChatOverlayView(viewModel: viewModel)
                                .frame(width: chatOverlayWidth(for: geometry.size.width))
                                .frame(maxHeight: chatOverlayMaxHeight(for: geometry.size.height))
                                .transition(AnyTransition.move(edge: Edge.trailing).combined(with: AnyTransition.opacity))
                        }
                        #if SKIP
                        .composeModifier { $0.imePadding() }
                        #endif
                    }

                    if !viewModel.state.isChatOpen &&
                        !viewModel.state.isWebinarAttendee &&
                        !viewModel.state.chatOverlayMessages.isEmpty {
                        VStack {
                            Spacer()

                            HStack {
                                ChatPreviewOverlayView(
                                    messages: viewModel.state.chatOverlayMessages,
                                    onDismiss: { id in
                                        viewModel.dismissChatOverlayMessage(id: id)
                                    }
                                )
                                .frame(maxWidth: isRegularSizeClass ? 360.0 : min(340.0, geometry.size.width - 32.0))

                                Spacer()
                            }
                            .padding(.leading, 16)
                            .padding(.bottom, max(84.0, geometry.safeAreaInsets.bottom + 76.0))
                        }
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                    }

                    if !viewModel.state.isWebinarAttendee {
                        ReactionOverlayView(
                            reactions: viewModel.state.activeReactions,
                            displayNameForUser: { userId in
                                viewModel.displayNameForUser(userId)
                            }
                        )
                    }
                }
                .padding(.leading, max(6.0, geometry.safeAreaInsets.leading))
                .padding(.trailing, max(6.0, geometry.safeAreaInsets.trailing))
            }
            .ignoresSafeArea(.container, edges: .bottom)
            .sheet(isPresented: $showMeetingSheet) {
                MeetingSheetView(
                    viewModel: viewModel,
                    page: $meetingSheetPage,
                    androidDetentHeight: meetingSheetDetentHeight(for: geometry.size.height)
                )
            }
        }
        .preferredColorScheme(.dark)
        .animation(.easeInOut(duration: 0.12), value: viewModel.state.isChatOpen)
        .animation(.easeInOut(duration: 0.12), value: viewModel.state.pinnedUserId)
        .animation(.easeInOut(duration: 0.12), value: viewModel.state.viewMode)
        .animation(.easeInOut(duration: 0.12), value: viewModel.state.hasActiveScreenShare)
        .animation(.easeInOut(duration: 0.12), value: viewModel.state.activeAppId)
        .animation(.easeInOut(duration: 0.12), value: viewModel.state.isBrowserActive)
    }

    @ViewBuilder
    private func meetingStage(containerSize: CGSize) -> some View {
        if viewModel.state.isWebinarAttendee {
            if viewModel.state.hasActiveScreenShare {
                PresentationLayoutView(
                    viewModel: viewModel,
                    isCompact: !isRegularSizeClass,
                    containerSize: containerSize
                )
                .transition(.opacity)
            } else if viewModel.state.usesSpotlightLayout {
                SpotlightLayoutView(
                    viewModel: viewModel,
                    isCompact: !isRegularSizeClass,
                    containerSize: containerSize
                )
                .transition(.opacity)
            } else {
                WebinarWaitingView()
                    .transition(.opacity)
            }
        } else if viewModel.state.activeAppId != nil {
            ActiveAppLayoutView(
                viewModel: viewModel,
                isCompact: !isRegularSizeClass
            )
            .transition(.opacity)
        } else if viewModel.state.isBrowserActive {
            SharedBrowserLayoutView(
                viewModel: viewModel,
                isCompact: !isRegularSizeClass
            )
            .transition(.opacity)
        } else if viewModel.state.hasActiveScreenShare {
            PresentationLayoutView(
                viewModel: viewModel,
                isCompact: !isRegularSizeClass,
                containerSize: containerSize
            )
            .transition(.opacity)
        } else if viewModel.state.usesSpotlightLayout {
            SpotlightLayoutView(
                viewModel: viewModel,
                isCompact: !isRegularSizeClass,
                containerSize: containerSize
            )
            .transition(.opacity)
        } else {
            GridLayoutView(viewModel: viewModel, isCompact: !isRegularSizeClass)
                .transition(.opacity)
        }
    }
}

private struct WebinarWaitingView: View {
    var body: some View {
        ZStack {
            ACMColors.dark

            Text("Waiting for the host to start speaking...")
                .font(ACMFont.trial(14, weight: .medium))
                .foregroundStyle(ACMColors.text)
                .multilineTextAlignment(.center)
                .padding(.horizontal, ACMSpacing.lg)
                .padding(.vertical, ACMSpacing.md)
                .acmColorBackground(ACMColors.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

#Preview {
    MeetingView(viewModel: MeetingViewModel())
}
