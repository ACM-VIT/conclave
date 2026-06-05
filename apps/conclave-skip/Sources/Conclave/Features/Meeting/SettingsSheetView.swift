import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

// MARK: - Settings Sheet

struct SettingsSheetView: View {
    @Bindable var viewModel: MeetingViewModel
    @Environment(\.dismiss) var dismiss
    var onBack: (() -> Void)? = nil
    @State var displayNameInput = ""
    
    private var isDisplayNameEmpty: Bool {
        displayNameInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    @ViewBuilder
    private func rowLabel(_ title: String) -> some View {
        Text(title)
            .font(ACMFont.trial(15))
            .foregroundStyle(ACMColors.text)
            .lineLimit(1)
    }

    @ViewBuilder
    private func settingsToggleRow(_ title: String, icon: String, androidIcon: String, isOn: Binding<Bool>, isActive: Bool = false, isDisabled: Bool = false) -> some View {
        let iconTint = isDisabled ? ACMColors.textFaint : (isActive ? ACMColors.primaryOrange : ACMColors.textMuted)
        let androidTint = isDisabled ? "faint" : (isActive ? "accent" : "muted")

        Toggle(isOn: isOn) {
            HStack(spacing: ACMSpacing.sm) {
                MeetingSheetIconBox(
                    icon: icon,
                    androidIcon: androidIcon,
                    tint: iconTint,
                    androidTint: androidTint
                )

                Text(title)
                    .font(ACMFont.trial(15, weight: .medium))
                    .foregroundStyle(isDisabled ? ACMColors.textFaint : ACMColors.text)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, ACMSpacing.sm)
        .frame(height: 52)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.62 : 1.0)
    }

    @ViewBuilder
    private func displayNameRow() -> some View {
        HStack(spacing: ACMSpacing.sm) {
            MeetingSheetIconBox(
                icon: "person.crop.circle",
                androidIcon: "account",
                tint: ACMColors.textMuted,
                androidTint: "muted"
            )

            TextField("", text: $displayNameInput, prompt: Text("Display name").foregroundStyle(ACMColors.textFaint))
                .textFieldStyle(.plain)
                .font(ACMFont.trial(15))
                .foregroundStyle(ACMColors.text)
                .tint(ACMColors.primaryOrange)
#if !SKIP
#if os(iOS)
                .textInputAutocapitalization(.words)
#endif
#endif
                .autocorrectionDisabled(true)
                .onAppear {
                    displayNameInput = viewModel.state.displayName
                }
        }
        .padding(.horizontal, ACMSpacing.sm)
        .frame(height: 52)
    }

    @ViewBuilder
    private func updateDisplayNameRow() -> some View {
        Button {
            viewModel.updateDisplayName(displayNameInput)
        } label: {
            HStack(spacing: ACMSpacing.sm) {
                MeetingSheetIconBox(
                    icon: "paperplane.fill",
                    androidIcon: "send",
                    tint: isDisplayNameEmpty ? ACMColors.textFaint : Color.white,
                    androidTint: isDisplayNameEmpty ? "faint" : "white",
                    background: isDisplayNameEmpty ? ACMColors.surfaceRaised : ACMColors.primaryOrange
                )

                Text("Update display name")
                    .font(ACMFont.trial(15, weight: .medium))
                    .foregroundStyle(isDisplayNameEmpty ? ACMColors.textFaint : ACMColors.text)
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
        .disabled(isDisplayNameEmpty)
        .opacity(isDisplayNameEmpty ? 0.62 : 1.0)
    }

    @ViewBuilder
    private func qualityRow() -> some View {
        HStack(spacing: ACMSpacing.sm) {
            MeetingSheetIconBox(
                icon: "video.fill",
                androidIcon: "video",
                tint: ACMColors.textMuted,
                androidTint: "muted"
            )

            rowLabel("Quality")

            Spacer()

            Picker("", selection: Binding(
                get: { viewModel.state.videoQuality },
                set: { next in
                    viewModel.setVideoQuality(next)
                }
            )) {
                Text("Standard").tag(VideoQuality.standard)
                Text("Low").tag(VideoQuality.low)
            }
            .tint(ACMColors.primaryOrange)
        }
        .padding(.horizontal, ACMSpacing.sm)
        .frame(height: 52)
    }

    var body: some View {
        VStack(spacing: 0) {
            MeetingSheetHeader(title: "Settings", onBack: onBack, onDone: { dismiss() })

            ScrollView {
                VStack(alignment: .leading, spacing: ACMSpacing.md) {
                    if viewModel.state.isAdmin {
                        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                            acmListSectionHeader("Room")

                            MeetingSheetSectionCard {
                                settingsToggleRow(
                                    "Lock room",
                                    icon: viewModel.state.isRoomLocked ? "lock.fill" : "lock.open.fill",
                                    androidIcon: viewModel.state.isRoomLocked ? "lock" : "lock.open",
                                    isOn: Binding(
                                        get: { viewModel.state.isRoomLocked },
                                        set: { next in
                                            if next != viewModel.state.isRoomLocked {
                                                viewModel.toggleRoomLock()
                                            }
                                        }
                                    ),
                                    isActive: viewModel.state.isRoomLocked
                                )
                                MeetingSheetRowDivider(inset: ACMSpacing.sm + 32 + ACMSpacing.sm)
                                settingsToggleRow(
                                    "Lock chat",
                                    icon: "message.fill",
                                    androidIcon: "chat",
                                    isOn: Binding(
                                        get: { viewModel.state.isChatLocked },
                                        set: { next in
                                            if next != viewModel.state.isChatLocked {
                                                viewModel.toggleChatLock()
                                            }
                                        }
                                    ),
                                    isActive: viewModel.state.isChatLocked
                                )
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                        acmListSectionHeader("Profile")

                        MeetingSheetSectionCard {
                            displayNameRow()
                            MeetingSheetRowDivider(inset: ACMSpacing.sm + 32 + ACMSpacing.sm)
                            updateDisplayNameRow()
                        }
                    }

                    VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                        acmListSectionHeader("Audio and video")

                        MeetingSheetSectionCard {
                            settingsToggleRow(
                                "Microphone",
                                icon: viewModel.state.isMuted ? "mic.slash.fill" : "mic.fill",
                                androidIcon: viewModel.state.isMuted ? "mic.off" : "mic",
                                isOn: Binding(
                                    get: { !viewModel.state.isMuted },
                                    set: { next in
                                        let shouldMute = !next
                                        if shouldMute != viewModel.state.isMuted {
                                            viewModel.toggleMute()
                                        }
                                    }
                                ),
                                isActive: !viewModel.state.isMuted,
                                isDisabled: viewModel.state.isGhostMode
                            )
                            MeetingSheetRowDivider(inset: ACMSpacing.sm + 32 + ACMSpacing.sm)
                            settingsToggleRow(
                                "Camera",
                                icon: viewModel.state.isCameraOff ? "video.slash.fill" : "video.fill",
                                androidIcon: viewModel.state.isCameraOff ? "video.off" : "video",
                                isOn: Binding(
                                    get: { !viewModel.state.isCameraOff },
                                    set: { next in
                                        let shouldDisable = !next
                                        if shouldDisable != viewModel.state.isCameraOff {
                                            viewModel.toggleCamera()
                                        }
                                    }
                                ),
                                isActive: !viewModel.state.isCameraOff,
                                isDisabled: viewModel.state.isGhostMode
                            )
                        }
                    }

                    VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                        acmListSectionHeader("Video")

                        MeetingSheetSectionCard {
                            qualityRow()
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
