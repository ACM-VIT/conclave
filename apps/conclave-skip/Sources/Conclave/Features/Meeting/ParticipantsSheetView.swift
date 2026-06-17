import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

// MARK: - Participants Sheet

@ViewBuilder
func acmListSectionHeader(_ title: String) -> some View {
    Text(title)
        .font(ACMFont.trial(12, weight: .medium))
        .foregroundStyle(ACMColors.textFaint)
        .padding(.horizontal, ACMSpacing.xs)
        #if !SKIP
        .textCase(nil)
        #endif
}

struct ParticipantsSheetView: View {
    @Bindable var viewModel: MeetingViewModel
    var bodyReady: Bool = true
    @Environment(\.dismiss) private var dismiss
    var onBack: (() -> Void)? = nil
    @State private var pendingHostPromotionUserId: String?
    @State private var promotingHostUserId: String?
    @State private var pendingKickUserId: String?
    @State private var removingUserId: String?

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

    @ViewBuilder
    private func hostActionButton(_ title: String, icon: String, androidIcon: String, tint: Color = ACMColors.text, androidTint: String = "text", action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: ACMSpacing.sm) {
                MeetingSheetIconBox(
                    icon: icon,
                    androidIcon: androidIcon,
                    tint: tint,
                    androidTint: androidTint
                )

                Text(title)
                    .font(ACMFont.trial(15, weight: .medium))
                    .foregroundStyle(tint)
                    .lineLimit(1)

                Spacer()
            }
            .padding(.horizontal, ACMSpacing.sm)
            .frame(height: 52)
            .frame(maxWidth: .infinity, alignment: .leading)
#if !SKIP
            .contentShape(Rectangle())
#endif
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func avatarView(_ name: String, size: CGFloat = 40.0) -> some View {
        Circle()
            .fill(ACMColors.avatarColor(for: name))
            .frame(width: size, height: size)
            .overlay {
                Text(String(name.prefix(1)).uppercased())
                    .font(.system(size: size == 40.0 ? 16.0 : 14.0, weight: .semibold))
                    .foregroundStyle(Color.white)
            }
    }

    @ViewBuilder
    private func statusBadge(icon: String, androidIcon: String, tint: Color, androidTint: String, background: Color, border: Color) -> some View {
        ACMSystemIcon.icon(icon, android: androidIcon, size: 13, tint: androidTint)
            .foregroundStyle(tint)
            .frame(width: 24, height: 24)
            .acmColorBackground(background)
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.sm)
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(border)
            }
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
    }

    @ViewBuilder
    private func statusBadges(
        isHandRaised: Bool,
        isMuted: Bool,
        isCameraOff: Bool,
        isScreenSharing: Bool,
        isGhost: Bool = false
    ) -> some View {
        HStack(spacing: ACMSpacing.xs) {
            if isHandRaised {
                statusBadge(
                    icon: "hand.raised.fill",
                    androidIcon: "raise.hand",
                    tint: ACMColors.handRaised,
                    androidTint: "amber",
                    background: ACMColors.handRaisedBackground,
                    border: ACMColors.handRaisedBorder
                )
            }

            if isScreenSharing {
                statusBadge(
                    icon: "rectangle.on.rectangle",
                    androidIcon: "screen.share",
                    tint: ACMColors.success,
                    androidTint: "success",
                    background: acmColor(red: 34.0, green: 197.0, blue: 94.0, opacity: 0.18),
                    border: acmColor(red: 34.0, green: 197.0, blue: 94.0, opacity: 0.36)
                )
            }

            if isCameraOff {
                statusBadge(
                    icon: "video.slash.fill",
                    androidIcon: "video.off",
                    tint: ACMColors.error,
                    androidTint: "danger",
                    background: ACMColors.surfaceRaised,
                    border: ACMColors.border
                )
            }

            if isMuted {
                statusBadge(
                    icon: "mic.slash.fill",
                    androidIcon: "mic.off",
                    tint: ACMColors.error,
                    androidTint: "danger",
                    background: ACMColors.surfaceRaised,
                    border: ACMColors.border
                )
            }

            if isGhost {
                statusBadge(
                    icon: "theatermasks.fill",
                    androidIcon: "ghost",
                    tint: ACMColors.primaryPink,
                    androidTint: "pink",
                    background: ACMColors.surfaceRaised,
                    border: ACMColors.border
                )
            }
        }
    }

    @ViewBuilder
    private func pendingUserRow(userId: String, name: String) -> some View {
        HStack(spacing: ACMSpacing.sm) {
            avatarView(name, size: 36)

            Text(name)
                .font(ACMFont.trial(15, weight: .medium))
                .foregroundStyle(ACMColors.text)
                .lineLimit(1)

            Spacer()

            Button {
                viewModel.admitUser(userId: userId)
            } label: {
                Text("Admit")
                    .font(ACMFont.trial(13, weight: .medium))
                    .foregroundStyle(Color.white)
                    .padding(.horizontal, ACMSpacing.sm)
                    .frame(height: 32)
                    .acmColorBackground(ACMColors.primaryOrange)
                    .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
            }
            .buttonStyle(.plain)

            Button {
                Task { @MainActor in
                    await viewModel.removeUser(userId: userId)
                }
            } label: {
                Text("Deny")
                    .font(ACMFont.trial(13, weight: .medium))
                    .foregroundStyle(ACMColors.error)
                    .padding(.horizontal, ACMSpacing.sm)
                    .frame(height: 32)
                    .acmColorBackground(ACMColors.surfaceRaised)
                    .overlay {
                        RoundedRectangle(cornerRadius: ACMRadius.sm)
                            .strokeBorder(lineWidth: 1)
                            .foregroundStyle(ACMColors.border)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, ACMSpacing.sm)
        .frame(height: 56)
    }

    private func pendingBulkActionRow() -> some View {
        HStack(spacing: ACMSpacing.sm) {
            Text("Requests to join")
                .font(ACMFont.trial(13, weight: .medium))
                .foregroundStyle(ACMColors.textMuted)
                .lineLimit(1)

            Spacer()

            Button {
                viewModel.admitAllPending()
            } label: {
                Text("Admit all")
                    .font(ACMFont.trial(13, weight: .medium))
                    .foregroundStyle(Color.white)
                    .padding(.horizontal, ACMSpacing.sm)
                    .frame(height: 32)
                    .acmColorBackground(ACMColors.primaryOrange)
                    .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
            }
            .buttonStyle(.plain)

            Button {
                viewModel.rejectAllPending()
            } label: {
                Text("Deny all")
                    .font(ACMFont.trial(13, weight: .medium))
                    .foregroundStyle(ACMColors.error)
                    .padding(.horizontal, ACMSpacing.sm)
                    .frame(height: 32)
                    .acmColorBackground(ACMColors.surfaceRaised)
                    .overlay {
                        RoundedRectangle(cornerRadius: ACMRadius.sm)
                            .strokeBorder(lineWidth: 1)
                            .foregroundStyle(ACMColors.border)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, ACMSpacing.sm)
        .frame(height: 56)
    }

    @ViewBuilder
    private func currentUserRow() -> some View {
        HStack(spacing: ACMSpacing.sm) {
            avatarView(viewModel.state.displayName)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: ACMSpacing.xs) {
                    Text(viewModel.state.displayName)
                        .font(ACMFont.trial(15, weight: .medium))
                        .foregroundStyle(ACMColors.text)
                        .lineLimit(1)

                    MeetingSheetStatusPill("You")
                }

                if viewModel.state.isHostUser(viewModel.state.userId) {
                    MeetingSheetStatusPill(
                        "Host",
                        tint: ACMColors.primaryOrange,
                        background: ACMColors.primaryOrangeFaint,
                        border: ACMColors.primaryOrangeGhost
                    )
                }
            }

            Spacer()

            statusBadges(
                isHandRaised: viewModel.state.isHandRaised,
                isMuted: viewModel.state.isMuted,
                isCameraOff: viewModel.state.isCameraOff,
                isScreenSharing: viewModel.state.isScreenSharing
            )
        }
        .padding(.horizontal, ACMSpacing.sm)
        .frame(height: 56)
    }

    @ViewBuilder
    private func participantRow(_ participant: Participant) -> some View {
        let displayName = viewModel.displayNameForUser(participant.id)
        let isScreenSharing = participant.isScreenSharing || viewModel.state.activeScreenShareUserId == participant.id
        let canPromoteParticipant = viewModel.state.isAdmin
            && !viewModel.state.isHostUser(participant.id)
            && !participant.isGhost
        let isPendingHostPromotion = pendingHostPromotionUserId == participant.id
        let isPromotingHost = promotingHostUserId == participant.id
        let isPendingRemoval = pendingKickUserId == participant.id
        let isRemovingUser = removingUserId == participant.id

        HStack(spacing: ACMSpacing.sm) {
            avatarView(displayName)

            HStack(spacing: ACMSpacing.xs) {
                Text(displayName)
                    .font(ACMFont.trial(15, weight: .medium))
                    .foregroundStyle(ACMColors.text)
                    .lineLimit(1)

                if viewModel.state.isHostUser(participant.id) {
                    MeetingSheetStatusPill(
                        "Host",
                        tint: ACMColors.primaryOrange,
                        background: ACMColors.primaryOrangeFaint,
                        border: ACMColors.primaryOrangeGhost
                    )
                }
            }

            Spacer()

            statusBadges(
                isHandRaised: participant.isHandRaised,
                isMuted: participant.isMuted,
                isCameraOff: participant.isCameraOff,
                isScreenSharing: isScreenSharing,
                isGhost: participant.isGhost
            )

            if viewModel.state.isAdmin {
                Menu {
                    if !participant.isCameraOff {
                        Button {
                            viewModel.turnOffParticipantCamera(userId: participant.id)
                        } label: {
                            Label {
                                Text("Turn off camera")
                            } icon: {
                                ACMSystemIcon.icon("video.slash.fill", android: "video.off", size: 16, tint: "danger")
                                    .foregroundStyle(ACMColors.error)
                            }
                        }
                    }

                    if isScreenSharing {
                        Button {
                            viewModel.stopParticipantScreenShare(userId: participant.id)
                        } label: {
                            Label {
                                Text("Stop screen share")
                            } icon: {
                                ACMSystemIcon.icon("rectangle.on.rectangle.slash", android: "screen.share.off", size: 16, tint: "danger")
                                    .foregroundStyle(ACMColors.error)
                            }
                        }
                    }

                    if !participant.isMuted {
                        Button {
                            viewModel.muteParticipant(userId: participant.id)
                        } label: {
                            Label {
                                Text("Mute")
                            } icon: {
                                ACMSystemIcon.icon("mic.slash.fill", android: "mic.off", size: 16, tint: "danger")
                                    .foregroundStyle(ACMColors.error)
                            }
                        }
                    }
                    if canPromoteParticipant {
                        if isPendingHostPromotion {
                            Button {
                                promoteHost(participant.id)
                            } label: {
                                Label {
                                    Text(isPromotingHost ? "Promoting" : "Confirm host")
                                } icon: {
                                    ACMSystemIcon.icon("crown.fill", android: "host", size: 16, tint: "accent")
                                        .foregroundStyle(ACMColors.primaryOrange)
                                }
                            }
                            .disabled(isPromotingHost)

                            Button {
                                if !isPromotingHost {
                                    pendingHostPromotionUserId = nil
                                }
                            } label: {
                                Label {
                                    Text("Cancel host change")
                                } icon: {
                                    ACMSystemIcon.icon("xmark", android: "close", size: 16, tint: "muted")
                                        .foregroundStyle(ACMColors.textMuted)
                                }
                            }
                            .disabled(isPromotingHost)
                        } else {
                            Button {
                                pendingHostPromotionUserId = participant.id
                            } label: {
                                Label {
                                    Text("Make host")
                                } icon: {
                                    ACMSystemIcon.icon("crown.fill", android: "host", size: 16, tint: "accent")
                                        .foregroundStyle(ACMColors.primaryOrange)
                                }
                            }
                        }
                    }
                    if isPendingRemoval {
                        Button {
                            removeParticipant(participant.id)
                        } label: {
                            Label {
                                Text(isRemovingUser ? "Removing" : "Confirm remove")
                            } icon: {
                                ACMSystemIcon.icon("person.fill.xmark", android: "remove.person", size: 16, tint: "danger")
                                    .foregroundStyle(ACMColors.error)
                            }
                        }
                        .disabled(isRemovingUser)

                        Button {
                            if !isRemovingUser {
                                pendingKickUserId = nil
                            }
                        } label: {
                            Label {
                                Text("Cancel remove")
                            } icon: {
                                ACMSystemIcon.icon("xmark", android: "close", size: 16, tint: "muted")
                                    .foregroundStyle(ACMColors.textMuted)
                            }
                        }
                        .disabled(isRemovingUser)
                    } else {
                        Button {
                            pendingKickUserId = participant.id
                        } label: {
                            Label {
                                Text("Remove from call")
                            } icon: {
                                ACMSystemIcon.icon("person.fill.xmark", android: "remove.person", size: 16, tint: "danger")
                                    .foregroundStyle(ACMColors.error)
                            }
                        }
                        .disabled(removingUserId != nil)
                    }
                } label: {
                    ACMSystemIcon.icon("ellipsis", android: "more", size: 18, tint: "muted")
                        .foregroundStyle(ACMColors.textMuted)
                        .frame(width: 36, height: 36)
                        .acmColorBackground(ACMColors.surfaceRaised)
                        .overlay {
                            RoundedRectangle(cornerRadius: ACMRadius.sm)
                                .strokeBorder(lineWidth: 1)
                                .foregroundStyle(ACMColors.border)
                        }
                        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
                }
            }
        }
        .padding(.horizontal, ACMSpacing.sm)
        .frame(height: 56)
    }

    var body: some View {
        let participants = viewModel.state.sortedParticipants
        let pendingUsers = viewModel.state.pendingUsers.sorted(by: { $0.value < $1.value })
        let dividerInset = ACMSpacing.sm + 40 + ACMSpacing.sm

        VStack(spacing: 0) {
            MeetingSheetHeader(title: "Participants", onBack: onBack, onDone: { dismiss() })

            if bodyReady {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: ACMSpacing.md) {
                    if viewModel.state.isAdmin {
                        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                            acmListSectionHeader("Host controls")

                            MeetingSheetSectionCard {
                                hostActionButton("Mute everyone", icon: "mic.slash.fill", androidIcon: "mic.off") {
                                    viewModel.muteAllParticipants()
                                }
                                MeetingSheetRowDivider(inset: ACMSpacing.sm + 32 + ACMSpacing.sm)
                                hostActionButton("Turn off cameras", icon: "video.slash.fill", androidIcon: "video.off") {
                                    viewModel.turnOffAllParticipantCameras()
                                }
                                MeetingSheetRowDivider(inset: ACMSpacing.sm + 32 + ACMSpacing.sm)
                                if viewModel.state.activeScreenShareUserId != nil {
                                    hostActionButton("Stop screen share", icon: "rectangle.on.rectangle.slash", androidIcon: "screen.share.off") {
                                        viewModel.stopAllScreenShares()
                                    }
                                    MeetingSheetRowDivider(inset: ACMSpacing.sm + 32 + ACMSpacing.sm)
                                }
                                if hasRaisedHands {
                                    hostActionButton("Clear raised hands", icon: "hand.raised.slash.fill", androidIcon: "raise.hand.off") {
                                        viewModel.clearAllRaisedHands()
                                    }
                                    MeetingSheetRowDivider(inset: ACMSpacing.sm + 32 + ACMSpacing.sm)
                                }
                                hostActionButton(
                                    viewModel.state.isRoomLocked ? "Unlock room" : "Lock room",
                                    icon: viewModel.state.isRoomLocked ? "lock.fill" : "lock.open.fill",
                                    androidIcon: viewModel.state.isRoomLocked ? "lock" : "lock.open",
                                    tint: viewModel.state.isRoomLocked ? ACMColors.primaryOrange : ACMColors.text,
                                    androidTint: viewModel.state.isRoomLocked ? "accent" : "text"
                                ) {
                                    viewModel.toggleRoomLock()
                                }
                                MeetingSheetRowDivider(inset: ACMSpacing.sm + 32 + ACMSpacing.sm)
                                hostActionButton(
                                    viewModel.state.isChatLocked ? "Unlock chat" : "Lock chat",
                                    icon: "message.fill",
                                    androidIcon: "chat",
                                    tint: viewModel.state.isChatLocked ? ACMColors.primaryOrange : ACMColors.text,
                                    androidTint: viewModel.state.isChatLocked ? "accent" : "text"
                                ) {
                                    viewModel.toggleChatLock()
                                }
                            }
                        }
                    }

                    if viewModel.state.isAdmin && viewModel.state.pendingUsersCount > 0 {
                        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                            acmListSectionHeader("Waiting to join")

                            MeetingSheetSectionCard {
                                pendingBulkActionRow()

                                MeetingSheetRowDivider(inset: ACMSpacing.sm)

                                ForEach(pendingUsers, id: \.key) { userId, name in
                                    pendingUserRow(userId: userId, name: name)

                                    if let last = pendingUsers.last {
                                        if userId != last.key {
                                            MeetingSheetRowDivider(inset: ACMSpacing.sm + 36 + ACMSpacing.sm)
                                        }
                                    }
                                }
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                        acmListSectionHeader("In this meeting (\(viewModel.state.participantCount))")

                        MeetingSheetSectionCard {
                            currentUserRow()

                            if !participants.isEmpty {
                                MeetingSheetRowDivider(inset: dividerInset)
                            }

                            ForEach(participants) { participant in
                                participantRow(participant)

                                if let last = participants.last {
                                    if participant.id != last.id {
                                        MeetingSheetRowDivider(inset: dividerInset)
                                    }
                                }
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
        .frame(maxWidth: .infinity, alignment: .top)
        #else
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        #endif
    }

    private func promoteHost(_ userId: String) {
        guard promotingHostUserId == nil else { return }
        promotingHostUserId = userId
        Task { @MainActor in
            await viewModel.makeHost(userId: userId)
            if pendingHostPromotionUserId == userId {
                pendingHostPromotionUserId = nil
            }
            if promotingHostUserId == userId {
                promotingHostUserId = nil
            }
        }
    }

    private func removeParticipant(_ userId: String) {
        guard removingUserId == nil else { return }
        removingUserId = userId
        Task { @MainActor in
            await viewModel.removeUser(userId: userId)
            if pendingKickUserId == userId {
                pendingKickUserId = nil
            }
            if removingUserId == userId {
                removingUserId = nil
            }
        }
    }
}
