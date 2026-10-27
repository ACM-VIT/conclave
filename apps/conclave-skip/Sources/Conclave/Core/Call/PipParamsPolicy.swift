import Foundation

// S70 3 (SYS-4, SY7; SX11 `PipParamsPolicy`; RECONCILE R28) and S70 8 (SYS-8): the pure rules behind the system
// Picture in Picture windows. Android builds `PictureInPictureParams` from `PipParamsModel` (K/PipManager.kt); the iOS
// window (VideoCallPictureInPicture+iOS.swift) reads the same content and status rules. Shared (transpiled): String
// raw-value enums, scalar structs and arrays of them only; no platform import. Host-tested on macOS
// (T/SYS4PipPoliciesTests.swift) and in Robolectric (T/Skip/SYS4PipBridgeTests.kt).

/// An aspect ratio as a reduced integer pair (Android `Rational`).
struct PipAspect: Equatable {
    let width: Int
    let height: Int

    /// Until the target's first decoded frame reports a size (and today's fixed value, CE E1).
    static let standard = PipAspect(width: 16, height: 9)
    /// The widest window Android accepts (2.39:1, D-14).
    static let widest = PipAspect(width: 239, height: 100)
    /// The tallest window Android accepts (1:2.39, D-14).
    static let tallest = PipAspect(width: 100, height: 239)
}

/// The source rectangle hint in window px (Android `Rect`), rounded from `PipTargetFrame`.
struct PipSourceRect: Equatable {
    let left: Int
    let top: Int
    let right: Int
    let bottom: Int
}

/// The Android `RemoteAction`s, absolute (S70 0.5): a stale tap after the state changed elsewhere is a no-op.
enum PipActionKind: String, CaseIterable, Equatable {
    case mute, unmute, leave
}

/// The API 33 subtitle (S70 3 g).
enum PipSubtitleKind: String, CaseIterable, Equatable {
    case none, muted, reconnecting, onHold
}

/// What Back at the call root (no panel open) and the Android Minimize button do (S70 D9): PiP when eligible, else the
/// task moves to the back. Never a leave.
enum PipMinimizeAction: String, CaseIterable, Equatable {
    case enterPictureInPicture, moveTaskToBack
}

/// Everything the Android params carry, as scalars, so one equality check decides whether
/// `setPictureInPictureParams` runs (S70 3 d: only when the aspect, rect, mute, attendee or eligibility changes).
struct PipParamsModel: Equatable {
    let presenceSession: Int
    let aspect: PipAspect
    /// Nil until the target slot is laid out; the window then falls back to the activity's own bounds.
    let sourceRect: PipSourceRect?
    let actions: [PipActionKind]
    let autoEnterEnabled: Bool
    /// API 33 title: the room label (or the webinar title for an attendee).
    let title: String
    let subtitle: PipSubtitleKind

    static let inactive = PipParamsModel(presenceSession: 0, aspect: PipAspect.standard, sourceRect: nil,
                                         actions: [PipActionKind.leave], autoEnterEnabled: false, title: "",
                                         subtitle: PipSubtitleKind.none)
}

enum PipParamsPolicy {
    /// D-14: Android rejects windows wider than 2.39:1 or taller than 1:2.39.
    static let maxAspectRatio: Double = 2.39

    /// The window aspect from the target's decoded frame size, clamped to 2.39:1 and 1:2.39; 16:9 while the size is 0
    /// (S70 3 d, l1: 720 x 1280 gives 9:16, a 3:1 frame clamps to 2.39:1, size 0 keeps 16:9).
    static func aspect(width: Int, height: Int) -> PipAspect {
        if width <= 0 || height <= 0 { return PipAspect.standard }
        let ratio = Double(width) / Double(height)
        if ratio > maxAspectRatio { return PipAspect.widest }
        if ratio < 1.0 / maxAspectRatio { return PipAspect.tallest }
        let divisor = greatestCommonDivisor(width, height)
        return PipAspect(width: width / divisor, height: height / divisor)
    }

    /// The slot bounds in window px (`boundsInWindow`, S20 13 d), or nil while the target is not laid out.
    static func sourceRect(_ frame: PipTargetFrame?) -> PipSourceRect? {
        guard let frame = frame, frame.hasBounds else { return nil }
        let rect = PipSourceRect(left: Int(frame.left.rounded()), top: Int(frame.top.rounded()),
                                 right: Int(frame.right.rounded()), bottom: Int(frame.bottom.rounded()))
        if rect.right <= rect.left || rect.bottom <= rect.top { return nil }
        return rect
    }

    /// Mute or Unmute (never for an attendee), then Leave call. Two actions fit every device's
    /// `getMaxNumPictureInPictureActions()` (at least 3); no custom close action (the system close keeps the call).
    static func actions(isMuted: Bool, isAttendee: Bool) -> [PipActionKind] {
        if isAttendee { return [PipActionKind.leave] }
        return [isMuted ? PipActionKind.unmute : PipActionKind.mute, PipActionKind.leave]
    }

    /// Recovery and hold outrank the mute state; an attendee has no microphone to describe.
    static func subtitle(phase: CallPresencePhase, isMuted: Bool, isAttendee: Bool) -> PipSubtitleKind {
        if phase == .recovering { return PipSubtitleKind.reconnecting }
        if phase == .onHold { return PipSubtitleKind.onHold }
        if isMuted && !isAttendee { return PipSubtitleKind.muted }
        return PipSubtitleKind.none
    }

    /// Phases in which the call can be shown in a PiP window (S70 3 a): live, recovering or on hold.
    static func isEligiblePhase(_ phase: CallPresencePhase) -> Bool {
        phase == .live || phase == .recovering || phase == .onHold
    }

    /// The Android params for a snapshot. `availability` is the adapter's own reading (PipAvailabilityPolicy), so
    /// auto-enter is armed only while the call is eligible: not suppressed by an external activity, supported and
    /// allowed by the person, and not already in PiP.
    static func params(snapshot: CallPresenceSnapshot, availability: PipAvailability) -> PipParamsModel {
        let target = snapshot.pipTarget
        // No target or no first frame yet: 16:9 (a nil target reads as size 0).
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

    /// Android string resource of an action title (S70 3 g; the system shows it as the action's label).
    static func actionTitleName(_ kind: PipActionKind) -> String {
        switch kind {
        case .mute: return "stg_pip_mute"
        case .unmute: return "stg_pip_unmute"
        case .leave: return "ds_leave_call"
        }
    }

    /// The generated app-module drawable of an action (SX8, SC20; RECONCILE R28). The microphone glyphs follow the
    /// call notification's action (`NotificationPostPolicy.actionDrawableName`), so both system surfaces agree.
    static func actionDrawableName(_ kind: PipActionKind) -> String {
        switch kind {
        case .mute: return "conclave_mic_fill1"
        case .unmute: return "conclave_mic_off_fill1"
        case .leave: return "conclave_call_end_fill1"
        }
    }

    /// Android string resource of an API 33 subtitle, or "" for none.
    static func subtitleName(_ kind: PipSubtitleKind) -> String {
        switch kind {
        case .none: return ""
        case .muted: return "stg_pip_muted"
        case .reconnecting: return "sys_pip_reconnecting"
        case .onHold: return "sys_pip_on_hold"
        }
    }

    /// The `sys.pip` Debug readout (S70 SX1): `aspect=w:h rect=l,t,r,b autoEnter=0/1` (rect "none" without a slot).
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

/// S70 0.5 `PipAvailability` as each PiP adapter reads it (SX11).
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

/// S70 3 a, 3 d and D9: how the call reaches a PiP window on Android.
enum PipEntryPolicy {
    /// Back at the call root with no panel open, or the Minimize button (S20 7): PiP when eligible and the PiP
    /// app-op allows it, else the task moves to the back. A failed entry also moves the task to the back (3 j).
    static func minimize(availability: PipAvailability) -> PipMinimizeAction {
        availability == .eligible ? PipMinimizeAction.enterPictureInPicture : PipMinimizeAction.moveTaskToBack
    }

    /// API 28 to 30 have no auto-enter: `onUserLeaveHint` enters PiP when eligible (which excludes a suppressed
    /// external activity) and no screen-capture consent is up. API 31+ auto-enter does it from the params.
    static func entersOnUserLeaveHint(api: Int, availability: PipAvailability, isRequestingCapture: Bool) -> Bool {
        api < 31 && availability == .eligible && !isRequestingCapture
    }
}

/// S20 13 d content: what a PiP window shows.
enum PipContentKind: String, CaseIterable, Equatable {
    /// The target's video (a share fit, a camera fill).
    case video
    /// The target's avatar with the name (camera off or no track yet).
    case avatar
    /// Nobody else is here: the S20 solo text on the dark card, no video.
    case solo
}

/// The status pill over the PiP content (S70 3 b, f).
enum PipStatusPill: String, CaseIterable, Equatable {
    case none, reconnecting, onHold
}

struct PipContentModel: Equatable {
    let kind: PipContentKind
    let userId: String
    let name: String
    let isMuted: Bool
    let isShare: Bool
    /// Name pill and muted glyph only in windows at least 160 pt / dp wide (S20 13 d).
    let showsNamePill: Bool
    let status: PipStatusPill

    static let solo = PipContentModel(kind: PipContentKind.solo, userId: "", name: "", isMuted: false, isShare: false,
                                      showsNamePill: false, status: PipStatusPill.none)
}

enum PipContentPolicy {
    /// S20 13 d: the name pill appears only from this window width (pt on iOS, dp on Android).
    static let namePillMinWidth: Double = 160.0

    static func status(phase: CallPresencePhase) -> PipStatusPill {
        if phase == .recovering { return PipStatusPill.reconnecting }
        if phase == .onHold { return PipStatusPill.onHold }
        return PipStatusPill.none
    }

    /// The content for the stage's PiP choice (`PipTargetPolicy.choose`, never you) and that person's stage row.
    static func content(choice: PipTargetChoice, participant: StageParticipantInput?, phase: CallPresencePhase,
                        windowWidth: Double) -> PipContentModel {
        var hasVideo = false
        if let row = participant {
            // A share shows once its track is bound; a camera once it is on with a bound track (S20 13 d).
            if choice.isShare {
                hasVideo = !row.shareVideoKey.isEmpty
            } else {
                hasVideo = PipTargetPolicy.hasVideo(row)
            }
        }
        return content(choice: choice, name: participant?.displayName ?? "", isMuted: participant?.isMuted ?? false,
                       hasVideo: hasVideo, phase: phase, windowWidth: windowWidth)
    }

    /// The same rule from the observable tile chrome and renderer binding the PiP views read.
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

/// The slot frames while the native call root is in a PiP window (S70 3 d, PS 9.4): the root stays composed, every
/// renderer stays attached, and only the target slot is laid out, over the whole window; every other slot gets an
/// empty frame, so nothing is disposed and nothing is recreated on exit.
enum PipStageLayoutPolicy {
    static func frames(targetSlotId: String, width: Double, height: Double) -> [StageFrame] {
        if targetSlotId.isEmpty || width <= 0 || height <= 0 { return [] }
        return [StageFrame(slotId: targetSlotId, x: 0.0, y: 0.0, width: width, height: height)]
    }
}

// MARK: - Leaving Conclave mid-call (S70 8; SYS-8)

/// Every activity Conclave starts outside the call screen (S70 8 a, 8 d).
enum ExternalHandoffKind: String, CaseIterable, Equatable {
    /// http and https in Custom Tabs on the call task (S40 3 h, Q16).
    case webLink
    /// A link that opens another app after the S40 confirmation: `mailto:`, `tel:` (`ACTION_DIAL` only fills the
    /// dialer), other schemes, and the `ACTION_VIEW` fallback when no browser supports Custom Tabs.
    case otherApp
    case meetingShare
    case transcriptShare
    case photoPicker
    /// The MediaProjection consent started from More (S30 CC15).
    case mediaProjectionConsent
    case permissionDialog
    /// App details, notification, channel and Wi-Fi settings.
    case systemSettings
}

enum ExternalHandoffPolicy {
    /// The slice rule (PLAN-screens SYS-8): every external activity suppresses the next PiP auto-enter, except
    /// Settings, where auto-enter keeps the call visible while the person flips a switch. The suppression ends when
    /// the activity returns (PipManager restores auto-enter on resume) or after the existing 2 s window.
    static func suppressesAutoEnter(_ kind: ExternalHandoffKind) -> Bool {
        kind != .systemSettings
    }

    /// The reason the `sys.pipSuppressions` readout shows (the legacy names are kept: CE E12).
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

    /// How a chat or assistant link leaves the call screen on Android (S40 3 h): http and https in Custom Tabs, any
    /// other scheme in its own app after the confirmation.
    static func kind(url: String) -> ExternalHandoffKind {
        let lower = url.lowercased()
        if lower.hasPrefix("http://") || lower.hasPrefix("https://") { return .webLink }
        return .otherApp
    }

    /// `sys.pipSuppressions` (S70 SX1): the count and the last reason ("0 none" before any).
    static func readout(count: Int, lastReason: String) -> String {
        String(count) + " " + (lastReason.isEmpty ? "none" : lastReason)
    }
}
