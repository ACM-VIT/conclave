import Foundation

// S30 6 j (CTL-6): the reaction palette contract and its pure policy, shared by the iOS More menu palette, the iOS
// fallback sheet and tray, and the Android More sheet rows (F00 C22, RECONCILE R35). Transpiled: String raw-value enums,
// scalar structs and arrays of structs. Ids are `MeetingReactionOption.value` exactly ("👍", "/reactions/aura.gif"),
// the wire value and the flat-art lookup key; kinds are the `ReactionKind` raw values. The art row stays empty until the
// six flat reaction assets ship per platform (CC14, S30 Q10, RECONCILE R12): the animated legacy GIFs never ship natively.

/// One palette entry (S30 0.5).
struct ReactionOptionModel: Equatable, Identifiable {
    /// `MeetingReactionOption.value`: the wire value and the flat-art key.
    let id: String
    /// `ReactionKind` raw value: "emoji" or "asset".
    let kind: String
    /// The spoken name key: thumbsUp, clap, laugh, heart, party, wow, aura, crying, goblin, phone, sixSeven, yawn.
    let nameKey: String
}

/// Why the palette cannot send (S30 6 f). `unavailable` covers leaving and not yet joined (no copy: the bar is
/// disabled then anyway).
enum ReactionAvailability: String, CaseIterable, Equatable {
    case available, disabledByHost, reconnecting, offline, attendee, unavailable
}

/// `controls.reactions`: read only by the palette, the tray and the Android reaction rows (S30 6 k), so a reaction
/// never touches `bar` or `more`.
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
    /// CC14 and S30 Q10: false until six flat art assets per platform ship with the existing wire ids. While false the
    /// art row, the iOS "More Reactions…" row and the tray's art row stay hidden, and the bundle carries no reaction art.
    static let artShipped = false

    /// The spoken name key for a wire value (S30 6 g); "" for a value outside the palette.
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

    /// The six emoji in the web order (MD `emojiOptions`, F00 C22 l).
    static func emojiOptions() -> [ReactionOptionModel] {
        var result: [ReactionOptionModel] = []
        for value in MeetingReactionConstants.emojiOptions {
            result.append(ReactionOptionModel(id: value, kind: ReactionKind.emoji.rawValue, nameKey: nameKey(value)))
        }
        return result
    }

    /// The six art reactions with their wire ids; empty while the flat art has not shipped.
    static func artOptions(artShipped: Bool) -> [ReactionOptionModel] {
        if !artShipped { return [] }
        var result: [ReactionOptionModel] = []
        for option in MeetingReactionConstants.assetOptions {
            result.append(ReactionOptionModel(id: option.value, kind: ReactionKind.asset.rawValue, nameKey: nameKey(option.value)))
        }
        return result
    }

    /// From the S1 `reactions` row (S30 7 Reactions row): attendees have none; a host keeps the palette when reactions
    /// are off (web parity, 6 f); recovery and offline block it with their reason.
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

    /// The reason line the palette shows in place of its rows (S30 6 f, 7) in the controls vocabulary.
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

    /// The option a palette id names, or nil (S30 0.5: an id that resolves to nothing is ignored instead of being
    /// dropped silently by the core's allow list).
    static func option(id: String) -> MeetingReactionOption? {
        for option in MeetingReactionConstants.allOptions {
            if option.value == id { return option }
        }
        return nil
    }

    /// True when `id` is one of the options this snapshot offers (emoji, or art once shipped).
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
