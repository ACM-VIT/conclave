//
//  MeetingSheetView.swift
//  Conclave
//
//  A single bottom sheet that swaps its content in place (More / Participants /
//  Settings) instead of dismissing one sheet and presenting another. On Skip
//  every `.sheet` is a native Material `ModalBottomSheet`; presenting a second
//  sheet only after the first finishes dismissing (the old `onDismiss` chain)
//  produced a visible ~half-second blank gap between two animations. Swapping
//  content inside one persistent sheet removes that presentation gap while the
//  page content handles its own push/pop transition.
//

import SwiftUI
import Observation

enum MeetingSheetPage: Equatable {
    case more
    case participants
    case settings
    case viewSettings
    case viewModeSettings
    case gridSettings
    case selfViewSettings
    case selfViewPositionSettings
    case adminControls
    case adminAccessControls
    case adminMediaControls
    case adminNoticeControls
    case adminDangerControls
    case sharedBrowser
    case apps
    case roomSettings
    case roomAccessSettings
    case roomCommunicationSettings
    case meetingInviteCodeSettings
    case webinarSettings
    case webinarAccessSettings
    case webinarCapacitySettings
    case webinarInviteCodeSettings
    case webinarLinkSettings
    case profileSettings
    case audioVideoSettings
    case microphoneSettings
    case cameraSettings
    case speakerSettings
}

private extension MeetingSheetPage {
    var depth: Int {
        switch self {
        case .more:
            return 0
        case .participants, .settings, .viewSettings, .adminControls, .sharedBrowser, .apps:
            return 1
        case .viewModeSettings, .gridSettings, .selfViewSettings, .selfViewPositionSettings,
             .adminAccessControls, .adminMediaControls, .adminNoticeControls, .adminDangerControls,
             .roomSettings, .webinarSettings, .profileSettings, .audioVideoSettings:
            return 2
        case .roomAccessSettings, .roomCommunicationSettings, .meetingInviteCodeSettings,
             .webinarAccessSettings, .webinarCapacitySettings, .webinarInviteCodeSettings, .webinarLinkSettings,
             .microphoneSettings, .cameraSettings, .speakerSettings:
            return 3
        }
    }

    var parent: MeetingSheetPage? {
        switch self {
        case .more:
            return nil
        case .participants, .settings, .viewSettings, .adminControls, .sharedBrowser, .apps:
            return .more
        case .viewModeSettings, .gridSettings, .selfViewSettings, .selfViewPositionSettings:
            return .viewSettings
        case .adminAccessControls, .adminMediaControls, .adminNoticeControls, .adminDangerControls:
            return .adminControls
        case .roomSettings, .webinarSettings, .profileSettings, .audioVideoSettings:
            return .settings
        case .roomAccessSettings, .roomCommunicationSettings, .meetingInviteCodeSettings:
            return .roomSettings
        case .webinarAccessSettings, .webinarCapacitySettings, .webinarInviteCodeSettings, .webinarLinkSettings:
            return .webinarSettings
        case .microphoneSettings, .cameraSettings, .speakerSettings:
            return .audioVideoSettings
        }
    }
}

private enum MeetingSheetNavigationDirection {
    case push
    case pop

    var transition: AnyTransition {
        switch self {
        case .push:
            return .asymmetric(
                insertion: .move(edge: .trailing),
                removal: .move(edge: .leading)
            )
        case .pop:
            return .asymmetric(
                insertion: .move(edge: .leading),
                removal: .move(edge: .trailing)
            )
        }
    }
}

struct MeetingSheetView: View {
    @Bindable var viewModel: MeetingViewModel
    @Binding var page: MeetingSheetPage
    var androidDetentHeight: CGFloat? = nil
    @State private var navigationDirection: MeetingSheetNavigationDirection = .push
    @State private var pageTransitionsEnabled = false
    // Defer the heavy sheet BODY (icon rows / bordered cards) until just after the
    // open slide settles, so the Material ModalBottomSheet's open animation isn't
    // blocked by first-frame composition (the cheap header still shows during the
    // slide). Drag-to-close stays smooth because the body is already composed.
    @State private var bodyReady = false
    @State private var bodyRevealGeneration = 0

    static let detentFraction: CGFloat = 0.62
    private static let fallbackAndroidDetentHeight: CGFloat = 420.0
    private static let pageAnimation = Animation.easeInOut(duration: 0.18)

    private var resolvedAndroidDetentHeight: CGFloat {
        max(1.0, androidDetentHeight ?? Self.fallbackAndroidDetentHeight)
    }

    private func navigate(to nextPage: MeetingSheetPage) {
        guard page != nextPage else { return }

        navigationDirection = nextPage.depth <= page.depth ? .pop : .push
        guard pageTransitionsEnabled else {
            page = nextPage
            return
        }

        withAnimation(Self.pageAnimation) {
            page = nextPage
        }
    }

    @ViewBuilder
    private func pageView<Content: View>(_ content: Content) -> some View {
        if pageTransitionsEnabled {
            content.transition(navigationDirection.transition)
        } else {
            content
        }
    }

    var body: some View {
        ACMGlassGroup(spacing: ACMSpacing.md) {
            ZStack(alignment: .top) {
                switch page {
                case .more:
                    pageView(
                        MoreSheetView(
                            viewModel: viewModel,
                            bodyReady: bodyReady,
                            onOpenViewSettings: { navigate(to: .viewSettings) },
                            onOpenSettings: { navigate(to: .settings) },
                            onOpenParticipants: { navigate(to: .participants) },
                            onOpenAdminControls: { navigate(to: .adminControls) },
                            onOpenSharedBrowser: { navigate(to: .sharedBrowser) },
                            onOpenApps: { navigate(to: .apps) }
                        )
                    )
                case .participants:
                    pageView(ParticipantsSheetView(viewModel: viewModel, bodyReady: bodyReady, onBack: { navigate(to: .more) }))
                case .settings:
                    pageView(SettingsSheetView(
                        viewModel: viewModel,
                        bodyReady: bodyReady,
                        page: SettingsSheetPage.overview,
                        onBack: { navigate(to: .more) },
                        onOpenRoomSettings: { navigate(to: .roomSettings) },
                        onOpenWebinarSettings: { navigate(to: .webinarSettings) },
                        onOpenProfileSettings: { navigate(to: .profileSettings) },
                        onOpenAudioVideoSettings: { navigate(to: .audioVideoSettings) }
                    ))
                case .viewSettings:
                    pageView(ViewSettingsSheetView(
                        viewModel: viewModel,
                        bodyReady: bodyReady,
                        page: ViewSettingsSheetPage.overview,
                        onBack: { navigate(to: .more) },
                        onOpenViewModeSettings: { navigate(to: .viewModeSettings) },
                        onOpenGridSettings: { navigate(to: .gridSettings) },
                        onOpenSelfViewSettings: { navigate(to: .selfViewSettings) },
                        onOpenSelfViewPositionSettings: { navigate(to: .selfViewPositionSettings) }
                    ))
                case .viewModeSettings:
                    pageView(ViewSettingsSheetView(viewModel: viewModel, bodyReady: bodyReady, page: ViewSettingsSheetPage.viewMode, onBack: { navigate(to: .viewSettings) }))
                case .gridSettings:
                    pageView(ViewSettingsSheetView(viewModel: viewModel, bodyReady: bodyReady, page: ViewSettingsSheetPage.grid, onBack: { navigate(to: .viewSettings) }))
                case .selfViewSettings:
                    pageView(ViewSettingsSheetView(viewModel: viewModel, bodyReady: bodyReady, page: ViewSettingsSheetPage.selfView, onBack: { navigate(to: .viewSettings) }))
                case .selfViewPositionSettings:
                    pageView(ViewSettingsSheetView(viewModel: viewModel, bodyReady: bodyReady, page: ViewSettingsSheetPage.selfViewPosition, onBack: { navigate(to: .viewSettings) }))
                case .adminControls:
                    pageView(AdminControlsSheetView(
                        viewModel: viewModel,
                        bodyReady: bodyReady,
                        page: AdminControlsSheetPage.overview,
                        onBack: { navigate(to: .more) },
                        onOpenAdminAccessControls: { navigate(to: .adminAccessControls) },
                        onOpenAdminMediaControls: { navigate(to: .adminMediaControls) },
                        onOpenAdminNoticeControls: { navigate(to: .adminNoticeControls) },
                        onOpenAdminDangerControls: { navigate(to: .adminDangerControls) }
                    ))
                case .adminAccessControls:
                    pageView(AdminControlsSheetView(viewModel: viewModel, bodyReady: bodyReady, page: AdminControlsSheetPage.access, onBack: { navigate(to: .adminControls) }))
                case .adminMediaControls:
                    pageView(AdminControlsSheetView(viewModel: viewModel, bodyReady: bodyReady, page: AdminControlsSheetPage.participantMedia, onBack: { navigate(to: .adminControls) }))
                case .adminNoticeControls:
                    pageView(AdminControlsSheetView(viewModel: viewModel, bodyReady: bodyReady, page: AdminControlsSheetPage.notice, onBack: { navigate(to: .adminControls) }))
                case .adminDangerControls:
                    pageView(AdminControlsSheetView(viewModel: viewModel, bodyReady: bodyReady, page: AdminControlsSheetPage.danger, onBack: { navigate(to: .adminControls) }))
                case .sharedBrowser:
                    pageView(SharedBrowserSheetView(viewModel: viewModel, bodyReady: bodyReady, onBack: { navigate(to: .more) }))
                case .apps:
                    pageView(AppsSheetView(viewModel: viewModel, bodyReady: bodyReady, onBack: { navigate(to: .more) }))
                case .roomSettings:
                    pageView(SettingsSheetView(
                        viewModel: viewModel,
                        bodyReady: bodyReady,
                        page: SettingsSheetPage.room,
                        onBack: { navigate(to: .settings) },
                        onOpenRoomAccessSettings: { navigate(to: .roomAccessSettings) },
                        onOpenRoomCommunicationSettings: { navigate(to: .roomCommunicationSettings) },
                        onOpenMeetingInviteCodeSettings: { navigate(to: .meetingInviteCodeSettings) }
                    ))
                case .roomAccessSettings:
                    pageView(SettingsSheetView(viewModel: viewModel, bodyReady: bodyReady, page: SettingsSheetPage.roomAccess, onBack: { navigate(to: .roomSettings) }))
                case .roomCommunicationSettings:
                    pageView(SettingsSheetView(viewModel: viewModel, bodyReady: bodyReady, page: SettingsSheetPage.roomCommunication, onBack: { navigate(to: .roomSettings) }))
                case .meetingInviteCodeSettings:
                    pageView(SettingsSheetView(viewModel: viewModel, bodyReady: bodyReady, page: SettingsSheetPage.meetingInviteCode, onBack: { navigate(to: .roomSettings) }))
                case .webinarSettings:
                    pageView(SettingsSheetView(
                        viewModel: viewModel,
                        bodyReady: bodyReady,
                        page: SettingsSheetPage.webinar,
                        onBack: { navigate(to: .settings) },
                        onOpenWebinarAccessSettings: { navigate(to: .webinarAccessSettings) },
                        onOpenWebinarCapacitySettings: { navigate(to: .webinarCapacitySettings) },
                        onOpenWebinarInviteCodeSettings: { navigate(to: .webinarInviteCodeSettings) },
                        onOpenWebinarLinkSettings: { navigate(to: .webinarLinkSettings) }
                    ))
                case .webinarAccessSettings:
                    pageView(SettingsSheetView(viewModel: viewModel, bodyReady: bodyReady, page: SettingsSheetPage.webinarAccess, onBack: { navigate(to: .webinarSettings) }))
                case .webinarCapacitySettings:
                    pageView(SettingsSheetView(viewModel: viewModel, bodyReady: bodyReady, page: SettingsSheetPage.webinarCapacity, onBack: { navigate(to: .webinarSettings) }))
                case .webinarInviteCodeSettings:
                    pageView(SettingsSheetView(viewModel: viewModel, bodyReady: bodyReady, page: SettingsSheetPage.webinarInviteCode, onBack: { navigate(to: .webinarSettings) }))
                case .webinarLinkSettings:
                    pageView(SettingsSheetView(viewModel: viewModel, bodyReady: bodyReady, page: SettingsSheetPage.webinarLink, onBack: { navigate(to: .webinarSettings) }))
                case .profileSettings:
                    pageView(SettingsSheetView(viewModel: viewModel, bodyReady: bodyReady, page: SettingsSheetPage.profile, onBack: { navigate(to: .settings) }))
                case .audioVideoSettings:
                    pageView(SettingsSheetView(
                        viewModel: viewModel,
                        bodyReady: bodyReady,
                        page: SettingsSheetPage.audioVideo,
                        onBack: { navigate(to: .settings) },
                        onOpenMicrophoneSettings: { navigate(to: .microphoneSettings) },
                        onOpenCameraSettings: { navigate(to: .cameraSettings) },
                        onOpenSpeakerSettings: { navigate(to: .speakerSettings) }
                    ))
                case .microphoneSettings:
                    pageView(SettingsSheetView(viewModel: viewModel, bodyReady: bodyReady, page: SettingsSheetPage.microphone, onBack: { navigate(to: .audioVideoSettings) }))
                case .cameraSettings:
                    pageView(SettingsSheetView(viewModel: viewModel, bodyReady: bodyReady, page: SettingsSheetPage.camera, onBack: { navigate(to: .audioVideoSettings) }))
                case .speakerSettings:
                    pageView(SettingsSheetView(viewModel: viewModel, bodyReady: bodyReady, page: SettingsSheetPage.speaker, onBack: { navigate(to: .audioVideoSettings) }))
                }
            }
        }
        // Android system / gesture BACK: on a sub-page (.participants/.settings)
        // pop back to .more instead of dismissing the whole sheet; on .more the
        // handler is disabled so BACK falls through to the default dismiss. Skip
        // has no SwiftUI BackHandler, so a Compose `BackHandler` is hosted in a
        // zero-size ComposeView (emits no UI). iOS is unaffected (#if !SKIP).
        #if SKIP
        .overlay(alignment: .top) {
            ComposeView { _ in
                MeetingSheetBackHandler(enabled: page.parent != nil) {
                    if let parent = page.parent {
                        navigate(to: parent)
                    }
                }
            }
            .frame(width: 0, height: 0)
        }
        #endif
        .clipped()
        #if SKIP
        .frame(maxWidth: .infinity, alignment: .top)
        .frame(height: resolvedAndroidDetentHeight, alignment: .top)
        #else
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        #endif
        // The sheet base is the app's darkest surface so the lighter rows /
        // cards inside each page keep their contrast (More's surfaceRaised card,
        // the participants/settings surface rows).
        .acmColorBackground(ACMColors.bg)
        .preferredColorScheme(.dark)
        // Brand the native Material controls (switches, picker, caret) with the
        // Carbon accent instead of iOS blue/green.
        .tint(ACMColors.primaryOrange)
        // One fixed detent for every page so the Material sheet never re-measures
        // / re-settles when the content swaps — a single clean spring reads as
        // instant. ~62% leaves the scrollable lists room while keeping More from
        // opening near-full.
        #if SKIP
        .presentationDetents([.height(resolvedAndroidDetentHeight)])
        #else
        .presentationDetents([.fraction(Self.detentFraction)])
        #endif
        .onAppear {
            pageTransitionsEnabled = true
            bodyRevealGeneration += 1
            let generation = bodyRevealGeneration
            #if SKIP
            // Android only: keep the very first slide frame light (just the cheap
            // header), then bring the body in almost immediately. The icon vectors
            // are pre-warmed at app start (warmMeetingIcons), so the body now
            // composes cheaply — a short ~90ms beat is enough to keep the open
            // smooth without the content feeling like it arrives late.
            bodyReady = false
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 90_000_000)
                guard bodyRevealGeneration == generation else { return }
                withAnimation(.easeOut(duration: 0.10)) {
                    bodyReady = true
                }
            }
            #else
            // iOS sheets aren't lag-bound — show the body immediately.
            bodyReady = true
            #endif
        }
        .onDisappear {
            bodyRevealGeneration += 1
            bodyReady = false
        }
        #if !SKIP
        .presentationDragIndicator(.visible)
        #endif
    }
}

/// Shared pinned header for the in-sheet pages. Replaces the per-sheet
/// `NavigationStack` + `.toolbar`, which Skip lowered into a full
/// `NavHost + Scaffold + CenterAlignedTopAppBar` on every open (pure overhead,
/// and an un-native iOS-style app bar inside an Android bottom sheet). A plain
/// `HStack` row is cheap and reads correctly on both platforms.
struct MeetingSheetHeader: View {
    let title: String
    var onBack: (() -> Void)? = nil
    let onDone: () -> Void

    var body: some View {
        // Plain native chrome: a bare back chevron and bare "Done" text — no
        // boxed/bordered buttons (those read as un-native on a bottom sheet).
        HStack(spacing: ACMSpacing.xs) {
            if let onBack {
                Button(action: onBack) {
                    ACMSystemIcon.icon("chevron.left", android: "back", size: 24, tint: "text")
                        .foregroundStyle(ACMColors.text)
                        .frame(width: 36, height: 36)
                        #if !SKIP
                        .contentShape(Rectangle())
                        #endif
                }
                .buttonStyle(.plain)
            }

            Text(title)
                .font(ACMFont.trial(18, weight: .semibold))
                .foregroundStyle(ACMColors.text)
                .lineLimit(1)

            Spacer()

            Button(action: onDone) {
                Text("Done")
                    .font(ACMFont.trial(16, weight: .medium))
                    .foregroundStyle(ACMColors.primaryOrange)
                    .frame(height: 36)
                    #if !SKIP
                    .contentShape(Rectangle())
                    #endif
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, ACMSpacing.lg)
        .padding(.top, ACMSpacing.md)
        .padding(.bottom, ACMSpacing.sm)
    }
}

struct MeetingSheetSectionCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) {
            content
        }
        .acmGlassRoundedRect(cornerRadius: ACMRadius.sm)
    }
}

struct MeetingSheetRowDivider: View {
    var inset: CGFloat = 0

    var body: some View {
        Rectangle()
            .fill(ACMColors.border)
            .frame(height: 1)
            .padding(.leading, inset)
    }
}

struct MeetingSheetIconBox: View {
    let icon: String
    let androidIcon: String
    var tint: Color = ACMColors.textMuted
    var androidTint: String = "muted"
    // Kept for call-site compatibility; no longer drawn as a box. A bordered box
    // around every list icon reads as un-native — a plain tinted glyph in a fixed
    // frame (so the row dividers still align) is the native list anatomy.
    var background: Color = ACMColors.surfaceRaised

    var body: some View {
        ACMSystemIcon.icon(icon, android: androidIcon, size: 22, tint: androidTint)
            .foregroundStyle(tint)
            .frame(width: 32, height: 32)
    }
}

struct MeetingSheetStatusPill: View {
    let title: String
    var tint: Color = ACMColors.textMuted
    var background: Color = ACMColors.surfaceRaised
    var border: Color = ACMColors.border

    init(_ title: String, tint: Color = ACMColors.textMuted, background: Color = ACMColors.surfaceRaised, border: Color = ACMColors.border) {
        self.title = title
        self.tint = tint
        self.background = background
        self.border = border
    }

    var body: some View {
        Text(title)
            .font(ACMFont.trial(11, weight: .medium))
            .foregroundStyle(tint)
            .padding(.horizontal, ACMSpacing.xs)
            .padding(.vertical, 3)
            .acmColorBackground(background)
            .overlay {
                Capsule()
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(border)
            }
            .clipShape(Capsule())
    }
}
