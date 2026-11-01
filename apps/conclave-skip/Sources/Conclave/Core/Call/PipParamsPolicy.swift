import Foundation

struct PipAspect: Equatable {
    let width: Int
    let height: Int

    static let standard = PipAspect(width: 16, height: 9)

    static let widest = PipAspect(width: 239, height: 100)

    static let tallest = PipAspect(width: 100, height: 239)
}

struct PipSourceRect: Equatable {
    let left: Int
    let top: Int
    let right: Int
    let bottom: Int
}

enum PipActionKind: String, CaseIterable, Equatable {
    case mute, unmute, leave
}

enum PipSubtitleKind: String, CaseIterable, Equatable {
    case none, muted, reconnecting, onHold
}

enum PipMinimizeAction: String, CaseIterable, Equatable {
    case enterPictureInPicture, moveTaskToBack
}

struct PipParamsModel: Equatable {
    let presenceSession: Int
    let aspect: PipAspect

    let sourceRect: PipSourceRect?
    let actions: [PipActionKind]
    let autoEnterEnabled: Bool

    let title: String
    let subtitle: PipSubtitleKind

    static let inactive = PipParamsModel(presenceSession: 0, aspect: PipAspect.standard, sourceRect: nil,
                                         actions: [PipActionKind.leave], autoEnterEnabled: false, title: "",
                                         subtitle: PipSubtitleKind.none)
}

enum PipParamsPolicy {

    static let maxAspectRatio: Double = 2.39

    static func aspect(width: Int, height: Int) -> PipAspect {
        if width <= 0 || height <= 0 { return PipAspect.standard }
        let ratio = Double(width) / Double(height)
        if ratio > maxAspectRatio { return PipAspect.widest }
        if ratio < 1.0 / maxAspectRatio { return PipAspect.tallest }
        let divisor = greatestCommonDivisor(width, height)
        return PipAspect(width: width / divisor, height: height / divisor)
    }

    static func sourceRect(_ frame: PipTargetFrame?) -> PipSourceRect? {
        guard let frame = frame, frame.hasBounds else { return nil }
        let rect = PipSourceRect(left: Int(frame.left.rounded()), top: Int(frame.top.rounded()),
                                 right: Int(frame.right.rounded()), bottom: Int(frame.bottom.rounded()))
        if rect.right <= rect.left || rect.bottom <= rect.top { return nil }
        return rect
    }

    static func actions(isMuted: Bool, isAttendee: Bool) -> [PipActionKind] {
        if isAttendee { return [PipActionKind.leave] }
        return [isMuted ? PipActionKind.unmute : PipActionKind.mute, PipActionKind.leave]
    }

    static func subtitle(phase: CallPresencePhase, isMuted: Bool, isAttendee: Bool) -> PipSubtitleKind {
        if phase == .recovering { return PipSubtitleKind.reconnecting }
        if phase == .onHold { return PipSubtitleKind.onHold }
        if isMuted && !isAttendee { return PipSubtitleKind.muted }
        return PipSubtitleKind.none
    }

    static func isEligiblePhase(_ phase: CallPresencePhase) -> Bool {
        phase == .live || phase == .recovering || phase == .onHold
    }

    static func params(snapshot: CallPresenceSnapshot, availability: PipAvailability) -> PipParamsModel {
        let target = snapshot.pipTarget

        let windowAspect = PipParamsPolicy.aspect(width: target?.videoWidth ?? 0, height: target?.videoHeight ?? 0)
        return PipParamsModel(
            presenceSession: snapshot.presenceSession,
            aspect: windowAspect,
            sourceRect: sourceRect(target),
            actions: actions(isMuted: snapshot.isMuted, isAttendee: snapshot.isAttendee),
            autoEnterEnabled: availability == .eligible,
            title: snapshot.title,
            subtitle: subtitle(phase: snapshot.phase, isMuted: snapshot.isMuted, isAttendee: snapshot.isAttendee)
        )
    }

    static func actionTitleName(_ kind: PipActionKind) -> String {
        switch kind {
        case .mute: return "stg_pip_mute"
        case .unmute: return "stg_pip_unmute"
        case .leave: return "ds_leave_call"
        }
    }

    static func actionDrawableName(_ kind: PipActionKind) -> String {
        switch kind {
        case .mute: return "conclave_mic_fill1"
        case .unmute: return "conclave_mic_off_fill1"
        case .leave: return "conclave_call_end_fill1"
        }
    }

    static func subtitleName(_ kind: PipSubtitleKind) -> String {
        switch kind {
        case .none: return ""
        case .muted: return "stg_pip_muted"
        case .reconnecting: return "sys_pip_reconnecting"
        case .onHold: return "sys_pip_on_hold"
        }
    }

    static func readout(_ model: PipParamsModel) -> String {
        var rect = "none"
        if let source = model.sourceRect {
            rect = String(source.left) + "," + String(source.top) + "," + String(source.right) + "," + String(source.bottom)
        }
        return "aspect=" + String(model.aspect.width) + ":" + String(model.aspect.height) + " rect=" + rect
            + " autoEnter=" + (model.autoEnterEnabled ? "1" : "0")
    }

    private static func greatestCommonDivisor(_ first: Int, _ second: Int) -> Int {
        var a = first
        var b = second
        while b != 0 {
            let remainder = a % b
            a = b
            b = remainder
        }
        return a == 0 ? 1 : a
    }
}

enum PipAvailabilityPolicy {
    static func availability(
        isSupported: Bool,
        isAllowedByUser: Bool,
        isSuppressed: Bool,
        isActive: Bool,
        phase: CallPresencePhase
    ) -> PipAvailability {
        if !isSupported { return .unsupported }
        if isActive { return .active }
        if !isAllowedByUser { return .disabledByUser }
        if !PipParamsPolicy.isEligiblePhase(phase) { return .notEligible }
        if isSuppressed { return .suppressed }
        return .eligible
    }
}

enum PipEntryPolicy {

    static func minimize(availability: PipAvailability) -> PipMinimizeAction {
        availability == .eligible ? PipMinimizeAction.enterPictureInPicture : PipMinimizeAction.moveTaskToBack
    }

    static func entersOnUserLeaveHint(api: Int, availability: PipAvailability, isRequestingCapture: Bool) -> Bool {
        api < 31 && availability == .eligible && !isRequestingCapture
    }
}

enum PipContentKind: String, CaseIterable, Equatable {

    case video

    case avatar

    case solo
}

enum PipStatusPill: String, CaseIterable, Equatable {
    case none, reconnecting, onHold
}

struct PipContentModel: Equatable {
    let kind: PipContentKind
    let userId: String
    let name: String
    let isMuted: Bool
    let isShare: Bool

    let showsNamePill: Bool
    let status: PipStatusPill

    static let solo = PipContentModel(kind: PipContentKind.solo, userId: "", name: "", isMuted: false, isShare: false,
                                      showsNamePill: false, status: PipStatusPill.none)
}

enum PipContentPolicy {

    static let namePillMinWidth: Double = 160.0

    static func status(phase: CallPresencePhase) -> PipStatusPill {
        if phase == .recovering { return PipStatusPill.reconnecting }
        if phase == .onHold { return PipStatusPill.onHold }
        return PipStatusPill.none
    }

    static func content(choice: PipTargetChoice, participant: StageParticipantInput?, phase: CallPresencePhase,
                        windowWidth: Double) -> PipContentModel {
        var hasVideo = false
        if let row = participant {

            if choice.isShare {
                hasVideo = !row.shareVideoKey.isEmpty
            } else {
                hasVideo = PipTargetPolicy.hasVideo(row)
            }
        }
        return content(choice: choice, name: participant?.displayName ?? "", isMuted: participant?.isMuted ?? false,
                       hasVideo: hasVideo, phase: phase, windowWidth: windowWidth)
    }

    static func content(choice: PipTargetChoice, name: String, isMuted: Bool, hasVideo: Bool, phase: CallPresencePhase,
                        windowWidth: Double) -> PipContentModel {
        let pill = PipContentPolicy.status(phase: phase)
        if choice.isEmpty {
            return PipContentModel(kind: PipContentKind.solo, userId: "", name: "", isMuted: false, isShare: false,
                                   showsNamePill: false, status: pill)
        }
        return PipContentModel(kind: hasVideo ? PipContentKind.video : PipContentKind.avatar, userId: choice.userId,
                               name: name, isMuted: isMuted, isShare: choice.isShare,
                               showsNamePill: windowWidth >= namePillMinWidth, status: pill)
    }
}

enum PipStageLayoutPolicy {
    static func frames(targetSlotId: String, width: Double, height: Double) -> [StageFrame] {
        if targetSlotId.isEmpty || width <= 0 || height <= 0 { return [] }
        return [StageFrame(slotId: targetSlotId, x: 0.0, y: 0.0, width: width, height: height)]
    }
}

enum ExternalHandoffKind: String, CaseIterable, Equatable {

    case webLink

    case otherApp
    case meetingShare
    case transcriptShare
    case photoPicker

    case mediaProjectionConsent
    case permissionDialog

    case systemSettings
}

enum ExternalHandoffPolicy {

    static func suppressesAutoEnter(_ kind: ExternalHandoffKind) -> Bool {
        kind != .systemSettings
    }

    static func reason(_ kind: ExternalHandoffKind) -> String {
        switch kind {
        case .webLink: return "chat_link"
        case .otherApp: return "external_app"
        case .meetingShare: return "meeting_share"
        case .transcriptShare: return "transcript_share"
        case .photoPicker: return "photo_picker"
        case .mediaProjectionConsent: return "media_projection"
        case .permissionDialog: return "permission"
        case .systemSettings: return "settings"
        }
    }

    static func kind(url: String) -> ExternalHandoffKind {
        let lower = url.lowercased()
        if lower.hasPrefix("http://") || lower.hasPrefix("https://") { return .webLink }
        return .otherApp
    }

    static func readout(count: Int, lastReason: String) -> String {
        String(count) + " " + (lastReason.isEmpty ? "none" : lastReason)
    }
}
