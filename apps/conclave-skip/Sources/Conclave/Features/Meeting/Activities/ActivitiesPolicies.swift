import Foundation

/// S60 7 (ACT-1): pure catalog, setup and vote rules, shared by the presenter and both test hosts.
enum ActivitiesCatalogPolicy {
    /// The SDK app catalog (C6-18): ids only, in the web order.
    static let defaultAppIds: [String] = ["whiteboard", "wheel", "watch"]
    /// Option segments render as a segmented row only up to this many choices (L6-10, both platforms).
    static let maxSegments = 4
    /// The text counter appears this many characters before the limit (S60 7 c).
    static let counterLead = 20
    /// "Still starting" after this long (S60 7 f).
    static let slowStartMillis = 5000.0
    /// Pending launcher actions clear after this long when the core never answered (a dropped command).
    static let pendingTimeoutMillis = 15000.0

    /// The key a number choice carries: integral values without a fraction, so "7" never reads "7.0".
    static func numberKey(_ value: Double) -> String {
        let rounded = value.rounded()
        if abs(value - rounded) < 0.0001 { return String(Int(rounded)) }
        return String(value)
    }

    static func clamp(_ value: Double, option: ActivityOptionInput) -> Double {
        var next = value
        if option.hasMin && next < option.min { next = option.min }
        if option.hasMax && next > option.max { next = option.max }
        return next
    }

    /// Number presets: the server's, else min, default and max (the legacy rule), clamped and deduplicated.
    static func numberPresets(_ option: ActivityOptionInput) -> [Double] {
        var source = option.presets
        if source.isEmpty {
            source = [option.hasMin ? option.min : option.defaultNumber, option.defaultNumber, option.hasMax ? option.max : option.defaultNumber]
        }
        var result: [Double] = []
        for raw in source {
            let value = clamp(raw, option: option)
            var seen = false
            for existing in result where abs(existing - value) < 0.0001 {
                seen = true
            }
            if !seen { result.append(value) }
        }
        return result
    }

    /// A number choice label: the number plus the server suffix verbatim ("10 min").
    static func numberLabel(_ value: Double, suffix: String) -> String {
        let base = numberKey(value)
        let trimmed = suffix.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? base : base + " " + trimmed
    }

    static func defaultValue(_ option: ActivityOptionInput) -> ActivityOptionValue {
        switch option.type {
        case GameOptionModel.numberKind:
            return ActivityOptionValue(id: option.id, isNumber: true, number: clamp(option.defaultNumber, option: option), text: "")
        case GameOptionModel.selectKind:
            var value = option.defaultString
            if !choiceExists(value, in: option.choices) { value = option.choices.first?.id ?? "" }
            return ActivityOptionValue(id: option.id, isNumber: false, number: 0, text: value)
        default:
            return ActivityOptionValue(id: option.id, isNumber: false, number: 0, text: option.defaultString)
        }
    }

    static func choiceExists(_ id: String, in choices: [GameChoiceModel]) -> Bool {
        for choice in choices where choice.id == id {
            return true
        }
        return false
    }

    /// The value a draft resolves to for the current option (unknown select values fall back to the default).
    static func currentValue(_ option: ActivityOptionInput, draft: ActivityOptionValue?) -> ActivityOptionValue {
        guard let draft = draft else { return defaultValue(option) }
        switch option.type {
        case GameOptionModel.numberKind:
            return ActivityOptionValue(id: option.id, isNumber: true, number: clamp(draft.number, option: option), text: "")
        case GameOptionModel.selectKind:
            if choiceExists(draft.text, in: option.choices) { return draft }
            return defaultValue(option)
        default:
            return draft
        }
    }

    /// The value sent on Start (C6-16, INM G2): numbers clamped, selects checked, text trimmed and capped once, here.
    static func resolvedForStart(_ option: ActivityOptionInput, draft: ActivityOptionValue?) -> ActivityOptionValue {
        let value = currentValue(option, draft: draft)
        if option.type != GameOptionModel.textKind { return value }
        var text = value.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if option.maxLength > 0 && text.count > option.maxLength {
            text = String(text.prefix(option.maxLength))
        }
        return ActivityOptionValue(id: option.id, isNumber: false, number: 0, text: text)
    }

    /// `showWhen` (C6-16): the option shows while the named select option holds one of the listed values. A
    /// condition naming an unknown option shows the option (older servers never send one).
    static func isVisible(_ option: ActivityOptionInput, among options: [ActivityOptionInput], drafts: [ActivityOptionValue]) -> Bool {
        if option.showWhenId.isEmpty { return true }
        for other in options where other.id == option.showWhenId {
            let value = currentValue(other, draft: draft(other.id, in: drafts))
            return option.showWhenEquals.contains(value.text)
        }
        return true
    }

    static func draft(_ id: String, in drafts: [ActivityOptionValue]) -> ActivityOptionValue? {
        for value in drafts where value.id == id {
            return value
        }
        return nil
    }

    static func optionModel(_ option: ActivityOptionInput, among options: [ActivityOptionInput],
                            drafts: [ActivityOptionValue]) -> GameOptionModel {
        let value = currentValue(option, draft: draft(option.id, in: drafts))
        var choices: [GameChoiceModel] = []
        var current = value.text
        switch option.type {
        case GameOptionModel.numberKind:
            for preset in numberPresets(option) {
                choices.append(GameChoiceModel(id: numberKey(preset), label: numberLabel(preset, suffix: option.suffix)))
            }
            current = numberKey(value.number)
            if !choiceExists(current, in: choices) {
                // A value between presets (an older draft or a server default) still shows as its own choice.
                choices.append(GameChoiceModel(id: current, label: numberLabel(value.number, suffix: option.suffix)))
            }
        case GameOptionModel.selectKind:
            choices = option.choices
        default:
            break
        }
        let kind = option.type == GameOptionModel.numberKind || option.type == GameOptionModel.selectKind
            ? option.type : GameOptionModel.textKind
        return GameOptionModel(id: option.id, label: option.label, kind: kind, choices: choices, value: current,
                               maxLength: option.maxLength, placeholder: option.placeholder,
                               isVisible: isVisible(option, among: options, drafts: drafts))
    }

    /// The vote leader: the most votes, the first candidate on a tie; "" when nobody voted yet.
    static func leader(candidates: [ActivityGameInput], counts: [ActivityVoteCount]) -> ActivityGameInput? {
        var best: ActivityGameInput? = nil
        var bestCount = 0
        for candidate in candidates {
            let count = voteCount(candidate.id, counts: counts)
            if count > bestCount {
                best = candidate
                bestCount = count
            }
        }
        return best
    }

    static func voteCount(_ gameId: String, counts: [ActivityVoteCount]) -> Int {
        for entry in counts where entry.gameId == gameId {
            return entry.count
        }
        return 0
    }

    /// The catalog footer reason, first match wins (S60 7 c): recovering, an open vote, a live game.
    static func catalogReason(isRecovering: Bool, isVoteOpen: Bool, isGameLive: Bool) -> ActivitiesReason {
        if isRecovering { return ActivitiesReason.recovering }
        if isVoteOpen { return ActivitiesReason.voteOpen }
        if isGameLive { return ActivitiesReason.gameLive }
        return ActivitiesReason.none
    }
}

/// The shared browser URL rules (S60 7 g "validation verbatim from web"), mirroring the view model's
/// `normalizedBrowserURL(from:)` so the launcher can explain a bad URL under the field before any command.
enum BrowserURLValidationPolicy {
    static func validate(_ input: String) -> BrowserValidation {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return BrowserValidation.empty }
        if trimmed.contains(" ") || trimmed.contains("\n") || trimmed.contains("\t") || trimmed.contains("\r") {
            return BrowserValidation.spaces
        }
        let lowercased = trimmed.lowercased()
        var candidate = trimmed
        if !(lowercased.hasPrefix("http://") || lowercased.hasPrefix("https://")) {
            if hasScheme(trimmed) { return BrowserValidation.scheme }
            candidate = "https://" + trimmed
        }
        guard let components = URLComponents(string: candidate),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host,
              !host.isEmpty,
              components.url != nil else {
            return BrowserValidation.invalid
        }
        return BrowserValidation.none
    }

    /// The view model's `hasURLScheme` rule verbatim: letters first, then letters, digits, "+", "." or "-" before a colon.
    static func hasScheme(_ value: String) -> Bool {
        guard let colonIndex = value.firstIndex(of: ":") else { return false }
        let scheme = String(value[..<colonIndex])
        guard let first = scheme.first else { return false }
        let letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
        let allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+.-"
        guard letters.contains(first) else { return false }
        for character in scheme where !allowed.contains(character) {
            return false
        }
        return true
    }
}
