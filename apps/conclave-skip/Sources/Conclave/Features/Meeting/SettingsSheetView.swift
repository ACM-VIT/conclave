import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

// MARK: - Settings Sheet

enum SettingsSheetPage {
    case overview
    case room
    case roomAccess
    case roomCommunication
    case meetingInviteCode
    case webinar
    case webinarAccess
    case webinarCapacity
    case webinarInviteCode
    case webinarLink
    case profile
    case audioVideo
    case microphone
    case camera
    case speaker
}

struct SettingsSheetView: View {
    @Bindable var viewModel: MeetingViewModel
    @Bindable var appState: AppState = AppState.shared
    var bodyReady: Bool = true
    var page: SettingsSheetPage = .overview
    @Environment(\.dismiss) private var dismiss
    var onBack: (() -> Void)? = nil
    var onOpenRoomSettings: (() -> Void)? = nil
    var onOpenRoomAccessSettings: (() -> Void)? = nil
    var onOpenRoomCommunicationSettings: (() -> Void)? = nil
    var onOpenMeetingInviteCodeSettings: (() -> Void)? = nil
    var onOpenWebinarSettings: (() -> Void)? = nil
    var onOpenWebinarAccessSettings: (() -> Void)? = nil
    var onOpenWebinarCapacitySettings: (() -> Void)? = nil
    var onOpenWebinarInviteCodeSettings: (() -> Void)? = nil
    var onOpenWebinarLinkSettings: (() -> Void)? = nil
    var onOpenProfileSettings: (() -> Void)? = nil
    var onOpenAudioVideoSettings: (() -> Void)? = nil
    var onOpenMicrophoneSettings: (() -> Void)? = nil
    var onOpenCameraSettings: (() -> Void)? = nil
    var onOpenSpeakerSettings: (() -> Void)? = nil
    @State private var displayNameInput = ""
    @State private var meetingInviteCodeInput = ""
    @State private var webinarInviteCodeInput = ""
    @State private var webinarMaxAttendeesInput = ""
    @State private var webinarLinkCodeInput = ""
    @State private var didCopyWebinarLink = false
    @State private var webinarLinkCopyFeedbackGeneration = 0
    @State private var isConfirmingWebinarLinkRotation = false

    private var isDisplayNameEmpty: Bool {
        displayNameInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var isMeetingInviteCodeEmpty: Bool {
        meetingInviteCodeInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var roomAccessSummary: String {
        let lockState = viewModel.state.isRoomLocked ? "Locked" : "Open"
        let guestState = viewModel.state.isNoGuests ? "Guests blocked" : "Guests allowed"
        return "\(lockState), \(guestState)"
    }

    private var roomCommunicationSummary: String {
        let chatState = viewModel.state.isChatLocked ? "Chat locked" : "Chat open"
        let dmState = viewModel.state.isDmEnabled ? "DMs on" : "DMs off"
        let ttsState = viewModel.state.isTtsDisabled ? "TTS off" : "TTS on"
        return "\(chatState), \(dmState), \(ttsState)"
    }

    private var meetingInviteCodeSummary: String {
        viewModel.state.meetingRequiresInviteCode ? "Required before joining" : "Not required"
    }

    private var webinarAccessSummary: String {
        let accessState = viewModel.state.isWebinarPublicAccess ? "Public access" : "Private access"
        let lockState = viewModel.state.isWebinarLocked ? "Locked" : "Open"
        return "\(accessState), \(lockState)"
    }

    private var webinarCapacitySummary: String {
        "\(viewModel.state.webinarAttendeeCount) / \(viewModel.state.webinarMaxAttendees) attendees"
    }

    private var webinarInviteCodeSummary: String {
        viewModel.state.webinarRequiresInviteCode ? "Required for attendees" : "Not required"
    }

    private var webinarLinkSummary: String {
        if let slug = viewModel.state.webinarLinkSlug, !slug.isEmpty {
            return "/w/\(slug)"
        }
        return "No link generated"
    }

    private var microphoneSummary: String {
        if viewModel.state.mediaPublishingDisabled {
            return "Publishing disabled"
        }
        let state = viewModel.state.isMuted ? "Muted" : "On"
        guard let label = selectedAudioInputLabel() else { return state }
        return "\(state), \(label)"
    }

    private var cameraSummary: String {
        let cameraState = viewModel.state.isCameraOff ? "Off" : "On"
        let quality = viewModel.state.videoQuality == .low ? "low bandwidth" : "standard"
        if viewModel.state.mediaPublishingDisabled {
            return "Publishing disabled, \(quality)"
        }
        return "\(cameraState), \(quality)"
    }

    private var speakerSummary: String {
        selectedAudioOutputLabel() ?? "System default"
    }

    private var title: String {
        switch page {
        case .overview:
            return "Settings"
        case .room:
            return "Room"
        case .roomAccess:
            return "Access"
        case .roomCommunication:
            return "Messages"
        case .meetingInviteCode:
            return "Invite code"
        case .webinar:
            return "Webinar"
        case .webinarAccess:
            return "Attendee access"
        case .webinarCapacity:
            return "Capacity"
        case .webinarInviteCode:
            return "Invite code"
        case .webinarLink:
            return "Webinar link"
        case .profile:
            return "Profile"
        case .audioVideo:
            return "Audio and video"
        case .microphone:
            return "Microphone"
        case .camera:
            return "Camera"
        case .speaker:
            return "Speaker"
        }
    }

    private var webinarMaxAttendeesValue: Int? {
        let trimmed = webinarMaxAttendeesInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value = Int(trimmed), (1...5000).contains(value) else { return nil }
        return value
    }

    private var sanitizedWebinarLinkInput: String {
        sanitizeWebinarLinkCode(webinarLinkCodeInput)
    }

    private var isWebinarLinkInputValid: Bool {
        let candidate = sanitizedWebinarLinkInput
        return candidate.isEmpty || (3...32).contains(candidate.count)
    }

    private func syncWebinarCapacityDraftFromState() {
        webinarMaxAttendeesInput = "\(viewModel.state.webinarMaxAttendees)"
    }

    private func syncWebinarLinkDraftFromState() {
        webinarLinkCodeInput = viewModel.state.webinarLinkSlug ?? ""
    }

    private func syncWebinarDraftsFromState() {
        syncWebinarCapacityDraftFromState()
        syncWebinarLinkDraftFromState()
    }

    private func selectedAudioInputLabel() -> String? {
        guard let selectedId = viewModel.currentAudioInputId(), !selectedId.isEmpty else { return nil }
        return viewModel.availableAudioInputs().first { $0.id == selectedId }?.label
    }

    private func selectedAudioOutputLabel() -> String? {
        guard let selectedId = viewModel.currentAudioOutputId(), !selectedId.isEmpty else { return nil }
        return viewModel.availableAudioOutputs().first { $0.id == selectedId }?.label
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
    private func settingsNavigationRow(
        _ title: String,
        subtitle: String,
        icon: String,
        androidIcon: String,
        isActive: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: ACMSpacing.sm) {
                MeetingSheetIconBox(
                    icon: icon,
                    androidIcon: androidIcon,
                    tint: isActive ? ACMColors.primaryOrange : ACMColors.textMuted,
                    androidTint: isActive ? "accent" : "muted"
                )

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(ACMFont.trial(15, weight: .medium))
                        .foregroundStyle(ACMColors.text)
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
            .frame(height: 58)
            .frame(maxWidth: .infinity, alignment: .leading)
            #if !SKIP
            .contentShape(Rectangle())
            #endif
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func meetingInviteCodeRow() -> some View {
        VStack(alignment: .leading, spacing: ACMSpacing.sm) {
            HStack(spacing: ACMSpacing.sm) {
                MeetingSheetIconBox(
                    icon: "key.fill",
                    androidIcon: "key",
                    tint: viewModel.state.meetingRequiresInviteCode ? ACMColors.primaryOrange : ACMColors.textMuted,
                    androidTint: viewModel.state.meetingRequiresInviteCode ? "accent" : "muted"
                )

                Text("Meeting invite code")
                    .font(ACMFont.trial(15, weight: .medium))
                    .foregroundStyle(ACMColors.text)
                    .lineLimit(1)

                Spacer()

                Text(viewModel.state.meetingRequiresInviteCode ? "Protected" : "Open")
                    .font(ACMFont.trial(12, weight: .medium))
                    .foregroundStyle(viewModel.state.meetingRequiresInviteCode ? ACMColors.primaryOrange : ACMColors.textFaint)
                    .lineLimit(1)
            }

            TextField("", text: $meetingInviteCodeInput, prompt: Text("Invite code").foregroundStyle(ACMColors.textFaint))
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
                .padding(.horizontal, ACMSpacing.sm)
                .frame(height: 44)
                .acmColorBackground(ACMColors.surfaceRaised)
                .overlay {
                    RoundedRectangle(cornerRadius: ACMRadius.sm)
                        .strokeBorder(lineWidth: 1)
                        .foregroundStyle(ACMColors.border)
                }
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))

            HStack(spacing: ACMSpacing.sm) {
                Button {
                    viewModel.setMeetingInviteCode(meetingInviteCodeInput)
                } label: {
                    HStack(spacing: 6) {
                        ACMSystemIcon.icon("checkmark", android: "check", size: 13, tint: isMeetingInviteCodeEmpty ? "faint" : "white")
                        Text("Set")
                            .font(ACMFont.trial(14, weight: .medium))
                    }
                    .foregroundStyle(isMeetingInviteCodeEmpty ? ACMColors.textFaint : Color.white)
                    .frame(maxWidth: .infinity)
                    .frame(height: 40)
                    .acmColorBackground(isMeetingInviteCodeEmpty ? ACMColors.surfaceRaised : ACMColors.primaryOrange)
                    .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
                }
                .buttonStyle(.plain)
                .disabled(isMeetingInviteCodeEmpty)

                Button {
                    viewModel.clearMeetingInviteCode()
                    meetingInviteCodeInput = ""
                } label: {
                    HStack(spacing: 6) {
                        ACMSystemIcon.icon("trash", android: "delete", size: 13, tint: viewModel.state.meetingRequiresInviteCode ? "danger" : "faint")
                        Text("Remove")
                            .font(ACMFont.trial(14, weight: .medium))
                    }
                    .foregroundStyle(viewModel.state.meetingRequiresInviteCode ? ACMColors.error : ACMColors.textFaint)
                    .frame(maxWidth: .infinity)
                    .frame(height: 40)
                    .acmColorBackground(ACMColors.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
                }
                .buttonStyle(.plain)
                .disabled(!viewModel.state.meetingRequiresInviteCode)
            }
        }
        .padding(ACMSpacing.sm)
    }

    @ViewBuilder
    private func webinarSection() -> some View {
        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
            acmListSectionHeader("Webinar")

            MeetingSheetSectionCard {
                settingsToggleRow(
                    viewModel.state.isWebinarEnabled ? "Webinar mode" : "Start webinar mode",
                    icon: "person.2.fill",
                    androidIcon: "participants",
                    isOn: Binding(
                        get: { viewModel.state.isWebinarEnabled },
                        set: { next in
                            if next != viewModel.state.isWebinarEnabled {
                                viewModel.toggleWebinarEnabled()
                            }
                        }
                    ),
                    isActive: viewModel.state.isWebinarEnabled
                )

                if viewModel.state.isWebinarEnabled {
                    MoreRowDivider()
                    settingsNavigationRow(
                        "Attendee access",
                        subtitle: webinarAccessSummary,
                        icon: viewModel.state.isWebinarLocked ? "lock.fill" : "globe",
                        androidIcon: viewModel.state.isWebinarLocked ? "lock" : "public",
                        isActive: viewModel.state.isWebinarPublicAccess || viewModel.state.isWebinarLocked
                    ) {
                        onOpenWebinarAccessSettings?()
                    }
                    MoreRowDivider()
                    settingsNavigationRow(
                        "Capacity",
                        subtitle: webinarCapacitySummary,
                        icon: "person.2.fill",
                        androidIcon: "participants"
                    ) {
                        onOpenWebinarCapacitySettings?()
                    }
                    MoreRowDivider()
                    settingsNavigationRow(
                        "Attendee invite code",
                        subtitle: webinarInviteCodeSummary,
                        icon: "key.fill",
                        androidIcon: "key",
                        isActive: viewModel.state.webinarRequiresInviteCode
                    ) {
                        onOpenWebinarInviteCodeSettings?()
                    }
                    MoreRowDivider()
                    settingsNavigationRow(
                        "Webinar link",
                        subtitle: webinarLinkSummary,
                        icon: "link",
                        androidIcon: "link",
                        isActive: viewModel.state.webinarLinkSlug != nil
                    ) {
                        onOpenWebinarLinkSettings?()
                    }
                }
            }
            .onAppear {
                if webinarMaxAttendeesInput.isEmpty {
                    webinarMaxAttendeesInput = "\(viewModel.state.webinarMaxAttendees)"
                }
                if webinarLinkCodeInput.isEmpty {
                    webinarLinkCodeInput = viewModel.state.webinarLinkSlug ?? ""
                }
            }
        }
    }

    @ViewBuilder
    private var webinarAccessSettingsContent: some View {
        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
            acmListSectionHeader("Attendee access")

            MeetingSheetSectionCard {
                settingsToggleRow(
                    "Public access",
                    icon: "globe",
                    androidIcon: "public",
                    isOn: Binding(
                        get: { viewModel.state.isWebinarPublicAccess },
                        set: { next in
                            if next != viewModel.state.isWebinarPublicAccess {
                                viewModel.toggleWebinarPublicAccess()
                            }
                        }
                    ),
                    isActive: viewModel.state.isWebinarPublicAccess
                )
                MoreRowDivider()
                settingsToggleRow(
                    "Lock attendees",
                    icon: viewModel.state.isWebinarLocked ? "lock.fill" : "lock.open.fill",
                    androidIcon: viewModel.state.isWebinarLocked ? "lock" : "lock.open",
                    isOn: Binding(
                        get: { viewModel.state.isWebinarLocked },
                        set: { next in
                            if next != viewModel.state.isWebinarLocked {
                                viewModel.toggleWebinarLocked()
                            }
                        }
                    ),
                    isActive: viewModel.state.isWebinarLocked
                )
            }
        }
    }

    @ViewBuilder
    private var webinarCapacitySettingsContent: some View {
        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
            acmListSectionHeader("Capacity")

            MeetingSheetSectionCard {
                webinarCapacityRow()
            }
        }
    }

    @ViewBuilder
    private var webinarInviteCodeSettingsContent: some View {
        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
            acmListSectionHeader("Invite code")

            MeetingSheetSectionCard {
                webinarInviteCodeRow()
            }
        }
    }

    @ViewBuilder
    private var webinarLinkSettingsContent: some View {
        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
            acmListSectionHeader("Webinar link")

            MeetingSheetSectionCard {
                webinarLinkRow()
            }
        }
    }

    @ViewBuilder
    private func webinarCapacityRow() -> some View {
        VStack(alignment: .leading, spacing: ACMSpacing.sm) {
            HStack(spacing: ACMSpacing.sm) {
                MeetingSheetIconBox(
                    icon: "person.2.fill",
                    androidIcon: "participants",
                    tint: ACMColors.textMuted,
                    androidTint: "muted"
                )

                Text("Max attendees")
                    .font(ACMFont.trial(15, weight: .medium))
                    .foregroundStyle(ACMColors.text)
                    .lineLimit(1)

                Spacer()

                Text("\(viewModel.state.webinarAttendeeCount) / \(viewModel.state.webinarMaxAttendees)")
                    .font(ACMFont.trial(12, weight: .medium))
                    .foregroundStyle(ACMColors.textFaint)
                    .lineLimit(1)
            }

            HStack(spacing: ACMSpacing.sm) {
                TextField("", text: $webinarMaxAttendeesInput, prompt: Text("500").foregroundStyle(ACMColors.textFaint))
                    .textFieldStyle(.plain)
                    .font(ACMFont.trial(15))
                    .foregroundStyle(ACMColors.text)
                    .tint(ACMColors.primaryOrange)
#if !SKIP
#if os(iOS)
                    .keyboardType(.numberPad)
#endif
#endif
                    .padding(.horizontal, ACMSpacing.sm)
                    .frame(height: 40)
                    .acmColorBackground(ACMColors.surfaceRaised)
                    .overlay {
                        RoundedRectangle(cornerRadius: ACMRadius.sm)
                            .strokeBorder(lineWidth: 1)
                            .foregroundStyle(ACMColors.border)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))

                Button {
                    if let value = webinarMaxAttendeesValue {
                        viewModel.setWebinarMaxAttendees(value)
                        webinarMaxAttendeesInput = "\(value)"
                    }
                } label: {
                    Text("Save")
                        .font(ACMFont.trial(14, weight: .medium))
                        .foregroundStyle(webinarMaxAttendeesValue == nil ? ACMColors.textFaint : Color.white)
                        .frame(width: 72, height: 40)
                        .acmColorBackground(webinarMaxAttendeesValue == nil ? ACMColors.surfaceRaised : ACMColors.primaryOrange)
                        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
                }
                .buttonStyle(.plain)
                .disabled(webinarMaxAttendeesValue == nil)
            }
        }
        .padding(ACMSpacing.sm)
    }

    @ViewBuilder
    private func webinarInviteCodeRow() -> some View {
        VStack(alignment: .leading, spacing: ACMSpacing.sm) {
            HStack(spacing: ACMSpacing.sm) {
                MeetingSheetIconBox(
                    icon: "key.fill",
                    androidIcon: "key",
                    tint: viewModel.state.webinarRequiresInviteCode ? ACMColors.primaryOrange : ACMColors.textMuted,
                    androidTint: viewModel.state.webinarRequiresInviteCode ? "accent" : "muted"
                )

                Text("Attendee invite code")
                    .font(ACMFont.trial(15, weight: .medium))
                    .foregroundStyle(ACMColors.text)
                    .lineLimit(1)

                Spacer()

                Text(viewModel.state.webinarRequiresInviteCode ? "Protected" : "Open")
                    .font(ACMFont.trial(12, weight: .medium))
                    .foregroundStyle(viewModel.state.webinarRequiresInviteCode ? ACMColors.primaryOrange : ACMColors.textFaint)
                    .lineLimit(1)
            }

            TextField("", text: $webinarInviteCodeInput, prompt: Text("Invite code").foregroundStyle(ACMColors.textFaint))
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
                .padding(.horizontal, ACMSpacing.sm)
                .frame(height: 40)
                .acmColorBackground(ACMColors.surfaceRaised)
                .overlay {
                    RoundedRectangle(cornerRadius: ACMRadius.sm)
                        .strokeBorder(lineWidth: 1)
                        .foregroundStyle(ACMColors.border)
                }
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))

            HStack(spacing: ACMSpacing.sm) {
                let isEmpty = webinarInviteCodeInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                Button {
                    viewModel.setWebinarInviteCode(webinarInviteCodeInput)
                } label: {
                    Text("Set")
                        .font(ACMFont.trial(14, weight: .medium))
                        .foregroundStyle(isEmpty ? ACMColors.textFaint : Color.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 40)
                        .acmColorBackground(isEmpty ? ACMColors.surfaceRaised : ACMColors.primaryOrange)
                        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
                }
                .buttonStyle(.plain)
                .disabled(isEmpty)

                Button {
                    viewModel.clearWebinarInviteCode()
                    webinarInviteCodeInput = ""
                } label: {
                    Text("Remove")
                        .font(ACMFont.trial(14, weight: .medium))
                        .foregroundStyle(viewModel.state.webinarRequiresInviteCode ? ACMColors.error : ACMColors.textFaint)
                        .frame(maxWidth: .infinity)
                        .frame(height: 40)
                        .acmColorBackground(ACMColors.surfaceRaised)
                        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
                }
                .buttonStyle(.plain)
                .disabled(!viewModel.state.webinarRequiresInviteCode)
            }
        }
        .padding(ACMSpacing.sm)
    }

    @ViewBuilder
    private func webinarLinkRow() -> some View {
        VStack(alignment: .leading, spacing: ACMSpacing.sm) {
            HStack(spacing: ACMSpacing.sm) {
                MeetingSheetIconBox(
                    icon: "link",
                    androidIcon: "link",
                    tint: viewModel.state.webinarLinkSlug == nil ? ACMColors.textMuted : ACMColors.primaryOrange,
                    androidTint: viewModel.state.webinarLinkSlug == nil ? "muted" : "accent"
                )

                Text("Webinar link")
                    .font(ACMFont.trial(15, weight: .medium))
                    .foregroundStyle(ACMColors.text)
                    .lineLimit(1)

                Spacer()
            }

            Text(viewModel.state.webinarLinkURL ?? webinarLinkLabel)
                .font(ACMFont.trial(13))
                .foregroundStyle(ACMColors.textFaint)
                .lineLimit(1)
                .padding(.horizontal, ACMSpacing.sm)
                .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                .acmColorBackground(ACMColors.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))

            TextField("", text: Binding(
                get: { webinarLinkCodeInput },
                set: { webinarLinkCodeInput = sanitizeWebinarLinkCode($0) }
            ), prompt: Text("custom-link").foregroundStyle(ACMColors.textFaint))
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
                .padding(.horizontal, ACMSpacing.sm)
                .frame(height: 40)
                .acmColorBackground(ACMColors.surfaceRaised)
                .overlay {
                    RoundedRectangle(cornerRadius: ACMRadius.sm)
                        .strokeBorder(lineWidth: 1)
                        .foregroundStyle(ACMColors.border)
                }
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))

            HStack(spacing: ACMSpacing.sm) {
                Button {
                    viewModel.setWebinarLinkSlug(sanitizedWebinarLinkInput)
                    webinarLinkCodeInput = sanitizedWebinarLinkInput
                    isConfirmingWebinarLinkRotation = false
                } label: {
                    Text("Set link")
                        .font(ACMFont.trial(14, weight: .medium))
                        .foregroundStyle(!isWebinarLinkInputValid || sanitizedWebinarLinkInput.isEmpty ? ACMColors.textFaint : Color.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 40)
                        .acmColorBackground(!isWebinarLinkInputValid || sanitizedWebinarLinkInput.isEmpty ? ACMColors.surfaceRaised : ACMColors.primaryOrange)
                        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
                }
                .buttonStyle(.plain)
                .disabled(!isWebinarLinkInputValid || sanitizedWebinarLinkInput.isEmpty)

                Button {
                    viewModel.clearWebinarLinkSlug()
                    webinarLinkCodeInput = ""
                    isConfirmingWebinarLinkRotation = false
                } label: {
                    Text("Clear")
                        .font(ACMFont.trial(14, weight: .medium))
                        .foregroundStyle(viewModel.state.webinarLinkSlug == nil ? ACMColors.textFaint : ACMColors.error)
                        .frame(maxWidth: .infinity)
                        .frame(height: 40)
                        .acmColorBackground(ACMColors.surfaceRaised)
                        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
                }
                .buttonStyle(.plain)
                .disabled(viewModel.state.webinarLinkSlug == nil)
            }

            HStack(spacing: ACMSpacing.sm) {
                Button {
                    Task {
                        if let link = await viewModel.copyableWebinarLink() {
                            isConfirmingWebinarLinkRotation = false
                            copyWebinarLink(link)
                        }
                    }
                } label: {
                    Text(didCopyWebinarLink ? "Copied" : (viewModel.state.webinarLinkSlug == nil ? "Generate" : "Copy"))
                        .font(ACMFont.trial(14, weight: .medium))
                        .foregroundStyle(Color.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 40)
                        .acmColorBackground(didCopyWebinarLink ? ACMColors.success : ACMColors.primaryOrange)
                        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
                }
                .buttonStyle(.plain)

                if isConfirmingWebinarLinkRotation {
                    Button {
                        Task {
                            if let link = await viewModel.rotateWebinarLink() {
                                webinarLinkCodeInput = viewModel.state.webinarLinkSlug ?? ""
                                isConfirmingWebinarLinkRotation = false
                                copyWebinarLink(link)
                            }
                        }
                    } label: {
                        Text("Confirm")
                            .font(ACMFont.trial(14, weight: .medium))
                            .foregroundStyle(Color.white)
                            .frame(maxWidth: .infinity)
                            .frame(height: 40)
                            .acmColorBackground(ACMColors.error)
                            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
                    }
                    .buttonStyle(.plain)

                    Button {
                        isConfirmingWebinarLinkRotation = false
                    } label: {
                        Text("Cancel")
                            .font(ACMFont.trial(14, weight: .medium))
                            .foregroundStyle(ACMColors.text)
                            .frame(maxWidth: .infinity)
                            .frame(height: 40)
                            .acmColorBackground(ACMColors.surfaceRaised)
                            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
                    }
                    .buttonStyle(.plain)
                } else if viewModel.state.webinarLinkSlug != nil {
                    Button {
                        isConfirmingWebinarLinkRotation = true
                    } label: {
                        Text("Rotate")
                            .font(ACMFont.trial(14, weight: .medium))
                            .foregroundStyle(ACMColors.text)
                            .frame(maxWidth: .infinity)
                            .frame(height: 40)
                            .acmColorBackground(ACMColors.surfaceRaised)
                            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(ACMSpacing.sm)
    }

    private var webinarLinkLabel: String {
        if let slug = viewModel.state.webinarLinkSlug, !slug.isEmpty {
            return "/w/\(slug)"
        }
        return "No link generated"
    }

    private func sanitizeWebinarLinkCode(_ value: String) -> String {
        let allowed = "abcdefghijklmnopqrstuvwxyz0123456789-"
        var sanitized = ""
        for character in value.lowercased() {
            if allowed.contains(character) {
                sanitized += String(character)
                if sanitized.count >= 32 {
                    break
                }
            }
        }
        return sanitized
    }

    private func copyWebinarLink(_ link: String) {
        #if !SKIP
#if canImport(UIKit)
        UIPasteboard.general.string = link
#endif
        HapticManager.shared.trigger(.success)
        #else
        ClipboardHelper.copyToClipboard(text: link, label: "Webinar link")
        #endif
        webinarLinkCopyFeedbackGeneration += 1
        let generation = webinarLinkCopyFeedbackGeneration
        didCopyWebinarLink = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_600_000_000)
            guard webinarLinkCopyFeedbackGeneration == generation else { return }
            didCopyWebinarLink = false
        }
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
    private func accountRow(_ user: AppState.User) -> some View {
        HStack(spacing: ACMSpacing.sm) {
            MeetingSheetIconBox(
                icon: "person.crop.circle.badge.checkmark",
                androidIcon: "account",
                tint: user.provider == .guest ? ACMColors.textMuted : ACMColors.primaryOrange,
                androidTint: user.provider == .guest ? "muted" : "accent"
            )

            VStack(alignment: .leading, spacing: 2) {
                Text(accountTitle(for: user))
                    .font(ACMFont.trial(15, weight: .medium))
                    .foregroundStyle(ACMColors.text)
                    .lineLimit(1)
                Text(accountSubtitle(for: user))
                    .font(ACMFont.trial(12))
                    .foregroundStyle(ACMColors.textFaint)
                    .lineLimit(1)
            }

            Spacer()
        }
        .padding(.horizontal, ACMSpacing.sm)
        .frame(height: 58)
    }

    @ViewBuilder
    private func signOutRow() -> some View {
        Button {
            appState.clearAuthentication()
        } label: {
            HStack(spacing: ACMSpacing.sm) {
                MeetingSheetIconBox(
                    icon: "person.crop.circle.badge.xmark",
                    androidIcon: "remove.person",
                    tint: ACMColors.error,
                    androidTint: "danger"
                )

                Text("Sign out")
                    .font(ACMFont.trial(15, weight: .medium))
                    .foregroundStyle(ACMColors.error)
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

    private func accountTitle(for user: AppState.User) -> String {
        if user.provider == .guest {
            return "Guest"
        }
        let name = user.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? "Signed in" : name
    }

    private func accountSubtitle(for user: AppState.User) -> String {
        if user.provider == .guest {
            return "Temporary meeting identity"
        }
        let provider = user.provider == .apple ? "Apple" : "Google"
        let email = user.email?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return email.isEmpty ? "Signed in with \(provider)" : email
    }

    @ViewBuilder
    private func microphoneInputRow() -> some View {
        let inputs = viewModel.availableAudioInputs()
        HStack(spacing: ACMSpacing.sm) {
            MeetingSheetIconBox(
                icon: "mic.fill",
                androidIcon: "mic",
                tint: ACMColors.textMuted,
                androidTint: "muted"
            )

            rowLabel("Microphone")

            Spacer()

            Picker("", selection: Binding(
                get: { viewModel.currentAudioInputId() ?? "" },
                set: { next in
                    if !next.isEmpty {
                        viewModel.setAudioInput(next)
                    }
                }
            )) {
                ForEach(inputs) { device in
                    Text(device.label).tag(device.id)
                }
            }
            .tint(ACMColors.primaryOrange)
            .disabled(inputs.isEmpty)
        }
        .padding(.horizontal, ACMSpacing.sm)
        .frame(height: 52)
    }

    @ViewBuilder
    private func audioOutputRow() -> some View {
        let outputs = viewModel.availableAudioOutputs()
        HStack(spacing: ACMSpacing.sm) {
            MeetingSheetIconBox(
                icon: "speaker.wave.2.fill",
                androidIcon: "volume",
                tint: ACMColors.textMuted,
                androidTint: "muted"
            )

            rowLabel("Speaker")

            Spacer()

            Picker("", selection: Binding(
                get: { viewModel.currentAudioOutputId() ?? "" },
                set: { next in
                    if !next.isEmpty {
                        viewModel.setAudioOutput(next)
                    }
                }
            )) {
                ForEach(outputs) { device in
                    Text(device.label).tag(device.id)
                }
            }
            .tint(ACMColors.primaryOrange)
            .disabled(outputs.isEmpty)
        }
        .padding(.horizontal, ACMSpacing.sm)
        .frame(height: 52)
    }

    @ViewBuilder
    private func testSpeakerRow() -> some View {
        Button {
            viewModel.testSpeaker()
        } label: {
            HStack(spacing: ACMSpacing.sm) {
                MeetingSheetIconBox(
                    icon: "speaker.wave.2.fill",
                    androidIcon: "volume",
                    tint: ACMColors.primaryOrange,
                    androidTint: "accent"
                )

                Text("Test speaker")
                    .font(ACMFont.trial(15, weight: .medium))
                    .foregroundStyle(ACMColors.text)
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

    @ViewBuilder
    private var settingsContent: some View {
        switch page {
        case .overview:
            overviewContent
        case .room:
            roomSettingsContent
        case .roomAccess:
            roomAccessSettingsContent
        case .roomCommunication:
            roomCommunicationSettingsContent
        case .meetingInviteCode:
            meetingInviteCodeSettingsContent
        case .webinar:
            webinarSection()
        case .webinarAccess:
            webinarAccessSettingsContent
        case .webinarCapacity:
            webinarCapacitySettingsContent
        case .webinarInviteCode:
            webinarInviteCodeSettingsContent
        case .webinarLink:
            webinarLinkSettingsContent
        case .profile:
            profileSettingsContent
        case .audioVideo:
            audioVideoSettingsContent
        case .microphone:
            microphoneSettingsContent
        case .camera:
            cameraSettingsContent
        case .speaker:
            speakerSettingsContent
        }
    }

    @ViewBuilder
    private var overviewContent: some View {
        if viewModel.state.isAdmin {
            VStack(alignment: .leading, spacing: ACMSpacing.xs) {
                acmListSectionHeader("Host controls")

                MeetingSheetSectionCard {
                    settingsNavigationRow(
                        "Room controls",
                        subtitle: viewModel.state.meetingRequiresInviteCode ? "Invite code required" : "Locks, guests, chat, invite code",
                        icon: viewModel.state.isRoomLocked ? "lock.fill" : "lock.open.fill",
                        androidIcon: viewModel.state.isRoomLocked ? "lock" : "lock.open",
                        isActive: viewModel.state.isRoomLocked || viewModel.state.isChatLocked || viewModel.state.isNoGuests || viewModel.state.meetingRequiresInviteCode
                    ) {
                        onOpenRoomSettings?()
                    }
                    MoreRowDivider()
                    settingsNavigationRow(
                        "Webinar",
                        subtitle: viewModel.state.isWebinarEnabled ? "\(viewModel.state.webinarAttendeeCount) attendees" : "Mode, access, links",
                        icon: "person.2.fill",
                        androidIcon: "participants",
                        isActive: viewModel.state.isWebinarEnabled
                    ) {
                        onOpenWebinarSettings?()
                    }
                }
            }
        }

        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
            acmListSectionHeader("Personal")

            MeetingSheetSectionCard {
                settingsNavigationRow(
                    "Profile",
                    subtitle: viewModel.state.displayName.isEmpty ? "Display name" : viewModel.state.displayName,
                    icon: "person.crop.circle",
                    androidIcon: "account"
                ) {
                    onOpenProfileSettings?()
                }
                MoreRowDivider()
                settingsNavigationRow(
                    "Audio and video",
                    subtitle: viewModel.state.mediaPublishingDisabled ? "Publishing disabled" : "Mic, camera, speaker",
                    icon: viewModel.state.isMuted ? "mic.slash.fill" : "mic.fill",
                    androidIcon: viewModel.state.isMuted ? "mic.off" : "mic",
                    isActive: !viewModel.state.isMuted || !viewModel.state.isCameraOff
                ) {
                    onOpenAudioVideoSettings?()
                }
            }
        }
    }

    @ViewBuilder
    private var roomSettingsContent: some View {
        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
            acmListSectionHeader("Room")

            MeetingSheetSectionCard {
                settingsNavigationRow(
                    "Access",
                    subtitle: roomAccessSummary,
                    icon: viewModel.state.isRoomLocked ? "lock.fill" : "lock.open.fill",
                    androidIcon: viewModel.state.isRoomLocked ? "lock" : "lock.open",
                    isActive: viewModel.state.isRoomLocked || viewModel.state.isNoGuests
                ) {
                    onOpenRoomAccessSettings?()
                }
                MoreRowDivider()
                settingsNavigationRow(
                    "Messages",
                    subtitle: roomCommunicationSummary,
                    icon: "message.fill",
                    androidIcon: "chat",
                    isActive: viewModel.state.isChatLocked || !viewModel.state.isDmEnabled || viewModel.state.isTtsDisabled
                ) {
                    onOpenRoomCommunicationSettings?()
                }
                MoreRowDivider()
                settingsNavigationRow(
                    "Invite code",
                    subtitle: meetingInviteCodeSummary,
                    icon: "key.fill",
                    androidIcon: "key",
                    isActive: viewModel.state.meetingRequiresInviteCode
                ) {
                    onOpenMeetingInviteCodeSettings?()
                }
            }
        }
    }

    @ViewBuilder
    private var roomAccessSettingsContent: some View {
        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
            acmListSectionHeader("Access")

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
                MoreRowDivider()
                settingsToggleRow(
                    "Block guests",
                    icon: "nosign",
                    androidIcon: "block",
                    isOn: Binding(
                        get: { viewModel.state.isNoGuests },
                        set: { next in
                            if next != viewModel.state.isNoGuests {
                                viewModel.toggleNoGuests()
                            }
                        }
                    ),
                    isActive: viewModel.state.isNoGuests
                )
            }
        }
    }

    @ViewBuilder
    private var roomCommunicationSettingsContent: some View {
        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
            acmListSectionHeader("Messages")

            MeetingSheetSectionCard {
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
                MoreRowDivider()
                settingsToggleRow(
                    "Direct messages",
                    icon: "bubble.left.and.bubble.right.fill",
                    androidIcon: "forum",
                    isOn: Binding(
                        get: { viewModel.state.isDmEnabled },
                        set: { next in
                            if next != viewModel.state.isDmEnabled {
                                viewModel.toggleDmEnabled()
                            }
                        }
                    ),
                    isActive: viewModel.state.isDmEnabled
                )
                MoreRowDivider()
                settingsToggleRow(
                    "Read messages aloud",
                    icon: viewModel.state.isTtsDisabled ? "speaker.slash.fill" : "speaker.wave.2.fill",
                    androidIcon: viewModel.state.isTtsDisabled ? "volume.off" : "volume",
                    isOn: Binding(
                        get: { !viewModel.state.isTtsDisabled },
                        set: { next in
                            if next == viewModel.state.isTtsDisabled {
                                viewModel.toggleTtsDisabled()
                            }
                        }
                    ),
                    isActive: !viewModel.state.isTtsDisabled
                )
            }
        }
    }

    @ViewBuilder
    private var meetingInviteCodeSettingsContent: some View {
        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
            acmListSectionHeader("Invite code")

            MeetingSheetSectionCard {
                meetingInviteCodeRow()
            }
        }
    }

    @ViewBuilder
    private var profileSettingsContent: some View {
        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
            acmListSectionHeader("Profile")

            MeetingSheetSectionCard {
                displayNameRow()
                MeetingSheetRowDivider(inset: ACMSpacing.sm + 32 + ACMSpacing.sm)
                updateDisplayNameRow()
                if let user = appState.currentUser {
                    MeetingSheetRowDivider(inset: ACMSpacing.sm + 32 + ACMSpacing.sm)
                    accountRow(user)
                    if user.provider != .guest {
                        MeetingSheetRowDivider(inset: ACMSpacing.sm + 32 + ACMSpacing.sm)
                        signOutRow()
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var audioVideoSettingsContent: some View {
        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
            acmListSectionHeader("Audio and video")

            MeetingSheetSectionCard {
                settingsNavigationRow(
                    "Microphone",
                    subtitle: microphoneSummary,
                    icon: viewModel.state.isMuted ? "mic.slash.fill" : "mic.fill",
                    androidIcon: viewModel.state.isMuted ? "mic.off" : "mic",
                    isActive: !viewModel.state.isMuted && !viewModel.state.mediaPublishingDisabled
                ) {
                    onOpenMicrophoneSettings?()
                }
                MoreRowDivider()
                settingsNavigationRow(
                    "Camera",
                    subtitle: cameraSummary,
                    icon: viewModel.state.isCameraOff ? "video.slash.fill" : "video.fill",
                    androidIcon: viewModel.state.isCameraOff ? "video.off" : "video",
                    isActive: (!viewModel.state.isCameraOff || viewModel.state.videoQuality == .low) && !viewModel.state.mediaPublishingDisabled
                ) {
                    onOpenCameraSettings?()
                }
                MoreRowDivider()
                settingsNavigationRow(
                    "Speaker",
                    subtitle: speakerSummary,
                    icon: "speaker.wave.2.fill",
                    androidIcon: "volume"
                ) {
                    onOpenSpeakerSettings?()
                }
            }
        }
    }

    @ViewBuilder
    private var microphoneSettingsContent: some View {
        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
            acmListSectionHeader("Microphone")

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
                    isDisabled: viewModel.state.mediaPublishingDisabled
                )
                MeetingSheetRowDivider(inset: ACMSpacing.sm + 32 + ACMSpacing.sm)
                microphoneInputRow()
            }
        }
    }

    @ViewBuilder
    private var cameraSettingsContent: some View {
        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
            acmListSectionHeader("Camera")

            MeetingSheetSectionCard {
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
                    isDisabled: viewModel.state.mediaPublishingDisabled
                )
                MeetingSheetRowDivider(inset: ACMSpacing.sm + 32 + ACMSpacing.sm)
                qualityRow()
            }
        }
    }

    @ViewBuilder
    private var speakerSettingsContent: some View {
        VStack(alignment: .leading, spacing: ACMSpacing.xs) {
            acmListSectionHeader("Speaker")

            MeetingSheetSectionCard {
                audioOutputRow()
                MeetingSheetRowDivider(inset: ACMSpacing.sm + 32 + ACMSpacing.sm)
                testSpeakerRow()
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            MeetingSheetHeader(title: title, onBack: onBack, onDone: { dismiss() })

            if bodyReady {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: ACMSpacing.md) {
                    settingsContent
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
        .onAppear {
            if viewModel.state.isAdmin {
                viewModel.refreshMeetingConfig()
                viewModel.refreshWebinarConfig()
                syncWebinarDraftsFromState()
            }
        }
        .onDisappear {
            webinarLinkCopyFeedbackGeneration += 1
            didCopyWebinarLink = false
            isConfirmingWebinarLinkRotation = false
        }
        .onChange(of: viewModel.state.webinarMaxAttendees) { _, _ in
            syncWebinarCapacityDraftFromState()
        }
        .onChange(of: viewModel.state.webinarLinkSlug) { _, _ in
            syncWebinarLinkDraftFromState()
            isConfirmingWebinarLinkRotation = false
        }
    }
}
