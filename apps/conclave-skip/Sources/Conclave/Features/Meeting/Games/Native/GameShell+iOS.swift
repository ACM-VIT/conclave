#if os(iOS) && !SKIP
import SwiftUI

struct GameShellHeaderActions: View {
    let games: GameStagePresenter
    @State private var endPrompt = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let chrome = games.chrome
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(spacing: 8))
        let barContent = GameShellBarPolicy.content(chrome: chrome, scene: games.scene, results: games.results)
        layout {
            if GameShellHeaderPolicy.showsSeatControl(chrome: chrome, sceneKind: games.scene.kind, barContent: barContent) {
                GameKitSeatControl(seat: chrome.seat, onJoin: { games.join() })
            }
            if chrome.canEnd || chrome.endPending {
                Button(role: .destructive) {
                    endPrompt = true
                } label: {
                    ActivityHeaderCapsuleLabel(title: ConclaveStrings.text("End"), isPending: chrome.endPending, isDestructive: true)
                }
                .buttonStyle(.plain)
                .disabled(chrome.endPending)
                .accessibilityLabel(ConclaveStrings.text("End Game for Everyone"))
                .accessibilityIdentifier("game.end")
                .modifier(GameShellEndDialog(games: games, name: chrome.name, isPresented: $endPrompt))
            }
        }
    }
}

struct GameShellEndDialog: ViewModifier {
    let games: GameStagePresenter
    let name: String
    @Binding var isPresented: Bool

    func body(content: Content) -> some View {
        content.confirmationDialog(ConclaveStrings.format("End %@ for Everyone?", name), isPresented: $isPresented,
                                   titleVisibility: .visible) {
            Button(ConclaveStrings.text("End Game"), role: .destructive) { games.requestEnd() }
            Button(ConclaveStrings.text("Cancel"), role: .cancel) {}
        } message: {
            Text(ConclaveStrings.text("Scores and progress are lost for everyone."))
        }
    }
}

struct GameShellBody: View {
    let games: GameStagePresenter
    let storeURL: String
    let onShowVideo: () -> Void
    @State private var bounds = GameShellBoundsProbe()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                GameShellNotices(games: games)
                GameShellScene(games: games, storeURL: storeURL, onShowVideo: onShowVideo)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .modifier(GameShellBoundsMeasure(probe: bounds, part: .content))
        }
        .modifier(GameShellBoundsMeasure(probe: bounds, part: .viewport))
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            GameShellBottomBar(games: games, showsEdge: bounds.barShowsEdge)
                .modifier(GameShellBoundsMeasure(probe: bounds, part: .bar))
        }
        .modifier(GameShellBoundsMeasure(probe: bounds, part: .body))
        .accessibilityIdentifier("game.body")
        .overlay(alignment: .topLeading) {
            GameShellBoundsReadout(probe: bounds)
        }
    }
}

enum GameShellBoundsPart {
    case body, viewport, content, bar
}

@MainActor
@Observable
final class GameShellBoundsProbe {
    private(set) var bodyRect = GameShellRect.zero
    private(set) var viewportRect = GameShellRect.zero
    private(set) var contentRect = GameShellRect.zero
    private(set) var barRect = GameShellRect.zero
    private(set) var barShowsEdge = false

    var readout: String {
        GameShellInsetPolicy.readout(body: bodyRect, viewport: viewportRect, content: contentRect, bar: barRect)
    }

    func record(_ part: GameShellBoundsPart, _ frame: CGRect) {
        let rect = GameShellRect(x: Double(frame.minX), y: Double(frame.minY), width: Double(frame.width), height: Double(frame.height))
        switch part {
        case .body: if bodyRect != rect { bodyRect = rect }
        case .viewport: if viewportRect != rect { viewportRect = rect }
        case .content: if contentRect != rect { contentRect = rect }
        case .bar: if barRect != rect { barRect = rect }
        }
        refreshEdge()
    }

    func clearBar() {
        if barRect != GameShellRect.zero { barRect = GameShellRect.zero }
        refreshEdge()
    }

    private func refreshEdge() {
        let showsEdge = GameShellInsetPolicy.barShowsEdge(viewport: viewportRect, content: contentRect, bar: barRect)
        if barShowsEdge != showsEdge { barShowsEdge = showsEdge }
    }
}

struct GameShellBoundsMeasure: ViewModifier {
    let probe: GameShellBoundsProbe
    let part: GameShellBoundsPart

    func body(content: Content) -> some View {
        content.onGeometryChange(for: CGRect.self) { proxy in
            proxy.frame(in: .global)
        } action: { frame in
            probe.record(part, frame)
        }
    }
}

struct GameShellBoundsReadout: View {
    let probe: GameShellBoundsProbe

    var body: some View {
        #if DEBUG
        Color.clear
            .frame(width: 1, height: 1)
            .allowsHitTesting(false)
            .accessibilityElement()
            .accessibilityLabel(Text(verbatim: probe.readout))
            .accessibilityIdentifier("game.bounds")
        #else
        EmptyView()
        #endif
    }
}

struct GameShellNotices: View {
    let games: GameStagePresenter

    var body: some View {
        let interaction = games.interaction
        let chrome = games.chrome
        VStack(alignment: .leading, spacing: 8) {
            if chrome.isReconnecting {
                GameKitNotice(kind: .reconnecting, message: "")
            }
            if let text = GameCopy.failure(interaction.failure, serverText: interaction.failureServerText) {
                GameKitNotice(kind: .failure, message: text, buttonTitle: ConclaveStrings.text("Dismiss"),
                              onButton: { games.dismissFailure() })
            }
            if chrome.endFailed {
                GameKitNotice(kind: .failure, message: GameCopy.endFailed(), buttonTitle: ConclaveStrings.text("Dismiss"),
                              onButton: { games.dismissFailure() })
            }
        }
    }
}

struct GameShellScene: View {
    let games: GameStagePresenter
    let storeURL: String
    let onShowVideo: () -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        let scene = games.scene
        let chrome = games.chrome
        switch scene.kind {
        case GameSceneKind.lobby:
            GameLobbyBody(scene: scene, chrome: chrome,
                          barContent: GameShellBarPolicy.content(chrome: chrome, scene: scene, results: games.results))
        case GameSceneKind.privateView:
            GameKitNotice(kind: .privateView, message: GameCopy.privateViewBody())
        case GameSceneKind.trivia, GameSceneKind.bluff, GameSceneKind.wouldYouRather, GameSceneKind.mostLikelyTo,
             GameSceneKind.reaction, GameSceneKind.imposter:

            PromptGameSceneBody(games: games)

        case GameSceneKind.wordle:
            WordleSceneBody(games: games)

        case GameSceneKind.chess:
            ChessSceneBody(games: games)

        case GameSceneKind.zip:
            ZipSceneBody(games: games)
        case GameSceneKind.unsupported:
            VStack(alignment: .leading, spacing: 10) {
                GameKitNotice(kind: .unsupported, message: "", buttonTitle: storeURL.isEmpty ? "" : ConclaveStrings.text("Update App"),
                              onButton: storeURL.isEmpty ? nil : {
                                  if let url = URL(string: storeURL) { openURL(url) }
                              })
                Button(ConclaveStrings.text("Show Video"), action: onShowVideo)
                    .buttonStyle(.bordered)
                    .tint(HostingTheme.token(DesignTokens.iosInCallText))
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("game.unsupported.showVideo")
            }
        default:
            if chrome.phase == .results {
                GameResultsBody(games: games)
            } else {
                GameGenericSceneBody(scene: scene, chrome: chrome, games: games)
            }
        }
    }
}

struct GameLobbyBody: View {
    let scene: GameScene
    let chrome: GameChromeModel
    let barContent: GameShellBarContent

    var body: some View {
        let caption = GameLobbyPolicy.bodyCaption(GameLobbyPolicy.caption(reason: scene.lobby.reason, isHost: chrome.isHost),
                                                  barContent: barContent)
        VStack(spacing: 20) {
            VStack(spacing: 12) {
                GameKitGlyphTile(gameId: chrome.gameId)
                if !scene.options.isEmpty {
                    GameKitOptionPills(options: scene.options)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 8)
            GameKitPlayerChips(players: scene.players, pending: scene.pendingJoiners)
            if caption != .none {
                GameKitWaitingLine(text: GameCopy.lobbyCaption(caption, minPlayers: scene.lobby.minPlayers),
                                   showsSpinner: GameLobbyPolicy.showsSpinner(caption))
                    .accessibilityIdentifier("game.lobby.caption")
            }
        }
    }
}

struct GameKitOptionPills: View {
    let options: [GameOptionSummaryModel]

    var body: some View {
        ConclaveFlowLayout(spacing: 6) {
            ForEach(options) { option in
                HStack(spacing: 4) {
                    Text(option.value)
                        .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    Text(option.label)
                        .foregroundStyle(HostingTheme.inCallTextSecondary)
                }
                .font(.footnote.weight(.semibold))
                .lineLimit(1)
                .padding(.horizontal, 10)
                .frame(minHeight: 26)
                .background(HostingTheme.token(DesignTokens.iosInCallSurfaceRaised), in: Capsule())
                .accessibilityElement(children: .combine)
            }
        }
        .accessibilityIdentifier("game.lobby.options")
    }
}

struct GameGenericSceneBody: View {
    let scene: GameScene
    let chrome: GameChromeModel
    let games: GameStagePresenter

    var body: some View {
        let common = scene.projection.common
        VStack(alignment: .leading, spacing: 12) {
            GameKitStatusRow(acted: common.actedCount, total: common.totalPlayers, countdown: games.countdown)
            GameKitPrompt(kicker: "", title: GameShellText.promptTitle(scene.projection))
            if chrome.seat != .player {
                GameKitWatching(canJoin: chrome.seat == .canJoin && scene.kind != GameSceneKind.imposter, onJoin: { games.join() })
            }
            GameKitPlayerChips(players: scene.players, pending: scene.pendingJoiners)
            if !common.scoreboard.isEmpty {
                GameKitScoreboard(rows: games.results.scoreboard)
            }
        }
    }
}

struct GameShellCountdownSlot: View {
    let games: GameStagePresenter

    var body: some View {
        if let countdown = games.countdown {
            GameKitCountdown(model: countdown)
        }
    }
}

struct GameResultsBody: View {
    let games: GameStagePresenter

    var body: some View {
        let results = games.results
        VStack(spacing: 16) {
            GameKitPodium(rows: results.scoreboard)
        }
        .padding(.top, 8)
    }
}

struct GameShellBottomBar: View {
    let games: GameStagePresenter
    var showsEdge = false

    var body: some View {
        let content = GameShellBarPolicy.content(chrome: games.chrome, scene: games.scene, results: games.results)
        if content != .none {
            GameShellBarContentView(games: games, content: content)
                .padding(.horizontal, 16)
                .padding(.top, 10)
                .padding(.bottom, 12)
                .frame(maxWidth: .infinity)
                .background(HostingTheme.token(DesignTokens.iosInCallTile))
                .overlay(alignment: .top) {
                    Rectangle()
                        .fill(showsEdge ? HostingTheme.inCallBorder : Color.clear)
                        .frame(height: 1)
                        .accessibilityHidden(true)
                }
                .accessibilityIdentifier("game.bar")
        } else {
            Color.clear.frame(height: 0)
        }
    }
}

struct GameShellBarContentView: View {
    let games: GameStagePresenter
    let content: GameShellBarContent
    @State private var endPrompt = false

    var body: some View {
        let chrome = games.chrome
        let results = games.results
        switch content {
        case .none:
            EmptyView()
        case .join:
            GameKitHostBar(primaryTitle: ConclaveStrings.text("Join"), onPrimary: { games.join() })
        case .start:
            GameKitHostBar(primaryTitle: ConclaveStrings.text("Start Game"), primaryEnabled: games.scene.lobby.canStart,
                           primaryPending: games.interaction.pendingType == "start",
                           onPrimary: { _ = games.send(GameMoveIntent.start()) })
        case .rematch:
            let showsEnd = GameShellBarPolicy.showsResultsEnd(chrome: chrome)
            GameKitHostBar(primaryTitle: results.rematchPending ? ConclaveStrings.text("Starting") : ConclaveStrings.text("Play Again"),
                           primaryPending: results.rematchPending, onPrimary: { games.rematch() },
                           secondaryTitle: showsEnd ? ConclaveStrings.text("End Game…") : "", secondaryRole: .destructive,
                           onSecondary: showsEnd ? { endPrompt = true } : nil)
                .modifier(GameShellEndDialog(games: games, name: chrome.name, isPresented: $endPrompt))
        case .promptHost:
            PromptGameHostBar(games: games)
        case .wordleNextRound:
            WordleHostBar(games: games)
        case .zipNextRound:
            ZipHostBar(games: games)
        case .waitingForHost:
            GameKitWaitingBar(text: chrome.phase == .lobby ? ConclaveStrings.text("Waiting for the Host to Start")
                                                          : ConclaveStrings.text("Waiting for the host"))
        }
    }
}

enum GameShellText {
    static func optionSummary(_ options: [GameOptionSummaryModel]) -> String {
        var line = ""
        for option in options {
            let part = ConclaveStrings.format("Option Summary %@ %@", option.label, option.value)
            line = line.isEmpty ? part : ConclaveStrings.format("Two Facts %@ %@", line, part)
        }
        return line
    }

    static func promptTitle(_ projection: GameProjection) -> String {
        if let trivia = projection.trivia { return trivia.prompt }
        if let bluff = projection.bluff { return bluff.question }
        if let mostLikely = projection.mostLikelyTo { return mostLikely.prompt }
        if let choice = projection.wouldYouRather, !choice.optionA.isEmpty {
            return ConclaveStrings.format("Two Facts %@ %@", choice.optionA, choice.optionB)
        }
        return ""
    }
}
#endif
