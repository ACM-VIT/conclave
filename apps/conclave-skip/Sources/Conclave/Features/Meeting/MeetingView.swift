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
        // Docked panel: a fixed right dock on iPad/desktop, a full-width sheet on
        // phones (matches the web chat: `w-full sm:w-[360px]`).
        return isRegularSizeClass ? 380.0 : containerWidth
    }

    static func bottomPadding(
        inputFocused: Bool,
        safeAreaBottom: CGFloat,
        keyboardInset: CGFloat,
        isAndroid: Bool
    ) -> CGFloat {
        // The composer sits at the very bottom of the panel; only inset for the
        // home indicator / keyboard, not for the (now-covered) controls bar.
        let basePadding = max(inputFocused ? (isAndroid ? 12.0 : 20.0) : 12.0, safeAreaBottom)
        return basePadding + keyboardInset
    }

    static func maxHeight(
        for availableHeight: CGFloat,
        inputFocused: Bool,
        isAndroid: Bool
    ) -> CGFloat {
        // Full-height docked panel (top to bottom), not a floating card.
        // While typing on iOS, guarantee enough height for the header, a few
        // messages, and the composer even if the keyboard inset misreports.
        let floor = inputFocused && !isAndroid ? 220.0 : 0.0
        return max(availableHeight, floor)
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
    @State private var sheetCoordinator = MeetingSheetCoordinator()
    @State private var chatInputFocused = false
    #if canImport(UIKit) && !SKIP
    @State private var keyboardHeight: CGFloat = 0.0
    #endif

    private func updateStageObscured(sheetPresented: Bool) {
        viewModel.setStageObscuredByOverlay(
            sheetPresented
                || viewModel.state.isChatOpen
                || viewModel.state.isTranscriptOpen
        )
    }

    private func openMeetingSheet(_ page: MeetingSheetPage) {
        PerformanceDiagnostics.event("meeting_sheet_open", details: "page=\(page)")
        #if SKIP
        viewModel.setStageObscuredByOverlay(true)
        #endif
        sheetCoordinator.open(page)
    }

    private func dismissMeetingSheet() {
        guard sheetCoordinator.isPresented else { return }
        PerformanceDiagnostics.event("meeting_sheet_dismiss", details: "page=\(sheetCoordinator.page)")
        sheetCoordinator.dismiss()
        updateStageObscured(sheetPresented: false)
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
        let _ = PerformanceDiagnostics.render("MeetingView") {
            "chat=\(viewModel.state.isChatOpen) transcript=\(viewModel.state.isTranscriptOpen) participants=\(viewModel.state.participantCount)"
        }
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

                        // Cross-fade when the stage changes KIND (grid to
                        // spotlight, game takeover, share start/stop). The
                        // value scoping keeps ambient withAnimation calls and
                        // state churn from animating stage internals; tiles
                        // own their glide via ACMMotion.tileGlide.
                        meetingStage(containerSize: geometry.size)
                            .animation(ACMMotion.stageSwap, value: stageKind)

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
                    // Side insets belong to the meeting column only. When they
                    // sat on the shared ZStack, the chat dock inherited a left
                    // margin while its width math pushed the right rounded
                    // corner off-screen - the panel read as clipped.
                    .padding(.leading, max(6.0, geometry.safeAreaInsets.leading))
                    .padding(.trailing, max(6.0, geometry.safeAreaInsets.trailing))

                    if viewModel.state.isChatOpen && !viewModel.state.isWebinarAttendee {
                        // This container already sits inside the top safe area
                        // on both platforms, so only clear the in-flow meeting
                        // header (~58pt); adding the inset doubled the gap and
                        // on Android the inset read 0 and buried the header.
                        let chatTopPadding = 60.0
                        #if SKIP
                        let chatAlignment = Alignment.bottomTrailing
                        #else
                        let chatAlignment = chatInputFocused ? Alignment.bottomTrailing : Alignment.topTrailing
                        #endif
                        #if SKIP
                        let chatKeyboardInset = 0.0
                        #elseif canImport(UIKit)
                        // Clamp the tracked keyboard height: a corrupted frame
                        // (foreign overlay windows, stage manager, split view)
                        // must never crush the panel into a sliver.
                        let rawChatKeyboardInset = chatInputFocused ? max(0.0, keyboardHeight - geometry.safeAreaInsets.bottom) : 0.0
                        let chatKeyboardInset = min(rawChatKeyboardInset, geometry.size.height * 0.5)
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
                                // No computed height on Android: the panel
                                // fills whatever the Compose insets leave, so
                                // the keyboard resizes it instead of clipping
                                // the composer (Jetchat inset pattern).
                                .frame(maxHeight: .infinity)
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
                        #if SKIP
                        // navigationBars BEFORE ime: the reverse order re-adds
                        // the nav inset on top of the keyboard (the classic
                        // Compose double-padding bug).
                        .composeModifier { $0.navigationBarsPadding().imePadding() }
                        #else
                        .padding(.bottom, effectiveChatBottomPadding)
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
            }
            .ignoresSafeArea(.container, edges: .bottom)
#if !SKIP
            // A call UI never compresses for the keyboard. With this on the
            // whole meeting container, geometry.size stays full-height; the
            // two text-input hosts lift themselves instead - the chat overlay
            // via its tracked keyboardHeight inset (chatKeyboardInset above),
            // the game card via KeyboardOverlapAvoidance. Before this, typing
            // collapsed the stage and floated the controls bar over the game.
            .ignoresSafeArea(.keyboard)
#endif
            .overlay {
                MeetingSheetPresenter(
                    viewModel: viewModel,
                    coordinator: sheetCoordinator,
                    availableHeight: geometry.size.height,
                    onDismissed: {
                        updateStageObscured(sheetPresented: false)
                    }
                )
            }
            .sheet(isPresented: Binding(
                get: { viewModel.state.isTranscriptOpen },
                set: { viewModel.state.isTranscriptOpen = $0 }
            )) {
                // The transcript stream is meeting-scoped, not sheet-scoped: closing
                // the panel must not tear down a session this user may be controlling.
                // It's opened on first appear and closed on meeting teardown.
                TranscriptPanelView(viewModel: viewModel)
            }
        }
        .preferredColorScheme(.dark)
        #if SKIP
        // Use the zero-parameter onChange overload on Android. SkipUI backs
        // onChange with rememberSaveable; under the recomposition churn the
        // entry-overlay fade induces, the two-parameter form can restore a
        // null `oldValue` and crash on Kotlin's non-null param check
        // (checkNotNullParameter). The no-arg closure never receives that
        // value, so it is immune - and these handlers ignore both params.
        .onChange(of: viewModel.state.isChatOpen ? "open" : "closed") {
            if !viewModel.state.isChatOpen {
                chatInputFocused = false
            }
            updateStageObscured(sheetPresented: sheetCoordinator.isPresented)
        }
        .onChange(of: viewModel.state.isTranscriptOpen ? "open" : "closed") {
            updateStageObscured(sheetPresented: sheetCoordinator.isPresented)
        }
        .onChange(of: viewModel.state.isWebinarAttendee ? "webinar" : "meeting") {
            if viewModel.state.isWebinarAttendee {
                dismissMeetingSheet()
                chatInputFocused = false
            }
        }
        .onChange(of: viewModel.state.connectionState == .joined ? "joined" : "other") {
            updateStageObscured(sheetPresented: sheetCoordinator.isPresented)
        }
        #else
        .onChange(of: viewModel.state.isChatOpen) {
            if !viewModel.state.isChatOpen {
                chatInputFocused = false
            }
        }
        .onChange(of: viewModel.state.isWebinarAttendee) {
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

    /// Discrete stage surface identity - mirrors the meetingStage branch
    /// order. The cross-fade animation is keyed to this so it fires only on
    /// surface swaps, never on state churn inside a surface.
    private var stageKind: String {
        if viewModel.state.isWebinarAttendee {
            if viewModel.state.hasActiveScreenShare { return "webinar-present" }
            if viewModel.state.usesSpotlightLayout { return "webinar-spotlight" }
            return "webinar-waiting"
        }
        if viewModel.state.activeAppId != nil { return "app" }
        if viewModel.state.isBrowserActive { return "browser" }
        if viewModel.state.gamePublicState != nil { return "game" }
        if viewModel.state.hasActiveScreenShare { return "presentation" }
        if viewModel.state.usesSpotlightLayout { return "spotlight" }
        return "grid"
    }

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
        } else if viewModel.state.gamePublicState != nil {
            // A running game owns the stage; play is interactive and timed,
            // so it outranks a passive screen share on a phone.
            stageSwapTransition(
                GameStageLayoutView(
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

@Observable
final class MeetingSheetCoordinator {
    var isPresented = false
    var page: MeetingSheetPage = .more

    func open(_ nextPage: MeetingSheetPage) {
        page = nextPage
        isPresented = true
    }

    func dismiss() {
        guard isPresented else { return }
        isPresented = false
    }

    func resetAfterDismiss() {
        page = .more
    }
}

private struct MeetingSheetPresenter: View {
    @Bindable var viewModel: MeetingViewModel
    @Bindable var coordinator: MeetingSheetCoordinator
    let availableHeight: CGFloat
    let onDismissed: () -> Void
    @State private var pendingTranscriptOpen = false

    private var detentHeight: CGFloat {
        #if SKIP
        return availableHeight * MeetingSheetView.androidDetentFraction
        #else
        return availableHeight * MeetingSheetView.detentFraction
        #endif
    }

    private func dismissMeetingSheet() {
        guard coordinator.isPresented else { return }
        PerformanceDiagnostics.event("meeting_sheet_dismiss", details: "page=\(coordinator.page)")
        coordinator.dismiss()
        coordinator.resetAfterDismiss()
        onDismissed()
    }

    private func openTranscriptFromMeetingSheet() {
        #if SKIP
        pendingTranscriptOpen = false
        dismissMeetingSheet()
        if !viewModel.state.isTranscriptOpen {
            PerformanceDiagnostics.event("transcript_open_from_more_after_close")
            viewModel.state.isTranscriptOpen = true
        }
        #else
        pendingTranscriptOpen = true
        dismissMeetingSheet()
        #endif
    }

    var body: some View {
        #if SKIP
        ComposeView { context in
            FlexibleMeetingSheetHost(
                context: context,
                isPresented: coordinator.isPresented,
                viewModel: viewModel,
                page: $coordinator.page,
                androidDetentHeight: detentHeight,
                detentFraction: MeetingSheetView.androidDetentFraction,
                onDismiss: {
                    dismissMeetingSheet()
                },
                onOpenTranscript: {
                    openTranscriptFromMeetingSheet()
                }
            )
        }
        .frame(width: 0, height: 0)
        .onChange(of: coordinator.isPresented ? "shown" : "hidden") {
            if !coordinator.isPresented {
                coordinator.resetAfterDismiss()
                onDismissed()
            }
        }
        #else
        Color.clear
            .frame(width: 0, height: 0)
            .sheet(isPresented: $coordinator.isPresented, onDismiss: {
                if pendingTranscriptOpen {
                    pendingTranscriptOpen = false
                    viewModel.state.isTranscriptOpen = true
                }
                coordinator.resetAfterDismiss()
                onDismissed()
            }) {
                MeetingSheetView(
                    viewModel: viewModel,
                    page: $coordinator.page,
                    androidDetentHeight: detentHeight,
                    onOpenTranscript: {
                        openTranscriptFromMeetingSheet()
                    }
                )
            }
        #endif
    }
}

@ViewBuilder
private func stageSwapTransition<Content: View>(_ content: Content) -> some View {
    // SkipUI maps this to Compose fadeIn/fadeOut, so both platforms get the
    // same cross-fade, driven by the stageKind-scoped animation upstream.
    content.transition(.opacity)
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
