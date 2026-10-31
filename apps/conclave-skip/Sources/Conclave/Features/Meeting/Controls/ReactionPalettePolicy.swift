import Foundation

struct ReactionOptionModel: Equatable, Identifiable {

    let id: String

    let kind: String

    let nameKey: String
}

enum ReactionAvailability: String, CaseIterable, Equatable {
    case available, disabledByHost, reconnecting, offline, attendee, unavailable
}

struct ReactionPaletteSnapshot: Equatable {
    let revision: Int
    let emoji: [ReactionOptionModel]
    let art: [ReactionOptionModel]
    let availability: ReactionAvailability

    static let empty = ReactionPaletteSnapshot(revision: 0, emoji: [], art: [], availability: ReactionAvailability.unavailable)

    var isAvailable: Bool { availability == ReactionAvailability.available }

    func withRevision(_ next: Int) -> ReactionPaletteSnapshot {
        ReactionPaletteSnapshot(revision: next, emoji: emoji, art: art, availability: availability)
    }
}

enum ReactionPalettePolicy {

    static let artShipped = false

    static func nameKey(_ value: String) -> String {
        switch value {
        case "👍": return "thumbsUp"
        case "👏": return "clap"
        case "😂": return "laugh"
        case "❤️": return "heart"
        case "🎉": return "party"
        case "😮": return "wow"
        case "/reactions/aura.gif": return "aura"
        case "/reactions/crycry.gif": return "crying"
        case "/reactions/goblin.gif": return "goblin"
        case "/reactions/phone.gif": return "phone"
        case "/reactions/sixseven.gif": return "sixSeven"
        case "/reactions/yawn.gif": return "yawn"
        default: return ""
        }
    }

    static func emojiOptions() -> [ReactionOptionModel] {
        var result: [ReactionOptionModel] = []
        for value in MeetingReactionConstants.emojiOptions {
            result.append(ReactionOptionModel(id: value, kind: ReactionKind.emoji.rawValue, nameKey: nameKey(value)))
        }
        return result
    }

    static func artOptions(artShipped: Bool) -> [ReactionOptionModel] {
        if !artShipped { return [] }
        var result: [ReactionOptionModel] = []
        for option in MeetingReactionConstants.assetOptions {
            result.append(ReactionOptionModel(id: option.value, kind: ReactionKind.asset.rawValue, nameKey: nameKey(option.value)))
        }
        return result
    }

    static func availability(_ inputs: CallControlsInputs) -> ReactionAvailability {
        if inputs.isWebinarAttendee { return ReactionAvailability.attendee }
        guard let row = inputs.row(MeetingControlID.reactions) else { return ReactionAvailability.unavailable }
        if row.isEnabled { return ReactionAvailability.available }
        switch row.blockedReason {
        case .disabledByHost: return ReactionAvailability.disabledByHost
        case .reconnecting: return ReactionAvailability.reconnecting
        case .offline: return ReactionAvailability.offline
        case .attendee: return ReactionAvailability.attendee
        default: return ReactionAvailability.unavailable
        }
    }

    static func snapshot(inputs: CallControlsInputs, artShipped: Bool, revision: Int) -> ReactionPaletteSnapshot {
        ReactionPaletteSnapshot(revision: revision, emoji: emojiOptions(), art: artOptions(artShipped: artShipped),
                                availability: availability(inputs))
    }

    static func reason(_ availability: ReactionAvailability) -> ControlBlockedReason {
        switch availability {
        case .available: return ControlBlockedReason.none
        case .disabledByHost: return ControlBlockedReason.disabledByHost
        case .reconnecting: return ControlBlockedReason.reconnecting
        case .offline: return ControlBlockedReason.offline
        case .attendee: return ControlBlockedReason.attendee
        case .unavailable: return ControlBlockedReason.notJoined
        }
    }

    static func option(id: String) -> MeetingReactionOption? {
        for option in MeetingReactionConstants.allOptions {
            if option.value == id { return option }
        }
        return nil
    }

    static func offers(_ palette: ReactionPaletteSnapshot, id: String) -> Bool {
        for option in palette.emoji {
            if option.id == id { return true }
        }
        for option in palette.art {
            if option.id == id { return true }
        }
        return false
    }
}
