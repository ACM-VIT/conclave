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
        let canUseParticipantActions = viewModel.state.connectionState == .joined
            && !viewModel.state.isGhostMode
            && !viewModel.state.isWebinarAttendee

        VStack(spacing: 0) {
            MeetingSheetHeader(title: "More", onDone: { dismiss() })

            if bodyReady {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: ACMSpacing.md) {
                        if canShowQuickReactions {
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
                                    }
                                }

                                HStack(spacing: ACMSpacing.xs) {
                                    ForEach(assetReactions) { option in
                                        Button {
                                            viewModel.sendReaction(option)
                                            dismiss()
                                        } label: {
                                            ReactionAssetThumbnailView(
                                                value: option.value,
                                                label: option.label,
                                                size: 26
                                            )
                                                .frame(maxWidth: .infinity)
                                                .frame(height: 38)
                                                .acmColorBackground(ACMColors.surfaceRaised)
                                                .clipShape(Capsule())
                                            #if !SKIP
                                                .contentShape(Rectangle())
                                            #endif
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }
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
                                    withAnimation(.easeInOut(duration: 0.12)) {
                                        viewModel.toggleChat()
                                    }
                                    dismiss()
                                }
                                MoreRowDivider()
                                MoreRow(icon: "person.2.fill", androidIcon: "participants", title: "Participants", showsChevron: true) {
                                    onOpenParticipants()
                                }
                                MoreRowDivider()
                                MoreRow(icon: "rectangle.grid.2x2", androidIcon: "grid", title: "Layout", showsChevron: true) {
                                    onOpenViewSettings()
                                }
                                MoreRowDivider()
                                MoreRow(icon: "person.badge.plus", androidIcon: "link", title: "Invite people") {
                                    if MeetingShare.shareMeetingLink(
                                        viewModel.state.meetingLink,
                                        roomId: viewModel.state.roomId
                                    ) {
                                        dismiss()
                                    }
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
        viewModel.state.isAdmin
            && viewModel.state.connectionState == .joined
            && !viewModel.state.isWebinarAttendee
    }

    private var canShowSharedBrowser: Bool {
        viewModel.state.connectionState == .joined &&
        !viewModel.state.isWebinarAttendee &&
        (canManageSharedBrowser || viewModel.state.isBrowserActive || viewModel.state.hasBrowserAudio)
    }

    private var canShowToolsSection: Bool {
        canShowAdminControls || canShowSharedBrowser || canShowAppsSection
    }

    private var canShowQuickReactions: Bool {
        let canUseParticipantActions = viewModel.state.connectionState == .joined
            && !viewModel.state.isGhostMode
            && !viewModel.state.isWebinarAttendee
        return canUseParticipantActions &&
            (!viewModel.state.isReactionsDisabled || viewModel.state.isAdmin) &&
            (!emojiReactions.isEmpty || !assetReactions.isEmpty)
    }

    private var canShowAdminControls: Bool {
        viewModel.state.isAdmin
            && viewModel.state.connectionState == .joined
            && !viewModel.state.isWebinarAttendee
    }

    private var canShowAppsSection: Bool {
        viewModel.state.connectionState == .joined &&
        !viewModel.state.isWebinarAttendee &&
        (viewModel.state.isAdmin || viewModel.state.activeAppId != nil)
    }
}

enum AdminControlsSheetPage {
    case overview
    case access
    case participantMedia
    case notice
    case danger
}

enum AdminControlsActionCompletionPolicy {
    static func shouldApplyCompletion(
        generation: Int,
        currentGeneration: Int,
        actionRoomId: String,
        currentRoomId: String
    ) -> Bool {
        return generation == currentGeneration &&
            NativeRoomIdNormalizer.matches(actionRoomId, currentRoomId)
    }
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
    @State private var accessUserKeyInput = ""
    @State private var noticeActionGeneration = 0
    @State private var endMeetingActionGeneration = 0

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

    private var accessSummary: String? {
        var states: [String] = []
        if viewModel.state.isRoomLocked {
            states.append("Room locked")
        }
        if viewModel.state.isChatLocked {
            states.append("Chat locked")
        }
        if viewModel.state.isNoGuests {
            states.append("Guests blocked")
        }
        return states.isEmpty ? nil : states.joined(separator: ", ")
    }

    private var trimmedAccessUserKey: String {
        accessUserKeyInput.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSubmitAccessUserKey: Bool {
        canUseHostControls
            && !trimmedAccessUserKey.isEmpty
            && trimmedAccessUserKey.count <= 256
            && !viewModel.state.isAdminAccessListRefreshing
    }

    private var participantMediaSummary: String {
        let count = viewModel.state.participantCount
        let noun = count == 1 ? "participant" : "participants"
        return "\(count) \(noun)"
    }

    private var hasRaisedHands: Bool {
        if viewModel.state.isHandRaised {
            return true
        }
        for participant in viewModel.state.presentParticipants {
            if participant.isHandRaised {
                return true
            }
        }
        return false
    }

    private var canUseHostControls: Bool {
        viewModel.state.isAdmin
            && viewModel.state.connectionState == .joined
            && !viewModel.state.isWebinarAttendee
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
        .onAppear {
            if page == .access {
                viewModel.refreshAdminAccessLists()
            }
        }
        .onChange(of: viewModel.state.roomId) { _, _ in
            resetTransientAdminActions()
        }
        .onChange(of: viewModel.state.connectionState) { _, state in
            if state != .joined {
                resetTransientAdminActions()
            }
        }
        .onChange(of: viewModel.state.isAdmin) { _, isAdmin in
            if !isAdmin {
                resetTransientAdminActions()
            }
        }
        .onChange(of: viewModel.state.isWebinarAttendee) { _, isWebinarAttendee in
            if isWebinarAttendee {
                resetTransientAdminActions()
            }
        }
        .onDisappear {
            resetTransientAdminActions()
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
                        androidIconTint: viewModel.state.isRoomLocked || viewModel.state.isChatLocked ? "accent" : "muted",
                        isDisabled: !canUseHostControls
                    ) {
                        onOpenAdminAccessControls?()
                    }

                    MoreRowDivider()

                    adminNavigationRow(
                        "Participant media",
                        subtitle: participantMediaSummary,
                        icon: "mic.slash.fill",
                        androidIcon: "mic.off",
                        iconTint: hasRaisedHands || viewModel.state.hasActiveScreenShare ? ACMColors.primaryOrange : ACMColors.textMuted,
                        androidIconTint: hasRaisedHands || viewModel.state.hasActiveScreenShare ? "accent" : "muted",
                        isDisabled: !canUseHostControls
                    ) {
                        onOpenAdminMediaControls?()
                    }

                    MoreRowDivider()

                    adminNavigationRow(
                        "Room notice",
                        icon: "megaphone.fill",
                        androidIcon: "info",
                        isDisabled: !canUseHostControls
                    ) {
                        onOpenAdminNoticeControls?()
                    }

                    MoreRowDivider()

                    adminNavigationRow(
                        "End meeting",
                        icon: "xmark.octagon.fill",
                        androidIcon: "close",
                        iconTint: ACMColors.error,
                        androidIconTint: "danger",
                        titleTint: ACMColors.error,
                        isDisabled: !canUseHostControls
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
                        androidTint: viewModel.state.isRoomLocked ? "accent" : "text",
                        isDisabled: !canUseHostControls
                    ) {
                        viewModel.toggleRoomLock()
                    }

                    MoreRowDivider()

                    MoreRow(
                        icon: "nosign",
                        androidIcon: "block",
                        title: viewModel.state.isNoGuests ? "Allow guests" : "Block guests",
                        tint: viewModel.state.isNoGuests ? ACMColors.primaryOrange : ACMColors.text,
                        androidTint: viewModel.state.isNoGuests ? "accent" : "text",
                        isDisabled: !canUseHostControls
                    ) {
                        viewModel.toggleNoGuests()
                    }

                    MoreRowDivider()

                    MoreRow(
                        icon: viewModel.state.isChatLocked ? "message.fill" : "message.badge.fill",
                        androidIcon: "chat",
                        title: viewModel.state.isChatLocked ? "Enable chat" : "Disable chat",
                        tint: viewModel.state.isChatLocked ? ACMColors.primaryOrange : ACMColors.text,
                        androidTint: viewModel.state.isChatLocked ? "accent" : "text",
                        isDisabled: !canUseHostControls
                    ) {
                        viewModel.toggleChatLock()
                    }

                    MoreRowDivider()

                    MoreRow(
                        icon: viewModel.state.isTtsDisabled ? "speaker.wave.2.fill" : "speaker.slash.fill",
                        androidIcon: viewModel.state.isTtsDisabled ? "volume" : "volume.off",
                        title: viewModel.state.isTtsDisabled ? "Enable TTS" : "Disable TTS",
                        tint: viewModel.state.isTtsDisabled ? ACMColors.primaryOrange : ACMColors.text,
                        androidTint: viewModel.state.isTtsDisabled ? "accent" : "text",
                        isDisabled: !canUseHostControls
                    ) {
                        viewModel.toggleTtsDisabled()
                    }

                    MoreRowDivider()

                    MoreRow(
                        icon: viewModel.state.isDmEnabled ? "message.fill" : "message.slash.fill",
                        androidIcon: "chat",
                        title: viewModel.state.isDmEnabled ? "Disable DMs" : "Enable DMs",
                        tint: viewModel.state.isDmEnabled ? ACMColors.text : ACMColors.primaryOrange,
                        androidTint: viewModel.state.isDmEnabled ? "text" : "accent",
                        isDisabled: !canUseHostControls
                    ) {
                        viewModel.toggleDmEnabled()
                    }
                }
            }

            VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                acmListSectionHeader("User access lists")

                MeetingSheetSectionCard {
                    accessUserKeyInputRow

                    MoreRowDivider()

                    HStack(spacing: ACMSpacing.xs) {
                        accessCommandButton(
                            title: "Allow",
                            icon: "person.crop.circle.badge.checkmark",
                            androidIcon: "check",
                            tint: ACMColors.success,
                            androidTint: "success",
                            isDisabled: !canSubmitAccessUserKey
                        ) {
                            let key = trimmedAccessUserKey
                            if viewModel.allowAccessUserKey(key) {
                                accessUserKeyInput = ""
                            }
                        }

                        accessCommandButton(
                            title: "Block",
                            icon: "person.crop.circle.badge.xmark",
                            androidIcon: "block",
                            tint: ACMColors.error,
                            androidTint: "danger",
                            isDisabled: !canSubmitAccessUserKey
                        ) {
                            let key = trimmedAccessUserKey
                            if viewModel.blockAccessUserKey(key) {
                                accessUserKeyInput = ""
                            }
                        }
                    }
                    .padding(.horizontal, ACMSpacing.sm)
                    .padding(.vertical, ACMSpacing.sm)

                    MoreRowDivider()

                    if viewModel.state.isAdminAccessListRefreshing {
                        Text("Refreshing access lists...")
                            .font(ACMFont.trial(12))
                            .foregroundStyle(ACMColors.textFaint)
                            .padding(.horizontal, ACMSpacing.sm)
                            .padding(.vertical, ACMSpacing.sm)

                        MoreRowDivider()
                    }

                    accessListSection(
                        title: "Allowed",
                        emptyText: "No users are explicitly allowed.",
                        keys: viewModel.state.adminAllowedUserKeys,
                        actionTitle: "Revoke",
                        actionIcon: "xmark.circle.fill",
                        actionAndroidIcon: "close",
                        actionTint: ACMColors.textMuted,
                        actionAndroidTint: "muted"
                    ) { key in
                        viewModel.revokeAllowedAccessUserKey(key)
                    }

                    MoreRowDivider()

                    accessListSection(
                        title: "Allowed while locked",
                        emptyText: "No users bypass the lock.",
                        keys: viewModel.state.adminLockedAllowedUserKeys,
                        actionTitle: "Revoke",
                        actionIcon: "lock.slash.fill",
                        actionAndroidIcon: "lock.open",
                        actionTint: ACMColors.primaryOrange,
                        actionAndroidTint: "accent"
                    ) { key in
                        viewModel.revokeAllowedAccessUserKey(key)
                    }

                    MoreRowDivider()

                    accessListSection(
                        title: "Blocked",
                        emptyText: "No users are blocked.",
                        keys: viewModel.state.adminBlockedUserKeys,
                        actionTitle: "Unblock",
                        actionIcon: "checkmark.circle.fill",
                        actionAndroidIcon: "check",
                        actionTint: ACMColors.success,
                        actionAndroidTint: "success"
                    ) { key in
                        viewModel.unblockAccessUserKey(key)
                    }
                }
            }
        }
    }

    private var accessUserKeyInputRow: some View {
        HStack(spacing: ACMSpacing.sm) {
            MeetingSheetIconBox(
                icon: "person.crop.circle.badge.plus",
                androidIcon: "person.add",
                tint: canUseHostControls ? ACMColors.textMuted : ACMColors.textFaint,
                androidTint: canUseHostControls ? "muted" : "faint",
                background: ACMColors.surfaceRaised
            )

            TextField("", text: $accessUserKeyInput, prompt: Text("User key or email").foregroundStyle(ACMColors.textFaint))
                .textFieldStyle(.plain)
                .font(ACMFont.trial(15))
                .foregroundStyle(ACMColors.text)
                .tint(ACMColors.primaryOrange)
                .disabled(!canUseHostControls || viewModel.state.isAdminAccessListRefreshing)
            #if !SKIP
            #if os(iOS)
                .textInputAutocapitalization(.never)
                .keyboardType(.emailAddress)
            #endif
            #endif
                .autocorrectionDisabled(true)
        }
        .padding(.horizontal, ACMSpacing.sm)
        .frame(minHeight: 52)
        .opacity(canUseHostControls ? 1.0 : 0.55)
    }

    private func accessCommandButton(
        title: String,
        icon: String,
        androidIcon: String,
        tint: Color,
        androidTint: String,
        isDisabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        let resolvedTint = isDisabled ? ACMColors.textFaint : tint
        let resolvedAndroidTint = isDisabled ? "faint" : androidTint

        return Button {
            guard !isDisabled else { return }
            action()
        } label: {
            HStack(spacing: 6) {
                ACMSystemIcon.icon(icon, android: androidIcon, size: 15, tint: resolvedAndroidTint)
                    .foregroundStyle(resolvedTint)
                    .frame(width: 18, height: 18)

                Text(title)
                    .font(ACMFont.trial(12, weight: .medium))
                    .foregroundStyle(resolvedTint)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 36)
            .acmColorBackground(isDisabled ? ACMColors.surfaceRaised : tint.opacity(0.14))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.55 : 1.0)
    }

    private func accessListSection(
        title: String,
        emptyText: String,
        keys: [String],
        actionTitle: String,
        actionIcon: String,
        actionAndroidIcon: String,
        actionTint: Color,
        actionAndroidTint: String,
        action: @escaping (String) -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
            HStack(spacing: ACMSpacing.xs) {
                Text(title)
                    .font(ACMFont.trial(12, weight: .medium))
                    .foregroundStyle(ACMColors.textMuted)
                    .lineLimit(1)

                Spacer()

                Text("\(keys.count)")
                    .font(ACMFont.trial(11, weight: .medium))
                    .foregroundStyle(ACMColors.textFaint)
                    .padding(.horizontal, 8)
                    .frame(height: 22)
                    .acmColorBackground(ACMColors.surfaceRaised)
                    .clipShape(Capsule())
            }
            .padding(.horizontal, ACMSpacing.sm)
            .padding(.top, ACMSpacing.sm)

            if keys.isEmpty {
                Text(emptyText)
                    .font(ACMFont.trial(12))
                    .foregroundStyle(ACMColors.textFaint)
                    .padding(.horizontal, ACMSpacing.sm)
                    .padding(.bottom, ACMSpacing.sm)
            } else {
                VStack(spacing: 0) {
                    ForEach(keys, id: \.self) { key in
                        accessListRow(
                            key: key,
                            actionTitle: actionTitle,
                            actionIcon: actionIcon,
                            actionAndroidIcon: actionAndroidIcon,
                            actionTint: actionTint,
                            actionAndroidTint: actionAndroidTint,
                            action: action
                        )
                    }
                }
                .padding(.bottom, ACMSpacing.xs)
            }
        }
    }

    private func accessListRow(
        key: String,
        actionTitle: String,
        actionIcon: String,
        actionAndroidIcon: String,
        actionTint: Color,
        actionAndroidTint: String,
        action: @escaping (String) -> Void
    ) -> some View {
        Button {
            guard canUseHostControls && !viewModel.state.isAdminAccessListRefreshing else { return }
            action(key)
        } label: {
            HStack(spacing: ACMSpacing.xs) {
                Text(key)
                    .font(ACMFont.trial(13, weight: .medium))
                    .foregroundStyle(ACMColors.text)
                    .lineLimit(1)
                    .truncationMode(.middle)

                Spacer(minLength: ACMSpacing.xs)

                HStack(spacing: 4) {
                    ACMSystemIcon.icon(actionIcon, android: actionAndroidIcon, size: 14, tint: actionAndroidTint)
                        .foregroundStyle(actionTint)
                        .frame(width: 16, height: 16)

                    Text(actionTitle)
                        .font(ACMFont.trial(11, weight: .medium))
                        .foregroundStyle(actionTint)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, ACMSpacing.sm)
            .frame(minHeight: 38)
        }
        .buttonStyle(.plain)
        .disabled(!canUseHostControls || viewModel.state.isAdminAccessListRefreshing)
        .opacity(canUseHostControls ? 1.0 : 0.55)
    }

    private var participantMediaContent: some View {
        LazyVStack(alignment: .leading, spacing: ACMSpacing.md) {
            VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                acmListSectionHeader("Participant media")

                MeetingSheetSectionCard {
                    MoreRow(icon: "mic.slash.fill", androidIcon: "mic.off", title: "Mute everyone", isDisabled: !canUseHostControls) {
                        viewModel.muteAllParticipants()
                    }

                    MoreRowDivider()

                    MoreRow(icon: "video.slash.fill", androidIcon: "video.off", title: "Turn off cameras", isDisabled: !canUseHostControls) {
                        viewModel.turnOffAllParticipantCameras()
                    }

                    if viewModel.state.hasActiveScreenShare {
                        MoreRowDivider()

                        MoreRow(icon: "rectangle.on.rectangle.slash", androidIcon: "screen.share.off", title: "Stop screen shares", isDisabled: !canUseHostControls) {
                            viewModel.stopAllScreenShares()
                        }
                    }

                    if hasRaisedHands {
                        MoreRowDivider()

                        MoreRow(icon: "hand.raised.slash.fill", androidIcon: "raise.hand.off", title: "Clear raised hands", isDisabled: !canUseHostControls) {
                            viewModel.clearAllRaisedHands()
                        }
                    }
                }
            }
        }
    }

    private func adminNavigationRow(
        _ title: String,
        subtitle: String? = nil,
        icon: String,
        androidIcon: String,
        iconTint: Color = ACMColors.textMuted,
        androidIconTint: String = "muted",
        titleTint: Color = ACMColors.text,
        isDisabled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        let rowIconTint = isDisabled ? ACMColors.textFaint : iconTint
        let rowAndroidIconTint = isDisabled ? "faint" : androidIconTint
        let rowTitleTint = isDisabled ? ACMColors.textFaint : titleTint
        let rowSubtitle = subtitle?.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasSubtitle = rowSubtitle?.isEmpty == false

        return Button(action: action) {
            HStack(spacing: ACMSpacing.sm) {
                MeetingSheetIconBox(
                    icon: icon,
                    androidIcon: androidIcon,
                    tint: rowIconTint,
                    androidTint: rowAndroidIconTint,
                    background: ACMColors.surfaceRaised
                )

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(ACMFont.trial(15, weight: .medium))
                        .foregroundStyle(rowTitleTint)
                        .lineLimit(1)

                    if let rowSubtitle, !rowSubtitle.isEmpty {
                        Text(rowSubtitle)
                            .font(ACMFont.trial(12))
                            .foregroundStyle(ACMColors.textFaint)
                            .lineLimit(1)
                    }
                }

                Spacer()

                ACMSystemIcon.icon("chevron.right", android: "arrow.forward", size: 16, tint: "faint")
                    .foregroundStyle(ACMColors.textFaint)
                    .frame(width: 24, height: 24)
            }
            .padding(.horizontal, ACMSpacing.sm)
            .frame(height: hasSubtitle ? 56.0 : 52.0)
            .frame(maxWidth: .infinity, alignment: .leading)
            #if !SKIP
            .contentShape(Rectangle())
            #endif
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.62 : 1.0)
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
                    isDisabled: isEndingMeeting || !canUseHostControls
                ) {
                    showEndMeetingConfirmation = true
                }
            }
        }
    }

    private var canSendNotice: Bool {
        canUseHostControls
            && !isNoticeSending
            && !noticeInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
        .disabled(isNoticeSending || !canUseHostControls)
    }

    private func sendNotice() {
        let message = noticeInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canUseHostControls, !message.isEmpty, !isNoticeSending else { return }
        let actionRoomId = viewModel.state.roomId
        let generation = nextNoticeActionGeneration()
        let level = noticeLevel
        isNoticeSending = true
        Task { @MainActor in
            let sent = await viewModel.broadcastAdminNotice(message: message, level: level)
            guard shouldApplyNoticeCompletion(generation: generation, roomId: actionRoomId) else {
                return
            }
            if sent {
                noticeInput = ""
            }
            isNoticeSending = false
        }
    }

    private func endMeetingForEveryone() {
        guard canUseHostControls, !isEndingMeeting else { return }
        let actionRoomId = viewModel.state.roomId
        let generation = nextEndMeetingActionGeneration()
        isEndingMeeting = true
        Task { @MainActor in
            let ended = await viewModel.endMeetingForEveryone()
            guard shouldApplyEndMeetingCompletion(generation: generation, roomId: actionRoomId) else {
                return
            }
            isEndingMeeting = false
            if ended {
                dismiss()
            }
        }
    }

    private func nextNoticeActionGeneration() -> Int {
        noticeActionGeneration += 1
        return noticeActionGeneration
    }

    private func nextEndMeetingActionGeneration() -> Int {
        endMeetingActionGeneration += 1
        return endMeetingActionGeneration
    }

    private func shouldApplyNoticeCompletion(generation: Int, roomId: String) -> Bool {
        AdminControlsActionCompletionPolicy.shouldApplyCompletion(
            generation: generation,
            currentGeneration: noticeActionGeneration,
            actionRoomId: roomId,
            currentRoomId: viewModel.state.roomId
        )
    }

    private func shouldApplyEndMeetingCompletion(generation: Int, roomId: String) -> Bool {
        AdminControlsActionCompletionPolicy.shouldApplyCompletion(
            generation: generation,
            currentGeneration: endMeetingActionGeneration,
            actionRoomId: roomId,
            currentRoomId: viewModel.state.roomId
        )
    }

    private func resetTransientAdminActions() {
        noticeActionGeneration += 1
        endMeetingActionGeneration += 1
        isNoticeSending = false
        isEndingMeeting = false
        showEndMeetingConfirmation = false
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
    @State private var hasEditedBrowserURLInput = false

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

                                    if canManageSharedBrowser {
                                        MoreRowDivider()
                                        browserURLRow
                                        MoreRowDivider()
                                        navigateBrowserRow
                                    }

                                    if canToggleBrowserAudio {
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
                                            androidTint: "error",
                                            isDisabled: !canManageSharedBrowser
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
                                } else if canToggleBrowserAudio {
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
        .onAppear(perform: syncBrowserURLInput)
        #if SKIP
        .onChange(of: viewModel.state.isBrowserActive ? "active" : "inactive") { _, _ in
            syncBrowserURLInput()
        }
        #else
        .onChange(of: viewModel.state.isBrowserActive) { _, _ in
            syncBrowserURLInput()
        }
        #endif
        .onChange(of: viewModel.state.browserURL) { _, _ in
            syncBrowserURLInput()
        }
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

            TextField("", text: Binding(
                get: { browserURLInput },
                set: {
                    browserURLInput = $0
                    hasEditedBrowserURLInput = true
                }
            ), prompt: Text(browserURLPrompt).foregroundStyle(ACMColors.textFaint))
                .textFieldStyle(.plain)
                .font(ACMFont.trial(15))
                .foregroundStyle(ACMColors.text)
                .tint(ACMColors.primaryOrange)
#if !SKIP
#if os(iOS)
                .textInputAutocapitalization(.never)
                .keyboardType(.URL)
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
                    if viewModel.launchSharedBrowser(url: option.url) {
                        hasEditedBrowserURLInput = false
                    }
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
                .disabled(!canManageSharedBrowser || viewModel.state.isBrowserLaunching)
            }
        }
        .padding(.horizontal, ACMSpacing.sm)
        .padding(.vertical, ACMSpacing.sm)
        .opacity(canManageSharedBrowser && !viewModel.state.isBrowserLaunching ? 1.0 : 0.45)
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
            if viewModel.launchSharedBrowser(url: browserURLInput) {
                hasEditedBrowserURLInput = false
            }
        }
    }

    private var navigateBrowserRow: some View {
        MoreRow(
            icon: "arrow.right",
            androidIcon: "arrow.forward",
            title: viewModel.state.isBrowserNavigating ? "Navigating..." : "Navigate shared browser",
            tint: canNavigateSharedBrowser ? ACMColors.text : ACMColors.textFaint,
            androidTint: canNavigateSharedBrowser ? "text" : "faint",
            isDisabled: !canNavigateSharedBrowser
        ) {
            if viewModel.navigateSharedBrowser(url: browserURLInput) {
                hasEditedBrowserURLInput = false
            }
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
        canManageSharedBrowser &&
        !viewModel.state.isBrowserLaunching &&
        !browserURLInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var browserURLPrompt: String {
        viewModel.state.isBrowserActive ? "Navigate to URL" : "Launch URL"
    }

    private var canNavigateSharedBrowser: Bool {
        canManageSharedBrowser &&
        viewModel.state.isBrowserActive &&
        !viewModel.state.isBrowserNavigating &&
        !browserURLInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canManageSharedBrowser: Bool {
        viewModel.state.isAdmin
            && viewModel.state.connectionState == .joined
            && !viewModel.state.isWebinarAttendee
    }

    private var canToggleBrowserAudio: Bool {
        viewModel.state.connectionState == .joined &&
        !viewModel.state.isWebinarAttendee &&
        (viewModel.state.hasBrowserAudio || viewModel.state.isBrowserActive)
    }

    private func syncBrowserURLInput() {
        let nextInput = SharedBrowserURLDraftSyncPolicy.nextInput(
            currentInput: browserURLInput,
            browserURL: viewModel.state.browserURL,
            isBrowserActive: viewModel.state.isBrowserActive,
            hasLocalEdits: hasEditedBrowserURLInput
        )
        guard nextInput != browserURLInput else { return }
        browserURLInput = nextInput
        hasEditedBrowserURLInput = false
    }
}

enum SharedBrowserURLDraftSyncPolicy {
    static func nextInput(
        currentInput: String,
        browserURL: String?,
        isBrowserActive: Bool,
        hasLocalEdits: Bool
    ) -> String {
        guard !hasLocalEdits else { return currentInput }
        guard isBrowserActive else { return "" }
        return browserURL ?? ""
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
        viewModel.state.isAdmin
            && viewModel.state.connectionState == .joined
            && !viewModel.state.isWebinarAttendee
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
                    MoreRow(icon: "rectangle.grid.2x2", androidIcon: "grid", title: "\(viewModel.state.viewMode.title) view", showsChevron: true) {
                        onOpenViewModeSettings?()
                    }
                    MoreRowDivider()
                    MoreRow(icon: "square.grid.2x2", androidIcon: "grid", title: "\(viewModel.state.viewMaxTiles) maximum tiles", showsChevron: true) {
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
                    viewModeRow(.auto, icon: "rectangle.grid.2x2", androidIcon: "grid")
                    MoreRowDivider()
                    viewModeRow(.tiled, icon: "square.grid.2x2", androidIcon: "grid")
                    MoreRowDivider()
                    viewModeRow(.spotlight, icon: "rectangle.inset.filled", androidIcon: "spotlight")
                    MoreRowDivider()
                    viewModeRow(.sidebar, icon: "sidebar.right", androidIcon: "sidebar")
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
                    selfViewModeRow(.auto, icon: "rectangle.grid.2x2", androidIcon: "grid")
                    MoreRowDivider()
                    selfViewModeRow(.tile, icon: "person.crop.rectangle", androidIcon: "account")
                    MoreRowDivider()
                    selfViewModeRow(.floating, icon: "pip", androidIcon: "pip")
                    MoreRowDivider()
                    selfViewModeRow(.minimized, icon: "minus.rectangle", androidIcon: "collapse")
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
                androidIcon: "grid",
                tint: ACMColors.text,
                androidTint: "text",
                background: ACMColors.surfaceRaised
            )

            Text("Maximum tiles")
                .font(ACMFont.trial(15, weight: .medium))
                .foregroundStyle(ACMColors.text)
                .lineLimit(1)

            Spacer()

            tileLimitButton(icon: "minus", androidIcon: "remove", delta: -1)
            Text("\(viewModel.state.viewMaxTiles)")
                .font(ACMFont.trial(13, weight: .semibold))
                .foregroundStyle(ACMColors.text)
                .frame(minWidth: 28)
            tileLimitButton(icon: "plus", androidIcon: "add", delta: 1)
        }
        .padding(.horizontal, ACMSpacing.sm)
        .frame(height: 52)
    }

    private func tileLimitButton(icon: String, androidIcon: String, delta: Int) -> some View {
        let nextValue = MeetingViewConstants.clampTiles(viewModel.state.viewMaxTiles + delta)
        let isDisabled = nextValue == viewModel.state.viewMaxTiles

        return Button {
            guard !isDisabled else { return }
            viewModel.adjustViewMaxTiles(by: delta)
        } label: {
            ACMSystemIcon.icon(icon, android: androidIcon, size: 14, tint: isDisabled ? "faint" : "text")
                .foregroundStyle(isDisabled ? ACMColors.textFaint : ACMColors.text)
                .frame(width: 30, height: 30)
                .acmColorBackground(ACMColors.surfaceRaised)
                .clipShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.55 : 1.0)
        .accessibilityLabel(delta < 0 ? "Decrease maximum tiles" : "Increase maximum tiles")
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
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    #if !SKIP
                    .fixedSize(horizontal: false, vertical: true)
                    .layoutPriority(1)
                    #endif

                Spacer(minLength: 8)

                if showsChevron {
                    ACMSystemIcon.icon("chevron.right", android: "arrow.forward", size: 16, tint: "faint")
                        .foregroundStyle(ACMColors.textFaint)
                        .frame(width: 24, height: 24)
                }
            }
            .padding(.horizontal, ACMSpacing.sm)
            .frame(minHeight: 52)
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
