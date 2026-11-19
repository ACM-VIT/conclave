#if os(iOS) && !SKIP
import Accessibility
import SwiftUI

struct WordleTeamStatus: View {
    let scene: WordleScene
    let team: WordleTeamScene
    let games: GameStagePresenter

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if scene.role == .spectator {
                PromptSpectatorNotice(games: games)
            }
            WordleTeamBanner(scene: scene, team: team, games: games)
            WordleTeamMembers(team: team)
        }
    }
}

struct WordleTeamBanner: View {
    let scene: WordleScene
    let team: WordleTeamScene
    let games: GameStagePresenter

    var body: some View {
        let mine = team.turn == .yours
        let shape = RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous)
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(WordleTeamCopy.title(scene, team: team))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = WordleTeamCopy.detail(scene, team: team) {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(HostingTheme.inCallTextSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(mine ? .isHeader : [])
            WordleTurnTimerSlot(team: team, games: games)
            if team.canPass {
                WordlePassButton(games: games)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), in: shape)
        .overlay { shape.strokeBorder(mine ? HostingTheme.coralFill : HostingTheme.inCallBorder, lineWidth: 1) }
        .modifier(PromptAnnouncement(games: games, key: team.turnKey, text: WordleTeamCopy.yourTurn(), urgent: true))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("game.wordle.team.banner")
    }
}

struct WordlePassButton: View {
    let games: GameStagePresenter

    var body: some View {
        let interaction = games.interaction
        let pending = interaction.isPending && interaction.pendingType == WordleIntent.passTurnType
        Button { _ = games.passWordleTurn() } label: {
            ZStack {
                Text(WordleTeamCopy.pass()).opacity(pending ? 0 : 1)
                if pending {
                    ProgressView()
                        .tint(HostingTheme.token(DesignTokens.iosInCallText))
                }
            }
        }
        .buttonStyle(.bordered)
        .tint(HostingTheme.token(DesignTokens.iosInCallText))
        .frame(minHeight: 44)
        .disabled(interaction.isPending)
        .accessibilityValue(pending ? ConclaveStrings.text("In Progress") : "")
        .accessibilityIdentifier("game.wordle.pass")
    }
}

struct WordleTurnTimerSlot: View {
    let team: WordleTeamScene
    let games: GameStagePresenter

    var body: some View {
        if let model = team.turnCountdown(serverOffsetMillis: games.countdown?.serverOffsetMillis ?? 0) {
            WordleTurnTimerChip(model: model, isMine: team.turn == .yours)
        }
    }
}

struct WordleTurnTimerChip: View {
    let model: CountdownModel
    let isMine: Bool
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        if scenePhase == .active {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                WordleTurnTimerFace(model: model, isMine: isMine, nowMillis: context.date.timeIntervalSince1970 * 1000)
            }
        } else {
            WordleTurnTimerFace(model: model, isMine: isMine, nowMillis: Date().timeIntervalSince1970 * 1000)
        }
    }
}

private struct WordleTurnTimerFace: View {
    let model: CountdownModel
    let isMine: Bool
    let nowMillis: Double

    var body: some View {
        let seconds = model.secondsLeft(nowMillis: nowMillis)
        GameKitTimerCapsule(text: WordleCopy.clock(seconds), isWarning: seconds <= CountdownModel.warningSeconds)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(WordleTeamCopy.turnTimeLeft(WordleCopy.spokenDuration(seconds)))
            .accessibilityIdentifier("game.wordle.turnTimer")
            .onChange(of: seconds) { _, value in
                if isMine && CountdownModel.announcedSeconds.contains(value) {
                    AccessibilityNotification.Announcement(WordleTeamCopy.turnTimeLeft(WordleCopy.spokenDuration(value))).post()
                }
            }
    }
}

struct WordleTeamMembers: View {
    let team: WordleTeamScene

    var body: some View {
        ConclaveFlowLayout(spacing: 6) {
            ForEach(team.members) { member in
                WordleTeamMemberChip(member: member, showsSeat: team.showsSeats)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(WordleTeamCopy.team())
        .accessibilityIdentifier("game.wordle.team.members")
    }
}

struct WordleTeamMemberChip: View {
    let member: WordleTeamMemberModel
    let showsSeat: Bool

    var body: some View {
        let ink = member.isGuessing ? HostingTheme.token(DesignTokens.iosInCallText) : HostingTheme.inCallTextSecondary
        HStack(spacing: 5) {
            if showsSeat {
                Text(String(member.seat))
                    .monospacedDigit()
                    .foregroundStyle(member.isGuessing ? HostingTheme.coralFill : HostingTheme.inCallTextSecondary)
            }
            Text(member.isYou ? ConclaveStrings.text("You") : member.name)
                .lineLimit(1)
                .truncationMode(.tail)
                .foregroundStyle(ink)
        }
        .font(.footnote.weight(member.isGuessing ? .semibold : .regular))
        .padding(.horizontal, 10)
        .frame(minHeight: 28)
        .overlay { Capsule().strokeBorder(member.isGuessing ? HostingTheme.coralFill : HostingTheme.inCallBorder, lineWidth: 1) }
        .opacity(member.isAway ? HostingTheme.disabledOpacity : 1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(WordleTeamCopy.member(member))
        .accessibilityIdentifier("game.wordle.team.member." + member.id)
    }
}

enum WordleTeamMetrics {
    static let labelWidth: CGFloat = 56
    static let labelGap: CGFloat = 6
}

struct WordleLabeledRow: View {
    let row: WordleRowModel
    let label: WordleRowLabel?

    var body: some View {
        let summary = WordleTeamCopy.rowSummary(row, label: label)
        ViewThatFits(in: .horizontal) {
            HStack(spacing: WordleTeamMetrics.labelGap) {
                Color.clear.frame(width: WordleTeamMetrics.labelWidth, height: 1)
                WordleRowView(row: row, label: summary)
                WordleRowGuesser(label: label)
            }
            HStack(spacing: WordleTeamMetrics.labelGap) {
                WordleRowView(row: row, label: summary)
                WordleRowGuesser(label: label)
            }
            WordleRowView(row: row, label: summary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(summary)
        .accessibilityIdentifier("game.wordle.row." + String(row.index))
    }
}

struct WordleRowGuesser: View {
    let label: WordleRowLabel?

    var body: some View {
        Text(label.map { $0.isYou ? ConclaveStrings.text("You") : $0.name } ?? "")
            .font(.caption.weight(label?.isTurn == true ? .semibold : .regular))
            .foregroundStyle(label?.isTurn == true ? HostingTheme.coralFill : HostingTheme.inCallTextSecondary)
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(width: WordleTeamMetrics.labelWidth, alignment: .leading)
            .accessibilityHidden(true)
    }
}

struct WordleTeamResults: View {
    let scene: WordleScene
    let team: WordleTeamScene
    let games: GameStagePresenter

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PromptHeadline(text: WordleTeamCopy.outcome(team.outcome))
                .accessibilityIdentifier("game.wordle.team.outcome")
            PromptLine(text: WordleTeamCopy.solvedDetail(team, maxTries: scene.maxTries))
            if !scene.myRows.isEmpty {
                WordleBoard(scene: scene, games: games, readOnly: true)
            }
        }
    }
}

enum WordleTeamCopy {
    static func yourTurn() -> String { ConclaveStrings.text("Your turn") }
    static func pass() -> String { ConclaveStrings.text("Pass") }
    static func team() -> String { ConclaveStrings.text("Team") }

    static func title(_ scene: WordleScene, team: WordleTeamScene) -> String {
        if scene.role == .setter { return ConclaveStrings.text("You set the word") }
        switch team.turn {
        case .yours: return yourTurn()
        case .anyone: return ConclaveStrings.text("One board, no turns")
        case .teammate:
            return team.guesserName.isEmpty ? ConclaveStrings.text("A teammate is guessing")
                : ConclaveStrings.format("%@ is guessing", team.guesserName)
        case .none: return ConclaveStrings.text("Team board")
        }
    }

    static func detail(_ scene: WordleScene, team: WordleTeamScene) -> String? {
        if scene.role == .setter { return ConclaveStrings.text("Watch your team crack it.") }
        switch team.turn {
        case .anyone: return ConclaveStrings.text("Talk it through on the call. Anyone can enter the next guess.")
        case .yours: return ConclaveStrings.text("Talk it through, then enter the team’s guess.")
        case .teammate: return team.isUpNext ? ConclaveStrings.text("You’re next") : nil
        case .none: return nil
        }
    }

    static func meta(_ scene: WordleScene, team: WordleTeamScene) -> String {
        team.mode == .relay ? ConclaveStrings.format("Take turns · %lld of %lld tries used", team.triesUsed, scene.maxTries)
            : ConclaveStrings.format("All together · %lld of %lld tries used", team.triesUsed, scene.maxTries)
    }

    static func outcome(_ outcome: WordleOutcome) -> String {
        switch outcome {
        case .solved: return ConclaveStrings.text("The team cracked it")
        case .outOfTries: return ConclaveStrings.text("Out of tries")
        case .timedOut: return ConclaveStrings.text("Time ran out")
        case .none: return ConclaveStrings.text("Round complete")
        }
    }

    static func solvedDetail(_ team: WordleTeamScene, maxTries: Int) -> String {
        if team.outcome != .solved { return "" }
        if team.solvedByName.isEmpty { return ConclaveStrings.format("Solved in %lld of %lld tries.", team.triesUsed, maxTries) }
        return ConclaveStrings.format("Solved in %lld of %lld tries. %@ landed the final guess.", team.triesUsed, maxTries, team.solvedByName)
    }

    static func member(_ member: WordleTeamMemberModel) -> String {
        let name = member.isYou ? ConclaveStrings.text("You") : member.name
        if member.isAway { return ConclaveStrings.format("%@, away", name) }
        if member.isGuessing { return ConclaveStrings.format("%@, guessing now", name) }
        if member.isUpNext { return ConclaveStrings.format("%@, up next", name) }
        return name
    }

    static func rowSummary(_ row: WordleRowModel, label: WordleRowLabel?) -> String {
        let summary = WordleCopy.rowSummary(row)
        guard let label = label, !label.isTurn, !label.name.isEmpty || label.isYou else { return summary }
        return ConclaveStrings.format("%@, guessed by %@", summary, label.isYou ? ConclaveStrings.text("You") : label.name)
    }

    static func turnTimeLeft(_ value: String) -> String { ConclaveStrings.format("%@ left in this turn", value) }
}
#endif
