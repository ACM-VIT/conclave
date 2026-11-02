import Foundation

enum ActivitiesCatalogPolicy {

    static let defaultAppIds: [String] = ["whiteboard", "wheel", "watch"]

    static let maxSegments = 4

    static let counterLead = 20

    static let slowStartMillis = 5000.0

    static let pendingTimeoutMillis = 15000.0

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

    static func resolvedForStart(_ option: ActivityOptionInput, draft: ActivityOptionValue?) -> ActivityOptionValue {
        let value = currentValue(option, draft: draft)
        if option.type != GameOptionModel.textKind { return value }
        var text = value.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if option.maxLength > 0 && text.count > option.maxLength {
            text = String(text.prefix(option.maxLength))
        }
        return ActivityOptionValue(id: option.id, isNumber: false, number: 0, text: text)
    }

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

    static func catalogReason(isRecovering: Bool, isVoteOpen: Bool, isGameLive: Bool) -> ActivitiesReason {
        if isRecovering { return ActivitiesReason.recovering }
        if isVoteOpen { return ActivitiesReason.voteOpen }
        if isGameLive { return ActivitiesReason.gameLive }
        return ActivitiesReason.none
    }
}

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
