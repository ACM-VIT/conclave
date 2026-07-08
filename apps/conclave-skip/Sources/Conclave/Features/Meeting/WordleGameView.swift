import SwiftUI

/// Native Wordle round UI. Renders the guess grid, an informational keyboard,
/// live standings, and the set-word / playing / results phases. Parses the same
/// server projection the web client consumes (`publicView` + per-player
/// `playerView`) and drives moves through `sendGameMove`. Lobby is handled by
/// the generic games sheet, so this view only covers set-word/playing/results.
struct WordleGameView: View {
    @Bindable var viewModel: MeetingViewModel
    let activeGame: GamePublicState
    let publicView: GameJSONValue?
    let playerView: GameJSONValue?
    let canPlay: Bool
    let canManage: Bool

    @State private var guessDraft = ""
    @State private var secretDraft = ""
    @State private var tick = 0
    @State private var tickerTask: Task<Void, Never>?
    // server clock minus device clock (ms), so the countdown tracks the server's
    // deadline instead of a possibly-skewed device clock.
    @State private var serverClockOffsetMs: Double = 0.0

    // Wordle palette (matches the web client so cross-platform play looks identical).
    private let wordleGreen = acmColor(red: 83.0, green: 141.0, blue: 78.0)
    private let wordleYellow = acmColor(red: 181.0, green: 159.0, blue: 59.0)
    private let wordleGray = acmColor(red: 58.0, green: 58.0, blue: 60.0)
    private let keyIdleBg = acmColor(red: 74.0, green: 74.0, blue: 78.0)

    private static let keyboardRows: [[String]] = [
        ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
        ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
        ["Z", "X", "C", "V", "B", "N", "M"]
    ]

    // MARK: - Parsed state

    private var phase: String { publicView?.string("phase") ?? activeGame.phase }
    private var wordLength: Int { max(1, publicView?.int("wordLength") ?? 5) }
    private var maxTries: Int { max(1, publicView?.int("maxTries") ?? 6) }
    private var setterName: String? { publicView?.string("setterName") }
    private var currentRound: Int { publicView?.int("currentRound") ?? 1 }
    private var totalRounds: Int { max(1, publicView?.int("totalRounds") ?? 1) }
    private var isFinalRound: Bool { publicView?.bool("isFinalRound") ?? true }
    private var deadline: Double? { publicView?.double("deadline") }
    private var serverNow: Double { publicView?.double("serverNow") ?? 0.0 }
    private var standings: [[String: Any]] { publicView?.objectArray("standings") ?? [] }
    private var scores: [[String: Any]] { publicView?.objectArray("scores") ?? [] }
    private var result: [String: Any]? { publicView?.dictionaryValue?["result"] as? [String: Any] }

    private var isSetter: Bool { playerView?.bool("isSetter") ?? false }
    private var canSetWord: Bool { playerView?.bool("canSetWord") ?? false }
    private var canGuessNow: Bool { (playerView?.bool("canGuess") ?? false) && canPlay }
    private var secretWord: String? { playerView?.string("secretWord") }
    private var myGuesses: [[String: Any]] { playerView?.objectArray("myGuesses") ?? [] }
    private var myOutcome: String? { playerView?.string("myOutcome") }

    private var isBusy: Bool { viewModel.state.isGameActionInFlight }

    var body: some View {
        VStack(alignment: .leading, spacing: ACMSpacing.sm) {
            header

            switch phase {
            case "set-word":
                setWordSection
            case "playing":
                playingSection
            case "results":
                resultsSection
            default:
                EmptyView()
            }
        }
        .padding(.horizontal, ACMSpacing.sm)
        .padding(.vertical, ACMSpacing.sm)
        .onAppear { startTicker() }
        .onDisappear { stopTicker() }
        .onChange(of: phase) {
            // New round/phase: drop any stale drafts.
            guessDraft = ""
            secretDraft = ""
        }
        .onChange(of: myGuesses.count) {
            // The server accepted a guess (a new row landed); safe to clear now.
            guessDraft = ""
        }
        .onChange(of: serverNow) {
            if serverNow > 0 {
                serverClockOffsetMs = serverNow - Date().timeIntervalSince1970 * 1000.0
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .top, spacing: ACMSpacing.sm) {
            statusBlock(title: headerTitle, subtitle: headerSubtitle)
            if phase == "playing", let remaining = remainingSeconds {
                Text("\(remaining)s")
                    .font(ACMFont.trial(13, weight: .semibold))
                    .foregroundStyle(remaining <= 10 ? ACMColors.error : ACMColors.textMuted)
                    .padding(.horizontal, 10)
                    .frame(height: 26)
                    .background(ACMColors.surfaceRaised, in: Capsule())
                    .overlay {
                        Capsule().strokeBorder(lineWidth: 1)
                            .foregroundStyle(remaining <= 10 ? ACMColors.error.opacity(0.4) : ACMColors.borderSubtle)
                    }
            }
        }
    }

    private var headerTitle: String {
        let roundPrefix = totalRounds > 1 ? "Round \(currentRound)/\(totalRounds) - " : ""
        switch phase {
        case "set-word":
            return "\(roundPrefix)Set the word"
        case "playing":
            return "\(roundPrefix)Guess the word"
        case "results":
            return totalRounds > 1 && !isFinalRound ? "Round \(currentRound) results" : "Final results"
        default:
            return "Wordle"
        }
    }

    private var headerSubtitle: String? {
        switch phase {
        case "set-word":
            if canSetWord { return "You pick the \(wordLength)-letter word." }
            if let setterName, !setterName.isEmpty { return "\(setterName) is choosing a word." }
            return "Waiting for the word."
        case "playing":
            return "\(wordLength) letters · \(maxTries) tries"
        default:
            return nil
        }
    }

    // MARK: - Set word

    private var setWordSection: some View {
        VStack(alignment: .leading, spacing: ACMSpacing.sm) {
            if canSetWord {
                letterField(text: secretBinding, placeholder: "Secret word")
                actionButton(title: "Set word", tint: wordleGreen, isDisabled: !isSecretReady) {
                    submitSecret()
                }
            } else {
                waitingBlock(setterName.map { "\($0) is choosing a word." } ?? "Waiting for the word setter.")
            }
        }
    }

    // MARK: - Playing

    private var playingSection: some View {
        VStack(alignment: .leading, spacing: ACMSpacing.md) {
            wordGrid

            if canGuessNow {
                VStack(alignment: .leading, spacing: ACMSpacing.sm) {
                    letterField(text: guessBinding, placeholder: "Your guess")
                    actionButton(title: "Enter guess", tint: wordleGreen, isDisabled: !isGuessReady) {
                        submitGuess()
                    }
                }
            } else if let outcomeText = myOutcomeText {
                waitingBlock(outcomeText)
            } else if isSetter {
                waitingBlock("You set the word. Watch everyone guess.")
            }

            keyboard
            standingsList
        }
    }

    // MARK: - Results

    private var resultsSection: some View {
        VStack(alignment: .leading, spacing: ACMSpacing.sm) {
            let winnerName = (result?["winnerName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let word = ((result?["targetWord"] as? String) ?? secretWord ?? "").uppercased()

            if let winnerName, !winnerName.isEmpty {
                Text("\(winnerName) got it!")
                    .font(ACMFont.trial(16, weight: .bold))
                    .foregroundStyle(wordleGreen)
            } else {
                Text("Nobody solved it")
                    .font(ACMFont.trial(16, weight: .semibold))
                    .foregroundStyle(ACMColors.textMuted)
            }

            if !word.isEmpty {
                let wordLetters = letters(of: word)
                HStack(spacing: 5) {
                    ForEach(Array(wordLetters.enumerated()), id: \.offset) { _, ch in
                        tile(letter: ch, state: "green")
                    }
                }
            }

            if totalRounds > 1 {
                scoreboard
            } else {
                standingsList
            }

            if canManage && !isFinalRound {
                actionButton(title: "Next round", tint: ACMColors.primaryOrange, isDisabled: isBusy) {
                    viewModel.sendGameMove(type: "nextRound")
                }
            } else if canManage {
                actionButton(title: "End game", tint: ACMColors.error, isDisabled: isBusy) {
                    viewModel.endActiveGame()
                }
            }
        }
    }

    // MARK: - Word grid

    private var wordGrid: some View {
        VStack(spacing: 4) {
            ForEach(Array(0..<maxTries), id: \.self) { row in
                let cells = rowContent(row)
                HStack(spacing: 4) {
                    ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                        tile(letter: cell.letter, state: cell.state)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func rowContent(_ row: Int) -> [(letter: String, state: String?)] {
        let length = wordLength
        if row < myGuesses.count {
            let guess = myGuesses[row]
            let word = ((guess["word"] as? String) ?? "").uppercased()
            let feedback = (guess["feedback"] as? [String]) ?? []
            let chars = letters(of: word)
            return (0..<length).map { i in
                let letter = i < chars.count ? chars[i] : ""
                let state = i < feedback.count ? feedback[i] : nil
                return (letter, state)
            }
        }

        let isCurrentRow = row == myGuesses.count && canGuessNow
        if isCurrentRow {
            let chars = letters(of: guessDraft.uppercased())
            return (0..<length).map { i in
                (i < chars.count ? chars[i] : "", nil)
            }
        }

        return (0..<length).map { _ in ("", nil) }
    }

    private func tile(letter: String, state: String?) -> some View {
        let hasLetter = !letter.isEmpty
        let borderColor: Color = state == nil
            ? (hasLetter ? ACMColors.borderStrong : ACMColors.border)
            : Color.clear
        return Text(letter)
            .font(ACMFont.trial(18, weight: .bold))
            .foregroundStyle(Color.white)
            .frame(width: 38, height: 38)
            .background(tileColor(state), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .strokeBorder(borderColor, lineWidth: 2)
            }
    }

    private func tileColor(_ state: String?) -> Color {
        switch state {
        case "green": return wordleGreen
        case "yellow": return wordleYellow
        case "gray": return wordleGray
        default: return Color.clear
        }
    }

    // MARK: - Keyboard (informational)

    private var keyboardStates: [String: String] {
        var result: [String: String] = [:]
        for guess in myGuesses {
            let word = ((guess["word"] as? String) ?? "").uppercased()
            let feedback = (guess["feedback"] as? [String]) ?? []
            let chars = letters(of: word)
            for (i, key) in chars.enumerated() {
                guard i < feedback.count else { continue }
                if stateRank(feedback[i]) > stateRank(result[key]) {
                    result[key] = feedback[i]
                }
            }
        }
        return result
    }

    private var keyboard: some View {
        let states = keyboardStates
        return VStack(spacing: 5) {
            ForEach(Array(Self.keyboardRows.enumerated()), id: \.offset) { _, keys in
                HStack(spacing: 4) {
                    ForEach(keys, id: \.self) { key in
                        Text(key)
                            .font(ACMFont.trial(12, weight: .semibold))
                            .foregroundStyle(Color.white)
                            .frame(maxWidth: .infinity)
                            .frame(height: 32)
                            .background(keyColor(states[key]), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                    }
                }
            }
        }
    }

    private func keyColor(_ state: String?) -> Color {
        switch state {
        case "green": return wordleGreen
        case "yellow": return wordleYellow
        case "gray": return wordleGray
        default: return keyIdleBg
        }
    }

    // MARK: - Standings

    private var standingsList: some View {
        VStack(spacing: 6) {
            ForEach(Array(standings.enumerated()), id: \.offset) { _, entry in
                let name = (entry["playerName"] as? String) ?? "Player"
                HStack(spacing: ACMSpacing.sm) {
                    Text(name)
                        .font(ACMFont.trial(13, weight: .medium))
                        .foregroundStyle(ACMColors.text)
                        .lineLimit(1)
                    Spacer(minLength: ACMSpacing.xs)
                    Text(standingStatus(entry))
                        .font(ACMFont.trial(12, weight: .medium))
                        .foregroundStyle(standingTint(entry))
                }
                .padding(.horizontal, ACMSpacing.sm)
                .frame(minHeight: 34)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background {
                    RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous)
                        .fill(ACMColors.surfaceRaised)
                }
            }
        }
    }

    private func standingStatus(_ entry: [String: Any]) -> String {
        let outcome = entry["outcome"] as? String
        let tries = intValue(entry["triesUsed"]) ?? 0
        switch outcome {
        case "win": return "Solved in \(tries)"
        case "lose": return "Out of tries"
        case "timeout": return "Timed out"
        default: return tries > 0 ? "\(tries) tries" : "Playing"
        }
    }

    private func standingTint(_ entry: [String: Any]) -> Color {
        switch entry["outcome"] as? String {
        case "win": return wordleGreen
        case "lose", "timeout": return ACMColors.textFaint
        default: return ACMColors.textMuted
        }
    }

    private var scoreboard: some View {
        VStack(spacing: 6) {
            ForEach(Array(scores.enumerated()), id: \.offset) { index, entry in
                let name = (entry["playerName"] as? String) ?? "Player"
                let score = intValue(entry["score"]) ?? 0
                let isLeader = index == 0
                HStack(spacing: ACMSpacing.sm) {
                    Text("\(index + 1)")
                        .font(ACMFont.trial(14, weight: .bold))
                        .foregroundStyle(isLeader ? ACMColors.primaryOrange : ACMColors.textFaint)
                        .frame(width: 22)
                    Text(name)
                        .font(ACMFont.trial(14, weight: .medium))
                        .foregroundStyle(ACMColors.text)
                        .lineLimit(1)
                    Spacer(minLength: ACMSpacing.xs)
                    Text("\(score)")
                        .font(ACMFont.trial(14, weight: .semibold))
                        .foregroundStyle(isLeader ? ACMColors.primaryOrange : ACMColors.textMuted)
                }
                .padding(.horizontal, ACMSpacing.sm)
                .frame(minHeight: 40)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background {
                    RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous)
                        .fill(isLeader ? ACMColors.primaryOrange.opacity(0.10) : ACMColors.surfaceRaised)
                }
                .overlay {
                    RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous)
                        .strokeBorder(isLeader ? ACMColors.primaryOrange.opacity(0.34) : ACMColors.border, lineWidth: 1)
                }
            }
        }
    }

    // MARK: - Shared styling

    // Flat title/subtitle block - no accent bar. The stage chrome already
    // carries the game identity; this row just states the task, quietly.
    private func statusBlock(title: String, subtitle: String?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(ACMFont.trial(15, weight: .semibold))
                .foregroundStyle(ACMColors.text)
                .lineLimit(2)
            if let subtitle = subtitle?.trimmingCharacters(in: .whitespacesAndNewlines), !subtitle.isEmpty {
                Text(subtitle)
                    .font(ACMFont.trial(12.5))
                    .foregroundStyle(ACMColors.textFaint)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func waitingBlock(_ text: String) -> some View {
        Text(text)
            .font(ACMFont.trial(13, weight: .medium))
            .foregroundStyle(ACMColors.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, ACMSpacing.xs)
    }

    private func actionButton(title: String, tint: Color, isDisabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(ACMFont.trial(14, weight: .semibold))
                .foregroundStyle(Color.white)
                .lineLimit(1)
                .frame(maxWidth: .infinity)
                .frame(minHeight: 42)
                .background(
                    isDisabled ? ACMColors.surfaceRaised : tint,
                    in: RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous)
                )
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.62 : 1.0)
    }

    private func letterField(text: Binding<String>, placeholder: String) -> some View {
        TextField("", text: text, prompt: Text(placeholder).foregroundStyle(ACMColors.textFaint))
            .textFieldStyle(.plain)
            .font(ACMFont.trial(18, weight: .semibold))
            .foregroundStyle(ACMColors.text)
            .tint(ACMColors.primaryOrange)
            #if os(iOS)
            .autocorrectionDisabled(true)
            .textInputAutocapitalization(.characters)
            #endif
            .padding(.horizontal, ACMSpacing.sm)
            .frame(minHeight: 46)
            .background {
                RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous)
                    .fill(ACMColors.surfaceRaised)
            }
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous)
                    .strokeBorder(ACMColors.border, lineWidth: 1)
            }
    }

    // MARK: - Bindings + actions

    private var guessBinding: Binding<String> {
        Binding(
            get: { guessDraft },
            set: { guessDraft = sanitize($0) }
        )
    }

    private var secretBinding: Binding<String> {
        Binding(
            get: { secretDraft },
            set: { secretDraft = sanitize($0) }
        )
    }

    private func sanitize(_ value: String) -> String {
        var result = ""
        for character in value.uppercased() {
            if character >= "A" && character <= "Z" {
                result += String(character)
            }
        }
        return String(result.prefix(wordLength))
    }

    private var isGuessReady: Bool {
        guessDraft.count == wordLength && !isBusy
    }

    private var isSecretReady: Bool {
        secretDraft.count == wordLength && !isBusy
    }

    private func submitGuess() {
        guard isGuessReady else { return }
        // Keep the draft until the server accepts it (a new row appears / phase
        // advances), so a rejected or dropped move doesn't lose the typed word.
        viewModel.sendGameMove(type: "guess", payload: GameJSONValue.object(["word": guessDraft]))
    }

    private func submitSecret() {
        guard isSecretReady else { return }
        viewModel.sendGameMove(type: "setWord", payload: GameJSONValue.object(["word": secretDraft]))
    }

    private var myOutcomeText: String? {
        switch myOutcome {
        case "win": return "You solved it!"
        case "lose": return "Out of tries."
        case "timeout": return "Time ran out."
        default: return nil
        }
    }

    // MARK: - Countdown

    private var remainingSeconds: Int? {
        guard let deadline else { return nil }
        _ = tick // re-evaluated each tick to keep the countdown live
        let serverNowMs = Date().timeIntervalSince1970 * 1000.0 + serverClockOffsetMs
        let remaining = (deadline - serverNowMs) / 1000.0
        if remaining <= 0 { return 0 }
        // Ceiling without FloatingPointRoundingRule (keep it Skip-safe).
        let whole = Int(remaining)
        return remaining > Double(whole) ? whole + 1 : whole
    }

    private func startTicker() {
        stopTicker()
        tickerTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if Task.isCancelled { break }
                tick += 1
            }
        }
    }

    private func stopTicker() {
        tickerTask?.cancel()
        tickerTask = nil
    }

    // MARK: - Helpers

    private func stateRank(_ state: String?) -> Int {
        switch state {
        case "green": return 3
        case "yellow": return 2
        case "gray": return 1
        default: return 0
        }
    }

    /// Splits a string into single-character strings. Skip does not support the
    /// `Array(someString)` initializer, so iterate explicitly.
    private func letters(of value: String) -> [String] {
        var result: [String] = []
        for character in value {
            result.append(String(character))
        }
        return result
    }

    private func intValue(_ value: Any?) -> Int? {
        if let intValue = value as? Int { return intValue }
        if let doubleValue = value as? Double { return Int(doubleValue) }
        if let numberValue = value as? NSNumber { return numberValue.intValue }
        return nil
    }
}
