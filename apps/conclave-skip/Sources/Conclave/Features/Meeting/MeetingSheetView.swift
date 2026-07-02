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
    case games
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
    case privacyPolicy
}

struct MeetingSheetCloseAction {
    var close: (() -> Void)? = nil
}

private struct MeetingSheetCloseActionKey: EnvironmentKey {
    static let defaultValue = MeetingSheetCloseAction()
}

extension EnvironmentValues {
    var meetingSheetCloseAction: MeetingSheetCloseAction {
        get { self[MeetingSheetCloseActionKey.self] }
        set { self[MeetingSheetCloseActionKey.self] = newValue }
    }
}

private extension MeetingSheetPage {
    var depth: Int {
        switch self {
        case .more:
            return 0
        case .participants, .settings, .viewSettings, .adminControls, .sharedBrowser, .apps, .games:
            return 1
        case .viewModeSettings, .gridSettings, .selfViewSettings, .selfViewPositionSettings,
             .adminAccessControls, .adminMediaControls, .adminNoticeControls, .adminDangerControls,
             .roomSettings, .webinarSettings, .profileSettings, .audioVideoSettings, .privacyPolicy:
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
        case .participants, .settings, .viewSettings, .adminControls, .sharedBrowser, .apps, .games:
            return .more
        case .viewModeSettings, .gridSettings, .selfViewSettings, .selfViewPositionSettings:
            return .viewSettings
        case .adminAccessControls, .adminMediaControls, .adminNoticeControls, .adminDangerControls:
            return .adminControls
        case .roomSettings, .webinarSettings, .profileSettings, .audioVideoSettings, .privacyPolicy:
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

enum MeetingSheetRevealPolicy {
    static func shouldRevealImmediately(after delayNanoseconds: UInt64) -> Bool {
        delayNanoseconds == UInt64(0)
    }

    static func shouldHideBodyBeforeReveal(after delayNanoseconds: UInt64) -> Bool {
        !shouldRevealImmediately(after: delayNanoseconds)
    }

    static func shouldApply(generation: Int, currentGeneration: Int) -> Bool {
        generation == currentGeneration
    }
}

struct MeetingSheetView: View {
    @Bindable var viewModel: MeetingViewModel
    @Binding var page: MeetingSheetPage
    var androidDetentHeight: CGFloat? = nil
    var onOpenTranscript: (() -> Void)? = nil
    @State private var navigationDirection: MeetingSheetNavigationDirection = .push
    @State private var pageTransitionsEnabled = false
    #if SKIP
    @State private var bodyReady = true
    #else
    @State private var bodyReady = true
    #endif
    @State private var bodyRevealGeneration = 0
    @State private var bodyRevealTask: Task<Void, Never>?

    static let detentFraction: CGFloat = 0.62
    static let androidDetentFraction: CGFloat = 0.88
    static let androidInitialBodyRevealDelayNanoseconds = UInt64(0)
    static let androidNavigationBodyRevealDelayNanoseconds = UInt64(0)
    private static let fallbackAndroidDetentHeight: CGFloat = 420.0
    private static let pageAnimation = Animation.easeInOut(duration: 0.16)

    private var resolvedAndroidDetentHeight: CGFloat {
        max(1.0, androidDetentHeight ?? Self.fallbackAndroidDetentHeight)
    }

    private func navigate(to nextPage: MeetingSheetPage) {
        guard page != nextPage else { return }

        PerformanceDiagnostics.event("meeting_sheet_navigate", details: "\(page)->\(nextPage)")
        navigationDirection = nextPage.depth <= page.depth ? .pop : .push
        #if SKIP
        page = nextPage
        return
        #else
        guard pageTransitionsEnabled else {
            page = nextPage
            return
        }

        withAnimation(Self.pageAnimation) {
            page = nextPage
        }
        #endif
    }

    #if SKIP
    private func scheduleAndroidBodyReveal(
        after delayNanoseconds: UInt64,
        enableTransitionsAfterReveal: Bool = false,
        animated: Bool = true
    ) {
        if MeetingSheetRevealPolicy.shouldRevealImmediately(after: delayNanoseconds) {
            bodyRevealTask?.cancel()
            bodyRevealTask = nil
            if !bodyReady {
                bodyReady = true
            }
            return
        }

        bodyRevealTask?.cancel()
        bodyRevealTask = nil
        bodyRevealGeneration += 1
        let generation = bodyRevealGeneration
        bodyReady = false
        bodyRevealTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: delayNanoseconds)
            guard !Task.isCancelled,
                  MeetingSheetRevealPolicy.shouldApply(
                    generation: generation,
                    currentGeneration: bodyRevealGeneration
                  ) else { return }
            PerformanceDiagnostics.event(
                "meeting_sheet_body_reveal",
                details: "delayNs=\(delayNanoseconds)"
            )
            guard animated else {
                bodyReady = true
                if enableTransitionsAfterReveal {
                    pageTransitionsEnabled = true
                }
                bodyRevealTask = nil
                return
            }
            withAnimation(.easeOut(duration: 0.08)) {
                bodyReady = true
            }
            if enableTransitionsAfterReveal {
                pageTransitionsEnabled = true
            }
            bodyRevealTask = nil
        }
    }

    private func resetAndroidBodyReveal() {
        bodyRevealTask?.cancel()
        bodyRevealTask = nil
        if !bodyReady {
            bodyReady = true
        }
    }
    #endif

    @ViewBuilder
    private func pageView<Content: View>(_ content: Content) -> some View {
        #if SKIP
        content
        #else
        if pageTransitionsEnabled {
            content.transition(navigationDirection.transition)
        } else {
            content
        }
        #endif
    }

    var body: some View {
        let _ = PerformanceDiagnostics.render("MeetingSheetView") {
            "page=\(page) ready=\(bodyReady) transitions=\(pageTransitionsEnabled)"
        }
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
                            onOpenApps: { navigate(to: .apps) },
                            onOpenGames: { navigate(to: .games) },
                            onOpenTranscript: onOpenTranscript
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
                        onOpenAudioVideoSettings: { navigate(to: .audioVideoSettings) },
                        onOpenPrivacyPolicy: { navigate(to: .privacyPolicy) }
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
                case .games:
                    pageView(GamesSheetView(viewModel: viewModel, bodyReady: bodyReady, onBack: { navigate(to: .more) }))
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
                case .privacyPolicy:
                    pageView(
                        PrivacyPolicyPageView(
                            onBack: { navigate(to: .settings) },
                            androidBodyHeight: max(260.0, resolvedAndroidDetentHeight - 64.0)
                        )
                    )
                }
            }
        }
        #if SKIP
        .overlay(alignment: .top) {
            if page.parent != nil {
                ComposeView { _ in
                    MeetingSheetBackHandler(enabled: true) {
                        if let parent = page.parent {
                            navigate(to: parent)
                        }
                    }
                }
                .frame(width: 0, height: 0)
            }
        }
        #endif
        .clipped()
        #if SKIP
        .frame(maxWidth: .infinity, alignment: .top)
        .frame(height: resolvedAndroidDetentHeight, alignment: .top)
        #else
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        #endif
        .acmColorBackground(ACMColors.bg)
        .preferredColorScheme(.dark)
        .tint(ACMColors.primaryOrange)
        #if !SKIP
        .presentationDetents([.fraction(Self.detentFraction)])
        #endif
        .onAppear {
            #if SKIP
            PerformanceDiagnostics.event("meeting_sheet_appear", details: "page=\(page)")
            if pageTransitionsEnabled {
                pageTransitionsEnabled = false
            }
            scheduleAndroidBodyReveal(
                after: Self.androidInitialBodyRevealDelayNanoseconds,
                animated: false
            )
            #else
            pageTransitionsEnabled = true
            bodyReady = true
            #endif
        }
        .onDisappear {
            #if SKIP
            resetAndroidBodyReveal()
            #else
            bodyRevealGeneration += 1
            bodyReady = false
            #endif
            pageTransitionsEnabled = false
            navigationDirection = .push
        }
        #if !SKIP
        .presentationDragIndicator(.visible)
        #endif
    }
}

/// Shared pinned header for in-sheet pages.
struct MeetingSheetHeader: View {
    let title: String
    var onBack: (() -> Void)? = nil
    let onDone: () -> Void
    @Environment(\.meetingSheetCloseAction) private var meetingSheetCloseAction

    private func close() {
        if let close = meetingSheetCloseAction.close {
            close()
        } else {
            onDone()
        }
    }

    var body: some View {
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
                .accessibilityLabel("Back")
            }

            Text(title)
                .font(ACMFont.trial(18, weight: .semibold))
                .foregroundStyle(ACMColors.text)
                .lineLimit(1)

            Spacer()

            Button(action: close) {
                Text("Done")
                    .font(ACMFont.trial(16, weight: .medium))
                    .foregroundStyle(ACMColors.primaryOrange)
                    .frame(height: 36)
                    #if !SKIP
                    .contentShape(Rectangle())
                    #endif
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Done")
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
    var background: Color = ACMColors.surfaceRaised

    var body: some View {
        ACMSystemIcon.icon(icon, android: androidIcon, size: 22, tint: androidTint)
            .foregroundStyle(tint)
            .frame(width: 32, height: 32)
            .acmColorBackground(background)
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
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
