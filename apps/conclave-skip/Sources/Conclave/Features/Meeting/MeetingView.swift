import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif
#if SKIP
import androidx.compose.foundation.layout.__
#endif

enum MeetingChatOverlayLayout {
    static func width(
        for containerWidth: CGFloat,
        isAndroid: Bool,
        isRegularSizeClass: Bool
    ) -> CGFloat {
        if isAndroid {
            return max(0.0, containerWidth - 20.0)
        }
        return isRegularSizeClass ? 380.0 : min(340.0, containerWidth * 0.85)
    }

    static func bottomPadding(
        inputFocused: Bool,
        safeAreaBottom: CGFloat,
        keyboardInset: CGFloat,
        isAndroid: Bool
    ) -> CGFloat {
        let focusedPadding = isAndroid ? 12.0 : 20.0
        let unfocusedPadding = isAndroid ? 84.0 : 12.0
        let basePadding = max(inputFocused ? focusedPadding : unfocusedPadding, safeAreaBottom)
        return basePadding + keyboardInset
    }

    static func maxHeight(
        for availableHeight: CGFloat,
        inputFocused: Bool,
        isAndroid: Bool
    ) -> CGFloat {
        let available = max(availableHeight, 0.0)
        guard isAndroid else {
            return min(available, 560.0)
        }

        let minimumUsefulHeight = min(available, inputFocused ? 220.0 : 240.0)
        let proportionalHeight = available * (inputFocused ? 0.50 : 0.64)
        let desiredHeight = max(proportionalHeight, minimumUsefulHeight)
        let heightCap = inputFocused ? 320.0 : 400.0
        return min(min(desiredHeight, heightCap), available)
    }
}

enum MeetingKeyboardLayout {
    static func visibleHeight(keyboardMinY: CGFloat, containerMaxY: CGFloat) -> CGFloat {
        max(0.0, containerMaxY - keyboardMinY)
    }

    static func containerMaxY(activeWindowMaxY: CGFloat?, keyboardFrameMaxY: CGFloat) -> CGFloat {
        if let activeWindowMaxY, activeWindowMaxY > 0.0 {
            return activeWindowMaxY
        }
        return max(0.0, keyboardFrameMaxY)
    }

    static func shouldUpdateVisibleHeight(current: CGFloat, next: CGFloat) -> Bool {
        abs(current - next) >= 0.5
    }
}

struct MeetingView: View {
    @Bindable var viewModel: MeetingViewModel
    @State private var showMeetingSheet = false
    @State private var meetingSheetPage: MeetingSheetPage = .more
    @State private var chatInputFocused = false
    #if canImport(UIKit) && !SKIP
    @State private var keyboardHeight: CGFloat = 0.0
    #endif

    private func openMeetingSheet(_ page: MeetingSheetPage) {
        meetingSheetPage = page
        showMeetingSheet = true
    }

    private func resetMeetingSheetStateAfterDismiss() {
        meetingSheetPage = .more
    }

    private func dismissMeetingSheet() {
        guard showMeetingSheet else { return }
        showMeetingSheet = false
        resetMeetingSheetStateAfterDismiss()
    }

    private func meetingSheetDetentHeight(for availableHeight: CGFloat) -> CGFloat {
        availableHeight * MeetingSheetView.detentFraction
    }

    private func chatOverlayWidth(for width: CGFloat) -> CGFloat {
#if SKIP
        return MeetingChatOverlayLayout.width(
            for: width,
            isAndroid: true,
            isRegularSizeClass: false
        )
#else
        return MeetingChatOverlayLayout.width(
            for: width,
            isAndroid: false,
            isRegularSizeClass: isRegularSizeClass
        )
#endif
    }

    private func chatOverlayMaxHeight(for availableHeight: CGFloat, inputFocused: Bool = false) -> CGFloat {
        MeetingChatOverlayLayout.maxHeight(
            for: availableHeight,
            inputFocused: inputFocused,
            isAndroid: isAndroidChatLayout
        )
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

    private var isAndroidChatLayout: Bool {
#if SKIP
        return true
#else
        return false
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
                            participantCount: viewModel.state.participantCount,
                            showsParticipantsButton: !viewModel.state.isWebinarAttendee,
                            onParticipantsPressed: { openMeetingSheet(.participants) }
                        )

                        MeetingBannerOverlay(
                            viewModel: viewModel,
                            onShowParticipants: { openMeetingSheet(.participants) }
                        )

                        meetingStage(containerSize: geometry.size)
                        #if !SKIP
                            .transaction { transaction in
                                transaction.animation = nil
                            }
                        #endif

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
                        #if SKIP
                        let chatTopPadding = max(12.0, geometry.safeAreaInsets.top + 8.0)
                        #else
                        let chatTopPadding = max(78.0, geometry.safeAreaInsets.top + 48.0)
                        #endif
                        #if SKIP
                        let chatAlignment = Alignment.bottomTrailing
                        #else
                        let chatAlignment = chatInputFocused ? Alignment.bottomTrailing : Alignment.topTrailing
                        #endif
                        #if SKIP
                        let chatKeyboardInset = 0.0
                        #elseif canImport(UIKit)
                        let chatKeyboardInset = chatInputFocused ? max(0.0, keyboardHeight - geometry.safeAreaInsets.bottom) : 0.0
                        #else
                        let chatKeyboardInset = 0.0
                        #endif
                        let effectiveChatBottomPadding = MeetingChatOverlayLayout.bottomPadding(
                            inputFocused: chatInputFocused,
                            safeAreaBottom: geometry.safeAreaInsets.bottom,
                            keyboardInset: chatKeyboardInset,
                            isAndroid: isAndroidChatLayout
                        )
                        let chatMaxHeight = chatOverlayMaxHeight(
                            for: geometry.size.height - chatTopPadding - effectiveChatBottomPadding,
                            inputFocused: chatInputFocused
                        )

                        HStack {
                            Spacer()

                            ChatOverlayView(
                                viewModel: viewModel,
                                onFocusChanged: { focused in
                                    chatInputFocused = focused
                                }
                            )
                                .frame(width: chatOverlayWidth(for: geometry.size.width))
                                #if SKIP
                                .frame(height: chatMaxHeight, alignment: .bottom)
                                #else
                                .frame(height: chatMaxHeight)
                                #endif
                                .transition(AnyTransition.move(edge: Edge.trailing).combined(with: AnyTransition.opacity))
                        }
                        #if SKIP
                        .frame(
                            maxWidth: .infinity,
                            maxHeight: .infinity,
                            alignment: chatAlignment
                        )
                        #else
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: chatAlignment)
                        #endif
                        .padding(.top, chatTopPadding)
                        .padding(.bottom, effectiveChatBottomPadding)
                        #if SKIP
                        .composeModifier { $0.imePadding().navigationBarsPadding() }
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
        #if SKIP
        .onChange(of: viewModel.state.isChatOpen ? "open" : "closed") { _, _ in
            if !viewModel.state.isChatOpen {
                chatInputFocused = false
            }
        }
        .onChange(of: showMeetingSheet ? "shown" : "hidden") { _, _ in
            if !showMeetingSheet {
                resetMeetingSheetStateAfterDismiss()
            }
        }
        .onChange(of: viewModel.state.isWebinarAttendee ? "webinar" : "meeting") { _, _ in
            if viewModel.state.isWebinarAttendee {
                dismissMeetingSheet()
                chatInputFocused = false
            }
        }
        #else
        .onChange(of: viewModel.state.isChatOpen) { _, _ in
            if !viewModel.state.isChatOpen {
                chatInputFocused = false
            }
        }
        .onChange(of: showMeetingSheet) { _, _ in
            if !showMeetingSheet {
                resetMeetingSheetStateAfterDismiss()
            }
        }
        .onChange(of: viewModel.state.isWebinarAttendee) { _, _ in
            if viewModel.state.isWebinarAttendee {
                dismissMeetingSheet()
                chatInputFocused = false
            }
        }
        #endif
        #if canImport(UIKit) && !SKIP
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { notification in
            let nextHeight = keyboardVisibleHeight(from: notification)
            guard MeetingKeyboardLayout.shouldUpdateVisibleHeight(current: keyboardHeight, next: nextHeight) else {
                return
            }
            withAnimation(.easeInOut(duration: 0.16)) {
                keyboardHeight = nextHeight
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            guard MeetingKeyboardLayout.shouldUpdateVisibleHeight(current: keyboardHeight, next: 0.0) else {
                return
            }
            withAnimation(.easeInOut(duration: 0.16)) {
                keyboardHeight = 0.0
            }
        }
        #endif
    }

    #if canImport(UIKit) && !SKIP
    private func keyboardVisibleHeight(from notification: Notification) -> CGFloat {
        guard let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else {
            return 0.0
        }
        let containerMaxY = MeetingKeyboardLayout.containerMaxY(
            activeWindowMaxY: activeWindowMaxY(),
            keyboardFrameMaxY: frame.maxY
        )
        return MeetingKeyboardLayout.visibleHeight(
            keyboardMinY: frame.minY,
            containerMaxY: containerMaxY
        )
    }

    private func activeWindowMaxY() -> CGFloat? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        return windows.first(where: \.isKeyWindow)?.frame.maxY
            ?? windows.first(where: { !$0.isHidden })?.frame.maxY
    }
    #endif

    @ViewBuilder
    private func meetingStage(containerSize: CGSize) -> some View {
        if viewModel.state.isWebinarAttendee {
            if viewModel.state.hasActiveScreenShare {
                stageSwapTransition(
                    PresentationLayoutView(
                        viewModel: viewModel,
                        isCompact: !isRegularSizeClass,
                        containerSize: containerSize
                    )
                )
            } else if viewModel.state.usesSpotlightLayout {
                stageSwapTransition(
                    SpotlightLayoutView(
                        viewModel: viewModel,
                        isCompact: !isRegularSizeClass,
                        containerSize: containerSize
                    )
                )
            } else {
                stageSwapTransition(WebinarWaitingView())
            }
        } else if viewModel.state.activeAppId != nil {
            stageSwapTransition(
                ActiveAppLayoutView(
                    viewModel: viewModel,
                    isCompact: !isRegularSizeClass
                )
            )
        } else if viewModel.state.isBrowserActive {
            stageSwapTransition(
                SharedBrowserLayoutView(
                    viewModel: viewModel,
                    isCompact: !isRegularSizeClass
                )
            )
        } else if viewModel.state.hasActiveScreenShare {
            stageSwapTransition(
                PresentationLayoutView(
                    viewModel: viewModel,
                    isCompact: !isRegularSizeClass,
                    containerSize: containerSize
                )
            )
        } else if viewModel.state.usesSpotlightLayout {
            stageSwapTransition(
                SpotlightLayoutView(
                    viewModel: viewModel,
                    isCompact: !isRegularSizeClass,
                    containerSize: containerSize
                )
            )
        } else {
            stageSwapTransition(GridLayoutView(viewModel: viewModel, isCompact: !isRegularSizeClass))
        }
    }
}

@ViewBuilder
private func stageSwapTransition<Content: View>(_ content: Content) -> some View {
    #if SKIP
    content
    #else
    content.transition(.opacity)
    #endif
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
