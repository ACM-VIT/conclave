import Foundation

// Shared, testable presentation policies for the in-call games. The games
// sheet (catalog/config/vote) and the on-stage game surface both read these.

struct GameCatalogVisual: Equatable {
    let icon: String
    let androidIcon: String
}

enum GameCatalogPresentationPolicy {
    static func visual(for gameId: String) -> GameCatalogVisual {
        switch gameId {
        case "trivia":
            return GameCatalogVisual(icon: "questionmark.circle.fill", androidIcon: "info")
        case "bluff":
            return GameCatalogVisual(icon: "theatermasks.fill", androidIcon: "forum")
        case "would-you-rather":
            return GameCatalogVisual(icon: "arrow.left.arrow.right", androidIcon: "arrow.forward")
        case "most-likely-to":
            return GameCatalogVisual(icon: "person.2.fill", androidIcon: "participants")
        case "reaction":
            return GameCatalogVisual(icon: "bolt.fill", androidIcon: "warning")
        case "imposter":
            return GameCatalogVisual(icon: "eye.slash.fill", androidIcon: "ghost")
        case "wordle":
            return GameCatalogVisual(icon: "square.grid.3x3.fill", androidIcon: "grid")
        case "chess":
            return GameCatalogVisual(icon: "checkerboard.rectangle", androidIcon: "grid")
        default:
            return GameCatalogVisual(icon: "gamecontroller.fill", androidIcon: "sports_esports")
        }
    }

    static func catalogSubtitle(_ game: GameCatalogEntry) -> String {
        let description = game.description.trimmingCharacters(in: .whitespacesAndNewlines)
        return description.isEmpty ? playerRange(game) : description
    }

    static func playerRange(_ game: GameCatalogEntry) -> String {
        if game.minPlayers == game.maxPlayers {
            return "\(game.minPlayers)"
        }
        return "\(game.minPlayers)-\(game.maxPlayers)"
    }

    static func canOpenVote(catalogCount: Int, isActionInFlight: Bool) -> Bool {
        !isActionInFlight && catalogCount >= 2
    }

    static func shouldShowDivider(after index: Int, total: Int, hasFooter: Bool) -> Bool {
        index < total - 1 || hasFooter
    }
}

enum GameVotePresentationPolicy {
    static func leader(in vote: GameVoteState) -> GameCatalogEntry? {
        var leader: GameCatalogEntry?
        var leaderVotes = -1
        for entry in vote.candidates {
            let count = vote.tally[entry.id] ?? 0
            if count > leaderVotes {
                leader = entry
                leaderVotes = count
            }
        }
        return leader
    }

    static func startLeaderTitle(_ vote: GameVoteState) -> String {
        guard let leader = leader(in: vote) else { return "Start leader" }
        let votes = vote.tally[leader.id] ?? 0
        return votes > 0 ? "Start \(leader.name)" : "Start leader"
    }

    static func shouldShowCandidateDivider(after index: Int, total: Int, hasHostActions: Bool) -> Bool {
        index < total - 1 || hasHostActions
    }
}

struct GameChoiceOption: Identifiable, Equatable {
    let id: String
    let text: String
    let subtitle: String?
    let isReal: Bool?
}

struct GameScoreRow: Identifiable, Equatable {
    let id: String
    let name: String
    let score: Int
}

struct GameReactionResultRow: Identifiable, Equatable {
    let id: String
    let rank: Int
    let name: String
    let resultText: String
    let isEarly: Bool
    let isWinner: Bool
}

enum GameDetailsPresentationPolicy {
    static func scoreboardRows(from view: GameJSONValue?) -> [GameScoreRow] {
        let rows = view?.objectArray("scoreboard") ?? []
        return rows.compactMap(scoreboardRow).sorted { $0.score > $1.score }
    }

    static func intMap(from view: GameJSONValue?, key: String) -> [String: Int] {
        guard let values = view?.dictionaryValue?[key] as? [String: Any] else {
            return [:]
        }
        var result: [String: Int] = [:]
        for (id, value) in values {
            if let count = intValue(value) {
                result[id] = count
            }
        }
        return result
    }

    static func namesSummary(_ names: [String]) -> String {
        let cleaned = names
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return cleaned.isEmpty ? "nobody" : cleaned.joined(separator: ", ")
    }

    static func roundPointsSummary(from view: GameJSONValue?) -> String? {
        let rows = view?.objectArray("roundPoints") ?? []
        var parts: [String] = []
        for row in rows {
            let name = (row["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !name.isEmpty, let points = intValue(row["points"]), points != 0 else {
                continue
            }
            let prefix = points > 0 ? "+" : ""
            parts.append("\(name) \(prefix)\(points)")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " - ")
    }

    static func reactionResultRows(from view: GameJSONValue?) -> [GameReactionResultRow] {
        let rows = view?.objectArray("results") ?? []
        return rows.enumerated().compactMap { index, row in
            let id = (row["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let resolvedId = id?.isEmpty == false ? id! : "reaction-\(index)"
            let rawName = (row["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let name = rawName?.isEmpty == false ? rawName! : resolvedId
            let isEarly = boolValue(row["early"]) ?? false
            let resultText: String
            if isEarly {
                resultText = "too soon"
            } else if let reactionMs = intValue(row["reactionMs"]) {
                resultText = "\(reactionMs) ms"
            } else {
                resultText = "no tap"
            }
            return GameReactionResultRow(
                id: resolvedId,
                rank: index + 1,
                name: name,
                resultText: resultText,
                isEarly: isEarly,
                isWinner: index == 0 && !isEarly
            )
        }
    }

    static func gamePlayerOption(_ row: [String: Any]) -> GamePlayer? {
        guard let id = row["id"] as? String else { return nil }
        let name = (row["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return GamePlayer(id: id, name: name?.isEmpty == false ? name! : id)
    }

    static func intValue(_ value: Any?) -> Int? {
        if let intValue = value as? Int { return intValue }
        if let doubleValue = value as? Double { return Int(doubleValue) }
        if let numberValue = value as? NSNumber { return numberValue.intValue }
        return nil
    }

    static func boolValue(_ value: Any?) -> Bool? {
        if let boolValue = value as? Bool { return boolValue }
        if let intValue = value as? Int { return intValue != 0 }
        if let doubleValue = value as? Double { return doubleValue != 0.0 }
        if let numberValue = value as? NSNumber { return numberValue.intValue != 0 }
        return nil
    }

    private static func scoreboardRow(_ row: [String: Any]) -> GameScoreRow? {
        guard let id = row["id"] as? String else { return nil }
        let name = (row["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return GameScoreRow(
            id: id,
            name: name?.isEmpty == false ? name! : id,
            score: intValue(row["score"]) ?? 0
        )
    }
}

struct GameNumberPreset: Identifiable {
    let value: Double
    let label: String

    var id: String { label }
}

enum GameConfigDraftPolicy {
    static func initialDrafts(for game: GameCatalogEntry) -> [String: GameConfigValue] {
        var options: [String: GameConfigValue] = [:]
        for option in game.options {
            let id = option.id.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty else { continue }
            options[id] = resolvedValue(for: option, draft: option.defaultConfigValue)
        }
        return options
    }

    static func resolvedOptions(
        for game: GameCatalogEntry,
        drafts: [String: GameConfigValue]
    ) -> [String: GameConfigValue] {
        var options: [String: GameConfigValue] = [:]
        for option in game.options {
            let id = option.id.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty else { continue }
            options[id] = resolvedValue(for: option, draft: drafts[option.id])
        }
        return options
    }

    static func resolvedValue(for option: GameOptionSpec, draft: GameConfigValue?) -> GameConfigValue {
        switch option.type {
        case "number":
            let raw = draft?.numberValue ?? option.defaultConfigValue.numberValue ?? option.min ?? 0.0
            return .number(clamp(raw, min: option.min, max: option.max))
        case "select":
            let choices = option.choices ?? []
            let defaultValue = option.defaultConfigValue.stringValue ?? choices.first?.value ?? ""
            let raw = draft?.stringValue ?? defaultValue
            if choices.contains(where: { $0.value == raw }) {
                return .string(raw)
            }
            return .string(defaultValue)
        default:
            let maxLength = max(0, option.maxLength ?? Int.max)
            let raw = draft?.stringValue ?? option.defaultConfigValue.stringValue ?? ""
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.count <= maxLength {
                return .string(trimmed)
            }
            return .string(String(trimmed.prefix(maxLength)))
        }
    }

    static func numberPresets(for option: GameOptionSpec) -> [GameNumberPreset] {
        let source = option.presets ?? [
            option.min ?? option.defaultConfigValue.numberValue ?? 0.0,
            option.defaultConfigValue.numberValue ?? option.min ?? 0.0,
            option.max ?? option.defaultConfigValue.numberValue ?? 0.0
        ]
        var seen: [Double] = []
        var presets: [GameNumberPreset] = []
        for raw in source {
            let value = clamp(raw, min: option.min, max: option.max)
            if seen.contains(where: { numbersMatch($0, value) }) { continue }
            seen.append(value)
            presets.append(GameNumberPreset(
                value: value,
                label: formattedNumber(value, suffix: option.suffix)
            ))
        }
        return presets
    }

    static func numbersMatch(_ lhs: Double, _ rhs: Double) -> Bool {
        abs(lhs - rhs) < 0.0001
    }

    private static func clamp(_ value: Double, min: Double?, max: Double?) -> Double {
        var next = value
        if let min {
            next = Swift.max(min, next)
        }
        if let max {
            next = Swift.min(max, next)
        }
        return next
    }

    private static func formattedNumber(_ value: Double, suffix: String?) -> String {
        let rounded = value.rounded()
        let base = numbersMatch(value, rounded) ? "\(Int(rounded))" : "\(value)"
        guard let suffix = suffix?.trimmingCharacters(in: .whitespacesAndNewlines),
              !suffix.isEmpty else { return base }
        return "\(base) \(suffix)"
    }
}

// MARK: - Stage text policies

/// Text derivations for the on-stage game views. Pure string logic so it can
/// be unit-tested without SwiftUI.
enum GameStageTextPolicy {
    static func progressKicker(_ view: GameJSONValue?, fallback: String) -> String {
        let index = view?.int("questionIndex") ?? view?.int("index")
        let total = view?.int("totalQuestions") ?? view?.int("total")
        let category = view?.string("category")
        if let index, let total, total > 0 {
            let prefix = category.flatMap { $0.isEmpty ? nil : "\($0) · " } ?? ""
            return "\(prefix)\(index + 1) of \(total)"
        }
        if let category, !category.isEmpty {
            return category
        }
        return fallback
    }

    static func phaseLabel(_ phase: String) -> String {
        switch phase {
        case "lobby": return "Lobby"
        case "question": return "Question"
        case "choose": return "Choose"
        case "vote": return "Vote"
        case "write": return "Write"
        case "arming": return "Get ready"
        case "go": return "Go"
        case "reveal": return "Reveal"
        case "result": return "Result"
        case "results": return "Results"
        case "discuss": return "Discuss"
        case "set-word": return "Set word"
        case "playing": return "Playing"
        default: return phase.capitalized
        }
    }

    static func playersLine(count: Int) -> String {
        count == 1 ? "1 player" : "\(count) players"
    }

    static func voteCountText(_ count: Int) -> String {
        count == 1 ? "1 vote" : "\(count) votes"
    }

    /// Server prompts are fragments like "to become a world leader"; read them
    /// as a sentence under the game's name.
    static func mostLikelyHeadline(_ prompt: String?) -> String {
        guard let prompt = prompt?.trimmingCharacters(in: .whitespacesAndNewlines),
              !prompt.isEmpty else {
            return "Waiting for the prompt."
        }
        if prompt.lowercased().hasPrefix("to ") {
            return "Most likely \(prompt)"
        }
        return prompt
    }

    static func triviaWinnerText(_ view: GameJSONValue?) -> String {
        let rows = GameDetailsPresentationPolicy.scoreboardRows(from: view)
        guard let winner = rows.first else { return "Scores are not available yet." }
        return "\(winner.name) wins with \(winner.score)"
    }

    static func triviaPlayerStatus(_ playerView: GameJSONValue, phase: String) -> String {
        if phase == "reveal" {
            if playerView.bool("correct") == true {
                let points = playerView.int("lastRoundPoints") ?? 0
                return points > 0 ? "Correct +\(points)" : "Correct"
            }
            if playerView.bool("answered") == true {
                return "Not quite"
            }
            return "Time's up"
        }
        let score = playerView.int("score") ?? 0
        let rank = playerView.int("rank")
        let rankSuffix = rank.map { " · #\($0)" } ?? ""
        return "\(score) points\(rankSuffix)"
    }

    static func reactionTitle(phase: String, tapped: Bool, early: Bool, reactionMs: Int?) -> String {
        if phase == "results" { return "Final scores" }
        if early { return "Too early" }
        if let reactionMs { return "\(reactionMs) ms" }
        if tapped { return "Locked in" }
        if phase == "go" { return "Tap!" }
        if phase == "reveal" { return "Round result" }
        return "Wait for green"
    }

    static func reactionSubtitle(_ view: GameJSONValue?, phase: String) -> String {
        if phase == "results" {
            let rows = GameDetailsPresentationPolicy.scoreboardRows(from: view)
            if let winner = rows.first, winner.score > 0 {
                return "\(winner.name) takes it with \(winner.score)"
            }
            return "That was quick."
        }
        if let winner = view?.string("winnerName"), !winner.isEmpty {
            return "Fastest: \(winner)"
        }
        let tapped = view?.int("tappedCount") ?? 0
        let total = view?.int("totalPlayers") ?? 0
        if total > 0 {
            return "\(tapped) of \(total) tapped"
        }
        return phaseLabel(phase)
    }

    static func bluffTitle(_ view: GameJSONValue?, phase: String) -> String {
        let round = view?.int("round")
        let total = view?.int("totalRounds")
        let prefix: String
        if let round, let total, total > 0 {
            prefix = "\(round + 1) of \(total) · "
        } else {
            prefix = ""
        }
        switch phase {
        case "write":
            return "\(prefix)Write a bluff"
        case "choose":
            return "\(prefix)Find the truth"
        case "reveal":
            return "\(prefix)Reveal"
        case "results":
            return "Final scores"
        default:
            return phaseLabel(phase)
        }
    }

    static func bluffSubmittedText(_ value: String?) -> String {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "Bluff submitted" : "Submitted: \(trimmed)"
    }

    static func bluffOption(_ row: [String: Any]) -> GameChoiceOption? {
        guard let id = row["id"] as? String else { return nil }
        let text = (row["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let text, !text.isEmpty else { return nil }
        let kind = row["kind"] as? String
        let votes = GameDetailsPresentationPolicy.intValue(row["votes"])
        let ownerName = (row["ownerName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let subtitleParts = [
            kind == "real" ? "Truth" : (ownerName?.isEmpty == false ? ownerName : nil),
            votes.map { count in voteCountText(count) }
        ].compactMap { $0 }
        return GameChoiceOption(
            id: id,
            text: text,
            subtitle: subtitleParts.isEmpty ? nil : subtitleParts.joined(separator: " · "),
            isReal: kind == nil ? nil : kind == "real"
        )
    }

    static func imposterTitle(publicView: GameJSONValue?, playerView: GameJSONValue?, phase: String) -> String {
        switch phase {
        case "reveal", "discuss":
            if playerView?.string("role") == "imposter" {
                return "You are the imposter"
            }
            let word = playerView?.string("word")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return word.isEmpty ? "Secret word" : word
        case "vote":
            return "Vote out the imposter"
        case "result":
            return imposterResultTitle(publicView)
        default:
            return phaseLabel(phase)
        }
    }

    static func imposterSubtitle(publicView: GameJSONValue?, playerView: GameJSONValue?, phase: String) -> String? {
        if phase == "vote" {
            let voted = publicView?.stringArray("votedPlayerIds").count ?? 0
            let total = publicView?.int("totalPlayers") ?? 0
            return total > 0 ? "\(voted) of \(total) voted" : nil
        }

        let category = playerView?.string("category") ?? publicView?.string("category")
        if phase == "reveal" || phase == "discuss",
           playerView?.string("role") == "imposter" {
            let base = "Blend in. You do not know the word."
            if let category, !category.isEmpty {
                return "\(base) Category: \(category)"
            }
            return base
        }
        if phase == "discuss",
           let starter = publicView?.string("starterName"),
           !starter.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let prefix = category.flatMap { $0.isEmpty ? nil : "\($0) · " } ?? ""
            return "\(prefix)\(starter) starts"
        }
        return category?.isEmpty == false ? category : nil
    }

    static func imposterResultTitle(_ view: GameJSONValue?) -> String {
        guard let result = view?.dictionaryValue?["result"] as? [String: Any] else {
            return "Result"
        }
        if GameDetailsPresentationPolicy.boolValue(result["tie"]) == true {
            return "Vote tied"
        }
        return GameDetailsPresentationPolicy.boolValue(result["crewWon"]) == true ? "Crew wins" : "Imposter wins"
    }

    static func imposterVoteSubtitle(_ view: GameJSONValue?, playerId: String, isSelf: Bool) -> String? {
        if isSelf { return "You" }
        let counts = view?.dictionaryValue?["voteCounts"] as? [String: Any]
        guard let count = GameDetailsPresentationPolicy.intValue(counts?[playerId]), count > 0 else { return nil }
        return voteCountText(count)
    }
}
