import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

struct MoreSheetView: View {
    @Bindable var viewModel: MeetingViewModel
    var bodyReady: Bool = true
    let onOpenViewSettings: () -> Void
    let onOpenSettings: () -> Void
    let onOpenParticipants: () -> Void
    let onOpenAdminControls: () -> Void
    let onOpenSharedBrowser: () -> Void
    let onOpenApps: () -> Void
    @Environment(\.dismiss) private var dismiss

    private let emojiReactions = MeetingReactionConstants.emojiReactionOptions
    private let assetReactions = MeetingReactionConstants.assetOptions

    var body: some View {
        let canUseParticipantActions = !viewModel.state.isGhostMode && !viewModel.state.isWebinarAttendee

        VStack(spacing: 0) {
            MeetingSheetHeader(title: "More", onDone: { dismiss() })

            if bodyReady {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: ACMSpacing.md) {
                        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                            acmListSectionHeader("Quick reactions")

                            HStack(spacing: 0) {
                                ForEach(emojiReactions) { option in
                                    Button {
                                        viewModel.sendReaction(option)
                                        dismiss()
                                    } label: {
                                        Text(option.value)
                                            .font(.system(size: 26))
                                            .frame(maxWidth: .infinity)
                                            .frame(height: 48)
                                        #if !SKIP
                                            .contentShape(Rectangle())
                                        #endif
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(!canUseParticipantActions)
                                }
                            }
                            .opacity(canUseParticipantActions ? 1.0 : 0.45)

                            HStack(spacing: ACMSpacing.xs) {
                                ForEach(assetReactions) { option in
                                    Button {
                                        viewModel.sendReaction(option)
                                        dismiss()
                                    } label: {
                                        Text(option.label)
                                            .font(ACMFont.trial(11, weight: .medium))
                                            .foregroundStyle(ACMColors.text)
                                            .lineLimit(1)
                                            .minimumScaleFactor(0.72)
                                            .frame(maxWidth: .infinity)
                                            .frame(height: 34)
                                            .acmColorBackground(ACMColors.surfaceRaised)
                                            .clipShape(Capsule())
                                        #if !SKIP
                                            .contentShape(Rectangle())
                                        #endif
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(!canUseParticipantActions)
                                }
                            }
                            .opacity(canUseParticipantActions ? 1.0 : 0.45)
                        }

                        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                            acmListSectionHeader("Meeting actions")

                            MeetingSheetSectionCard {
                                MoreRow(
                                    icon: viewModel.state.isHandRaised ? "hand.raised.fill" : "hand.raised",
                                    androidIcon: viewModel.state.isHandRaised ? "raise.hand" : "raise.hand.off",
                                    title: viewModel.state.isHandRaised ? "Lower hand" : "Raise hand",
                                    tint: canUseParticipantActions
                                        ? (viewModel.state.isHandRaised ? ACMColors.handRaised : ACMColors.text)
                                        : ACMColors.textFaint,
                                    androidTint: canUseParticipantActions
                                        ? (viewModel.state.isHandRaised ? "amber" : "text")
                                        : "faint",
                                    isDisabled: !canUseParticipantActions
                                ) {
                                    viewModel.toggleHandRaise()
                                    dismiss()
                                }
                                MoreRowDivider()
                                MoreRow(icon: "message.fill", androidIcon: "chat", title: "Chat") {
                                    viewModel.toggleChat()
                                    dismiss()
                                }
                                MoreRowDivider()
                                MoreRow(icon: "person.2.fill", androidIcon: "participants", title: "Participants", showsChevron: true) {
                                    onOpenParticipants()
                                }
                                MoreRowDivider()
                                MoreRow(icon: "rectangle.grid.2x2", androidIcon: "participants", title: "Layout", showsChevron: true) {
                                    onOpenViewSettings()
                                }
                                MoreRowDivider()
                                MoreRow(icon: "person.badge.plus", androidIcon: "link", title: "Invite people") {
                                    MeetingShare.shareMeetingLink(
                                        viewModel.state.meetingLink,
                                        roomId: viewModel.state.roomId
                                    )
                                    dismiss()
                                }
                                MoreRowDivider()
                                MoreRow(icon: "doc.on.doc", androidIcon: "copy", title: "Copy meeting link") {
                                    MeetingShare.copyMeetingLink(viewModel.state.meetingLink)
                                    dismiss()
                                }
                                MoreRowDivider()
                                MoreRow(icon: "gearshape.fill", androidIcon: "settings", title: "Settings", showsChevron: true) {
                                    onOpenSettings()
                                }
                            }
                        }

                        if canShowToolsSection {
                            toolsSection
                        }
                    }
                    .padding(.horizontal, ACMSpacing.lg)
                    .padding(.top, ACMSpacing.md)
                    .padding(.bottom, ACMSpacing.lg)
                }
                .transition(.opacity)
            } else {
                Spacer()
            }
        }
        #if SKIP
        .frame(maxWidth: .infinity, alignment: .topLeading)
        #else
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        #endif
    }

    @ViewBuilder
    private var toolsSection: some View {
        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
            acmListSectionHeader("Tools")

            MeetingSheetSectionCard {
                if canShowAdminControls {
                    MoreRow(icon: "slider.horizontal.3", androidIcon: "settings", title: "Host controls", showsChevron: true) {
                        onOpenAdminControls()
                    }
                }

                if canShowAdminControls && canShowSharedBrowser {
                    MoreRowDivider()
                }

                if canShowSharedBrowser {
                    MoreRow(icon: "globe", androidIcon: "public", title: "Shared browser", showsChevron: true) {
                        onOpenSharedBrowser()
                    }
                }

                if (canShowAdminControls || canShowSharedBrowser) && canShowAppsSection {
                    MoreRowDivider()
                }

                if canShowAppsSection {
                    MoreRow(icon: "pencil", androidIcon: "forum", title: "Apps", showsChevron: true) {
                        onOpenApps()
                    }
                }
            }
        }
    }

    private var canManageSharedBrowser: Bool {
        viewModel.state.isAdmin && !viewModel.state.isWebinarAttendee
    }

    private var canShowSharedBrowser: Bool {
        !viewModel.state.isWebinarAttendee &&
        (canManageSharedBrowser || viewModel.state.isBrowserActive || viewModel.state.hasBrowserAudio)
    }

    private var canShowToolsSection: Bool {
        canShowAdminControls || canShowSharedBrowser || canShowAppsSection
    }

    private var canShowAdminControls: Bool {
        viewModel.state.isAdmin && !viewModel.state.isWebinarAttendee
    }

    private var canShowAppsSection: Bool {
        (viewModel.state.isAdmin && !viewModel.state.isWebinarAttendee) || viewModel.state.activeAppId != nil
    }
}

enum AdminControlsSheetPage {
    case overview
    case access
    case participantMedia
    case notice
    case danger
}

struct AdminControlsSheetView: View {
    @Bindable var viewModel: MeetingViewModel
    var bodyReady: Bool = true
    var page: AdminControlsSheetPage = .overview
    var onBack: (() -> Void)? = nil
    var onOpenAdminAccessControls: (() -> Void)? = nil
    var onOpenAdminMediaControls: (() -> Void)? = nil
    var onOpenAdminNoticeControls: (() -> Void)? = nil
    var onOpenAdminDangerControls: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var noticeInput = ""
    @State private var noticeLevel: AdminNoticeLevel = .info
    @State private var isNoticeSending = false
    @State private var showEndMeetingConfirmation = false
    @State private var isEndingMeeting = false

    private var title: String {
        switch page {
        case .overview:
            return "Host controls"
        case .access:
            return "Access"
        case .participantMedia:
            return "Participant media"
        case .notice:
            return "Room notice"
        case .danger:
            return "End meeting"
        }
    }

    private var accessSummary: String {
        let roomState = viewModel.state.isRoomLocked ? "Room locked" : "Room open"
        let chatState = viewModel.state.isChatLocked ? "chat locked" : "chat open"
        return "\(roomState), \(chatState)"
    }

    private var participantMediaSummary: String {
        let count = viewModel.state.participantCount
        let noun = count == 1 ? "participant" : "participants"
        return "\(count) \(noun), mute and camera controls"
    }

    private var hasRaisedHands: Bool {
        if viewModel.state.isHandRaised {
            return true
        }
        for participant in viewModel.state.sortedParticipants {
            if participant.isHandRaised {
                return true
            }
        }
        return false
    }

    var body: some View {
        VStack(spacing: 0) {
            MeetingSheetHeader(title: title, onBack: onBack, onDone: { dismiss() })

            if bodyReady {
                ScrollView {
                    content
                    .padding(.horizontal, ACMSpacing.lg)
                    .padding(.top, ACMSpacing.md)
                    .padding(.bottom, ACMSpacing.lg)
                }
                .transition(.opacity)
            } else {
                Spacer()
            }
        }
        #if SKIP
        .frame(maxWidth: .infinity, alignment: .topLeading)
        #else
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        #endif
        .confirmationDialog(
            "End meeting for everyone?",
            isPresented: $showEndMeetingConfirmation,
            titleVisibility: .visible
        ) {
            Button("End meeting", role: .destructive) {
                endMeetingForEveryone()
            }
            Button("Cancel", role: .cancel) {
            }
        } message: {
            Text("Everyone in the room, including people waiting to join, will be disconnected.")
        }
    }

    @ViewBuilder
    private var content: some View {
        switch page {
        case .overview:
            overviewContent
        case .access:
            accessContent
        case .participantMedia:
            participantMediaContent
        case .notice:
            LazyVStack(alignment: .leading, spacing: ACMSpacing.md) {
                noticeSection
            }
        case .danger:
            LazyVStack(alignment: .leading, spacing: ACMSpacing.md) {
                destructiveSection
            }
        }
    }

    private var overviewContent: some View {
        LazyVStack(alignment: .leading, spacing: ACMSpacing.md) {
            VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                acmListSectionHeader("Host controls")

                MeetingSheetSectionCard {
                    adminNavigationRow(
                        "Access and chat",
                        subtitle: accessSummary,
                        icon: viewModel.state.isRoomLocked ? "lock.fill" : "lock.open.fill",
                        androidIcon: viewModel.state.isRoomLocked ? "lock" : "lock.open",
                        iconTint: viewModel.state.isRoomLocked || viewModel.state.isChatLocked ? ACMColors.primaryOrange : ACMColors.textMuted,
                        androidIconTint: viewModel.state.isRoomLocked || viewModel.state.isChatLocked ? "accent" : "muted"
                    ) {
                        onOpenAdminAccessControls?()
                    }

                    MoreRowDivider()

                    adminNavigationRow(
                        "Participant media",
                        subtitle: participantMediaSummary,
                        icon: "mic.slash.fill",
                        androidIcon: "mic.off",
                        iconTint: hasRaisedHands || viewModel.state.activeScreenShareUserId != nil ? ACMColors.primaryOrange : ACMColors.textMuted,
                        androidIconTint: hasRaisedHands || viewModel.state.activeScreenShareUserId != nil ? "accent" : "muted"
                    ) {
                        onOpenAdminMediaControls?()
                    }

                    MoreRowDivider()

                    adminNavigationRow(
                        "Room notice",
                        subtitle: "Send a banner to everyone",
                        icon: "megaphone.fill",
                        androidIcon: "info"
                    ) {
                        onOpenAdminNoticeControls?()
                    }

                    MoreRowDivider()

                    adminNavigationRow(
                        "End meeting",
                        subtitle: "Disconnect everyone in this room",
                        icon: "xmark.octagon.fill",
                        androidIcon: "close",
                        iconTint: ACMColors.error,
                        androidIconTint: "danger",
                        titleTint: ACMColors.error
                    ) {
                        onOpenAdminDangerControls?()
                    }
                }
            }
        }
    }

    private var accessContent: some View {
        LazyVStack(alignment: .leading, spacing: ACMSpacing.md) {
            VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                acmListSectionHeader("Access and moderation")

                MeetingSheetSectionCard {
                    MoreRow(
                        icon: viewModel.state.isRoomLocked ? "lock.open.fill" : "lock.fill",
                        androidIcon: viewModel.state.isRoomLocked ? "lock.open" : "lock",
                        title: viewModel.state.isRoomLocked ? "Unlock meeting" : "Lock meeting",
                        tint: viewModel.state.isRoomLocked ? ACMColors.primaryOrange : ACMColors.text,
                        androidTint: viewModel.state.isRoomLocked ? "accent" : "text"
                    ) {
                        viewModel.toggleRoomLock()
                    }

                    MoreRowDivider()

                    MoreRow(
                        icon: "nosign",
                        androidIcon: "block",
                        title: viewModel.state.isNoGuests ? "Allow guests" : "Block guests",
                        tint: viewModel.state.isNoGuests ? ACMColors.primaryOrange : ACMColors.text,
                        androidTint: viewModel.state.isNoGuests ? "accent" : "text"
                    ) {
                        viewModel.toggleNoGuests()
                    }

                    MoreRowDivider()

                    MoreRow(
                        icon: viewModel.state.isChatLocked ? "message.fill" : "message.badge.fill",
                        androidIcon: "chat",
                        title: viewModel.state.isChatLocked ? "Enable chat" : "Disable chat",
                        tint: viewModel.state.isChatLocked ? ACMColors.primaryOrange : ACMColors.text,
                        androidTint: viewModel.state.isChatLocked ? "accent" : "text"
                    ) {
                        viewModel.toggleChatLock()
                    }

                    MoreRowDivider()

                    MoreRow(
                        icon: viewModel.state.isTtsDisabled ? "speaker.wave.2.fill" : "speaker.slash.fill",
                        androidIcon: viewModel.state.isTtsDisabled ? "volume" : "volume.off",
                        title: viewModel.state.isTtsDisabled ? "Enable TTS" : "Disable TTS",
                        tint: viewModel.state.isTtsDisabled ? ACMColors.primaryOrange : ACMColors.text,
                        androidTint: viewModel.state.isTtsDisabled ? "accent" : "text"
                    ) {
                        viewModel.toggleTtsDisabled()
                    }

                    MoreRowDivider()

                    MoreRow(
                        icon: viewModel.state.isDmEnabled ? "message.fill" : "message.slash.fill",
                        androidIcon: "chat",
                        title: viewModel.state.isDmEnabled ? "Disable DMs" : "Enable DMs",
                        tint: viewModel.state.isDmEnabled ? ACMColors.text : ACMColors.primaryOrange,
                        androidTint: viewModel.state.isDmEnabled ? "text" : "accent"
                    ) {
                        viewModel.toggleDmEnabled()
                    }
                }
            }
        }
    }

    private var participantMediaContent: some View {
        LazyVStack(alignment: .leading, spacing: ACMSpacing.md) {
            VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                acmListSectionHeader("Participant media")

                MeetingSheetSectionCard {
                    MoreRow(icon: "mic.slash.fill", androidIcon: "mic.off", title: "Mute everyone") {
                        viewModel.muteAllParticipants()
                    }

                    MoreRowDivider()

                    MoreRow(icon: "video.slash.fill", androidIcon: "video.off", title: "Turn off cameras") {
                        viewModel.turnOffAllParticipantCameras()
                    }

                    if viewModel.state.activeScreenShareUserId != nil {
                        MoreRowDivider()

                        MoreRow(icon: "rectangle.on.rectangle.slash", androidIcon: "screen.share.off", title: "Stop screen shares") {
                            viewModel.stopAllScreenShares()
                        }
                    }

                    if hasRaisedHands {
                        MoreRowDivider()

                        MoreRow(icon: "hand.raised.slash.fill", androidIcon: "raise.hand.off", title: "Clear raised hands") {
                            viewModel.clearAllRaisedHands()
                        }
                    }
                }
            }
        }
    }

    private func adminNavigationRow(
        _ title: String,
        subtitle: String,
        icon: String,
        androidIcon: String,
        iconTint: Color = ACMColors.textMuted,
        androidIconTint: String = "muted",
        titleTint: Color = ACMColors.text,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: ACMSpacing.sm) {
                MeetingSheetIconBox(
                    icon: icon,
                    androidIcon: androidIcon,
                    tint: iconTint,
                    androidTint: androidIconTint,
                    background: ACMColors.surfaceRaised
                )

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(ACMFont.trial(15, weight: .medium))
                        .foregroundStyle(titleTint)
                        .lineLimit(1)

                    Text(subtitle)
                        .font(ACMFont.trial(12))
                        .foregroundStyle(ACMColors.textFaint)
                        .lineLimit(1)
                }

                Spacer()

                ACMSystemIcon.icon("chevron.right", android: "arrow.forward", size: 16, tint: "faint")
                    .foregroundStyle(ACMColors.textFaint)
                    .frame(width: 24, height: 24)
            }
            .padding(.horizontal, ACMSpacing.sm)
            .frame(height: 56)
            .frame(maxWidth: .infinity, alignment: .leading)
            #if !SKIP
            .contentShape(Rectangle())
            #endif
        }
        .buttonStyle(.plain)
    }

    private var noticeSection: some View {
        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
            acmListSectionHeader("Room notice")

            MeetingSheetSectionCard {
                HStack(spacing: ACMSpacing.sm) {
                    MeetingSheetIconBox(
                        icon: "megaphone.fill",
                        androidIcon: "info",
                        tint: noticeTint(for: noticeLevel),
                        androidTint: noticeAndroidTint(for: noticeLevel),
                        background: ACMColors.surfaceRaised
                    )

                    TextField("", text: $noticeInput, prompt: Text("Message everyone").foregroundStyle(ACMColors.textFaint))
                        .textFieldStyle(.plain)
                        .font(ACMFont.trial(15))
                        .foregroundStyle(ACMColors.text)
                        .tint(ACMColors.primaryOrange)
                    #if !SKIP
                    #if os(iOS)
                        .textInputAutocapitalization(.sentences)
                    #endif
                    #endif
                }
                .padding(.horizontal, ACMSpacing.sm)
                .frame(height: 52)

                MoreRowDivider()

                HStack(spacing: ACMSpacing.xs) {
                    noticeLevelButton(.info, title: "Info")
                    noticeLevelButton(.warning, title: "Warning")
                    noticeLevelButton(.error, title: "Error")
                }
                .padding(.horizontal, ACMSpacing.sm)
                .padding(.vertical, ACMSpacing.sm)

                MoreRowDivider()

                MoreRow(
                    icon: "paperplane.fill",
                    androidIcon: "send",
                    title: isNoticeSending ? "Sending notice..." : "Send notice",
                    tint: canSendNotice ? ACMColors.text : ACMColors.textFaint,
                    androidTint: canSendNotice ? "text" : "faint",
                    isDisabled: !canSendNotice
                ) {
                    sendNotice()
                }
            }
        }
    }

    private var destructiveSection: some View {
        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
            acmListSectionHeader("Danger zone")

            MeetingSheetSectionCard {
                MoreRow(
                    icon: "xmark.octagon.fill",
                    androidIcon: "close",
                    title: isEndingMeeting ? "Ending meeting..." : "End meeting for everyone",
                    tint: ACMColors.error,
                    androidTint: "danger",
                    isDisabled: isEndingMeeting
                ) {
                    showEndMeetingConfirmation = true
                }
            }
        }
    }

    private var canSendNotice: Bool {
        !isNoticeSending && !noticeInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func noticeLevelButton(_ level: AdminNoticeLevel, title: String) -> some View {
        let isSelected = noticeLevel == level
        return Button {
            noticeLevel = level
        } label: {
            Text(title)
                .font(ACMFont.trial(12, weight: .medium))
                .foregroundStyle(isSelected ? noticeTint(for: level) : ACMColors.textMuted)
                .lineLimit(1)
                .minimumScaleFactor(0.78)
                .frame(maxWidth: .infinity)
                .frame(height: 34)
                .acmColorBackground(isSelected ? noticeBackground(for: level) : ACMColors.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .disabled(isNoticeSending)
    }

    private func sendNotice() {
        let message = noticeInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty, !isNoticeSending else { return }
        isNoticeSending = true
        Task { @MainActor in
            let sent = await viewModel.broadcastAdminNotice(message: message, level: noticeLevel)
            if sent {
                noticeInput = ""
            }
            isNoticeSending = false
        }
    }

    private func endMeetingForEveryone() {
        guard !isEndingMeeting else { return }
        isEndingMeeting = true
        Task { @MainActor in
            let ended = await viewModel.endMeetingForEveryone()
            isEndingMeeting = false
            if ended {
                dismiss()
            }
        }
    }

    private func noticeTint(for level: AdminNoticeLevel) -> Color {
        switch level {
        case .info:
            return ACMColors.primaryOrange
        case .warning:
            return ACMColors.handRaised
        case .error:
            return ACMColors.error
        }
    }

    private func noticeBackground(for level: AdminNoticeLevel) -> Color {
        switch level {
        case .info:
            return ACMColors.primaryOrangeFaint
        case .warning:
            return ACMColors.handRaisedBackground
        case .error:
            return ACMColors.error.opacity(0.16)
        }
    }

    private func noticeAndroidTint(for level: AdminNoticeLevel) -> String {
        switch level {
        case .info:
            return "accent"
        case .warning:
            return "amber"
        case .error:
            return "error"
        }
    }
}

struct SharedBrowserSheetView: View {
    @Bindable var viewModel: MeetingViewModel
    var bodyReady: Bool = true
    var onBack: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var browserURLInput = ""

    private let browserLaunchOptions = BrowserLaunchOption.defaults
    private let browserLaunchColumns = [
        GridItem(.flexible(), spacing: ACMSpacing.xs),
        GridItem(.flexible(), spacing: ACMSpacing.xs)
    ]

    var body: some View {
        VStack(spacing: 0) {
            MeetingSheetHeader(title: "Shared browser", onBack: onBack, onDone: { dismiss() })

            if bodyReady {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: ACMSpacing.md) {
                        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                            acmListSectionHeader("Session")

                            MeetingSheetSectionCard {
                                if viewModel.state.isBrowserActive {
                                    activeBrowserStatusRow

                                    if viewModel.state.hasBrowserAudio {
                                        MoreRowDivider()
                                        browserAudioRow
                                    }

                                    if canManageSharedBrowser {
                                        MoreRowDivider()

                                        MoreRow(
                                            icon: "xmark",
                                            androidIcon: "close",
                                            title: "Close shared browser",
                                            tint: ACMColors.error,
                                            androidTint: "error"
                                        ) {
                                            viewModel.closeSharedBrowser()
                                        }
                                    }
                                } else if canManageSharedBrowser {
                                    browserURLRow
                                    MoreRowDivider()
                                    browserQuickLaunchGrid
                                    MoreRowDivider()
                                    launchBrowserRow
                                } else if viewModel.state.hasBrowserAudio {
                                    browserAudioRow
                                }
                            }
                        }
                    }
                    .padding(.horizontal, ACMSpacing.lg)
                    .padding(.top, ACMSpacing.md)
                    .padding(.bottom, ACMSpacing.lg)
                }
                .transition(.opacity)
            } else {
                Spacer()
            }
        }
        #if SKIP
        .frame(maxWidth: .infinity, alignment: .topLeading)
        #else
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        #endif
    }

    private var activeBrowserStatusRow: some View {
        HStack(spacing: ACMSpacing.sm) {
            MeetingSheetIconBox(
                icon: "globe",
                androidIcon: "public",
                tint: ACMColors.primaryOrange,
                androidTint: "accent",
                background: ACMColors.surfaceRaised
            )

            VStack(alignment: .leading, spacing: 2) {
                Text("Browser active")
                    .font(ACMFont.trial(15, weight: .medium))
                    .foregroundStyle(ACMColors.text)
                    .lineLimit(1)
                Text(viewModel.state.browserURL ?? "Session running")
                    .font(ACMFont.trial(12))
                    .foregroundStyle(ACMColors.textFaint)
                    .lineLimit(1)
            }

            Spacer()
        }
        .padding(.horizontal, ACMSpacing.sm)
        .frame(height: 56)
    }

    private var browserURLRow: some View {
        HStack(spacing: ACMSpacing.sm) {
            MeetingSheetIconBox(
                icon: "globe",
                androidIcon: "public",
                tint: ACMColors.textMuted,
                androidTint: "muted",
                background: ACMColors.surfaceRaised
            )

            TextField("", text: $browserURLInput, prompt: Text("example.com").foregroundStyle(ACMColors.textFaint))
                .textFieldStyle(.plain)
                .font(ACMFont.trial(15))
                .foregroundStyle(ACMColors.text)
                .tint(ACMColors.primaryOrange)
#if !SKIP
#if os(iOS)
                .textInputAutocapitalization(.never)
#endif
#endif
                .autocorrectionDisabled(true)
        }
        .padding(.horizontal, ACMSpacing.sm)
        .frame(height: 52)
    }

    private var browserQuickLaunchGrid: some View {
        LazyVGrid(columns: browserLaunchColumns, spacing: ACMSpacing.xs) {
            ForEach(browserLaunchOptions) { option in
                Button {
                    viewModel.launchSharedBrowser(url: option.url)
                } label: {
                    Text(option.name)
                        .font(ACMFont.trial(13, weight: .medium))
                        .foregroundStyle(ACMColors.text)
                        .lineLimit(1)
                        .minimumScaleFactor(0.78)
                        .frame(maxWidth: .infinity)
                        .frame(height: 36)
                        .acmColorBackground(ACMColors.surfaceRaised)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        #if !SKIP
                        .contentShape(Rectangle())
                        #endif
                }
                .buttonStyle(.plain)
                .disabled(viewModel.state.isBrowserLaunching)
            }
        }
        .padding(.horizontal, ACMSpacing.sm)
        .padding(.vertical, ACMSpacing.sm)
        .opacity(viewModel.state.isBrowserLaunching ? 0.45 : 1.0)
    }

    private var launchBrowserRow: some View {
        MoreRow(
            icon: "play.fill",
            androidIcon: "public",
            title: viewModel.state.isBrowserLaunching ? "Launching..." : "Launch shared browser",
            tint: canLaunchSharedBrowser ? ACMColors.text : ACMColors.textFaint,
            androidTint: canLaunchSharedBrowser ? "text" : "faint",
            isDisabled: !canLaunchSharedBrowser
        ) {
            viewModel.launchSharedBrowser(url: browserURLInput)
        }
    }

    private var browserAudioRow: some View {
        MoreRow(
            icon: viewModel.state.isBrowserAudioMuted ? "speaker.slash.fill" : "speaker.wave.2.fill",
            androidIcon: viewModel.state.isBrowserAudioMuted ? "volume.off" : "volume",
            title: viewModel.state.isBrowserAudioMuted ? "Unmute browser audio" : "Mute browser audio",
            tint: viewModel.state.isBrowserAudioMuted ? ACMColors.primaryOrange : ACMColors.text,
            androidTint: viewModel.state.isBrowserAudioMuted ? "accent" : "text"
        ) {
            viewModel.toggleBrowserAudio()
        }
    }

    private var canLaunchSharedBrowser: Bool {
        !viewModel.state.isBrowserLaunching &&
        !browserURLInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canManageSharedBrowser: Bool {
        viewModel.state.isAdmin && !viewModel.state.isWebinarAttendee
    }
}

struct AppsSheetView: View {
    @Bindable var viewModel: MeetingViewModel
    var bodyReady: Bool = true
    var onBack: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            MeetingSheetHeader(title: "Apps", onBack: onBack, onDone: { dismiss() })

            if bodyReady {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: ACMSpacing.md) {
                        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                            acmListSectionHeader("Runtime")

                            MeetingSheetSectionCard {
                                if let activeAppName = viewModel.state.activeAppName {
                                    activeAppStatusRow(activeAppName)

                                    if canManageApps {
                                        MoreRowDivider()
                                    }
                                }

                                if canManageApps {
                                    whiteboardRow

                                    #if DEBUG
                                    if canManageDevPlayground {
                                        MoreRowDivider()
                                        devPlaygroundRow
                                    }
                                    #endif

                                    if canManageUnknownActiveApp {
                                        MoreRowDivider()
                                        closeUnknownAppRow
                                    }

                                    MoreRowDivider()
                                    appsLockRow
                                }
                            }
                        }
                    }
                    .padding(.horizontal, ACMSpacing.lg)
                    .padding(.top, ACMSpacing.md)
                    .padding(.bottom, ACMSpacing.lg)
                }
                .transition(.opacity)
            } else {
                Spacer()
            }
        }
        #if SKIP
        .frame(maxWidth: .infinity, alignment: .topLeading)
        #else
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        #endif
    }

    private func activeAppStatusRow(_ activeAppName: String) -> some View {
        HStack(spacing: ACMSpacing.sm) {
            MeetingSheetIconBox(
                icon: "pencil",
                androidIcon: "forum",
                tint: ACMColors.primaryOrange,
                androidTint: "accent",
                background: ACMColors.surfaceRaised
            )

            VStack(alignment: .leading, spacing: 2) {
                Text("\(activeAppName) active")
                    .font(ACMFont.trial(15, weight: .medium))
                    .foregroundStyle(ACMColors.text)
                    .lineLimit(1)
                Text(viewModel.state.isAppsLocked ? "Editing locked" : "Editing open")
                    .font(ACMFont.trial(12))
                    .foregroundStyle(ACMColors.textFaint)
                    .lineLimit(1)
            }

            Spacer()
        }
        .padding(.horizontal, ACMSpacing.sm)
        .frame(height: 56)
    }

    private var whiteboardRow: some View {
        MoreRow(
            icon: viewModel.state.isWhiteboardActive ? "xmark" : "pencil",
            androidIcon: viewModel.state.isWhiteboardActive ? "close" : "forum",
            title: viewModel.state.isWhiteboardActive ? "Close whiteboard" : "Open whiteboard",
            tint: viewModel.state.isWhiteboardActive ? ACMColors.error : ACMColors.text,
            androidTint: viewModel.state.isWhiteboardActive ? "error" : "text",
            isDisabled: viewModel.state.isAppsActionInFlight
        ) {
            if viewModel.state.isWhiteboardActive {
                viewModel.closeActiveApp()
            } else {
                viewModel.openWhiteboard()
            }
        }
    }

    #if DEBUG
    private var devPlaygroundRow: some View {
        MoreRow(
            icon: viewModel.state.activeAppId == "dev-playground" ? "xmark" : "chevron.left.forwardslash.chevron.right",
            androidIcon: viewModel.state.activeAppId == "dev-playground" ? "close" : "info",
            title: viewModel.state.activeAppId == "dev-playground" ? "Close dev playground" : "Open dev playground",
            tint: viewModel.state.activeAppId == "dev-playground" ? ACMColors.error : ACMColors.text,
            androidTint: viewModel.state.activeAppId == "dev-playground" ? "error" : "text",
            isDisabled: viewModel.state.isAppsActionInFlight
        ) {
            if viewModel.state.activeAppId == "dev-playground" {
                viewModel.closeActiveApp()
            } else {
                viewModel.openDevPlayground()
            }
        }
    }
    #endif

    private var closeUnknownAppRow: some View {
        MoreRow(
            icon: "xmark",
            androidIcon: "close",
            title: "Close \(viewModel.state.activeAppName ?? "app")",
            tint: ACMColors.error,
            androidTint: "error",
            isDisabled: viewModel.state.isAppsActionInFlight
        ) {
            viewModel.closeActiveApp()
        }
    }

    private var appsLockRow: some View {
        MoreRow(
            icon: viewModel.state.isAppsLocked ? "lock.open.fill" : "lock.fill",
            androidIcon: viewModel.state.isAppsLocked ? "lock.open" : "lock",
            title: viewModel.state.isAppsLocked ? "Unlock app editing" : "Lock app editing",
            tint: viewModel.state.isAppsLocked ? ACMColors.primaryOrange : ACMColors.text,
            androidTint: viewModel.state.isAppsLocked ? "accent" : "text",
            isDisabled: viewModel.state.isAppsActionInFlight
        ) {
            viewModel.toggleAppsLock()
        }
    }

    private var canManageApps: Bool {
        viewModel.state.isAdmin && !viewModel.state.isWebinarAttendee
    }

    private var canManageActiveApp: Bool {
        canManageApps && viewModel.state.activeAppId != nil
    }

    private var canManageUnknownActiveApp: Bool {
        guard canManageActiveApp, let activeAppId = viewModel.state.activeAppId else { return false }
        return activeAppId != "whiteboard" && activeAppId != "dev-playground"
    }

    private var canManageDevPlayground: Bool {
        #if DEBUG
        return canManageApps
        #else
        return false
        #endif
    }
}

enum ViewSettingsSheetPage {
    case overview
    case viewMode
    case grid
    case selfView
    case selfViewPosition
}

struct ViewSettingsSheetView: View {
    @Bindable var viewModel: MeetingViewModel
    var bodyReady: Bool = true
    var page: ViewSettingsSheetPage = .overview
    var onBack: (() -> Void)? = nil
    var onOpenViewModeSettings: (() -> Void)? = nil
    var onOpenGridSettings: (() -> Void)? = nil
    var onOpenSelfViewSettings: (() -> Void)? = nil
    var onOpenSelfViewPositionSettings: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss

    private var title: String {
        switch page {
        case .overview:
            return "Layout"
        case .viewMode:
            return "View"
        case .grid:
            return "Grid"
        case .selfView:
            return "Self-view"
        case .selfViewPosition:
            return "Position"
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            MeetingSheetHeader(title: title, onBack: onBack, onDone: { dismiss() })

            if bodyReady {
                ScrollView {
                    content
                    .padding(.horizontal, ACMSpacing.lg)
                    .padding(.top, ACMSpacing.md)
                    .padding(.bottom, ACMSpacing.lg)
                }
                .transition(.opacity)
            } else {
                Spacer()
            }
        }
        #if SKIP
        .frame(maxWidth: .infinity, alignment: .topLeading)
        #else
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        #endif
    }

    @ViewBuilder
    private var content: some View {
        switch page {
        case .overview:
            overviewContent
        case .viewMode:
            viewModeContent
        case .grid:
            gridContent
        case .selfView:
            selfViewContent
        case .selfViewPosition:
            selfViewPositionContent
        }
    }

    private var overviewContent: some View {
        LazyVStack(alignment: .leading, spacing: ACMSpacing.md) {
            VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                acmListSectionHeader("Layout")

                MeetingSheetSectionCard {
                    MoreRow(icon: "rectangle.grid.2x2", androidIcon: "settings", title: "\(viewModel.state.viewMode.title) view", showsChevron: true) {
                        onOpenViewModeSettings?()
                    }
                    MoreRowDivider()
                    MoreRow(icon: "square.grid.2x2", androidIcon: "participants", title: "\(viewModel.state.viewMaxTiles) maximum tiles", showsChevron: true) {
                        onOpenGridSettings?()
                    }
                    MoreRowDivider()
                    MoreRow(icon: "person.crop.rectangle", androidIcon: "account", title: viewModel.state.selfViewMode.title, showsChevron: true) {
                        onOpenSelfViewSettings?()
                    }
                    MoreRowDivider()
                    MoreRow(icon: "arrow.up.left.and.arrow.down.right", androidIcon: "open.in.full", title: viewModel.state.selfViewCorner.title, showsChevron: true) {
                        onOpenSelfViewPositionSettings?()
                    }
                }
            }
        }
    }

    private var viewModeContent: some View {
        LazyVStack(alignment: .leading, spacing: ACMSpacing.md) {
            VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                acmListSectionHeader("View")

                MeetingSheetSectionCard {
                    viewModeRow(.auto, icon: "rectangle.grid.2x2", androidIcon: "settings")
                    MoreRowDivider()
                    viewModeRow(.tiled, icon: "square.grid.2x2", androidIcon: "participants")
                    MoreRowDivider()
                    viewModeRow(.spotlight, icon: "rectangle.inset.filled", androidIcon: "pin.off")
                    MoreRowDivider()
                    viewModeRow(.sidebar, icon: "sidebar.right", androidIcon: "participants")
                }
            }
        }
    }

    private var gridContent: some View {
        LazyVStack(alignment: .leading, spacing: ACMSpacing.md) {
            VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                acmListSectionHeader("Grid")

                MeetingSheetSectionCard {
                    maxTilesRow
                    MoreRowDivider()
                    MoreRow(
                        icon: viewModel.state.hideTilesWithoutVideo ? "video.fill" : "video.slash.fill",
                        androidIcon: viewModel.state.hideTilesWithoutVideo ? "video" : "video.off",
                        title: viewModel.state.hideTilesWithoutVideo ? "Show video-off tiles" : "Hide tiles without video",
                        tint: viewModel.state.hideTilesWithoutVideo ? ACMColors.primaryOrange : ACMColors.text,
                        androidTint: viewModel.state.hideTilesWithoutVideo ? "accent" : "text"
                    ) {
                        viewModel.toggleHideTilesWithoutVideo()
                    }
                }
            }
        }
    }

    private var selfViewContent: some View {
        LazyVStack(alignment: .leading, spacing: ACMSpacing.md) {
            VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                acmListSectionHeader("Self-view")

                MeetingSheetSectionCard {
                    selfViewModeRow(.auto, icon: "rectangle.grid.2x2", androidIcon: "settings")
                    MoreRowDivider()
                    selfViewModeRow(.tile, icon: "person.crop.rectangle", androidIcon: "account")
                    MoreRowDivider()
                    selfViewModeRow(.floating, icon: "pip", androidIcon: "info")
                    MoreRowDivider()
                    selfViewModeRow(.minimized, icon: "minus.rectangle", androidIcon: "remove.person")
                }
            }
        }
    }

    private var selfViewPositionContent: some View {
        LazyVStack(alignment: .leading, spacing: ACMSpacing.md) {
            VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                acmListSectionHeader("Self-view position")

                MeetingSheetSectionCard {
                    selfViewCornerRow(.topLeft, icon: "arrow.up.left", androidIcon: "north.west")
                    MoreRowDivider()
                    selfViewCornerRow(.topRight, icon: "arrow.up.right", androidIcon: "north.east")
                    MoreRowDivider()
                    selfViewCornerRow(.bottomLeft, icon: "arrow.down.left", androidIcon: "south.west")
                    MoreRowDivider()
                    selfViewCornerRow(.bottomRight, icon: "arrow.down.right", androidIcon: "south.east")
                }
            }
        }
    }

    @ViewBuilder
    private func viewModeRow(_ mode: MeetingViewMode, icon: String, androidIcon: String) -> some View {
        let isSelected = viewModel.state.viewMode == mode
        MoreRow(
            icon: isSelected ? "checkmark.circle.fill" : icon,
            androidIcon: isSelected ? "check" : androidIcon,
            title: "\(mode.title) view",
            tint: isSelected ? ACMColors.primaryOrange : ACMColors.text,
            androidTint: isSelected ? "accent" : "text"
        ) {
            viewModel.setViewMode(mode)
        }
    }

    private var maxTilesRow: some View {
        HStack(spacing: ACMSpacing.sm) {
            MeetingSheetIconBox(
                icon: "square.grid.2x2",
                androidIcon: "participants",
                tint: ACMColors.text,
                androidTint: "text",
                background: ACMColors.surfaceRaised
            )

            VStack(alignment: .leading, spacing: 2) {
                Text("Maximum tiles")
                    .font(ACMFont.trial(15, weight: .medium))
                    .foregroundStyle(ACMColors.text)
                    .lineLimit(1)
                Text("\(viewModel.state.viewMaxTiles) visible")
                    .font(ACMFont.trial(12))
                    .foregroundStyle(ACMColors.textFaint)
                    .lineLimit(1)
            }

            Spacer()

            tileLimitButton(icon: "minus", androidIcon: "close", delta: -1)
            Text("\(viewModel.state.viewMaxTiles)")
                .font(ACMFont.trial(13, weight: .semibold))
                .foregroundStyle(ACMColors.text)
                .frame(minWidth: 28)
            tileLimitButton(icon: "plus", androidIcon: "add", delta: 1)
        }
        .padding(.horizontal, ACMSpacing.sm)
        .frame(height: 58)
    }

    private func tileLimitButton(icon: String, androidIcon: String, delta: Int) -> some View {
        Button {
            viewModel.adjustViewMaxTiles(by: delta)
        } label: {
            ACMSystemIcon.icon(icon, android: androidIcon, size: 14, tint: "text")
                .foregroundStyle(ACMColors.text)
                .frame(width: 30, height: 30)
                .acmColorBackground(ACMColors.surfaceRaised)
                .clipShape(Circle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func selfViewModeRow(_ mode: MeetingSelfViewMode, icon: String, androidIcon: String) -> some View {
        let isSelected = viewModel.state.selfViewMode == mode
        MoreRow(
            icon: isSelected ? "checkmark.circle.fill" : icon,
            androidIcon: isSelected ? "check" : androidIcon,
            title: mode.title,
            tint: isSelected ? ACMColors.primaryOrange : ACMColors.text,
            androidTint: isSelected ? "accent" : "text"
        ) {
            viewModel.setSelfViewMode(mode)
        }
    }

    @ViewBuilder
    private func selfViewCornerRow(_ corner: MeetingSelfViewCorner, icon: String, androidIcon: String) -> some View {
        let isSelected = viewModel.state.selfViewCorner == corner
        MoreRow(
            icon: isSelected ? "checkmark.circle.fill" : icon,
            androidIcon: isSelected ? "check" : androidIcon,
            title: corner.title,
            tint: isSelected ? ACMColors.primaryOrange : ACMColors.text,
            androidTint: isSelected ? "accent" : "text"
        ) {
            viewModel.setSelfViewCorner(corner)
        }
    }
}

private struct BrowserLaunchOption: Identifiable {
    let id: String
    let name: String
    let url: String

    static let defaults = [
        BrowserLaunchOption(id: "figma", name: "Figma", url: "https://www.figma.com"),
        BrowserLaunchOption(id: "miro", name: "Miro", url: "https://miro.com"),
        BrowserLaunchOption(id: "notion", name: "Notion", url: "https://www.notion.so"),
        BrowserLaunchOption(id: "google-docs", name: "Docs", url: "https://docs.google.com"),
        BrowserLaunchOption(id: "trello", name: "Trello", url: "https://trello.com"),
        BrowserLaunchOption(id: "youtube", name: "YouTube", url: "https://www.youtube.com"),
        BrowserLaunchOption(id: "loom", name: "Loom", url: "https://www.loom.com")
    ]
}

struct MoreRow: View {
    let icon: String
    let androidIcon: String
    let title: String
    var tint: Color = ACMColors.text
    var androidTint: String = "text"
    var showsChevron: Bool = false
    var isDisabled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: ACMSpacing.sm) {
                MeetingSheetIconBox(
                    icon: icon,
                    androidIcon: androidIcon,
                    tint: tint,
                    androidTint: androidTint,
                    background: ACMColors.surfaceRaised
                )

                Text(title)
                    .font(ACMFont.trial(15, weight: .medium))
                    .foregroundStyle(tint)
                    .lineLimit(1)

                Spacer()

                if showsChevron {
                    ACMSystemIcon.icon("chevron.right", android: "arrow.forward", size: 16, tint: "faint")
                        .foregroundStyle(ACMColors.textFaint)
                        .frame(width: 24, height: 24)
                }
            }
            .padding(.horizontal, ACMSpacing.sm)
            .frame(height: 52)
            .frame(maxWidth: .infinity, alignment: .leading)
            #if !SKIP
            .contentShape(Rectangle())
            #endif
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.55 : 1.0)
    }
}

struct MoreRowDivider: View {
    var body: some View {
        MeetingSheetRowDivider(inset: ACMSpacing.sm + 32 + ACMSpacing.sm)
    }
}
