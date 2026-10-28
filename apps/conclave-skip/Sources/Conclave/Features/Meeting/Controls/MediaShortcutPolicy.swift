import Foundation

// S30 2 (CTL-4): the Mic and Camera long-press shortcut items, read by both platforms and both test hosts. Every item
// duplicates a control that exists elsewhere (HIG context menus, H-21): the route button and Settings for audio, the
// self-view flip, the top-row flip and More for the camera. The Camera items come from the controls inputs (the
// presenter publishes them as `shortcuts`); the iOS Mic items read the route owner's snapshot and are built only where
// the menu or its accessibility actions are drawn (S30 2 k: the route is never read by the bar cell body). Android's
// Mic long press opens the route sheet (S30 3) instead of a menu. Unavailable items are hidden; an item that exists
// but cannot act right now (a flip in flight, a flip while reconnecting) stays with its reason (S30 2 f). Shared
// (transpiled): String raw-value enums, scalar structs, arrays of structs, no protocols, no associated values.

enum MediaShortcutItemID: String, CaseIterable, Equatable {
    /// iOS Mic: the Speaker quick toggle (only with a receiver, never on iPad).
    case speaker
    /// iOS 26 Mic: the system microphone picker (`AVInputPickerInteraction`), "Choose Microphone…".
    case chooseMicrophone
    /// iOS 17 to 25 Mic: a `Picker` over the route's inputs, shown with more than one input.
    case microphone
    /// iOS Mic: the system microphone modes module (S30 Q7), "Mic Mode…".
    case micMode
    /// iOS Mic: Settings at its Audio section (CC6), "Audio Settings".
    case audioSettings
    case flipCamera
    /// The native Effects panel (invoker `.call`), only when an engine publishes it (RECONCILE OQ6 default A).
    case effects
    /// iOS: the system video effects module while the camera runs (S30 Q7, CC11), "Video Effects…".
    case systemVideoEffects
}

/// How the iOS Mic shortcut offers the microphone input (S30 2 c, CL17): the iOS 26 system picker, or the iOS 17 to 25
/// `Picker` over `route.inputs`. The iOS view passes the one its OS supports.
enum MicrophoneInputChooser: String, CaseIterable, Equatable {
    case systemPicker, list
}

struct MediaShortcutItem: Equatable, Identifiable {
    /// `MediaShortcutItemID.rawValue`; stable.
    let id: String
    let kind: MediaShortcutItemID
    /// The Speaker toggle's checked state; false for the other items.
    let isOn: Bool
    let isEnabled: Bool
    /// Why a present item cannot act right now (`none` otherwise).
    let reason: ControlBlockedReason
}

/// The Android Camera menu words (S30 2 g, Material sentence case), resolved by the Kotlin view and handed to
/// `MediaShortcutPolicy.cameraMenuSections`, as `LeaveMenuTitles` does for the host Leave menu.
struct MediaShortcutTitles: Equatable {
    let flipCamera: String
    let effects: String
    let reconnecting: String
    let offline: String
}

/// `CallControlsPresenter.shortcuts`: the Camera control's long-press items (S30 2 j). Published only on a change.
struct MediaShortcutSnapshot: Equatable {
    let revision: Int
    let camera: [MediaShortcutItem]

    static let empty = MediaShortcutSnapshot(revision: 0, camera: [])

    func withRevision(_ next: Int) -> MediaShortcutSnapshot {
        MediaShortcutSnapshot(revision: next, camera: camera)
    }

    func cameraItem(_ kind: MediaShortcutItemID) -> MediaShortcutItem? {
        MediaShortcutPolicy.item(camera, kind)
    }
}

enum MediaShortcutPolicy {
    // MARK: Items

    /// The iOS Mic items in menu order (S30 2 b, c): Speaker (with a receiver), the microphone input (the iOS 26
    /// system picker with any input, the iOS 17 to 25 list with more than one), Mic Mode (S30 Q7), Audio Settings.
    /// Nothing while leaving. Route changes stay available while recovering or offline (S30 2 f, 3 f).
    static func microphoneItems(route: AudioRouteSnapshot, chooser: MicrophoneInputChooser, opensAudioSettings: Bool,
                                isLeaving: Bool) -> [MediaShortcutItem] {
        if isLeaving { return [] }
        var items: [MediaShortcutItem] = []
        if route.canToggleSpeaker {
            items.append(make(MediaShortcutItemID.speaker, isOn: route.isSpeakerOn))
        }
        switch chooser {
        case .systemPicker:
            if !route.inputs.isEmpty {
                items.append(make(MediaShortcutItemID.chooseMicrophone))
            }
        case .list:
            if route.canChooseInput && route.inputs.count > 1 {
                items.append(make(MediaShortcutItemID.microphone))
            }
        }
        if route.canShowMicModes {
            items.append(make(MediaShortcutItemID.micMode))
        }
        if opensAudioSettings {
            items.append(make(MediaShortcutItemID.audioSettings))
        }
        return items
    }

    /// The Camera items in menu order (S30 2 b, c, d): Flip Camera while the camera is on and the device can flip (the
    /// same capability and reason as More's row, so it stays in place while reconnecting, R10, disabled with its
    /// reason, and disabled while a flip is in flight), then Effects when the panel exists or, on iOS, Video Effects…
    /// while the camera runs. Nothing while leaving or for a person without a camera control (attendees).
    static func cameraItems(inputs: CallControlsInputs) -> [MediaShortcutItem] {
        if inputs.phase == MeetingPhaseKind.leaving { return [] }
        guard let row = inputs.row(MeetingControlID.camera), row.isVisible else { return [] }
        let cameraOn = row.isOn
        var items: [MediaShortcutItem] = []
        if inputs.canFlipCamera && cameraOn {
            let reason = MoreMenuPolicy.socketReason(inputs)
            items.append(MediaShortcutItem(id: MediaShortcutItemID.flipCamera.rawValue, kind: MediaShortcutItemID.flipCamera,
                                           isOn: false, isEnabled: reason == ControlBlockedReason.none && !inputs.isFlipInFlight,
                                           reason: reason))
        }
        if inputs.effectsPanelAvailable && MoreMenuPolicy.isLanded(MeetingPanel.effects) {
            items.append(make(MediaShortcutItemID.effects))
        } else if inputs.canShowSystemVideoEffects && cameraOn {
            items.append(make(MediaShortcutItemID.systemVideoEffects))
        }
        return items
    }

    static func item(_ items: [MediaShortcutItem], _ kind: MediaShortcutItemID) -> MediaShortcutItem? {
        for item in items {
            if item.kind == kind { return item }
        }
        return nil
    }

    static func hasEnabledItem(_ items: [MediaShortcutItem]) -> Bool {
        for item in items {
            if item.isEnabled { return true }
        }
        return false
    }

    /// The Android Camera dropdown (S30 2 d) as one FND-2 menu section: Flip camera, then Effects, icon complete
    /// (F00 7.1). The iOS system module item never reaches Android (its input is false there) and is skipped anyway. A
    /// present item that cannot act stays, disabled, with its reason line (R10).
    static func cameraMenuSections(_ items: [MediaShortcutItem], titles: MediaShortcutTitles) -> [MenuSectionModel] {
        var rows: [MenuItemModel] = []
        for item in items {
            if item.kind == MediaShortcutItemID.flipCamera {
                rows.append(MenuItemModel(id: item.id, title: titles.flipCamera, concept: "flip_camera", role: MenuItemRole.normal,
                                          isOn: false, isEnabled: item.isEnabled,
                                          disabledReason: item.isEnabled ? "" : reasonText(item.reason, titles: titles)))
            } else if item.kind == MediaShortcutItemID.effects {
                rows.append(MenuItemModel(id: item.id, title: titles.effects, concept: "effects", role: MenuItemRole.normal,
                                          isOn: false, isEnabled: item.isEnabled, disabledReason: ""))
            }
        }
        if rows.isEmpty { return [] }
        return [MenuSectionModel(id: "camera", items: rows)]
    }

    /// The reason line of a disabled Camera item (S30 2 f, 7): reconnecting or offline; "" for a flip in flight.
    static func reasonText(_ reason: ControlBlockedReason, titles: MediaShortcutTitles) -> String {
        switch reason {
        case .reconnecting: return titles.reconnecting
        case .offline: return titles.offline
        default: return ""
        }
    }

    /// The Camera items TalkBack lists as custom actions (S30 2 d, AX4): only the items that can act right now.
    static func accessibilityItems(_ items: [MediaShortcutItem]) -> [MediaShortcutItem] {
        var result: [MediaShortcutItem] = []
        for item in items {
            if item.isEnabled && item.kind != MediaShortcutItemID.systemVideoEffects { result.append(item) }
        }
        return result
    }

    // MARK: The bar's `hasShortcut`

    /// The Mic control always has its shortcut while it exists and the call is not ending: the route sheet on Android,
    /// and on iOS at least Audio Settings (Settings is a landed panel).
    static func microphoneHasShortcut(inputs: CallControlsInputs) -> Bool {
        guard let row = inputs.row(MeetingControlID.microphone), row.isVisible else { return false }
        return inputs.phase != MeetingPhaseKind.leaving
    }

    /// S30 2 d: a camera with no enabled item never opens a dead-end menu (iOS attaches no menu; Android attaches no
    /// long press and shows the plain "Camera" tooltip instead).
    static func cameraHasShortcut(inputs: CallControlsInputs) -> Bool {
        hasEnabledItem(cameraItems(inputs: inputs))
    }

    /// iOS (S30 2 a, c): the context menu attaches only below the accessibility text sizes, where long press belongs to
    /// the Large Content Viewer, and only when an item can act; the accessibility actions exist either way.
    static func attachesMenu(_ items: [MediaShortcutItem], isAccessibilityText: Bool) -> Bool {
        !isAccessibilityText && hasEnabledItem(items)
    }

    // MARK: Feedback and capture (CC11)

    /// RECONCILE R13 and S30 2 e, h: a flip from the shortcut plays `selectionChanged` only when it was dispatched; the
    /// other items play nothing on iOS (the system menu plays its own) and Android plays `longPress` on open only.
    static func gestureKind(_ kind: MediaShortcutItemID, result: ControlTapResult) -> FeedbackKind? {
        if kind == MediaShortcutItemID.flipCamera && result == ControlTapResult.dispatched { return FeedbackKind.selectionChanged }
        return nil
    }

    /// S30 CC11: the system video effects module opens only while the call camera captures (iOS 15, always on the
    /// iOS 17 target); the core feeds `canShowSystemVideoEffects` from this on iOS and false on Android.
    static func isCameraCaptureRunning(isCameraOff: Bool, isAudioOnly: Bool, isCameraInterrupted: Bool,
                                       isPublishingDisabled: Bool) -> Bool {
        !isCameraOff && !isAudioOnly && !isCameraInterrupted && !isPublishingDisabled
    }

    private static func make(_ kind: MediaShortcutItemID, isOn: Bool = false) -> MediaShortcutItem {
        MediaShortcutItem(id: kind.rawValue, kind: kind, isOn: isOn, isEnabled: true, reason: ControlBlockedReason.none)
    }
}
