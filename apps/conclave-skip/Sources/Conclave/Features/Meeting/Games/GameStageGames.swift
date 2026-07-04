import SwiftUI
import Observation

// Per-game surfaces for the on-stage runtime. Each view parses the same
// server projection the web client consumes and drives moves through the
// view model. Layout contract: scrollable content on top, pinned action bar
// at the bottom of the stage card.

// MARK: - Trivia

struct TriviaStageView: View {
    @Bindable var viewModel: MeetingViewModel
    let activeGame: GamePublicState
    let playerView: GameJSONValue?
    let canPlay: Bool
    let canManage: Bool

    var body: some View {
        let publicView = activeGame.view
        let phase = publicView?.string("phase") ?? activeGame.phase
        let options = publicView?.stringArray("options") ?? []
        let reveal = phase == "reveal"
        let results = phase == "results"
        let answered = playerView?.bool("answered") ?? false
        let selectedChoice = playerView?.int("choice")
        let correctChoice = publicView?.int("correctIndex")
        let counts = publicView?.intArray("optionCounts") ?? []
        let deadline = publicView?.double("deadline")
        let serverNow = publicView?.double("serverNow") ?? 0.0
        let durationMs = publicView?.double("questionDurationMs")
        let answeredCount = publicView?.int("answeredCount") ?? 0
        let totalPlayers = publicView?.int("totalPlayers") ?? 0
        let canAnswer = canPlay && phase == "question" && !answered && !viewModel.state.isGameActionInFlight

        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: ACMSpacing.md) {
                    GameStagePrompt(
                        kicker: results ? "Results" : GameStageTextPolicy.progressKicker(publicView, fallback: "Question"),
                        title: results
                            ? GameStageTextPolicy.triviaWinnerText(publicView)
                            : (publicView?.string("prompt") ?? "Waiting for the question."),
                        subtitle: results ? nil : triviaSupportLine(
                            phase: phase,
                            answered: answered,
                            answeredCount: answeredCount,
                            totalPlayers: totalPlayers
                        )
                    )

                    if phase == "question", let deadline, deadline > 0 {
                        GameStageCountdown(deadline: deadline, serverNow: serverNow, durationMs: durationMs)
                    }

                    if results {
                        GameStageScoreboard(rows: GameDetailsPresentationPolicy.scoreboardRows(from: publicView))
                    } else {
                        VStack(spacing: 8) {
                            ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                                GameStageChoiceCard(
                                    title: option,
                                    trailing: reveal && index < counts.count ? "\(counts[index])" : nil,
                                    isSelected: selectedChoice == index,
                                    isCorrect: reveal ? correctChoice == index : nil,
                                    isDisabled: !canAnswer
                                ) {
                                    viewModel.sendGameMove(
                                        type: "answer",
                                        payload: GameJSONValue.object(["choice": index])
                                    )
                                }
                            }
                        }
                    }

                    if !results, let playerView {
                        GameStageMetaLine(text: GameStageTextPolicy.triviaPlayerStatus(playerView, phase: phase))
                    }
                }
                .padding(ACMSpacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if results {
                GameStageResultsBar(viewModel: viewModel, canManage: canManage)
            } else {
                GameStageHostRoundBar(viewModel: viewModel, phase: phase, canManage: canManage)
            }
        }
    }

    private func triviaSupportLine(phase: String, answered: Bool, answeredCount: Int, totalPlayers: Int) -> String? {
        guard phase == "question" else { return nil }
        var parts: [String] = []
        if answered {
            parts.append("Answer locked in")
        }
        if totalPlayers > 0 {
            parts.append("\(answeredCount) of \(totalPlayers) answered")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

// MARK: - Reaction

struct ReactionStageView: View {
    @Bindable var viewModel: MeetingViewModel
    let activeGame: GamePublicState
    let playerView: GameJSONValue?
    let canPlay: Bool
    let canManage: Bool

    var body: some View {
        let publicView = activeGame.view
        let phase = publicView?.string("phase") ?? activeGame.phase
        let tapped = playerView?.bool("tapped") ?? false
        let early = playerView?.bool("early") ?? false
        let reactionMs = playerView?.int("reactionMs")
        let canTap = canPlay
            && (phase == "arming" || phase == "go")
            && !tapped
            && !viewModel.state.isGameActionInFlight

        VStack(spacing: 0) {
            if (phase == "arming" || phase == "go") && canPlay {
                // The pad is the whole stage: nothing to read, one thing to do.
                reactionTapPad(
                    phase: phase,
                    tapped: tapped,
                    early: early,
                    reactionMs: reactionMs,
                    canTap: canTap
                )
                .padding(ACMSpacing.md)
            } else if (phase == "arming" || phase == "go") && !canPlay {
                // Spectators do not get a tap pad; just show what is happening.
                GameStageNotice(
                    icon: "bolt.fill",
                    androidIcon: "warning",
                    title: phase == "go" ? "Players are tapping" : "Get ready",
                    subtitle: GameStageTextPolicy.reactionSubtitle(publicView, phase: phase)
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: ACMSpacing.md) {
                        GameStagePrompt(
                            kicker: phase == "results" ? "Results" : "Reaction",
                            title: GameStageTextPolicy.reactionTitle(phase: phase, tapped: tapped, early: early, reactionMs: reactionMs),
                            subtitle: GameStageTextPolicy.reactionSubtitle(publicView, phase: phase)
                        )

                        if phase == "reveal" {
                            reactionResultsList(publicView)
                        } else if phase == "results" {
                            GameStageScoreboard(rows: GameDetailsPresentationPolicy.scoreboardRows(from: publicView))
                        }
                    }
                    .padding(ACMSpacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                if phase == "results" {
                    GameStageResultsBar(viewModel: viewModel, canManage: canManage)
                } else {
                    GameStageHostRoundBar(viewModel: viewModel, phase: phase, canManage: canManage)
                }
            }
        }
    }

    private func reactionTapPad(
        phase: String,
        tapped: Bool,
        early: Bool,
        reactionMs: Int?,
        canTap: Bool
    ) -> some View {
        let isGo = phase == "go"
        let tint: Color = early ? ACMColors.error : (isGo ? ACMColors.success : ACMColors.errorDim)
        let title = GameStageTextPolicy.reactionTitle(phase: phase, tapped: tapped, early: early, reactionMs: reactionMs)
        let subtitle: String = {
            if early { return "You jumped the gun." }
            if reactionMs != nil { return "Nice. Wait for the others." }
            if tapped { return "Locked. Wait for the reveal." }
            return isGo ? "Tap anywhere!" : "Green means go."
        }()

        return Button {
            HapticManager.shared.trigger(.medium)
            viewModel.sendGameMove(type: "tap")
        } label: {
            VStack(spacing: 8) {
                Text(title)
                    .font(ACMFont.trial(isGo && !tapped ? 44.0 : 30.0, weight: .bold))
                    .foregroundStyle(Color.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                Text(subtitle)
                    .font(ACMFont.trial(14, weight: .medium))
                    .foregroundStyle(Color.white.opacity(0.82))
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(tint, in: RoundedRectangle(cornerRadius: ACMRadius.lg, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!canTap)
        .accessibilityLabel(isGo ? "Tap now" : "Wait for green")
    }

    private func reactionResultsList(_ view: GameJSONValue?) -> some View {
        let rows = GameDetailsPresentationPolicy.reactionResultRows(from: view)
        return VStack(spacing: 8) {
            if rows.isEmpty {
                GameStageMetaLine(text: "Results are not available yet.")
            } else {
                ForEach(rows) { row in
                    HStack(spacing: ACMSpacing.sm) {
                        Text("\(row.rank)")
                            .font(ACMFont.trial(14, weight: .bold))
                            .foregroundStyle(row.isWinner ? ACMColors.primaryOrange : ACMColors.textFaint)
                            .frame(width: 26, alignment: .center)
                        Text(row.name)
                            .font(ACMFont.trial(15, weight: .medium))
                            .foregroundStyle(ACMColors.text)
                            .lineLimit(1)
                        Spacer(minLength: ACMSpacing.xs)
                        Text(row.resultText)
                            .font(ACMFont.trial(14, weight: .semibold))
                            .foregroundStyle(row.isEarly ? ACMColors.error : ACMColors.textMuted)
                    }
                    .padding(.horizontal, ACMSpacing.md)
                    .frame(minHeight: 46)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background {
                        RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous)
                            .fill(row.isWinner ? ACMColors.primaryOrange.opacity(0.10) : ACMColors.surfaceRaised)
                    }
                    .overlay {
                        RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous)
                            .strokeBorder(row.isWinner ? ACMColors.primaryOrange.opacity(0.34) : ACMColors.border, lineWidth: 1)
                    }
                }
            }
        }
    }
}

// MARK: - Most likely to

struct MostLikelyStageView: View {
    @Bindable var viewModel: MeetingViewModel
    let activeGame: GamePublicState
    let playerView: GameJSONValue?
    let canPlay: Bool
    let canManage: Bool

    var body: some View {
        let publicView = activeGame.view
        let phase = publicView?.string("phase") ?? activeGame.phase
        let playerRows = publicView?.objectArray("players") ?? []
        let players = playerRows.compactMap { GameDetailsPresentationPolicy.gamePlayerOption($0) }
        let votedFor = playerView?.string("yourVote")
        let voteCounts = GameDetailsPresentationPolicy.intMap(from: publicView, key: "counts")
        let maxVoteCount = max(1, voteCounts.values.max() ?? 0)
        let reveal = phase == "reveal"
        let results = phase == "results"
        let winnerId = publicView?.string("winnerId")
        let deadline = publicView?.double("deadline")
        let serverNow = publicView?.double("serverNow") ?? 0.0
        let voteDurationMs = publicView?.double("voteDurationMs")
        let canVote = canPlay && phase == "vote" && !viewModel.state.isGameActionInFlight

        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: ACMSpacing.md) {
                    GameStagePrompt(
                        kicker: results ? "Results" : GameStageTextPolicy.progressKicker(publicView, fallback: "Vote"),
                        title: results
                            ? "That is a wrap"
                            : GameStageTextPolicy.mostLikelyHeadline(publicView?.string("prompt")),
                        subtitle: mostLikelySupportLine(publicView, phase: phase)
                    )

                    if phase == "vote", let deadline, deadline > 0 {
                        GameStageCountdown(deadline: deadline, serverNow: serverNow, durationMs: voteDurationMs)
                    }

                    if phase == "vote" || reveal {
                        VStack(spacing: 8) {
                            ForEach(players) { player in
                                let voteCount = voteCounts[player.id] ?? 0
                                GameStageChoiceCard(
                                    title: player.name,
                                    trailing: reveal && voteCount > 0 ? GameStageTextPolicy.voteCountText(voteCount) : nil,
                                    isSelected: votedFor == player.id,
                                    isCorrect: reveal ? player.id == winnerId : nil,
                                    fillRatio: reveal ? Double(voteCount) / Double(maxVoteCount) : nil,
                                    isDisabled: !canVote || reveal
                                ) {
                                    viewModel.sendGameMove(
                                        type: "vote",
                                        payload: GameJSONValue.object(["target": player.id])
                                    )
                                }
                            }
                        }
                    } else if results {
                        GameStageNotice(
                            icon: "person.2.fill",
                            androidIcon: "participants",
                            title: "No hard feelings",
                            subtitle: "The votes were cast. The friendships survive."
                        )
                    }
                }
                .padding(ACMSpacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if results {
                GameStageResultsBar(viewModel: viewModel, canManage: canManage)
            } else {
                GameStageHostRoundBar(viewModel: viewModel, phase: phase, canManage: canManage)
            }
        }
    }

    private func mostLikelySupportLine(_ view: GameJSONValue?, phase: String) -> String? {
        if phase == "reveal", let winner = view?.string("winnerName"), !winner.isEmpty {
            return "Most votes: \(winner)"
        }
        if phase == "vote" {
            return "Pick the person this fits best."
        }
        return nil
    }
}

// MARK: - Would you rather

struct WouldYouRatherStageView: View {
    @Bindable var viewModel: MeetingViewModel
    let activeGame: GamePublicState
    let playerView: GameJSONValue?
    let canPlay: Bool
    let canManage: Bool

    var body: some View {
        let publicView = activeGame.view
        let phase = publicView?.string("phase") ?? activeGame.phase
        let selected = playerView?.int("choice")
        let counts = publicView?.intArray("counts") ?? []
        let reveal = phase == "reveal"
        let results = phase == "results"
        let deadline = publicView?.double("deadline")
        let serverNow = publicView?.double("serverNow") ?? 0.0
        let chooseDurationMs = publicView?.double("chooseDurationMs")
        let canChoose = canPlay && phase == "choose" && !viewModel.state.isGameActionInFlight

        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: ACMSpacing.md) {
                    GameStagePrompt(
                        kicker: results ? "Results" : GameStageTextPolicy.progressKicker(publicView, fallback: "Would you rather"),
                        title: reveal ? "The room split" : "Pick a side"
                    )

                    if phase == "choose", let deadline, deadline > 0 {
                        GameStageCountdown(deadline: deadline, serverNow: serverNow, durationMs: chooseDurationMs)
                    }

                    VStack(spacing: 10) {
                        GameStageChoiceCard(
                            title: publicView?.string("optionA") ?? "Option A",
                            trailing: reveal && !counts.isEmpty ? "\(counts[0])" : nil,
                            isSelected: selected == 0,
                            isDisabled: !canChoose || reveal
                        ) {
                            viewModel.sendGameMove(
                                type: "choose",
                                payload: GameJSONValue.object(["option": 0])
                            )
                        }

                        Text("or")
                            .font(ACMFont.trial(12, weight: .semibold))
                            .foregroundStyle(ACMColors.textFaint)
                            .frame(maxWidth: .infinity, alignment: .center)

                        GameStageChoiceCard(
                            title: publicView?.string("optionB") ?? "Option B",
                            trailing: reveal && counts.count > 1 ? "\(counts[1])" : nil,
                            isSelected: selected == 1,
                            isDisabled: !canChoose || reveal
                        ) {
                            viewModel.sendGameMove(
                                type: "choose",
                                payload: GameJSONValue.object(["option": 1])
                            )
                        }
                    }

                    if reveal {
                        revealSplit(publicView)
                    }
                }
                .padding(ACMSpacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if results {
                GameStageResultsBar(viewModel: viewModel, canManage: canManage)
            } else {
                GameStageHostRoundBar(viewModel: viewModel, phase: phase, canManage: canManage)
            }
        }
    }

    private func revealSplit(_ view: GameJSONValue?) -> some View {
        let counts = view?.intArray("counts") ?? []
        let first = counts.count > 0 ? counts[0] : 0
        let second = counts.count > 1 ? counts[1] : 0
        let total = max(1, first + second)
        let firstNames = GameDetailsPresentationPolicy.namesSummary(view?.stringArray("namesA") ?? [])
        let secondNames = GameDetailsPresentationPolicy.namesSummary(view?.stringArray("namesB") ?? [])

        return VStack(alignment: .leading, spacing: ACMSpacing.xs) {
            GeometryReader { geometry in
                HStack(spacing: 2) {
                    Rectangle()
                        .fill(ACMColors.primaryOrange)
                        .frame(width: max(4.0, geometry.size.width * Double(first) / Double(total)))
                    Rectangle()
                        .fill(ACMColors.surfaceHover)
                }
            }
            .frame(height: 10)
            .clipShape(Capsule())

            HStack(alignment: .top, spacing: ACMSpacing.sm) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(first) picked")
                        .font(ACMFont.trial(12, weight: .semibold))
                        .foregroundStyle(ACMColors.primaryOrange)
                    Text(firstNames)
                        .font(ACMFont.trial(12))
                        .foregroundStyle(ACMColors.textFaint)
                        .lineLimit(3)
                }
                Spacer(minLength: ACMSpacing.sm)
                VStack(alignment: .trailing, spacing: 2) {
                    Text("\(second) picked")
                        .font(ACMFont.trial(12, weight: .semibold))
                        .foregroundStyle(ACMColors.textMuted)
                    Text(secondNames)
                        .font(ACMFont.trial(12))
                        .foregroundStyle(ACMColors.textFaint)
                        .lineLimit(3)
                }
            }
        }
    }
}

// MARK: - Bluff

struct BluffStageView: View {
    @Bindable var viewModel: MeetingViewModel
    let activeGame: GamePublicState
    let playerView: GameJSONValue?
    let canPlay: Bool
    let canManage: Bool

    @State private var bluffAnswerInput = ""

    private var trimmedBluffAnswer: String {
        bluffAnswerInput.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var bluffAnswerBinding: Binding<String> {
        Binding(
            get: { bluffAnswerInput },
            set: { value in
                bluffAnswerInput = String(value.prefix(60))
            }
        )
    }

    var body: some View {
        let publicView = activeGame.view
        let phase = publicView?.string("phase") ?? activeGame.phase
        let question = publicView?.string("question") ?? "Waiting for the prompt."
        let submitted = playerView?.bool("submitted") ?? false
        let yourFake = playerView?.string("yourFake")
        let yourPick = playerView?.string("yourPick")
        let ownOptionId = playerView?.string("ownOptionId")
        let score = playerView?.int("score")
        let optionRows = publicView?.objectArray("options") ?? []
        let options = optionRows.compactMap { GameStageTextPolicy.bluffOption($0) }
        let results = phase == "results"
        let deadline = publicView?.double("deadline")
        let serverNow = publicView?.double("serverNow") ?? 0.0
        let canSubmit = canPlay
            && phase == "write"
            && !submitted
            && !trimmedBluffAnswer.isEmpty
            && !viewModel.state.isGameActionInFlight
        let canChoose = canPlay && phase == "choose" && !viewModel.state.isGameActionInFlight

        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: ACMSpacing.md) {
                    GameStagePrompt(
                        kicker: GameStageTextPolicy.bluffTitle(publicView, phase: phase),
                        title: results ? GameStageTextPolicy.triviaWinnerText(publicView) : question
                    )

                    if phase == "write" || phase == "choose", let deadline, deadline > 0 {
                        GameStageCountdown(deadline: deadline, serverNow: serverNow)
                    }

                    if phase == "write" {
                        if submitted {
                            GameStageMetaLine(text: GameStageTextPolicy.bluffSubmittedText(yourFake))
                        } else if canPlay {
                            bluffComposer(canSubmit: canSubmit)
                        }
                    } else if phase == "choose" {
                        VStack(spacing: 8) {
                            ForEach(options) { option in
                                let isOwnOption = option.id == ownOptionId
                                GameStageChoiceCard(
                                    title: option.text,
                                    subtitle: isOwnOption ? "Your bluff" : nil,
                                    isSelected: yourPick == option.id,
                                    isDisabled: !canChoose || isOwnOption
                                ) {
                                    viewModel.sendGameMove(
                                        type: "choose",
                                        payload: GameJSONValue.object(["optionId": option.id])
                                    )
                                }
                            }
                        }
                    } else if phase == "reveal" {
                        VStack(spacing: 8) {
                            ForEach(options) { option in
                                GameStageChoiceCard(
                                    title: option.text,
                                    subtitle: option.subtitle,
                                    isSelected: yourPick == option.id,
                                    isCorrect: option.isReal,
                                    isDisabled: true
                                ) {}
                            }
                        }
                        if let roundPoints = GameDetailsPresentationPolicy.roundPointsSummary(from: publicView) {
                            GameStageMetaLine(text: roundPoints)
                        }
                    } else if results {
                        GameStageScoreboard(rows: GameDetailsPresentationPolicy.scoreboardRows(from: publicView))
                    }

                    if let score, !results {
                        GameStageMetaLine(text: "\(score) points")
                    }
                }
                .padding(ACMSpacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if results {
                GameStageResultsBar(viewModel: viewModel, canManage: canManage)
            } else if canManage {
                bluffHostBar(phase: phase)
            }
        }
        // New round means the previous bluff is stale; drop the draft. The
        // zero-parameter onChange is Android-safe.
        .onChange(of: phase) {
            bluffAnswerInput = ""
        }
    }

    private func bluffComposer(canSubmit: Bool) -> some View {
        VStack(alignment: .leading, spacing: ACMSpacing.sm) {
            TextField("", text: bluffAnswerBinding, prompt: Text("Write something believable").foregroundStyle(ACMColors.textFaint))
                .font(ACMFont.trial(15))
                .foregroundStyle(ACMColors.text)
                .tint(ACMColors.primaryOrange)
                #if !SKIP
                .autocorrectionDisabled(false)
                #endif
                .padding(.horizontal, ACMSpacing.md)
                .frame(minHeight: 50)
                .background {
                    RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous)
                        .fill(ACMColors.surfaceRaised)
                }
                .overlay {
                    RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous)
                        .strokeBorder(lineWidth: 1)
                        .foregroundStyle(ACMColors.border)
                }
                .submitLabel(SubmitLabel.send)
                .onSubmit {
                    if canSubmit {
                        submitBluffAnswer()
                    }
                }

            GameStageActionButton(
                title: "Submit bluff",
                isDisabled: !canSubmit
            ) {
                submitBluffAnswer()
            }
        }
    }

    @ViewBuilder
    private func bluffHostBar(phase: String) -> some View {
        if phase == "write" || phase == "choose" {
            GameStageBottomBar {
                GameStageActionButton(
                    title: phase == "write" ? "Skip writing" : "Reveal now",
                    isPrimary: false,
                    tint: ACMColors.text,
                    isDisabled: viewModel.state.isGameActionInFlight
                ) {
                    viewModel.sendGameMove(type: "skip")
                }
            }
        } else if phase == "reveal" {
            GameStageBottomBar {
                GameStageActionButton(
                    title: "Next",
                    isDisabled: viewModel.state.isGameActionInFlight
                ) {
                    viewModel.sendGameMove(type: "next")
                }
            }
        }
    }

    private func submitBluffAnswer() {
        let answer = trimmedBluffAnswer
        guard !answer.isEmpty else { return }
        viewModel.sendGameMove(
            type: "submit",
            payload: GameJSONValue.object(["text": answer])
        )
        bluffAnswerInput = ""
    }
}

// MARK: - Imposter

struct ImposterStageView: View {
    @Bindable var viewModel: MeetingViewModel
    let activeGame: GamePublicState
    let playerView: GameJSONValue?
    let canPlay: Bool
    let canManage: Bool

    var body: some View {
        let publicView = activeGame.view
        let phase = publicView?.string("phase") ?? activeGame.phase
        let playerRows = publicView?.objectArray("players") ?? []
        let players = playerRows.compactMap { GameDetailsPresentationPolicy.gamePlayerOption($0) }
        let yourVote = playerView?.string("yourVote")
        let isImposter = playerView?.string("role") == "imposter"
        let deadline = publicView?.double("deadline")
        let serverNow = publicView?.double("serverNow") ?? 0.0
        let canVote = canPlay && phase == "vote" && !viewModel.state.isGameActionInFlight

        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: ACMSpacing.md) {
                    if (phase == "reveal" || phase == "discuss") && canPlay {
                        imposterRoleCard(isImposter: isImposter)
                    }

                    GameStagePrompt(
                        kicker: phase == "result" ? "Result" : GameStageTextPolicy.phaseLabel(phase),
                        title: GameStageTextPolicy.imposterTitle(publicView: publicView, playerView: playerView, phase: phase),
                        subtitle: GameStageTextPolicy.imposterSubtitle(publicView: publicView, playerView: playerView, phase: phase)
                    )

                    if phase == "reveal", let deadline, deadline > 0 {
                        GameStageCountdown(deadline: deadline, serverNow: serverNow)
                    }

                    if phase == "vote" {
                        VStack(spacing: 8) {
                            ForEach(players) { player in
                                let isSelf = viewModel.state.isLocalIdentityUserId(player.id)
                                GameStageChoiceCard(
                                    title: player.name,
                                    subtitle: GameStageTextPolicy.imposterVoteSubtitle(publicView, playerId: player.id, isSelf: isSelf),
                                    isSelected: yourVote == player.id,
                                    isDisabled: !canVote || isSelf
                                ) {
                                    viewModel.sendGameMove(
                                        type: "vote",
                                        payload: GameJSONValue.object(["target": player.id])
                                    )
                                }
                            }
                        }
                    } else if phase == "result" {
                        imposterResultDetails(publicView)
                    }
                }
                .padding(ACMSpacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            imposterHostBar(phase: phase)
        }
    }

    /// Your secret, styled so a shoulder-surfer reads it less easily than a
    /// plain headline. Imposters get the warning tone instead of a word.
    private func imposterRoleCard(isImposter: Bool) -> some View {
        HStack(spacing: ACMSpacing.sm) {
            ACMSystemIcon.icon(
                isImposter ? "eye.slash.fill" : "checkmark.seal.fill",
                android: isImposter ? "ghost" : "check",
                size: 18,
                tint: isImposter ? "error" : "accent"
            )
            .foregroundStyle(isImposter ? ACMColors.error : ACMColors.primaryOrange)

            Text(isImposter ? "You are the imposter" : "You know the word")
                .font(ACMFont.trial(14, weight: .semibold))
                .foregroundStyle(ACMColors.text)
                .lineLimit(1)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, ACMSpacing.md)
        .frame(minHeight: 46)
        .background {
            RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous)
                .fill(isImposter ? ACMColors.error.opacity(0.10) : ACMColors.primaryOrangeFaint)
        }
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous)
                .strokeBorder(isImposter ? ACMColors.error.opacity(0.34) : ACMColors.primaryOrange.opacity(0.34), lineWidth: 1)
        }
    }

    @ViewBuilder
    private func imposterResultDetails(_ view: GameJSONValue?) -> some View {
        if let result = view?.dictionaryValue?["result"] as? [String: Any] {
            let word = (result["word"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let imposter = (result["imposterName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let votedOut = (result["votedOutName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            VStack(alignment: .leading, spacing: 6) {
                if !word.isEmpty {
                    GameStageMetaLine(text: "Word: \(word)")
                }
                if !imposter.isEmpty {
                    GameStageMetaLine(text: "Imposter: \(imposter)")
                }
                if !votedOut.isEmpty {
                    GameStageMetaLine(text: "Voted out: \(votedOut)")
                }
            }
        } else {
            GameStageMetaLine(text: "Result pending")
        }
    }

    @ViewBuilder
    private func imposterHostBar(phase: String) -> some View {
        if canManage {
            if phase == "discuss" {
                GameStageBottomBar {
                    GameStageActionButton(
                        title: "Call the vote",
                        isDisabled: viewModel.state.isGameActionInFlight
                    ) {
                        viewModel.sendGameMove(type: "callVote")
                    }
                }
            } else if phase == "vote" {
                GameStageBottomBar {
                    GameStageActionButton(
                        title: "End vote",
                        isDisabled: viewModel.state.isGameActionInFlight
                    ) {
                        viewModel.sendGameMove(type: "tally")
                    }
                }
            } else if phase == "result" {
                GameStageResultsBar(viewModel: viewModel, canManage: canManage)
            }
        }
    }
}

// MARK: - Chess

struct ChessStageSquare: Identifiable {
    let square: String
    let piece: String?
    let isDark: Bool

    var id: String { square }
}

struct ChessStageView: View {
    @Bindable var viewModel: MeetingViewModel
    let activeGame: GamePublicState
    let playerView: GameJSONValue?
    let canPlay: Bool
    let canManage: Bool

    @State private var selectedSquare: String? = nil

    private var side: String? {
        playerView?.string("side")
    }

    private var canMove: Bool {
        canPlay
            && playerView?.bool("canMove") == true
            && !viewModel.state.isGameActionInFlight
    }

    var body: some View {
        let publicView = activeGame.view
        let phase = publicView?.string("phase") ?? activeGame.phase
        let fen = publicView?.string("fen") ?? ""
        let squares = ChessStageView.boardSquares(from: fen, side: side)
        let targets = selectedSquare.flatMap { legalTargets(for: $0, in: publicView) } ?? []

        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: ACMSpacing.md) {
                    GameStagePrompt(
                        kicker: phase == "results" ? "Result" : "Chess",
                        title: statusTitle(publicView: publicView, phase: phase),
                        subtitle: roleSubtitle(publicView: publicView)
                    )

                    LazyVGrid(
                        columns: Array(repeating: GridItem(.flexible(), spacing: 0), count: 8),
                        spacing: 0
                    ) {
                        ForEach(squares) { item in
                            chessSquare(item, isSelected: selectedSquare == item.square, isTarget: targets.contains(item.square))
                        }
                    }
                    .aspectRatio(1.0, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: ACMRadius.md, style: .continuous)
                            .strokeBorder(lineWidth: 1)
                            .foregroundStyle(ACMColors.border)
                    }

                    teamSummary(publicView)

                    if let drawOffer = publicView?.dictionaryValue?["drawOffer"] as? [String: Any],
                       let name = drawOffer["byName"] as? String {
                        GameStageMetaLine(text: "\(name) offered a draw.")
                    }
                }
                .padding(ACMSpacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            bottomBar(publicView: publicView, phase: phase)
        }
    }

    private func chessSquare(_ item: ChessStageSquare, isSelected: Bool, isTarget: Bool) -> some View {
        Button {
            handleSquare(item)
        } label: {
            ZStack {
                Rectangle()
                    .fill(squareColor(isDark: item.isDark, isSelected: isSelected, isTarget: isTarget))
                if let piece = item.piece {
                    Text(piece)
                        .font(.system(size: 30, weight: .regular, design: .serif))
                        .foregroundStyle(ChessStageView.isWhitePiece(piece) ? Color.white : Color.black)
                        .shadow(color: Color.black.opacity(0.18), radius: 1, x: 0, y: 1)
                }
                if isTarget && item.piece == nil {
                    Circle()
                        .fill(Color.black.opacity(0.32))
                        .frame(width: 12, height: 12)
                }
            }
            .aspectRatio(1.0, contentMode: .fit)
        }
        .buttonStyle(.plain)
        .disabled(!canMove)
    }

    private func squareColor(isDark: Bool, isSelected: Bool, isTarget: Bool) -> Color {
        if isSelected { return ACMColors.primaryOrange }
        if isTarget { return ACMColors.primaryOrange.opacity(0.42) }
        return isDark ? Color(red: 0.38, green: 0.45, blue: 0.37) : Color(red: 0.83, green: 0.76, blue: 0.62)
    }

    private func handleSquare(_ item: ChessStageSquare) {
        guard canMove else { return }
        let pieceIsOwn = ChessStageView.side(forPiece: item.piece) == side
        if selectedSquare == nil {
            if pieceIsOwn { selectedSquare = item.square }
            return
        }
        guard let selected = selectedSquare else { return }
        let targets = legalTargets(for: selected, in: activeGame.view)
        if selected == item.square {
            selectedSquare = nil
            return
        }
        if pieceIsOwn && !targets.contains(item.square) {
            selectedSquare = item.square
            return
        }
        guard targets.contains(item.square) else { return }
        let movingPiece = ChessStageView.piece(at: selected, in: activeGame.view?.string("fen") ?? "")
        let promotion = ChessStageView.shouldPromote(piece: movingPiece, to: item.square) ? "q" : ""
        selectedSquare = nil
        viewModel.sendGameMove(
            type: "move",
            payload: GameJSONValue.object([
                "from": selected,
                "to": item.square,
                "promotion": promotion
            ])
        )
    }

    @ViewBuilder
    private func bottomBar(publicView: GameJSONValue?, phase: String) -> some View {
        if phase == "results" {
            GameStageResultsBar(viewModel: viewModel, canManage: canManage)
        } else if playerView?.bool("canRespondToDraw") == true {
            GameStageBottomBar {
                GameStageActionButton(
                    title: "Accept draw",
                    isDisabled: viewModel.state.isGameActionInFlight
                ) {
                    viewModel.sendGameMove(type: "acceptDraw")
                }
                GameStageActionButton(
                    title: "Decline",
                    isPrimary: false,
                    tint: ACMColors.text,
                    isDisabled: viewModel.state.isGameActionInFlight
                ) {
                    viewModel.sendGameMove(type: "declineDraw")
                }
            }
        } else if playerView?.bool("canOfferDraw") == true || playerView?.bool("canResign") == true {
            GameStageBottomBar {
                GameStageActionButton(
                    title: "Offer draw",
                    isPrimary: false,
                    tint: ACMColors.text,
                    isDisabled: viewModel.state.isGameActionInFlight || publicView?.dictionaryValue?["drawOffer"] != nil
                ) {
                    viewModel.sendGameMove(type: "offerDraw")
                }
                GameStageActionButton(
                    title: "Resign",
                    isPrimary: false,
                    tint: ACMColors.error,
                    isDisabled: viewModel.state.isGameActionInFlight
                ) {
                    viewModel.sendGameMove(type: "resign")
                }
            }
        }
    }

    private func statusTitle(publicView: GameJSONValue?, phase: String) -> String {
        if let result = publicView?.dictionaryValue?["result"] as? [String: Any] {
            let winner = (result["winner"] as? String) ?? "draw"
            let reason = (result["reason"] as? String) ?? "result"
            if winner == "draw" { return "Draw by \(reason)" }
            return "\(winner.capitalized) wins by \(reason)"
        }
        if canMove { return "Your move" }
        let turnSide = publicView?.string("turnSide") ?? "white"
        return "\(turnSide.capitalized) to move"
    }

    private func roleSubtitle(publicView: GameJSONValue?) -> String? {
        let role = playerView?.string("role") ?? "spectator"
        if role == "spectator" { return "Watching" }
        if publicView?.bool("inCheck") == true {
            return "\(role.replacingOccurrences(of: "-", with: " ")). Check."
        }
        return role.replacingOccurrences(of: "-", with: " ")
    }

    private func legalTargets(for square: String, in view: GameJSONValue?) -> [String] {
        guard let legal = view?.dictionaryValue?["legalMoves"] as? [String: Any] else { return [] }
        return legal[square] as? [String] ?? []
    }

    private func teamSummary(_ view: GameJSONValue?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            chessTeamLine(title: "White", rows: teamRows("white", in: view))
            chessTeamLine(title: "Black", rows: teamRows("black", in: view))
        }
    }

    private func chessTeamLine(title: String, rows: [[String: Any]]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(ACMFont.trial(12, weight: .semibold))
                .foregroundStyle(ACMColors.textFaint)
            Text(rows.map { row in
                let name = (row["name"] as? String) ?? "Player"
                let captain = GameDetailsPresentationPolicy.boolValue(row["captain"]) == true
                return captain ? "\(name) lead" : name
            }.joined(separator: ", "))
            .font(ACMFont.trial(13))
            .foregroundStyle(ACMColors.textMuted)
            .lineLimit(2)
        }
    }

    private func teamRows(_ side: String, in view: GameJSONValue?) -> [[String: Any]] {
        guard let teams = view?.dictionaryValue?["teams"] as? [String: Any] else { return [] }
        return teams[side] as? [[String: Any]] ?? []
    }

    static func boardSquares(from fen: String, side: String?) -> [ChessStageSquare] {
        let placement = fen.split(separator: " ").first.map(String.init) ?? ""
        let rows = placement.split(separator: "/").map(String.init)
        let files = ["a", "b", "c", "d", "e", "f", "g", "h"]
        let ranks = ["8", "7", "6", "5", "4", "3", "2", "1"]
        var squares: [ChessStageSquare] = []
        for (rankIndex, row) in rows.enumerated() {
            var fileIndex = 0
            for token in row {
                if let count = Int(String(token)) {
                    for _ in 0..<count {
                        squares.append(ChessStageSquare(
                            square: "\(files[fileIndex])\(ranks[rankIndex])",
                            piece: nil,
                            isDark: (fileIndex + rankIndex) % 2 == 1
                        ))
                        fileIndex += 1
                    }
                } else {
                    squares.append(ChessStageSquare(
                        square: "\(files[fileIndex])\(ranks[rankIndex])",
                        piece: pieceSymbol(String(token)),
                        isDark: (fileIndex + rankIndex) % 2 == 1
                    ))
                    fileIndex += 1
                }
            }
        }
        return side == "black" ? Array(squares.reversed()) : squares
    }

    static func pieceSymbol(_ code: String) -> String {
        switch code {
        case "P": return "♙"
        case "N": return "♘"
        case "B": return "♗"
        case "R": return "♖"
        case "Q": return "♕"
        case "K": return "♔"
        case "p": return "♟"
        case "n": return "♞"
        case "b": return "♝"
        case "r": return "♜"
        case "q": return "♛"
        case "k": return "♚"
        default: return ""
        }
    }

    static func isWhitePiece(_ piece: String) -> Bool {
        ["♙", "♘", "♗", "♖", "♕", "♔"].contains(piece)
    }

    static func side(forPiece piece: String?) -> String? {
        guard let piece else { return nil }
        return isWhitePiece(piece) ? "white" : "black"
    }

    static func piece(at square: String, in fen: String) -> String? {
        boardSquares(from: fen, side: nil).first { $0.square == square }?.piece
    }

    static func shouldPromote(piece: String?, to square: String) -> Bool {
        if piece == "♙" { return square.hasSuffix("8") }
        if piece == "♟" { return square.hasSuffix("1") }
        return false
    }
}

// MARK: - Wordle

/// Wordle already has a full native round UI; the stage wraps it in the
/// scroll frame it expects.
struct WordleStageView: View {
    @Bindable var viewModel: MeetingViewModel
    let activeGame: GamePublicState
    let playerView: GameJSONValue?
    let canPlay: Bool
    let canManage: Bool

    var body: some View {
        ScrollView {
            WordleGameView(
                viewModel: viewModel,
                activeGame: activeGame,
                publicView: activeGame.view,
                playerView: playerView,
                canPlay: canPlay,
                canManage: canManage
            )
            .padding(.horizontal, ACMSpacing.xs)
            .padding(.vertical, ACMSpacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
