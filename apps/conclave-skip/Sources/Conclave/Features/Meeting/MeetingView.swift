//
//  MeetingView.swift
//  Conclave
//
//  Main meeting view matching web app exactly
//

import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

struct MeetingView: View {
    @Bindable var viewModel: MeetingViewModel
    // One bottom sheet for More / Participants / Settings, switched by page. A
    // single persistent sheet that swaps content in place avoids the old
    // dismiss-then-represent chain (which left a blank gap between two Material
    // sheet animations on Android).
    @State var showMeetingSheet = false
    @State var meetingSheetPage: MeetingSheetPage = .more

    private func openMeetingSheet(_ page: MeetingSheetPage) {
        meetingSheetPage = page
        showMeetingSheet = true
    }

#if !os(macOS) && !SKIP
    @Environment(\.horizontalSizeClass) var horizontalSizeClass
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
                            participantCount: viewModel.state.participantCount,
                            onParticipantsPressed: { openMeetingSheet(.participants) }
                        )

                        // Reconnecting status, ambient pending-join host cue, and
                        // transient recoverable errors (previously written to
                        // state but read by no view while joined).
                        MeetingBannerOverlay(
                            viewModel: viewModel,
                            onShowParticipants: { openMeetingSheet(.participants) }
                        )

                        if viewModel.state.hasActiveScreenShare {
                            PresentationLayoutView(
                                viewModel: viewModel,
                                isCompact: !isRegularSizeClass,
                                containerSize: geometry.size
                            )
                            .transition(.opacity)
                        } else if viewModel.state.pinnedUserId != nil {
                            SpotlightLayoutView(
                                viewModel: viewModel,
                                isCompact: !isRegularSizeClass,
                                containerSize: geometry.size
                            )
                            .transition(.opacity)
                        } else {
                            GridLayoutView(viewModel: viewModel, isCompact: !isRegularSizeClass)
                                .transition(.opacity)
                        }

                        // Controls bar lives in the main column (NOT a full-height
                        // bottom-anchored overlay): on Android that overlay made
                        // Skip ghost the bar's ComposeView icons at the top of the
                        // stage. In-flow at the bottom, it renders once, cleanly.
                        ControlsBarView(
                            viewModel: viewModel,
                            availableWidth: geometry.size.width - geometry.safeAreaInsets.leading - geometry.safeAreaInsets.trailing,
                            onParticipantsPressed: { openMeetingSheet(.participants) },
                            onSettingsPressed: { openMeetingSheet(.settings) },
                            onMorePressed: { openMeetingSheet(.more) }
                        )
                        .padding(.top, 8)
                        .padding(.bottom, max(12.0, geometry.safeAreaInsets.bottom))
                    }

                    if viewModel.state.isChatOpen {
                        HStack {
                            Spacer()

                            ChatOverlayView(viewModel: viewModel)
                                .frame(width: isRegularSizeClass ? 380.0 : min(340.0, geometry.size.width * 0.85))
                                .transition(.move(edge: .trailing).combined(with: AnyTransition.opacity))
                        }
                    }

                    ReactionOverlayView(reactions: viewModel.state.activeReactions)
                }
                .padding(.leading, max(6.0, geometry.safeAreaInsets.leading))
                .padding(.trailing, max(6.0, geometry.safeAreaInsets.trailing))
            }
            .ignoresSafeArea(.container, edges: .bottom)
        }
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showMeetingSheet) {
            MeetingSheetView(viewModel: viewModel, page: $meetingSheetPage)
        }
        .animation(.easeInOut(duration: 0.25), value: viewModel.state.isChatOpen)
        .animation(.easeInOut(duration: 0.2), value: viewModel.state.pinnedUserId)
        // Grid ↔ screen-share presentation crossfades like grid ↔ spotlight.
        .animation(.easeInOut(duration: 0.25), value: viewModel.state.hasActiveScreenShare)
    }
}

#Preview {
    MeetingView(viewModel: MeetingViewModel())
}
