#if os(iOS) && !SKIP
import SwiftUI

struct LongShotSceneBody: View {
    let games: GameStagePresenter

    var body: some View {
        if let scene = games.scene.longShot {
            LongShotSceneView(scene: scene, games: games)
        } else {
            GameKitNotice(kind: .unsupported, message: "")
        }
    }
}

struct LongShotSceneView: View {
    let scene: LongShotScene
    let games: GameStagePresenter

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch scene.board {
            case .lobby:
                EmptyView()
            case .dive(let dive):
                LongShotDiveView(board: dive, scene: scene, games: games)
            case .reveal(let reveal):
                LongShotRevealView(board: reveal)
            case .fuse(let fuse):
                LongShotFuseView(board: fuse, scene: scene, games: games)
            case .popped(let pop):
                LongShotPopView(board: pop)
            case .results(let results):
                LongShotResultsView(board: results)
            }
            if !scene.isPlayer && scene.stage != .results {
                PromptSpectatorNotice(games: games, allowsJoin: scene.mode == .classic)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(PromptAnnouncement(games: games, key: scene.announcementKey, text: LongShotCopy.announcement(scene)))
        .accessibilityIdentifier("game.scene.longShot")
    }
}

struct LongShotDiveView: View {
    let board: LongShotDiveBoard
    let scene: LongShotScene
    let games: GameStagePresenter

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 12) {
                LongShotDepthReadout(depth: board.depth, gain: board.gain)
                Spacer(minLength: 8)
                if let countdown = games.countdown {
                    GameKitCountdown(model: countdown)
                }
            }
            GameKitPrompt(kicker: LongShotCopy.promptKicker(board.prompt, mode: scene.mode, foundCount: 0),
                          title: board.prompt.text,
                          subtitle: board.isReady ? "" : LongShotCopy.lockedCount(board.lockedCount, total: board.totalPlayers))
            if let landing = board.landing {
                LongShotLockedRow(landing: landing)
            } else if scene.entry.isShown {
                LongShotEntry(entry: scene.entry, games: games, missKey: board.miss?.atMillis ?? 0)
                if let miss = board.miss {
                    LongShotNoteLine(text: LongShotCopy.miss(miss), symbol: LongShotSymbols.miss)
                }
            }
            LongShotLadder(rungs: board.rungs, landedIndex: board.landedIndex)
        }
    }
}

struct LongShotDepthReadout: View {
    let depth: Int
    let gain: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(ConclaveStrings.text("Depth"))
                .font(.footnote.weight(.semibold))
                .foregroundStyle(HostingTheme.inCallTextSecondary)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(LongShotCopy.meters(depth))
                    .font(.title2.weight(.semibold))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                if gain > 0 {
                    Text(LongShotCopy.gain(gain))
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(HostingTheme.inCallCoralText)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("game.longShot.depth")
    }
}

struct LongShotEntry: View {
    let entry: LongShotEntryModel
    let games: GameStagePresenter
    let missKey: Double
    @State private var showsChecking = false
    @State private var shakes = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let interaction = games.interaction
        let pending = interaction.isPending && interaction.pendingType == LongShotIntent.answerType
        let draft = Binding(get: { games.longShotDraft }, set: { games.setLongShotDraft($0) })
        VStack(alignment: .leading, spacing: 6) {
            GameKitTextEntry(label: ConclaveStrings.text("Answer"), placeholder: LongShotCopy.hint(entry.hint),
                             maxLength: LongShotSceneBuilder.maxAnswerLength, text: draft, submitTitle: LongShotCopy.action(entry.action),
                             isPending: pending, isEnabled: entry.canSubmit && (!interaction.isPending || pending),
                             onSubmit: { _ = games.submitLongShot() })
                .keyframeAnimator(initialValue: 0.0, trigger: shakes) { content, offset in
                    content.offset(x: offset)
                } keyframes: { _ in
                    KeyframeTrack {
                        CubicKeyframe(-6, duration: 0.07)
                        CubicKeyframe(5, duration: 0.08)
                        CubicKeyframe(-2, duration: 0.07)
                        CubicKeyframe(0, duration: 0.08)
                    }
                }
            if showsChecking {
                GameKitWaitingLine(text: ConclaveStrings.text("Checking your answer"))
                    .accessibilityIdentifier("game.longShot.checking")
            }
        }
        .onChange(of: missKey) { previous, next in
            if !reduceMotion && LongShotShakePolicy.shakes(previousMissAt: previous, nextMissAt: next) { shakes += 1 }
        }
        .task(id: pending) {
            if !pending {
                showsChecking = false
                return
            }
            try? await Task.sleep(for: .milliseconds(350))
            if !Task.isCancelled { showsChecking = true }
        }
    }
}

struct LongShotLockedRow: View {
    let landing: LongShotLanding

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous)
        HStack(spacing: 8) {
            Image(systemName: ConclaveSymbols.lockFill)
                .foregroundStyle(HostingTheme.inCallTextSecondary)
            Text(landing.text)
                .font(.body.weight(.semibold))
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(ConclaveStrings.text("Locked In"))
                .font(.footnote.weight(.semibold))
                .foregroundStyle(HostingTheme.inCallTextSecondary)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 48)
        .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), in: shape)
        .overlay { shape.strokeBorder(HostingTheme.inCallBorder, lineWidth: 1) }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("game.longShot.locked")
    }
}

struct LongShotNoteLine: View {
    let text: String
    let symbol: String

    var body: some View {
        Label {
            Text(text)
        } icon: {
            Image(systemName: symbol)
        }
        .labelStyle(GameKitCompactLabelStyle())
        .font(.footnote.weight(.semibold))
        .foregroundStyle(HostingTheme.inCallTextSecondary)
        .padding(.leading, 12)
        .accessibilityIdentifier("game.longShot.note")
    }
}

struct LongShotLadder: View {
    let rungs: [LongShotRungModel]
    let landedIndex: Int
    @State private var marker: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(rungs: [LongShotRungModel], landedIndex: Int) {
        self.rungs = rungs
        self.landedIndex = landedIndex
        _marker = State(initialValue: landedIndex)
    }

    var body: some View {
        VStack(spacing: 4) {
            ForEach(Array(rungs.enumerated()), id: \.element.id) { index, rung in
                LongShotRungRow(rung: rung, isMarked: index == marker, isPassed: marker >= 0 && index < marker && marker < landedIndex,
                                isDimmed: marker == landedIndex && landedIndex >= 0 && index != landedIndex)
            }
        }
        .task(id: landedIndex) {
            if landedIndex < 0 {
                marker = -1
                return
            }
            if marker == landedIndex { return }
            if reduceMotion {
                marker = landedIndex
                return
            }
            var step = 0
            while step <= landedIndex {
                withAnimation(.easeOut(duration: LongShotMotion.stepSeconds)) { marker = step }
                try? await Task.sleep(for: .milliseconds(LongShotMotion.stepMillis))
                if Task.isCancelled { return }
                step += 1
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("game.longShot.ladder")
    }
}

enum LongShotMotion {
    static let stepMillis = 110
    static let stepSeconds = 0.14
}

struct LongShotRungRow: View {
    let rung: LongShotRungModel
    let isMarked: Bool
    let isPassed: Bool
    let isDimmed: Bool

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusSmall), style: .continuous)
        let landed = rung.isLanded && isMarked
        HStack(spacing: 10) {
            Circle()
                .fill(isMarked ? HostingTheme.coralFill : Color.clear)
                .frame(width: 8, height: 8)
            Text(LongShotCopy.tier(rung.tier))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            if landed && !rung.word.isEmpty {
                Text(rung.word)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .lineLimit(1)
                    .padding(.horizontal, 8)
                    .frame(minHeight: 22)
                    .background(HostingTheme.token(DesignTokens.iosInCallSurfaceHigh), in: Capsule())
            }
            Spacer(minLength: 8)
            Text(LongShotCopy.meters(rung.points))
                .font(.subheadline)
                .monospacedDigit()
                .foregroundStyle(landed ? HostingTheme.inCallCoralText : HostingTheme.inCallTextSecondary)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 40)
        .background(isPassed ? HostingTheme.token(DesignTokens.iosInCallSurfaceHigh) : HostingTheme.token(DesignTokens.iosInCallSurfaceRaised),
                    in: shape)
        .overlay { shape.strokeBorder(landed ? HostingTheme.coralFill : HostingTheme.inCallBorder, lineWidth: 1) }
        .opacity(isDimmed ? 0.5 : 1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(LongShotCopy.rungLabel(rung))
        .accessibilityAddTraits(rung.isLanded ? .isSelected : [])
    }
}

struct LongShotRevealView: View {
    let board: LongShotRevealBoard

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            LongShotDepthReadout(depth: board.depth, gain: board.gain)
            GameKitPrompt(kicker: LongShotCopy.promptKicker(board.prompt, mode: .classic, foundCount: 0), title: board.prompt.text)
            LongShotRows {
                ForEach(board.rows) { row in
                    LongShotAnswerRow(answer: row.landing?.text ?? ConclaveStrings.text("No answer"), isMissing: row.landing == nil,
                                      name: LongShotCopy.name(row.name, isYou: row.isYou), isJudged: row.landing?.isJudged ?? false,
                                      trailing: row.landing.map { LongShotCopy.gain($0.points) } ?? LongShotCopy.meters(0),
                                      isHighlighted: (row.landing?.tier ?? .obvious) == .pearl)
                }
            }
            if let pearl = board.pearl {
                LongShotFactLine(label: LongShotCopy.tier(.pearl), value: pearl.answer,
                                 detail: pearl.foundBy.isEmpty ? "" : ConclaveStrings.format("Long Shot Found By %@", pearl.foundBy.joined(separator: ", ")))
            }
            if !board.missedGems.isEmpty {
                LongShotFactLine(label: ConclaveStrings.text("Missed"), value: board.missedGems.joined(separator: ", "), detail: "")
            }
        }
    }
}

struct LongShotRows<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous)
        VStack(spacing: 0) {
            content
        }
        .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), in: shape)
        .overlay { shape.strokeBorder(HostingTheme.inCallBorder, lineWidth: 1) }
    }
}

struct LongShotAnswerRow: View {
    let answer: String
    var isMissing = false
    let name: String
    let isJudged: Bool
    let trailing: String
    var isHighlighted = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(answer)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(isMissing ? HostingTheme.inCallTextSecondary : HostingTheme.token(DesignTokens.iosInCallText))
                    .lineLimit(2)
                Text(isJudged ? ConclaveStrings.format("Two Facts %@ %@", name, ConclaveStrings.text("Judged")) : name)
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(trailing)
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(isHighlighted ? HostingTheme.inCallCoralText : HostingTheme.token(DesignTokens.iosInCallText))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) {
            Rectangle().fill(HostingTheme.inCallBorder).frame(height: 1).padding(.leading, 12)
        }
        .accessibilityElement(children: .combine)
    }
}

struct LongShotFactLine: View {
    let label: String
    let value: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(HostingTheme.inCallTextSecondary)
            Text(value)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .fixedSize(horizontal: false, vertical: true)
            if !detail.isEmpty {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

struct LongShotFuseView: View {
    let board: LongShotFuseBoard
    let scene: LongShotScene
    let games: GameStagePresenter

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            LongShotSeats(seats: board.seats)
            GameKitPrompt(kicker: LongShotCopy.promptKicker(board.prompt, mode: .fuse, foundCount: board.foundCount), title: board.prompt.text)
            VStack(alignment: .leading, spacing: 8) {
                Text(LongShotCopy.status(board))
                    .font(.headline)
                    .foregroundStyle(board.status == .yourTurn ? HostingTheme.inCallCoralText : HostingTheme.token(DesignTokens.iosInCallText))
                    .accessibilityIdentifier("game.longShot.status")
                if board.showsMeter {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(ConclaveStrings.text("Next heart"))
                            .font(.footnote)
                            .foregroundStyle(HostingTheme.inCallTextSecondary)
                        ProgressView(value: board.meterFraction)
                            .tint(HostingTheme.coralFill)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            if scene.entry.isShown {
                LongShotEntry(entry: scene.entry, games: games, missKey: board.note.missLine?.isYou == true ? board.note.missLine?.miss.atMillis ?? 0 : 0)
            }
            if let line = board.note.missLine {
                LongShotNoteLine(text: ConclaveStrings.format("Long Shot Miss By %@ %@", LongShotCopy.name(line.name, isYou: line.isYou),
                                                              LongShotCopy.miss(line.miss)),
                                 symbol: LongShotSymbols.miss)
            } else if let line = board.note.heartLine {
                LongShotNoteLine(text: line.isYou ? ConclaveStrings.text("You earned a heart")
                                                  : ConclaveStrings.format("Long Shot Heart %@", line.name),
                                 symbol: LongShotSymbols.heart)
            }
            if !board.chain.isEmpty {
                LongShotRows {
                    ForEach(board.chain) { row in
                        LongShotAnswerRow(answer: row.landing.text, name: LongShotCopy.name(row.name, isYou: row.isYou),
                                          isJudged: row.landing.isJudged, trailing: LongShotCopy.tier(row.landing.tier),
                                          isHighlighted: row.landing.tier == .pearl)
                            .transition(.opacity)
                    }
                }
                .animation(.easeOut(duration: 0.2), value: board.chain.first?.id)
            }
        }
    }
}

struct LongShotSeats: View {
    let seats: [LongShotSeatModel]

    var body: some View {
        ConclaveFlowLayout(spacing: 6) {
            ForEach(seats) { seat in
                HStack(spacing: 4) {
                    Text(LongShotCopy.name(seat.name, isYou: seat.isYou))
                        .strikethrough(seat.isOut)
                        .lineLimit(1)
                    if !seat.isOut {
                        Image(systemName: LongShotSymbols.heart)
                            .font(.caption2)
                        Text(String(seat.hearts))
                            .monospacedDigit()
                    }
                }
                .font(.footnote.weight(.semibold))
                .foregroundStyle(seat.isOut ? HostingTheme.inCallTextSecondary : HostingTheme.token(DesignTokens.iosInCallText))
                .padding(.horizontal, 10)
                .frame(minHeight: 28)
                .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), in: Capsule())
                .overlay {
                    Capsule().strokeBorder(seat.isHolding || seat.isPopped ? HostingTheme.coralFill : HostingTheme.inCallBorder, lineWidth: 1)
                }
                .opacity(seat.isOut ? 0.6 : 1)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(LongShotCopy.seatLabel(seat))
            }
        }
        .accessibilityIdentifier("game.longShot.seats")
    }
}

struct LongShotPopView: View {
    let board: LongShotPopBoard

    var body: some View {
        VStack(spacing: 14) {
            VStack(spacing: 6) {
                Text(ConclaveStrings.text("Out of air"))
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .accessibilityAddTraits(.isHeader)
                Text(LongShotCopy.popped(board))
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
            .accessibilityElement(children: .combine)
            LongShotSeats(seats: board.seats)
        }
    }
}

struct LongShotResultsView: View {
    let board: LongShotResultsBoard

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(spacing: 4) {
                Text(LongShotCopy.resultTitle(board))
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                if let winner = board.winner {
                    Text(LongShotCopy.meters(winner.depth))
                        .font(.subheadline)
                        .monospacedDigit()
                        .foregroundStyle(HostingTheme.inCallTextSecondary)
                }
                if let band = board.band {
                    Text(ConclaveStrings.format("Long Shot Your Dive %@", LongShotCopy.band(band)))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HostingTheme.inCallCoralText)
                        .padding(.top, 4)
                }
            }
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("game.longShot.result")
            VStack(spacing: 10) {
                ForEach(board.standings) { standing in
                    LongShotStandingRow(standing: standing)
                }
            }
            if !board.best.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text(ConclaveStrings.text("Deepest answers"))
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(HostingTheme.inCallTextSecondary)
                    LongShotRows {
                        ForEach(board.best) { row in
                            LongShotAnswerRow(answer: row.landing.text, name: LongShotCopy.name(row.name, isYou: row.isYou),
                                              isJudged: row.landing.isJudged, trailing: LongShotCopy.tier(row.landing.tier),
                                              isHighlighted: row.landing.tier == .pearl)
                        }
                    }
                }
            }
        }
        .padding(.top, 8)
    }
}

struct LongShotStandingRow: View {
    let standing: LongShotStandingModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(LongShotCopy.name(standing.name, isYou: standing.isYou))
                    .font(.subheadline.weight(standing.isYou ? .semibold : .regular))
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(LongShotCopy.meters(standing.depth))
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            }
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised))
                    Capsule()
                        .fill(standing.isWinner ? HostingTheme.coralFill : HostingTheme.token(DesignTokens.iosInCallSurfaceHigh))
                        .frame(width: max(4, proxy.size.width * standing.fraction))
                }
            }
            .frame(height: 6)
            .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
    }
}

enum LongShotSymbols {
    static let heart = "heart.fill"
    static let miss = "xmark.circle"
}

enum LongShotCopy {
    static func meters(_ value: Int) -> String {
        ConclaveStrings.format("Long Shot Meters %@", value.formatted(.number))
    }

    static func gain(_ value: Int) -> String {
        ConclaveStrings.format("Long Shot Gain %@", value.formatted(.number))
    }

    static func tier(_ tier: LongShotTier) -> String {
        switch tier {
        case .obvious: return ConclaveStrings.text("Obvious")
        case .cliche: return ConclaveStrings.text("Cliché")
        case .solid: return ConclaveStrings.text("Solid")
        case .rare: return ConclaveStrings.text("Rare")
        case .longShot: return ConclaveStrings.text("Long shot")
        case .pearl: return ConclaveStrings.text("Pearl")
        }
    }

    static func band(_ band: LongShotDepthBand) -> String {
        switch band {
        case .shallows: return ConclaveStrings.text("Shallows")
        case .twilight: return ConclaveStrings.text("Twilight")
        case .midnight: return ConclaveStrings.text("Midnight")
        case .abyss: return ConclaveStrings.text("Abyss")
        case .trench: return ConclaveStrings.text("Trench")
        }
    }

    static func hint(_ hint: LongShotEntryHint) -> String {
        hint == .getReady ? ConclaveStrings.text("Get ready") : ConclaveStrings.text("Type an answer")
    }

    static func action(_ action: LongShotEntryAction) -> String {
        action == .pass ? ConclaveStrings.text("Pass") : ConclaveStrings.text("Dive")
    }

    static func name(_ name: String, isYou: Bool) -> String {
        isYou ? ConclaveStrings.text("You") : name
    }

    static func promptKicker(_ prompt: LongShotPromptCard, mode: LongShotMode, foundCount: Int) -> String {
        let meta = mode == .fuse
            ? (foundCount > 0 ? ConclaveStrings.format("Long Shot Found %lld", foundCount) : "")
            : ConclaveStrings.format("Long Shot Prompt Count %lld %lld", prompt.number, prompt.total)
        if meta.isEmpty { return prompt.category }
        if prompt.category.isEmpty { return meta }
        return ConclaveStrings.format("Two Facts %@ %@", prompt.category, meta)
    }

    static func lockedCount(_ locked: Int, total: Int) -> String {
        total > 0 ? ConclaveStrings.format("Long Shot Locked Count %lld %lld", locked, total) : ""
    }

    static func miss(_ miss: LongShotMissedAnswer) -> String {
        miss.reason == .taken && !miss.text.isEmpty ? ConclaveStrings.format("Long Shot Taken %@", miss.text)
                                                    : ConclaveStrings.text("Not on the list")
    }

    static func status(_ board: LongShotFuseBoard) -> String {
        switch board.status {
        case .paused: return ConclaveStrings.text("Waiting for players")
        case .yourTurn: return ConclaveStrings.text("Your turn")
        case .theirTurn: return ConclaveStrings.format("Long Shot Turn %@", board.holderName)
        case .nobody: return ConclaveStrings.text("Waiting for players")
        }
    }

    static func popped(_ board: LongShotPopBoard) -> String {
        if board.isYou {
            return board.isEliminated ? ConclaveStrings.text("You are out") : ConclaveStrings.text("You lost a heart")
        }
        return board.isEliminated ? ConclaveStrings.format("Long Shot Out %@", board.name)
                                  : ConclaveStrings.format("Long Shot Lost Heart %@", board.name)
    }

    static func resultTitle(_ board: LongShotResultsBoard) -> String {
        if let winner = board.winner {
            return winner.isYou ? ConclaveStrings.text("You win") : ConclaveStrings.format("Long Shot Wins %@", winner.name)
        }
        return board.isTie ? ConclaveStrings.text("Tie at the top") : ConclaveStrings.text("Everyone surfaced")
    }

    static func rungLabel(_ rung: LongShotRungModel) -> String {
        let base = ConclaveStrings.format("Two Facts %@ %@", tier(rung.tier), meters(rung.points))
        return rung.isLanded ? ConclaveStrings.format("Long Shot Your Answer %@ %@", base, rung.word) : base
    }

    static func seatLabel(_ seat: LongShotSeatModel) -> String {
        let name = name(seat.name, isYou: seat.isYou)
        if seat.isOut { return ConclaveStrings.format("Two Facts %@ %@", name, ConclaveStrings.text("Surfaced")) }
        let hearts = ConclaveStrings.format("Long Shot Hearts %lld", seat.hearts)
        return ConclaveStrings.format("Two Facts %@ %@", name, hearts)
    }

    static func announcement(_ scene: LongShotScene) -> String {
        switch scene.board {
        case .dive(let dive):
            guard let landing = dive.landing else { return "" }
            return ConclaveStrings.format("Long Shot Landed %@ %@", landing.text, ConclaveStrings.format("Two Facts %@ %@", tier(landing.tier),
                                                                                                         meters(landing.points)))
        case .fuse(let fuse):
            return fuse.status == .yourTurn ? ConclaveStrings.text("Your turn") : ""
        case .popped(let pop):
            return ConclaveStrings.format("Two Facts %@ %@", ConclaveStrings.text("Out of air"), popped(pop))
        default:
            return ""
        }
    }
}
#endif
