import Foundation

// S20 11 (STG-9, SL12): which activity takes the stage, which one waits behind the Now Playing chip, and the local
// overrides (Show Video, Show on the chip). Pure and shared (transpiled), so the stage presenter, both container
// views and both test hosts read one rule. Priority follows D17 (app, then shared browser, then game), but a lower
// activity is never silently hidden: whatever is live and not on the card is named by the chip, and Show on the chip
// moves it onto the card for this person only (apps/conclave-skip/AGENTS.md game stage layout rules keep you in the
// strip and never float your self view over the card).

/// The three activity kinds as the stage carries them (`StageLayoutSnapshot.activityKind` raw strings).
enum ActivityStageKind {
    static let app = "app"
    static let browser = "browser"
    static let game = "game"

    /// D17 order: an SDK app wins over the shared browser, which wins over a game.
    static let priority: [String] = [ActivityStageKind.app, ActivityStageKind.browser, ActivityStageKind.game]

    static func stageKind(_ kind: String) -> StageKind? {
        switch kind {
        case ActivityStageKind.app: return StageKind.app
        case ActivityStageKind.browser: return StageKind.browser
        case ActivityStageKind.game: return StageKind.game
        default: return nil
        }
    }
}

/// The names the chip and the announcements carry: the server game name verbatim and the SDK app id (the views map
/// the id to app-owned localized copy, S60 C6-18); the shared browser has no name of its own.
struct ActivityStageNames: Equatable {
    let appId: String
    let gameName: String

    static let empty = ActivityStageNames(appId: "", gameName: "")

    func name(for kind: String) -> String {
        switch kind {
        case ActivityStageKind.app: return appId
        case ActivityStageKind.game: return gameName
        default: return ""
        }
    }
}

/// What the stage shows for the live activities (S20 11 j): `activityKind` is the activity the card holds (or would
/// hold while video shows), `onStageKind` is empty while Show Video is on, and `hiddenActivityKind` names the activity
/// behind the chip: the card's own activity while video shows, else the next live activity.
struct ActivityStageResolution: Equatable {
    let liveKinds: [String]
    let activityKind: String
    let onStageKind: String
    let hiddenActivityKind: String
    let showsVideoOverActivity: Bool
    let chip: NowPlayingChip?

    static let none = ActivityStageResolution(liveKinds: [], activityKind: "", onStageKind: "", hiddenActivityKind: "",
                                              showsVideoOverActivity: false, chip: nil)

    /// The stage kind for the card, nil while no card shows.
    var stageKind: StageKind? { ActivityStageKind.stageKind(onStageKind) }
}

/// Activities that started or ended between two live sets, in priority order (announcements, S20 11 g, i).
struct ActivityStageTransitions: Equatable {
    let started: [String]
    let ended: [String]

    var isEmpty: Bool { started.isEmpty && ended.isEmpty }
}

enum ActivityStagePolicy {
    /// Announcement kinds the stage posts (`StageAnnouncement.kind`); the views resolve the strings (S20 11 g).
    static let startedAnnouncement = "activityStarted"
    static let endedAnnouncement = "activityEnded"

    /// The live kinds in priority order.
    static func liveKinds(activeAppId: String, isBrowserActive: Bool, isGameActive: Bool) -> [String] {
        var result: [String] = []
        if !activeAppId.isEmpty { result.append(ActivityStageKind.app) }
        if isBrowserActive { result.append(ActivityStageKind.browser) }
        if isGameActive { result.append(ActivityStageKind.game) }
        return result
    }

    /// The live kinds of a stage input set.
    static func liveKinds(_ inputs: StageInputs) -> [String] {
        if inputs.isWebinarAttendee { return [] }   // attendees never see activities (S20 11 f, web parity)
        return liveKinds(activeAppId: inputs.activeAppId, isBrowserActive: inputs.isBrowserActive, isGameActive: inputs.isGameActive)
    }

    /// A local preference (Show on the chip) survives only while its activity is live; then the priority order rules.
    static func normalizedPreference(_ preferred: String, live: [String]) -> String {
        if preferred.isEmpty || !live.contains(preferred) { return "" }
        return preferred
    }

    /// Show Video is local and reversible, and it resets when no activity is left (S20 11 j).
    static func normalizedShowsVideo(_ showsVideo: Bool, live: [String]) -> Bool {
        showsVideo && !live.isEmpty
    }

    /// The activity the card holds: the live preference, else the first live kind in priority order.
    static func primaryKind(live: [String], preferredKind: String) -> String {
        let preferred = normalizedPreference(preferredKind, live: live)
        if !preferred.isEmpty { return preferred }
        return live.first ?? ""
    }

    static func resolve(live: [String], preferredKind: String, showsVideoOverActivity: Bool,
                        names: ActivityStageNames) -> ActivityStageResolution {
        if live.isEmpty { return ActivityStageResolution.none }
        let primary = primaryKind(live: live, preferredKind: preferredKind)
        let showsVideo = normalizedShowsVideo(showsVideoOverActivity, live: live)
        var hidden = ""
        if showsVideo {
            hidden = primary
        } else {
            for kind in live where kind != primary {
                hidden = kind
                break
            }
        }
        var chip: NowPlayingChip? = nil
        if !hidden.isEmpty {
            chip = NowPlayingChip(kind: hidden, name: names.name(for: hidden))
        }
        return ActivityStageResolution(liveKinds: live, activityKind: primary, onStageKind: showsVideo ? "" : primary,
                                       hiddenActivityKind: hidden, showsVideoOverActivity: showsVideo, chip: chip)
    }

    /// What Show on the chip does: bring the card back while video shows, else move the hidden activity onto the card.
    /// Returns the next local preference; `showsVideo` is cleared by the caller in both cases.
    static func preferenceAfterShowingHidden(_ resolution: ActivityStageResolution, currentPreference: String) -> String {
        if resolution.showsVideoOverActivity { return currentPreference }
        if resolution.hiddenActivityKind.isEmpty { return currentPreference }
        return resolution.hiddenActivityKind
    }

    /// Whether a person tapping Show for `kind` (Activities panel, Now Playing row) needs the stage to change.
    static func isOnStage(kind: String, resolution: ActivityStageResolution) -> Bool {
        !kind.isEmpty && resolution.onStageKind == kind
    }

    /// The announcement name carries the activity kind ("game:Trivia", "app:whiteboard", "browser:"), because the
    /// stage announcement has one name field and shared code cannot localize: the views decode it and resolve the
    /// game name, the app's localized name or "Shared Browser".
    static func announcementName(kind: String, names: ActivityStageNames) -> String {
        kind + ":" + names.name(for: kind)
    }

    static func announcedKind(_ name: String) -> String {
        let parts = name.components(separatedBy: ":")
        return parts.count > 1 ? parts[0] : ""
    }

    static func announcedName(_ name: String) -> String {
        let parts = name.components(separatedBy: ":")
        if parts.count < 2 { return name }
        var rest: [String] = []
        var index = 1
        while index < parts.count {
            rest.append(parts[index])
            index += 1
        }
        return rest.joined(separator: ":")
    }

    static func transitions(previous: [String], next: [String]) -> ActivityStageTransitions {
        var started: [String] = []
        var ended: [String] = []
        for kind in ActivityStageKind.priority {
            let was = previous.contains(kind)
            let isLive = next.contains(kind)
            if isLive && !was { started.append(kind) }
            if was && !isLive { ended.append(kind) }
        }
        return ActivityStageTransitions(started: started, ended: ended)
    }
}

/// The card's own load state for web-backed bodies (S20 11 c, S60R 25): "Opening %@" with a spinner, "Couldn't Open
/// %@" with Retry and Show Video. Games are always `live` (their states live in the game shell).
enum ActivityCardPhase: String, CaseIterable, Equatable {
    case live, opening, failed
}
