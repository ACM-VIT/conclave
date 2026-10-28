#if os(iOS) && !SKIP
import Accessibility
import SwiftUI

// S60 10 B2 (ACT-4) on iOS: Wordle inside the game shell's scroll view (GameShell+iOS.swift routes `GameSceneKind.wordle`
// to `WordleSceneBody` and pins `WordleHostBar` in its bottom bar, HD request B7-T7 R2). The board is six rows of five
// 38 pt cells with 4 pt gaps; each row is one accessibility element that reads its letters and marks as text, and every
// mark has a glyph twin (a check for the right spot, a dot for in the word), so correctness is never color alone. Input
// is the letter keys (default), the system keyboard ("Type Your Guess", the default while VoiceOver runs) or a hardware
// keyboard; all three feed the one presenter draft (`GameStagePresenter.wordleDraft`). The board and the keys never mirror
// in right-to-left layouts (D18). Only the newly marked row changes and marks appear in one frame (no flip). The timer is
// its own leaf over `countdown`, the board's draft row reads `wordleDraft`, the keys read `keyStates` (S60 10 k).

// MARK: Scene

/// The Wordle body for every phase: setting the word, playing, a round's results and the final results.
struct WordleSceneBody: View {
    let games: GameStagePresenter

    var body: some View {
        if let wordle = games.scene.wordle {
            WordleSceneView(scene: wordle, games: games, isFinished: games.chrome.phase == .results)
        }
    }
}

struct WordleSceneView: View {
    let scene: WordleScene
    let games: GameStagePresenter
    let isFinished: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            WordleHeader(scene: scene, games: games, isFinished: isFinished)
            switch scene.phase {
            case .lobby:
                EmptyView()
            case .setWord:
                WordleSetWordView(scene: scene, games: games)
            case .playing:
                WordlePlayingView(scene: scene, games: games)
            case .results:
                WordleResultsView(scene: scene, games: games, isFinished: isFinished)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("game.scene.wordle")
    }
}

/// "Round 1 of 3 · Guess the Word", "5 letters · 6 tries" and the timer chip (S60 10 b, g). The card header above already
/// carries the game's identity, so this states the task quietly (no accent bar, AGENTS.md game rules).
struct WordleHeader: View {
    let scene: WordleScene
    let games: GameStagePresenter
    let isFinished: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Text(WordleCopy.title(scene, isFinished: isFinished))
                    .font(.headline)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if scene.phase == .setWord || scene.phase == .playing {
                    Text(WordleCopy.meta(scene))
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(HostingTheme.inCallTextSecondary)
                }
            }
            Spacer(minLength: 8)
            if scene.phase == .playing {
                WordleTimerSlot(games: games)
            }
        }
    }
}

// MARK: Timer (K2 variant)

/// Observes only `countdown`, so the per-second leaf never re-evaluates the scene.
struct WordleTimerSlot: View {
    let games: GameStagePresenter

    var body: some View {
        if let countdown = games.countdown {
            WordleTimerChip(model: countdown)
        }
    }
}

/// "2:41" with tabular digits, once per second only while the scene is active (stopped in the background, recomputed on
/// resume), from the server deadline plus the push's clock offset. At 10 s or less it turns the warning color and reads
/// "0:09 left" (the text twin); VoiceOver hears "%@ left" at 60 s and 10 s only.
struct WordleTimerChip: View {
    let model: CountdownModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        if scenePhase == .active {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                WordleTimerFace(model: model, nowMillis: context.date.timeIntervalSince1970 * 1000)
            }
        } else {
            WordleTimerFace(model: model, nowMillis: Date().timeIntervalSince1970 * 1000)
        }
    }
}

private struct WordleTimerFace: View {
    let model: CountdownModel
    let nowMillis: Double

    var body: some View {
        let seconds = model.secondsLeft(nowMillis: nowMillis)
        let warning = seconds <= WordleBoardPolicy.warningSeconds
        let clock = WordleCopy.clock(seconds)
        let ink = warning ? HostingTheme.token(DesignTokens.iosInCallWarning) : HostingTheme.token(DesignTokens.iosInCallText)
        Label {
            Text(warning ? WordleCopy.timeLeft(clock) : clock)
        } icon: {
            Image(systemName: ConclaveSymbols.timer).accessibilityHidden(true)
        }
            .font(.subheadline.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(ink)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .overlay { Capsule().strokeBorder(HostingTheme.inCallBorder, lineWidth: 1) }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(WordleCopy.timeLeft(WordleCopy.spokenDuration(seconds)))
            .accessibilityIdentifier("game.wordle.timer")
            .onChange(of: seconds) { _, value in
                if WordleBoardPolicy.announcedSeconds.contains(value) {
                    AccessibilityNotification.Announcement(WordleCopy.timeLeft(WordleCopy.spokenDuration(value))).post()
                }
            }
    }
}

// MARK: Phases

/// Set the word (S60 10 c, f): the setter types the secret into a secure field ("Set Word" at five letters); everyone else
/// reads who is choosing. A rejected word keeps the draft (the shell shows the server's reason).
struct WordleSetWordView: View {
    let scene: WordleScene
    let games: GameStagePresenter

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if scene.isSetter {
                // The setter keeps the field (disabled while reconnecting or while the word is in flight).
                PromptLine(text: WordleCopy.youPick(scene.wordLength))
                WordleSecretEntry(scene: scene, games: games)
            } else {
                PromptHeadline(text: WordleCopy.choosing(scene.setterName))
                    .accessibilityIdentifier("game.wordle.choosing")
                if scene.role == .spectator {
                    PromptSpectatorNotice(games: games)
                }
            }
        }
    }
}

/// Playing (S60 10 c, f): your board, its outcome and the input for a guesser; the setter watches the standings and the
/// status-only boards; a spectator reads the standings.
struct WordlePlayingView: View {
    let scene: WordleScene
    let games: GameStagePresenter
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    /// nil follows VoiceOver (text entry while it runs); "Type Your Guess" and "Use Letter Keys" set it while this round's
    /// board shows (the view is new each round, because the results phase sits between rounds).
    @State private var prefersTextEntry: Bool? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch scene.role {
            case .setter:
                PromptHeadline(text: WordleCopy.setterWatching())
                    .accessibilityIdentifier("game.wordle.setterWatching")
                WordleLiveBoards(scene: scene)
                WordleStandingsList(scene: scene)
            case .spectator:
                PromptSpectatorNotice(games: games)
                WordleStandingsList(scene: scene)
            case .guesser:
                WordleBoard(scene: scene, games: games, readOnly: false)
                WordleOutcomeLine(scene: scene, games: games)
                if scene.myOutcome == .none {
                    WordleInputArea(scene: scene, games: games, textEntry: prefersTextEntry ?? voiceOver,
                                    autoFocusField: prefersTextEntry == true, onTextEntry: { prefersTextEntry = $0 })
                }
                WordleStandingsList(scene: scene)
            }
        }
    }
}

/// The letter keys or the text field, and the switch between them ("Type Your Guess" with the letter keys, "Use Letter
/// Keys" with the field). The `keyboard` concept glyph joins "Type Your Guess" when the R6-1 icon lands (HD request R7).
struct WordleInputArea: View {
    let scene: WordleScene
    let games: GameStagePresenter
    let textEntry: Bool
    let autoFocusField: Bool
    let onTextEntry: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if textEntry {
                WordleTextEntry(scene: scene, games: games, autoFocus: autoFocusField)
                Button(WordleCopy.useLetterKeys()) { onTextEntry(false) }
                    .buttonStyle(.bordered)
                    .tint(HostingTheme.token(DesignTokens.iosInCallText))
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("game.wordle.useLetterKeys")
            } else {
                WordleLetterKeyboard(scene: scene, games: games)
                Button { onTextEntry(true) } label: {
                    Label {
                        Text(WordleCopy.typeYourGuess())
                    } icon: {
                        Image(systemName: ConclaveSymbols.keyboard).accessibilityHidden(true)
                    }
                }
                    .buttonStyle(.bordered)
                    .tint(HostingTheme.token(DesignTokens.iosInCallText))
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("game.wordle.typeGuess")
            }
        }
    }
}

/// Results (S60 10 c, f): the solution as correct cells, the winner line, your outcome and board, the standings (and the
/// scoreboard at the final results); participants wait for the host. Next Round and Play Again are the pinned bars.
struct WordleResultsView: View {
    let scene: WordleScene
    let games: GameStagePresenter
    let isFinished: Bool

    var body: some View {
        let isHost = games.chrome.isHost
        let isFinal = isFinished || scene.isFinalRound
        VStack(alignment: .leading, spacing: 12) {
            if !scene.solution.isEmpty {
                WordleRowView(row: WordleBoardPolicy.solutionRow(scene), label: WordleCopy.wordWas(scene.solution))
                    .frame(maxWidth: .infinity)
                    .environment(\.layoutDirection, .leftToRight)
                    .accessibilityIdentifier("game.wordle.solution")
            }
            PromptHeadline(text: WordleCopy.winner(scene))
            WordleOutcomeLine(scene: scene, games: games)
            if scene.role == .guesser && !scene.myRows.isEmpty {
                WordleBoard(scene: scene, games: games, readOnly: true)
            }
            if isFinished && scene.roundTotal > 1 && !games.results.scoreboard.isEmpty {
                GameKitScoreboard(rows: games.results.scoreboard)
            }
            WordleStandingsList(scene: scene)
            if !isHost {
                PromptLine(text: isFinal ? WordleCopy.waitingForHost() : WordleCopy.waitingNextRound())
            }
        }
        .modifier(PromptAnnouncement(games: games, key: scene.resultKey, text: WordleCopy.wordWas(scene.solution)))
        .accessibilityIdentifier("game.wordle.results")
    }
}

/// "You solved it", "Out of tries", "Time ran out", announced once (S60 10 f, i).
struct WordleOutcomeLine: View {
    let scene: WordleScene
    let games: GameStagePresenter

    var body: some View {
        if let text = WordleCopy.outcome(scene.myOutcome) {
            PromptHeadline(text: text)
                .accessibilityIdentifier("game.wordle.outcome")
                .modifier(PromptAnnouncement(games: games, key: scene.outcomeKey, text: text))
        }
    }
}

/// The pinned host bar (S60 10 f): Next Round for a seated host at a round's results, pending until that emit's ack.
struct WordleHostBar: View {
    let games: GameStagePresenter

    var body: some View {
        if let wordle = games.scene.wordle, wordle.canAdvanceRound {
            let interaction = games.interaction
            let pending = interaction.isPending && interaction.pendingType == WordleIntent.nextRoundType
            GameKitHostBar(primaryTitle: WordleCopy.nextRound(), primaryEnabled: !interaction.isPending || pending,
                           primaryPending: pending, onPrimary: { _ = games.send(WordleIntent.nextRound()) })
                .accessibilityIdentifier("game.host.nextRound")
        }
    }
}

// MARK: Board (B2)

/// Your rows: the marked guesses, the draft row while your board is open and empty rows up to six. Read-only at the
/// results (no draft read, so typing elsewhere never touches it). After a guess is marked, VoiceOver focus moves to that
/// row's summary (S60 10 i).
struct WordleBoard: View {
    let scene: WordleScene
    let games: GameStagePresenter
    let readOnly: Bool
    @AccessibilityFocusState private var focusedRow: Int?

    var body: some View {
        let rows = readOnly ? scene.myRows : WordleBoardPolicy.displayRows(scene, draft: games.wordleDraft)
        VStack(spacing: CGFloat(WordleBoardPolicy.gap)) {
            ForEach(rows) { row in
                WordleRowView(row: row, label: WordleCopy.rowSummary(row))
                    .accessibilityFocused($focusedRow, equals: row.index)
            }
        }
        .frame(maxWidth: .infinity)
        .environment(\.layoutDirection, .leftToRight)
        .accessibilityIdentifier("game.wordle.board")
        .onChange(of: scene.myRows.count) { old, new in
            if !readOnly && new > old { focusedRow = new - 1 }
        }
    }
}

/// One row as one accessibility element ("Row 2: S, not in the word, L, in the word, ..."); long press at the largest
/// text sizes shows the word in the Large Content Viewer (geometry-bound board, F00 5).
struct WordleRowView: View {
    let row: WordleRowModel
    let label: String

    var body: some View {
        HStack(spacing: CGFloat(WordleBoardPolicy.gap)) {
            ForEach(row.cells) { cell in
                WordleCellView(cell: cell)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityShowsLargeContentViewer {
            Text(row.word)
        }
        .accessibilityIdentifier("game.wordle.row." + String(row.index))
    }
}

/// A 38 pt cell. Fills: correct `iosInCallSuccess`, in the word `iosInCallWarning` (both with dark ink above 4.5:1),
/// not in the word `iosInCallSurfaceHigh` with paper ink; empty and typed cells are outlined (`inCallBorderStrong`).
/// The accent never marks correctness (S60 10 e).
struct WordleCellView: View {
    let cell: WordleCellModel

    var body: some View {
        let style = WordleStyle.cell(cell.state)
        let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)
        ZStack(alignment: .topTrailing) {
            shape.fill(style.fill)
            shape.strokeBorder(style.border, lineWidth: style.borderWidth)
            Text(cell.letter)
                .font(.title3.weight(.bold))
                .dynamicTypeSize(...DynamicTypeSize.accessibility1)
                .foregroundStyle(style.ink)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            WordleMarkGlyph(mark: cell.state, ink: style.ink)
                .padding(3)
        }
        .frame(width: CGFloat(WordleBoardPolicy.cellSize), height: CGFloat(WordleBoardPolicy.cellSize))
    }
}

/// The glyph twin of a mark: a check for the right spot, a dot for in the word, nothing otherwise (the row's text
/// carries all three for VoiceOver).
struct WordleMarkGlyph: View {
    let mark: WordleCellState
    let ink: Color

    var body: some View {
        switch mark {
        case .correct:
            Image(systemName: ConclaveSymbols.checkmark)
                .font(.caption2.weight(.bold))
                .imageScale(.small)
                .dynamicTypeSize(...DynamicTypeSize.large)
                .foregroundStyle(ink)
                .accessibilityHidden(true)
        case .present:
            Circle()
                .fill(ink)
                .frame(width: 5, height: 5)
                .padding(2)
                .accessibilityHidden(true)
        case .empty, .typed, .absent:
            EmptyView()
        }
    }
}

/// The setter's view of every contestant (S60 10 f): small status-only boards (marks without letters), each one
/// accessibility element with the name and status as text.
struct WordleLiveBoards: View {
    let scene: WordleScene

    var body: some View {
        if !scene.liveBoards.isEmpty {
            ConclaveFlowLayout(spacing: 12) {
                ForEach(scene.liveBoards) { board in
                    VStack(alignment: .leading, spacing: 4) {
                        VStack(spacing: 2) {
                            ForEach(board.rows) { row in
                                HStack(spacing: 2) {
                                    ForEach(row.cells) { cell in
                                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                                            .fill(WordleStyle.cell(cell.state).fill)
                                            .frame(width: 10, height: 10)
                                    }
                                }
                            }
                        }
                        Text(board.name)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                            .lineLimit(1)
                        Text(WordleCopy.status(board.status, tries: board.tries))
                            .font(.caption2)
                            .foregroundStyle(HostingTheme.inCallTextSecondary)
                    }
                    .environment(\.layoutDirection, .leftToRight)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(WordleCopy.twoFacts(board.name, WordleCopy.status(board.status, tries: board.tries)))
                    .accessibilityIdentifier("game.wordle.live." + board.id)
                }
            }
        }
    }
}

/// Who solved and in how many tries, who is still playing (S60 10 g), keyed by player id.
struct WordleStandingsList: View {
    let scene: WordleScene

    var body: some View {
        if !scene.standings.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(WordleCopy.standings())
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .accessibilityAddTraits(.isHeader)
                ForEach(scene.standings) { row in
                    HStack(spacing: 10) {
                        Text(row.isYou ? ConclaveStrings.text("You") : row.name)
                            .font(.body)
                            .lineLimit(2)
                        Spacer(minLength: 8)
                        Text(WordleCopy.status(row.status, tries: row.tries))
                            .font(.subheadline)
                            .monospacedDigit()
                            .multilineTextAlignment(.trailing)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(row.isYou ? HostingTheme.token(DesignTokens.iosInCallSurfaceRaised) : Color.clear,
                                in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusSmall), style: .continuous))
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("game.wordle.standing." + row.id)
                }
            }
        }
    }
}

// MARK: Input

/// The letter keys (S60 10 c): three rows, keys 44 pt tall and min(32, (width - 36) / 10) wide (the deliberate game-grid
/// exception; text entry is the full-size alternative), Enter and Delete one and a half keys wide, each key reflecting
/// the best known state of its letter with the same glyph twins. Hardware letters, delete and return feed the same
/// draft while the keys have focus. No per-key haptic (the outcomes carry `guessInvalid` and `wordSolved`).
struct WordleLetterKeyboard: View {
    let scene: WordleScene
    let games: GameStagePresenter
    @FocusState private var focused: Bool

    var body: some View {
        let interaction = games.interaction
        let canType = scene.canGuess && !interaction.isPending
        let pending = interaction.isPending && interaction.pendingType == WordleIntent.guessType
        let canEnter = !interaction.isPending && WordleBoardPolicy.canSubmit(scene, draft: games.wordleDraft)
        VStack(spacing: 6) {
            WordleKeyRowLayout {
                ForEach(scene.keys(inRow: 0)) { key in
                    WordleLetterKey(key: key, enabled: canType) { games.typeWordleLetter(key.letter) }
                }
            }
            WordleKeyRowLayout {
                ForEach(scene.keys(inRow: 1)) { key in
                    WordleLetterKey(key: key, enabled: canType) { games.typeWordleLetter(key.letter) }
                }
            }
            WordleKeyRowLayout {
                WordleWideKey(title: WordleCopy.enterKey(), symbol: "", label: WordleCopy.enterKey(), enabled: canEnter,
                              pending: pending, identifier: "game.wordle.enter", action: submit)
                    .layoutValue(key: WordleKeyWidthFactor.self, value: CGFloat(WordleBoardPolicy.wideKeyFactor))
                ForEach(scene.keys(inRow: 2)) { key in
                    WordleLetterKey(key: key, enabled: canType) { games.typeWordleLetter(key.letter) }
                }
                WordleWideKey(title: "", symbol: WordleSymbols.backspace, label: WordleCopy.deleteKey(), enabled: canType,
                              pending: false, identifier: "game.wordle.delete", action: { games.deleteWordleLetter() })
                    .layoutValue(key: WordleKeyWidthFactor.self, value: CGFloat(WordleBoardPolicy.wideKeyFactor))
            }
        }
        .environment(\.layoutDirection, .leftToRight)
        .focusable(canType)
        .focusEffectDisabled()
        .focused($focused)
        .onKeyPress(characters: .letters, phases: .down) { press in
            if press.modifiers.contains(.command) || press.modifiers.contains(.control) { return .ignored }
            let letter = WordleBoardPolicy.normalized(press.characters, limit: 1)
            if letter.isEmpty || !canType { return .ignored }
            games.typeWordleLetter(letter)
            return .handled
        }
        .onKeyPress(.delete) {
            if canType { games.deleteWordleLetter() }
            return .handled
        }
        .onKeyPress(.return) {
            submit()
            return .handled
        }
        .onAppear {
            focused = canType
        }
        .accessibilityIdentifier("game.wordle.keyboard")
    }

    private func submit() {
        if games.interaction.isPending || !WordleBoardPolicy.canSubmit(scene, draft: games.wordleDraft) { return }
        _ = games.submitWordle()
    }
}

/// Text entry (S60 10 c): the system keyboard, letters A to Z only, at most five, autocapitalized, no autocorrect, Go
/// submits; paste keeps letters only. A 44 pt "Enter Guess" button. The field mirrors the presenter draft both ways.
struct WordleTextEntry: View {
    let scene: WordleScene
    let games: GameStagePresenter
    let autoFocus: Bool
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        let interaction = games.interaction
        let draft = games.wordleDraft
        let pending = interaction.isPending && interaction.pendingType == WordleIntent.guessType
        VStack(alignment: .leading, spacing: 8) {
            TextField(WordleCopy.guessField(), text: $text)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .submitLabel(.go)
                .font(.title3.weight(.semibold))
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .focused($focused)
                .onSubmit { submit() }
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
                .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised),
                            in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous)
                        .strokeBorder(HostingTheme.inCallBorderStrong, lineWidth: 1)
                }
                .disabled(!scene.canGuess || interaction.isPending)
                .accessibilityIdentifier("game.wordle.field")
            GameKitHostBar(primaryTitle: WordleCopy.enterGuess(),
                           primaryEnabled: !interaction.isPending && WordleBoardPolicy.canSubmit(scene, draft: draft),
                           primaryPending: pending, onPrimary: submit)
                .accessibilityIdentifier("game.wordle.enterGuess")
        }
        .onAppear {
            text = draft
            if autoFocus && scene.canGuess { focused = true }
        }
        .onChange(of: text) { _, value in
            let letters = WordleBoardPolicy.normalized(value, limit: scene.wordLength)
            if letters != value { text = letters }
            games.setWordleDraft(letters)
        }
        .onChange(of: draft) { _, value in
            if value != text { text = value }
        }
    }

    private func submit() {
        if games.interaction.isPending || !WordleBoardPolicy.canSubmit(scene, draft: games.wordleDraft) { return }
        _ = games.submitWordle()
    }
}

/// The setter's secure field ("Secret Word") and "Set Word" (S60 10 c, f); the same letter filter as a guess.
struct WordleSecretEntry: View {
    let scene: WordleScene
    let games: GameStagePresenter
    @State private var text = ""

    var body: some View {
        let interaction = games.interaction
        let draft = games.wordleDraft
        let pending = interaction.isPending && interaction.pendingType == WordleIntent.setWordType
        VStack(alignment: .leading, spacing: 8) {
            SecureField(WordleCopy.secretField(), text: $text)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .submitLabel(.done)
                .font(.title3.weight(.semibold))
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .onSubmit { submit() }
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
                .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised),
                            in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous)
                        .strokeBorder(HostingTheme.inCallBorderStrong, lineWidth: 1)
                }
                .disabled(!scene.canSetWord || interaction.isPending)
                .accessibilityIdentifier("game.wordle.secret")
            GameKitHostBar(primaryTitle: WordleCopy.setWord(),
                           primaryEnabled: !interaction.isPending && WordleBoardPolicy.canSubmit(scene, draft: draft),
                           primaryPending: pending, onPrimary: submit)
                .accessibilityIdentifier("game.wordle.setWord")
        }
        .onAppear {
            text = draft
        }
        .onChange(of: text) { _, value in
            let letters = WordleBoardPolicy.normalized(value, limit: scene.wordLength)
            if letters != value { text = letters }
            games.setWordleDraft(letters)
        }
        .onChange(of: draft) { _, value in
            if value != text { text = value }
        }
    }

    private func submit() {
        if games.interaction.isPending || !WordleBoardPolicy.canSubmit(scene, draft: games.wordleDraft) { return }
        _ = games.submitWordle()
    }
}

/// One keyboard row: letter keys min(32, (width - 36) / 10) wide, Enter and Delete one and a half keys, 4 pt gaps,
/// centered, 44 pt tall. A custom layout, so the width rule holds without a GeometryReader.
struct WordleKeyRowLayout: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? CGFloat(WordleBoardPolicy.boardWidth)
        let unit = CGFloat(WordleBoardPolicy.keyWidth(available: Double(width)))
        var height = WordleKeyMetrics.keyHeight
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: unit * subview[WordleKeyWidthFactor.self], height: nil))
            height = max(height, size.height)
        }
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let unit = CGFloat(WordleBoardPolicy.keyWidth(available: Double(bounds.width)))
        let gap = CGFloat(WordleBoardPolicy.gap)
        var total: CGFloat = 0
        for subview in subviews {
            total += unit * subview[WordleKeyWidthFactor.self]
        }
        total += gap * CGFloat(max(0, subviews.count - 1))
        var x = bounds.minX + max(0, (bounds.width - total) / 2)
        for subview in subviews {
            let width = unit * subview[WordleKeyWidthFactor.self]
            subview.place(at: CGPoint(x: x, y: bounds.minY), anchor: .topLeading,
                          proposal: ProposedViewSize(width: width, height: bounds.height))
            x += width + gap
        }
    }
}

/// A key's width in letter-key units (1, or 1.5 for Enter and Delete).
struct WordleKeyWidthFactor: LayoutValueKey {
    static let defaultValue: CGFloat = 1
}

enum WordleKeyMetrics {
    static let keyHeight: CGFloat = 44
}

/// One letter key: the letter, its state's fill and glyph twin, and "E, in the word" for VoiceOver (S60 10 i).
struct WordleLetterKey: View {
    let key: WordleKeyModel
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        let style = WordleStyle.key(key.state)
        let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                shape.fill(style.fill)
                shape.strokeBorder(style.border, lineWidth: style.borderWidth)
                Text(key.letter)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(style.ink)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                WordleMarkGlyph(mark: WordleStyle.mark(key.state), ink: style.ink)
                    .padding(2)
            }
            .frame(maxWidth: .infinity, minHeight: WordleKeyMetrics.keyHeight, maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : HostingTheme.disabledOpacity)
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .accessibilityLabel(WordleCopy.keyLabel(key))
        .accessibilityShowsLargeContentViewer()
        .accessibilityIdentifier("game.wordle.key." + key.letter)
    }
}

/// Enter (text) and Delete (canonical R6-1 backspace artwork).
struct WordleWideKey: View {
    let title: String
    let symbol: String
    let label: String
    let enabled: Bool
    let pending: Bool
    let identifier: String
    let action: () -> Void

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)
        Button(action: action) {
            ZStack {
                shape.fill(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised))
                shape.strokeBorder(HostingTheme.inCallBorderStrong, lineWidth: 1)
                if pending {
                    ProgressView()
                        .tint(HostingTheme.token(DesignTokens.iosInCallText))
                } else if !symbol.isEmpty {
                    Image(systemName: symbol)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                        .accessibilityHidden(true)
                } else {
                    Text(title)
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                }
            }
            .frame(maxWidth: .infinity, minHeight: WordleKeyMetrics.keyHeight, maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled || pending)
        .opacity(enabled || pending ? 1 : HostingTheme.disabledOpacity)
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .accessibilityLabel(label)
        .accessibilityValue(pending ? ConclaveStrings.text("In Progress") : "")
        .accessibilityShowsLargeContentViewer()
        .accessibilityIdentifier(identifier)
    }
}

// MARK: Style and copy

/// Canonical R6-1 Wordle concepts.
enum WordleSymbols {
    static let backspace = ConclaveSymbols.deleteBackward
}

struct WordleCellStyle {
    let fill: Color
    let ink: Color
    let border: Color
    let borderWidth: CGFloat
}

/// S60 10 e tokens: functional colors with text and glyph twins, never the accent; dark ink on success and warning.
enum WordleStyle {
    static func cell(_ state: WordleCellState) -> WordleCellStyle {
        let paper = HostingTheme.token(DesignTokens.iosInCallText)
        let dark = HostingTheme.token(DesignTokens.iosInCallOnControlOff)
        switch state {
        case .empty:
            return WordleCellStyle(fill: Color.clear, ink: paper, border: HostingTheme.inCallBorderStrong, borderWidth: 1)
        case .typed:
            return WordleCellStyle(fill: Color.clear, ink: paper, border: HostingTheme.inCallBorderStrong, borderWidth: 2)
        case .correct:
            let fill = HostingTheme.token(DesignTokens.iosInCallSuccess)
            return WordleCellStyle(fill: fill, ink: dark, border: fill, borderWidth: 1)
        case .present:
            let fill = HostingTheme.token(DesignTokens.iosInCallWarning)
            return WordleCellStyle(fill: fill, ink: dark, border: fill, borderWidth: 1)
        case .absent:
            let fill = HostingTheme.token(DesignTokens.iosInCallSurfaceHigh)
            return WordleCellStyle(fill: fill, ink: paper, border: fill, borderWidth: 1)
        }
    }

    static func key(_ state: WordleKeyState) -> WordleCellStyle {
        switch state {
        case .unused:
            return WordleCellStyle(fill: HostingTheme.token(DesignTokens.iosInCallSurfaceRaised),
                                   ink: HostingTheme.token(DesignTokens.iosInCallText), border: HostingTheme.inCallBorder, borderWidth: 1)
        case .correct:
            return cell(.correct)
        case .present:
            return cell(.present)
        case .absent:
            let fill = HostingTheme.token(DesignTokens.iosInCallSurfaceHigh)
            return WordleCellStyle(fill: fill, ink: HostingTheme.inCallTextSecondary, border: fill, borderWidth: 1)
        }
    }

    static func mark(_ state: WordleKeyState) -> WordleCellState {
        switch state {
        case .unused: return .empty
        case .correct: return .correct
        case .present: return .present
        case .absent: return .absent
        }
    }
}

/// S60 10 g, exhaustive iOS copy (L6-14): Apple title case for controls and headings, sentence case for lines.
enum WordleCopy {
    static func title(_ scene: WordleScene, isFinished: Bool) -> String {
        let rounds = scene.roundTotal > 1 && scene.round > 0
        switch scene.phase {
        case .lobby:
            return ""
        case .setWord:
            return rounds ? ConclaveStrings.format("Round %lld of %lld · Set the Word", scene.round, scene.roundTotal)
                : ConclaveStrings.text("Set the Word")
        case .playing:
            return rounds ? ConclaveStrings.format("Round %lld of %lld · Guess the Word", scene.round, scene.roundTotal)
                : ConclaveStrings.text("Guess the Word")
        case .results:
            return isFinished || scene.isFinalRound ? ConclaveStrings.text("Final Results")
                : ConclaveStrings.format("Round %lld Results", scene.round)
        }
    }

    static func meta(_ scene: WordleScene) -> String {
        ConclaveStrings.format("%lld letters · %lld tries", scene.wordLength, scene.maxTries)
    }

    static func youPick(_ length: Int) -> String { ConclaveStrings.format("You pick the %lld-letter word.", length) }
    static func secretField() -> String { ConclaveStrings.text("Secret Word") }
    static func setWord() -> String { ConclaveStrings.text("Set Word") }

    static func choosing(_ name: String) -> String {
        name.isEmpty ? ConclaveStrings.text("Waiting for the word.") : ConclaveStrings.format("%@ is choosing a word.", name)
    }

    static func guessField() -> String { ConclaveStrings.text("Your Guess") }
    static func enterGuess() -> String { ConclaveStrings.text("Enter Guess") }
    static func typeYourGuess() -> String { ConclaveStrings.text("Type Your Guess") }
    static func useLetterKeys() -> String { ConclaveStrings.text("Use Letter Keys") }
    static func enterKey() -> String { ConclaveStrings.text("Wordle Enter Key") }
    static func deleteKey() -> String { ConclaveStrings.text("Wordle Delete Key") }
    static func setterWatching() -> String { ConclaveStrings.text("You set the word. Watch everyone guess.") }
    static func nextRound() -> String { ConclaveStrings.text("Next Round") }
    static func waitingNextRound() -> String { ConclaveStrings.text("Waiting for the host to start the next round") }
    static func waitingForHost() -> String { ConclaveStrings.text("Waiting for the host") }
    static func standings() -> String { ConclaveStrings.text("Standings") }

    static func outcome(_ outcome: WordleOutcome) -> String? {
        switch outcome {
        case .none: return nil
        case .solved: return ConclaveStrings.text("You solved it")
        case .outOfTries: return ConclaveStrings.text("Out of tries")
        case .timedOut: return ConclaveStrings.text("Time ran out")
        }
    }

    static func winner(_ scene: WordleScene) -> String {
        scene.winnerName.isEmpty ? ConclaveStrings.text("Nobody solved it") : ConclaveStrings.format("%@ got it", scene.winnerName)
    }

    static func wordWas(_ word: String) -> String { ConclaveStrings.format("The word was %@", word) }

    /// "1 try", "3 tries" (a plural catalog entry, S60 10 l).
    static func tries(_ count: Int) -> String { ConclaveStrings.format("%lld tries", count) }

    static func status(_ status: WordleStandingStatus, tries count: Int) -> String {
        switch status {
        case .solved: return ConclaveStrings.format("Solved in %@", tries(count))
        case .outOfTries: return ConclaveStrings.text("Out of tries")
        case .timedOut: return ConclaveStrings.text("Timed out")
        case .playing: return count > 0 ? tries(count) : ConclaveStrings.text("Wordle Status Playing")
        }
    }

    static func twoFacts(_ first: String, _ second: String) -> String { ConclaveStrings.format("Two Facts %@ %@", first, second) }

    static func cellLabel(_ cell: WordleCellModel) -> String {
        switch cell.state {
        case .empty: return ""
        case .typed: return cell.letter
        case .correct: return ConclaveStrings.format("%@, correct position", cell.letter)
        case .present: return ConclaveStrings.format("%@, in the word", cell.letter)
        case .absent: return ConclaveStrings.format("%@, not in the word", cell.letter)
        }
    }

    static func keyLabel(_ key: WordleKeyModel) -> String {
        switch key.state {
        case .unused: return key.letter
        case .correct: return ConclaveStrings.format("%@, correct position", key.letter)
        case .present: return ConclaveStrings.format("%@, in the word", key.letter)
        case .absent: return ConclaveStrings.format("%@, not in the word", key.letter)
        }
    }

    /// "Row 2: S, not in the word, L, in the word, ..." or "Row 4, empty".
    static func rowSummary(_ row: WordleRowModel) -> String {
        var parts: [String] = []
        for cell in row.cells where !cell.letter.isEmpty {
            parts.append(cellLabel(cell))
        }
        if parts.isEmpty { return ConclaveStrings.format("Row %lld, empty", row.index + 1) }
        return ConclaveStrings.format("Row %lld: %@", row.index + 1, parts.joined(separator: ", "))
    }

    /// "2:41" in the current locale's digits.
    static func clock(_ seconds: Int) -> String {
        Duration.seconds(max(0, seconds)).formatted(.time(pattern: .minuteSecond))
    }

    /// "2 minutes, 41 seconds" for VoiceOver.
    static func spokenDuration(_ seconds: Int) -> String {
        Duration.seconds(max(0, seconds)).formatted(.units(allowed: [.minutes, .seconds], width: .wide))
    }

    /// "2:41 left"; its own key, because "%@ left" is the toast for a person who left.
    static func timeLeft(_ value: String) -> String { ConclaveStrings.format("Wordle Time Left %@", value) }
}
#endif
