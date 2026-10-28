import SwiftUI
import Observation
#if SKIP
import androidx.compose.foundation.layout.__
#endif

enum MeetingChatOverlayLayout {
    static func width(
        for containerWidth: CGFloat,
        isAndroid: Bool,
        isRegularSizeClass: Bool
    ) -> CGFloat {

        return isRegularSizeClass ? 380.0 : containerWidth
    }

    static func bottomPadding(
        inputFocused: Bool,
        safeAreaBottom: CGFloat,
        keyboardInset: CGFloat,
        isAndroid: Bool
    ) -> CGFloat {

        let basePadding = max(inputFocused ? (isAndroid ? 12.0 : 20.0) : 12.0, safeAreaBottom)
        return basePadding + keyboardInset
    }

    static func maxHeight(
        for availableHeight: CGFloat,
        inputFocused: Bool,
        isAndroid: Bool
    ) -> CGFloat {

        let floor = inputFocused && !isAndroid ? 220.0 : 0.0
        return max(availableHeight, floor)
    }
}

struct MeetingView: View {
    @Bindable var viewModel: MeetingViewModel
    @State private var sheetCoordinator = MeetingSheetCoordinator()
    @State private var chatInputFocused = false

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

                        meetingStage(containerSize: geometry.size)
                            .animation(ACMMotion.stageSwap, value: stageKind)

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

                    .padding(.leading, geometry.safeAreaInsets.leading)
                    .padding(.trailing, geometry.safeAreaInsets.trailing)

                    MeetingBannerOverlay(
                        viewModel: viewModel,
                        onShowParticipants: { openMeetingSheet(.participants) }
                    )
                    .padding(.top, MeetingHeaderLayout.barHeight)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)

                    if viewModel.state.isChatOpen && !viewModel.state.isWebinarAttendee {

                        let chatTopPadding = 60.0

                        let chatAlignment = Alignment.topTrailing
                        let chatKeyboardInset = 0.0

                        let chatSafeAreaBottom = chatInputFocused && !isAndroidChatLayout
                            ? 0.0
                            : geometry.safeAreaInsets.bottom
                        let effectiveChatBottomPadding = MeetingChatOverlayLayout.bottomPadding(
                            inputFocused: chatInputFocused,
                            safeAreaBottom: chatSafeAreaBottom,
                            keyboardInset: chatKeyboardInset,
                            isAndroid: isAndroidChatLayout
                        )

                        let chatMaxHeight = chatOverlayMaxHeight(
                            for: geometry.size.height - chatTopPadding,
                            inputFocused: chatInputFocused
                        )

                        HStack(spacing: 0) {
                            Spacer(minLength: 0)

                            ChatOverlayView(
                                viewModel: viewModel,
                                bottomContentInset: isAndroidChatLayout ? 0.0 : effectiveChatBottomPadding,
                                onFocusChanged: { focused in
                                    chatInputFocused = focused
                                }
                            )
                            .frame(width: chatOverlayWidth(for: geometry.size.width))
                            #if SKIP

                            .frame(maxHeight: .infinity)
                            #else
                            .frame(height: chatMaxHeight)
                            #endif
                            .transition(AnyTransition.move(edge: Edge.trailing).combined(with: AnyTransition.opacity))
                        }
                        .frame(
                            maxWidth: .infinity,
                            maxHeight: .infinity,
                            alignment: chatAlignment
                        )
                        .padding(.top, chatTopPadding)
                        #if SKIP

                        .composeModifier { $0.navigationBarsPadding().imePadding() }
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

                    MeetingReactionOverlayLayer(viewModel: viewModel)
                }
            }
            .ignoresSafeArea(.container, edges: .bottom)
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

                TranscriptPanelView(viewModel: viewModel)
            }
        }
        #if canImport(UIKit) && !SKIP
        .modifier(MeetingKeyboardSafeAreaPolicy(
            allowsSystemAvoidance: viewModel.state.isChatOpen
        ))
        #endif
        .preferredColorScheme(.dark)
        #if SKIP

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
    }

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

private struct MeetingReactionOverlayLayer: View {
    @Bindable var viewModel: MeetingViewModel

    @ViewBuilder
    var body: some View {
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

#if canImport(UIKit) && !SKIP

private struct MeetingKeyboardSafeAreaPolicy: ViewModifier {
    let allowsSystemAvoidance: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if allowsSystemAvoidance {
            content
        } else {
            content.ignoresSafeArea(.keyboard, edges: .bottom)
        }
    }
}
#endif

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
