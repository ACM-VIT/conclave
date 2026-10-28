#if os(iOS) && !SKIP
import AVKit
import SwiftUI
import UIKit

struct SettingsRouteOutputRow: View {
    let owner: AudioRouteOwner

    var body: some View {
        let route = owner.route
        LabeledContent {
            HStack(spacing: 8) {
                Text(LobbyAudioCopy.routeName(kind: route.routeKind.rawValue, name: route.routeName))
                    .foregroundStyle(HostingTheme.secondaryText)
                    .lineLimit(2)
                SettingsRoutePicker(onDismiss: { owner.noteSystemRoutePickerDismissed() })
                    .frame(width: 44, height: 44)
                    .accessibilityIdentifier("settings.output.picker")
            }
        } label: {
            Text(SettingsCopy.rowTitle(.output))
        }
        .accessibilityIdentifier("settings.row.output")
    }
}

struct SettingsMicrophoneValueRow: View {
    let owner: AudioRouteOwner

    var body: some View {
        let route = owner.route
        LabeledContent(SettingsCopy.rowTitle(.microphone), value: SettingsRouteNames.inputName(route))
    }
}

enum SettingsRouteNames {
    static func inputName(_ route: AudioRouteSnapshot) -> String {
        for input in route.inputs where input.id == route.currentInputId {
            return input.name
        }
        return route.inputs.first?.name ?? ""
    }
}

struct SettingsTestSoundRow: View {
    let settings: SettingsPresenter
    let phase: SpeakerTestPhase

    var body: some View {
        let playing = phase == SpeakerTestPhase.playing
        Button {
            settings.playTestSound()
        } label: {
            LabeledContent {
                if playing {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text(ConclaveStrings.text("Playing"))
                    }
                }
            } label: {
                Text(SettingsCopy.rowTitle(.testSound))
            }
        }
        .disabled(playing)
        .accessibilityValue(playing ? ConclaveStrings.text("Playing") : "")
        .accessibilityIdentifier("settings.row.testSound")
    }
}

struct SettingsLevelMeter: View {
    let segments: Int

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<MicLevelPolicy.segmentCount, id: \.self) { index in
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(index < segments ? Color(uiColor: .label) : Color(uiColor: .separator))
                    .frame(maxWidth: .infinity)
                    .frame(height: 12)
            }
        }
        .accessibilityHidden(true)
    }
}

struct SettingsMicLevelRow: View {
    let meter: MicLevelMeter

    var body: some View {
        let segments = meter.segments
        ViewThatFits(in: .horizontal) {
            LabeledContent(ConclaveStrings.text("Speak to Test")) {
                SettingsLevelMeter(segments: segments).frame(width: 120)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(ConclaveStrings.text("Speak to Test"))
                SettingsLevelMeter(segments: segments)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ConclaveStrings.text("Speak to Test"))
        .accessibilityValue(SettingsCopy.levelValue(segments))
        .accessibilityAddTraits(.updatesFrequently)
        .accessibilityIdentifier("settings.mic.level")
    }
}

struct SettingsRoutePicker: UIViewRepresentable {
    let onDismiss: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onDismiss: onDismiss)
    }

    func makeUIView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.prioritizesVideoDevices = false
        view.tintColor = UIColor(HostingTheme.coralText)
        view.activeTintColor = UIColor(HostingTheme.coralText)
        view.delegate = context.coordinator
        return view
    }

    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {
        context.coordinator.onDismiss = onDismiss
    }

    final class Coordinator: NSObject, AVRoutePickerViewDelegate {
        var onDismiss: () -> Void

        init(onDismiss: @escaping () -> Void) {
            self.onDismiss = onDismiss
        }

        func routePickerViewDidEndPresentingRoutes(_ routePickerView: AVRoutePickerView) {
            onDismiss()
        }
    }
}

struct SettingsNameRow: View {
    let settings: SettingsPresenter
    let editor: DisplayNameEditor
    let canEdit: Bool
    @Environment(\.panelPromoteToLargeDetent) private var promoteToLarge
    @FocusState private var isFocused: Bool

    var body: some View {
        LabeledContent(SettingsCopy.rowTitle(.name)) {
            TextField(SettingsCopy.rowTitle(.name),
                      text: Binding(get: { editor.draft }, set: { settings.editDisplayName($0) }),
                      prompt: Text(ConclaveStrings.text("Your Name")))
                .multilineTextAlignment(.trailing)
                .textContentType(.name)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .focused($isFocused)
                .onSubmit { settings.flushDisplayName() }
                .disabled(!canEdit)
        }
        .onChange(of: isFocused) { _, focused in
            if focused { promoteToLarge() }
        }
        .accessibilityIdentifier("settings.row.name")
    }
}

struct SettingsNameStatus: View {
    let settings: SettingsPresenter
    let editor: DisplayNameEditor
    let account: SettingsAccount

    var body: some View {
        let phase = SettingsNamePolicy.status(isSaving: editor.isSaving, refusal: editor.refusal, draft: editor.draft,
                                              saved: account.savedDisplayName, hasEdited: settings.hasEditedName)
        let count = editor.draft.count
        VStack(alignment: .leading, spacing: 4) {
            if let status = SettingsCopy.nameStatus(phase, refusal: editor.refusal) {
                if phase == NameSavePhase.failed {
                    Label(status, systemImage: ConclaveSymbols.exclamationmarkOctagonFill)
                        .foregroundStyle(Color(uiColor: .systemRed))
                        .accessibilityIdentifier("settings.name.refusal")
                } else if phase == NameSavePhase.saving {
                    HStack(spacing: 6) {
                        ProgressView()
                        Text(status)
                    }
                    .accessibilityIdentifier("settings.name.saving")
                } else {
                    Text(status).accessibilityIdentifier("settings.name.saved")
                }
            }
            if DisplayNamePolicy.isCounterVisible(count: count) {
                Text(ConclaveStrings.format("%lld of %lld characters", count, DisplayNamePolicy.limit))
                    .monospacedDigit()
                    .accessibilityIdentifier("settings.name.counter")
            }
            if let reason = SettingsCopy.nameReason(account.nameReason) {
                Text(reason)
            }
        }
    }
}

struct SettingsIdentityRow: View {
    let account: SettingsAccount

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let guest = SettingsCopy.accountKind(account.account) {
                Text(guest)
            } else {
                Text(account.accountName.isEmpty ? account.accountEmail : account.accountName)
                if !account.accountEmail.isEmpty && !account.accountName.isEmpty {
                    Text(account.accountEmail)
                        .font(.footnote)
                        .foregroundStyle(HostingTheme.secondaryText)
                }
                if let provider = SettingsCopy.providerLine(account.accountProvider) {
                    Text(provider)
                        .font(.footnote)
                        .foregroundStyle(HostingTheme.secondaryText)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("settings.row.identity")
    }
}
#endif
