import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

// MARK: - Participants Sheet

// Styled section header shared by the meeting sheets — Carbon type ramp, and
// `.textCase(nil)` kills iOS's forced-uppercase system header.
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
    @Environment(\.dismiss) var dismiss
    var onBack: (() -> Void)? = nil

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
    private func statusBadges(isHandRaised: Bool, isMuted: Bool, isGhost: Bool = false) -> some View {
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
                viewModel.removeUser(userId: userId)
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

                if viewModel.state.isAdmin {
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
                isMuted: viewModel.state.isMuted
            )
        }
        .padding(.horizontal, ACMSpacing.sm)
        .frame(height: 56)
    }

    @ViewBuilder
    private func participantRow(_ participant: Participant) -> some View {
        let displayName = viewModel.displayNameForUser(participant.id)

        HStack(spacing: ACMSpacing.sm) {
            avatarView(displayName)

            Text(displayName)
                .font(ACMFont.trial(15, weight: .medium))
                .foregroundStyle(ACMColors.text)
                .lineLimit(1)

            Spacer()

            statusBadges(
                isHandRaised: participant.isHandRaised,
                isMuted: participant.isMuted,
                isGhost: participant.isGhost
            )

            if viewModel.state.isAdmin {
                Menu {
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
                    Button {
                        viewModel.makeHost(userId: participant.id)
                    } label: {
                        Label {
                            Text("Make host")
                        } icon: {
                            ACMSystemIcon.icon("crown.fill", android: "host", size: 16, tint: "accent")
                                .foregroundStyle(ACMColors.primaryOrange)
                        }
                    }
                    Button {
                        viewModel.removeUser(userId: participant.id)
                    } label: {
                        Label {
                            Text("Remove from call")
                        } icon: {
                            ACMSystemIcon.icon("person.fill.xmark", android: "remove.person", size: 16, tint: "danger")
                                .foregroundStyle(ACMColors.error)
                        }
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

            ScrollView {
                VStack(alignment: .leading, spacing: ACMSpacing.md) {
                    if viewModel.state.isAdmin {
                        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                            acmListSectionHeader("Host controls")

                            MeetingSheetSectionCard {
                                hostActionButton("Mute everyone", icon: "mic.slash.fill", androidIcon: "mic.off") {
                                    viewModel.muteAllParticipants()
                                }
                                MeetingSheetRowDivider(inset: ACMSpacing.sm + 32 + ACMSpacing.sm)
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
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}
