#if os(iOS) && !SKIP
import AVKit
import SwiftUI
import UIKit

// S30 2 c (CTL-4): the Mic and Camera long-press shortcuts on the iOS bar. A context menu on the toggle (no preview
// closure: the control itself lifts), attached only below the accessibility text sizes, where long press belongs to the
// Large Content Viewer, and only when an item can act; an empty menu attaches nothing. Every item is also an
// accessibility action on the same control, under the same visibility gate, whether or not the menu is attached (AX4,
// F00 C16 i), and every item duplicates a control that exists elsewhere (H-21). The Mic menu reads the route owner's
// snapshot only inside this modifier and the menu, never in the cell body (S30 2 k); the Camera menu reads only
// `controls.shortcuts`. Menus inherit the dark stage environment [Unverified on iOS 17 and 26, F00 2.1]. Feedback: the
// system menu plays its own on open; Flip plays `selectionChanged` from the cell, only on dispatch (RECONCILE R13, H2
// row 23); nothing else plays (S30 2 h). Icons: F00 concepts through `ConclaveSymbols` (no raw symbol names); the
// CL11 Speaker and Effects use canonical artwork; the microphone menu group is icon-complete.

/// Attaches the shortcut for the Mic or the Camera cell; other kinds pass through.
struct MediaShortcutModifier: ViewModifier {
    let model: CallControlModel
    let controls: CallControlsPresenter
    let isAccessibilityText: Bool
    /// The cell's flip counter (its `selectionChanged` trigger), bumped only after a dispatched flip.
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

// MARK: Mic

/// The Mic shortcut: Speaker (with a receiver), the microphone input (the iOS 26 system picker, or the iOS 17 to 25
/// `Picker` over the route's inputs with more than one), Mic Mode (S30 Q7) and Audio Settings (CC6). The iOS output
/// list stays the system route button (S30 Q12).
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
            // The menu has started closing; present the system picker on the next turn [Unverified on device].
            let handle = inputPicker
            Task { @MainActor in
                _ = handle.present()
            }
        }
    }
}

/// The Mic menu content. Reads the route here, so only an open menu observes it; the items come from the shared policy.
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
                    // The system menu toggle owns its selection feedback (3 h).
                    Toggle(isOn: Binding(get: { controls.route.isSpeakerOn }, set: { on in _ = controls.setSpeaker(on) })) {
                        Label(MediaShortcutCopy.title(item.kind), systemImage: ConclaveSymbols.speakerWave2Fill)
                    }
                    .accessibilityIdentifier("control.microphone.shortcut.speaker")
                case .microphone:
                    // iOS 17 to 25: one submenu level over the route's inputs (CL17).
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
                    .accessibilityIdentifier("control.microphone.shortcut." + item.id)
                }
            }
        }
    }
}

/// The iOS 26 system microphone picker (`AVInputPickerInteraction`, IOS 17.5), attached to a 1 pt view behind the Mic
/// cell inside the bar's hosting view. The interaction uses the shared audio session, which is the call's
/// `.playAndRecord` session, so its list is never empty during a call. Below iOS 26 nothing is attached.
@MainActor
final class MicrophoneInputPickerHandle {
    fileprivate var interaction: AnyObject? = nil

    /// Presents the picker; false below iOS 26 or before the anchor exists.
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

// MARK: Camera

/// The Camera shortcut: Flip Camera (while the camera is on and the device can flip; disabled with its reason while a
/// flip is in flight or the call reconnects), then Effects when the panel exists (invoker `.call`) or Video Effects…
/// (the system module, CC11) while the camera runs.
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

// MARK: Copy

/// iOS copy for the shortcuts (S30 2 g: Apple title case; an item that opens a chooser keeps the ellipsis, an item that
/// opens a panel does not; accessibility actions drop the ellipsis). String Catalog keys through `ConclaveStrings`.
enum MediaShortcutCopy {
    /// The microphone chooser this OS offers (S30 2 c).
    static var inputChooser: MicrophoneInputChooser {
        if #available(iOS 26.0, *) {
            return MicrophoneInputChooser.systemPicker
        }
        return MicrophoneInputChooser.list
    }

    static func title(_ kind: MediaShortcutItemID) -> String {
        switch kind {
        case .speaker: return ConclaveStrings.text("Speaker")
        case .chooseMicrophone: return ConclaveStrings.text("Choose Microphone…")
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

    /// S30 2 e concepts: microphone, `speaking` (waveform) for Mic Mode, settings (gearshape), flip_camera; Effects uses
    /// Canonical media-shortcut glyphs (CL11).
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
