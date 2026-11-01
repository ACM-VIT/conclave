import Foundation

enum ActivityStageKind {
    static let app = "app"
    static let browser = "browser"
    static let game = "game"

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

struct ActivityStageResolution: Equatable {
    let liveKinds: [String]
    let activityKind: String
    let onStageKind: String
    let hiddenActivityKind: String
    let showsVideoOverActivity: Bool
    let chip: NowPlayingChip?

    static let none = ActivityStageResolution(liveKinds: [], activityKind: "", onStageKind: "", hiddenActivityKind: "",
                                              showsVideoOverActivity: false, chip: nil)

    var stageKind: StageKind? { ActivityStageKind.stageKind(onStageKind) }
}

struct ActivityStageTransitions: Equatable {
    let started: [String]
    let ended: [String]

    var isEmpty: Bool { started.isEmpty && ended.isEmpty }
}

enum ActivityStagePolicy {

    static let startedAnnouncement = "activityStarted"
    static let endedAnnouncement = "activityEnded"

    static func liveKinds(activeAppId: String, isBrowserActive: Bool, isGameActive: Bool) -> [String] {
        var result: [String] = []
        if !activeAppId.isEmpty { result.append(ActivityStageKind.app) }
        if isBrowserActive { result.append(ActivityStageKind.browser) }
        if isGameActive { result.append(ActivityStageKind.game) }
        return result
    }

    static func liveKinds(_ inputs: StageInputs) -> [String] {
        if inputs.isWebinarAttendee { return [] }
        return liveKinds(activeAppId: inputs.activeAppId, isBrowserActive: inputs.isBrowserActive, isGameActive: inputs.isGameActive)
    }

    static func normalizedPreference(_ preferred: String, live: [String]) -> String {
        if preferred.isEmpty || !live.contains(preferred) { return "" }
        return preferred
    }

    static func normalizedShowsVideo(_ showsVideo: Bool, live: [String]) -> Bool {
        showsVideo && !live.isEmpty
    }

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

    static func preferenceAfterShowingHidden(_ resolution: ActivityStageResolution, currentPreference: String) -> String {
        if resolution.showsVideoOverActivity { return currentPreference }
        if resolution.hiddenActivityKind.isEmpty { return currentPreference }
        return resolution.hiddenActivityKind
    }

    static func isOnStage(kind: String, resolution: ActivityStageResolution) -> Bool {
        !kind.isEmpty && resolution.onStageKind == kind
    }

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

enum ActivityCardPhase: String, CaseIterable, Equatable {
    case live, opening, failed
}
