import Foundation

enum MediaShortcutItemID: String, CaseIterable, Equatable {

    case speaker

    case chooseMicrophone

    case microphone

    case micMode

    case audioSettings
    case flipCamera

    case effects

    case systemVideoEffects
}

enum MicrophoneInputChooser: String, CaseIterable, Equatable {
    case systemPicker, list
}

struct MediaShortcutItem: Equatable, Identifiable {

    let id: String
    let kind: MediaShortcutItemID

    let isOn: Bool
    let isEnabled: Bool

    let reason: ControlBlockedReason
}

struct MediaShortcutTitles: Equatable {
    let flipCamera: String
    let effects: String
    let reconnecting: String
    let offline: String
}

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

    static func reasonText(_ reason: ControlBlockedReason, titles: MediaShortcutTitles) -> String {
        switch reason {
        case .reconnecting: return titles.reconnecting
        case .offline: return titles.offline
        default: return ""
        }
    }

    static func accessibilityItems(_ items: [MediaShortcutItem]) -> [MediaShortcutItem] {
        var result: [MediaShortcutItem] = []
        for item in items {
            if item.isEnabled && item.kind != MediaShortcutItemID.systemVideoEffects { result.append(item) }
        }
        return result
    }

    static func microphoneHasShortcut(inputs: CallControlsInputs) -> Bool {
        guard let row = inputs.row(MeetingControlID.microphone), row.isVisible else { return false }
        return inputs.phase != MeetingPhaseKind.leaving
    }

    static func cameraHasShortcut(inputs: CallControlsInputs) -> Bool {
        hasEnabledItem(cameraItems(inputs: inputs))
    }

    static func attachesMenu(_ items: [MediaShortcutItem], isAccessibilityText: Bool) -> Bool {
        !isAccessibilityText && hasEnabledItem(items)
    }

    static func gestureKind(_ kind: MediaShortcutItemID, result: ControlTapResult) -> FeedbackKind? {
        if kind == MediaShortcutItemID.flipCamera && result == ControlTapResult.dispatched { return FeedbackKind.selectionChanged }
        return nil
    }

    static func isCameraCaptureRunning(isCameraOff: Bool, isAudioOnly: Bool, isCameraInterrupted: Bool,
                                       isPublishingDisabled: Bool) -> Bool {
        !isCameraOff && !isAudioOnly && !isCameraInterrupted && !isPublishingDisabled
    }

    private static func make(_ kind: MediaShortcutItemID, isOn: Bool = false) -> MediaShortcutItem {
        MediaShortcutItem(id: kind.rawValue, kind: kind, isOn: isOn, isEnabled: true, reason: ControlBlockedReason.none)
    }
}
