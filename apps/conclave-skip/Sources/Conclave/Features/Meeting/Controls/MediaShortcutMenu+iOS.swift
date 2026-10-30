#if os(iOS) && !SKIP
import AVKit
import SwiftUI
import UIKit

struct MediaShortcutModifier: ViewModifier {
    let model: CallControlModel
    let controls: CallControlsPresenter
    let isAccessibilityText: Bool

    let onFlip: () -> Void

    @ViewBuilder
    func body(content: Content) -> some View {
        switch model.kind {
        case .microphone:
            content.modifier(MicrophoneShortcutModifier(controls: controls, hasShortcut: model.hasShortcut,
                                                        isAccessibilityText: isAccessibilityText))
        case .camera:
            content.modifier(CameraShortcutModifier(controls: controls, hasShortcut: model.hasShortcut,
                                                    isAccessibilityText: isAccessibilityText, onFlip: onFlip))
        default:
            content
        }
    }
}

private struct MicrophoneShortcutModifier: ViewModifier {
    let controls: CallControlsPresenter
    let hasShortcut: Bool
    let isAccessibilityText: Bool
    @State private var inputPicker = MicrophoneInputPickerHandle()

    @ViewBuilder
    func body(content: Content) -> some View {
        let items = hasShortcut ? controls.microphoneShortcuts(chooser: MediaShortcutCopy.inputChooser) : []
        let anchored = content.background {
            if MediaShortcutPolicy.item(items, MediaShortcutItemID.chooseMicrophone) != nil {
                MicrophoneInputPickerAnchor(handle: inputPicker)
                    .frame(width: 1, height: 1)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        let withActions = anchored.accessibilityActions {
            ForEach(items) { item in
                Button(MediaShortcutCopy.actionTitle(item.kind)) {
                    choose(item.kind)
                }
            }
        }
        if MediaShortcutPolicy.attachesMenu(items, isAccessibilityText: isAccessibilityText) {
            withActions.contextMenu {
                MicShortcutMenu(controls: controls, onChoose: { kind in choose(kind) })
            }
        } else {
            withActions
        }
    }

    private func choose(_ kind: MediaShortcutItemID) {
        let result = controls.selectShortcut(kind)
        if kind == MediaShortcutItemID.chooseMicrophone && result == ControlTapResult.dispatched {

            let handle = inputPicker
            Task { @MainActor in
                _ = handle.present()
            }
        }
    }
}

private struct MicShortcutMenu: View {
    let controls: CallControlsPresenter
    let onChoose: (MediaShortcutItemID) -> Void

    var body: some View {
        let route = controls.route
        let items = controls.microphoneShortcuts(chooser: MediaShortcutCopy.inputChooser)
        Section {
            ForEach(items) { item in
                switch item.kind {
                case .speaker:

                    Toggle(isOn: Binding(get: { controls.route.isSpeakerOn }, set: { on in _ = controls.setSpeaker(on) })) {
                        Label(MediaShortcutCopy.title(item.kind), systemImage: ConclaveSymbols.speakerWave2Fill)
                    }
                    .accessibilityIdentifier("control.microphone.shortcut.speaker")
                case .microphone:

                    Picker(selection: Binding(get: { controls.route.currentInputId },
                                              set: { id in _ = controls.requestInput(id: id) })) {
                        ForEach(route.inputs) { input in
                            Text(verbatim: input.name).tag(input.id)
                        }
                    } label: {
                        MoreRowLabel(title: MediaShortcutCopy.title(item.kind), subtitle: nil,
                                     systemImage: MediaShortcutCopy.glyph(item.kind))
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("control.microphone.shortcut." + item.id)
                default:
                    Button {
                        onChoose(item.kind)
                    } label: {
                        MoreRowLabel(title: MediaShortcutCopy.title(item.kind), subtitle: nil,
                                     systemImage: MediaShortcutCopy.glyph(item.kind))
                    }
                    .accessibilityLabel(MediaShortcutCopy.actionTitle(item.kind))
                    .accessibilityIdentifier("control.microphone.shortcut." + item.id)
                }
            }
        }
    }
}

@MainActor
final class MicrophoneInputPickerHandle {
    fileprivate var interaction: AnyObject? = nil

    @discardableResult
    func present() -> Bool {
        if #available(iOS 26.0, *) {
            if let picker = interaction as? AVInputPickerInteraction {
                picker.present()
                return true
            }
        }
        return false
    }
}

private struct MicrophoneInputPickerAnchor: UIViewRepresentable {
    let handle: MicrophoneInputPickerHandle

    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        view.isAccessibilityElement = false
        if #available(iOS 26.0, *) {
            let picker = AVInputPickerInteraction()
            view.addInteraction(picker)
            handle.interaction = picker
        }
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {}

    static func dismantleUIView(_ uiView: UIView, coordinator: ()) {
        for interaction in uiView.interactions {
            uiView.removeInteraction(interaction)
        }
    }
}

private struct CameraShortcutModifier: ViewModifier {
    let controls: CallControlsPresenter
    let hasShortcut: Bool
    let isAccessibilityText: Bool
    let onFlip: () -> Void

    @ViewBuilder
    func body(content: Content) -> some View {
        let items = controls.shortcuts.camera
        let withActions = content.accessibilityActions {
            ForEach(items) { item in
                if item.isEnabled {
                    Button(MediaShortcutCopy.actionTitle(item.kind)) {
                        choose(item.kind)
                    }
                }
            }
        }
        if hasShortcut && MediaShortcutPolicy.attachesMenu(items, isAccessibilityText: isAccessibilityText) {
            withActions.contextMenu {
                ForEach(items) { item in
                    Button {
                        choose(item.kind)
                    } label: {
                        MoreRowLabel(title: MediaShortcutCopy.title(item.kind),
                                     subtitle: item.isEnabled ? nil : CallControlsCopy.reasonText(item.reason, name: ""),
                                     systemImage: MediaShortcutCopy.glyph(item.kind))
                    }
                    .disabled(!item.isEnabled)
                    .accessibilityIdentifier("control.camera.shortcut." + item.id)
                }
            }
        } else {
            withActions
        }
    }

    private func choose(_ kind: MediaShortcutItemID) {
        let result = controls.selectShortcut(kind)
        if MediaShortcutPolicy.gestureKind(kind, result: result) != nil {
            onFlip()
        }
    }
}

enum MediaShortcutCopy {

    static var inputChooser: MicrophoneInputChooser {
        if #available(iOS 26.0, *) {
            return MicrophoneInputChooser.systemPicker
        }
        return MicrophoneInputChooser.list
    }

    static func title(_ kind: MediaShortcutItemID) -> String {
        switch kind {
        case .speaker: return ConclaveStrings.text("Speaker")
        case .chooseMicrophone: return ConclaveStrings.text("Microphone…")
        case .microphone: return ConclaveStrings.text("Microphone")
        case .micMode: return ConclaveStrings.text("Mic Mode…")
        case .audioSettings: return ConclaveStrings.text("Audio Settings")
        case .flipCamera: return ConclaveStrings.text("Flip Camera")
        case .effects: return ConclaveStrings.text("Effects")
        case .systemVideoEffects: return ConclaveStrings.text("Video Effects…")
        }
    }

    static func actionTitle(_ kind: MediaShortcutItemID) -> String {
        switch kind {
        case .speaker: return ConclaveStrings.text("Speaker")
        case .chooseMicrophone: return ConclaveStrings.text("Choose Microphone")
        case .microphone: return ConclaveStrings.text("Microphone")
        case .micMode: return ConclaveStrings.text("Mic Mode")
        case .audioSettings: return ConclaveStrings.text("Audio Settings")
        case .flipCamera: return ConclaveStrings.text("Flip Camera")
        case .effects: return ConclaveStrings.text("Effects")
        case .systemVideoEffects: return ConclaveStrings.text("Video Effects")
        }
    }

    static func glyph(_ kind: MediaShortcutItemID) -> String {
        switch kind {
        case .speaker: return ConclaveSymbols.speakerWave2Fill
        case .micMode: return ConclaveSymbols.waveform
        case .chooseMicrophone, .microphone: return ConclaveSymbols.micFill
        case .audioSettings: return ConclaveSymbols.gearshape
        case .flipCamera: return ConclaveSymbols.arrowTriangle2CirclepathCamera
        case .effects, .systemVideoEffects: return ConclaveSymbols.cameraFilters
        }
    }
}
#endif
