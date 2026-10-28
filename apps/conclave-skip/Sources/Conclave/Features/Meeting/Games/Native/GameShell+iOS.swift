#if os(iOS) && !SKIP
import SwiftUI

// S60 8 (ACT-2) on iOS: everything every game shares inside the S20 activity card. The card (S20 11, STG-9) draws the
// container, the identity and Show Video; this file supplies the header's trailing actions (K12 seat control and the
// host End with its attached confirmation, R09) and the body: lobby, private-view loading, spectator and failure
// notices, results with the scoreboard and rematch, the unsupported-game fallback, and the generic scene that ACT-3
// to ACT-6 replace per game. Each leaf observes only the presenter property it shows (8 k): the header reads `chrome`,
// the scene reads `scene`, notices read `interaction`, the countdown leaf reads `countdown`.

/// The card header's trailing slot for a game.
struct GameShellHeaderActions: View {
    let games: GameStagePresenter
    @State private var endPrompt = false

    var body: some View {
        let chrome = games.chrome
        HStack(spacing: 8) {
            GameKitSeatControl(seat: chrome.seat, onJoin: { games.join() })
            if chrome.canEnd || chrome.endPending {
                Button(role: .destructive) {
                    endPrompt = true
                } label: {
                    if chrome.endPending {
                        ProgressView().tint(HostingTheme.inCallLeave)
                    } else {
                        Text(ConclaveStrings.text("End"))
                    }
                }
                .buttonStyle(.bordered)
                .tint(HostingTheme.inCallLeave)
                .frame(minHeight: 44)
                .disabled(chrome.endPending)
                .accessibilityLabel(ConclaveStrings.text("End Game for Everyone"))
                .accessibilityIdentifier("game.end")
                .modifier(GameShellEndDialog(games: games, name: chrome.name, isPresented: $endPrompt))
            }
        }
    }
}

/// The End confirmation, attached to the control that opens it (R09; copy S60 7 g).
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

/// The card body for a game. The scene scrolls; the host and results bars stay pinned inside the card.
struct GameShellBody: View {
    let games: GameStagePresenter
    let storeURL: String
    let onShowVideo: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                GameShellNotices(games: games)
                GameShellScene(games: games, storeURL: storeURL, onShowVideo: onShowVideo)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            GameShellBottomBar(games: games)
        }
        .accessibilityIdentifier("game.body")
    }
}

/// Reconnecting, move failures and the End failure (K13), announced once each.
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

/// The scene switch. ACT-3 to ACT-6 add their per-game bodies here, keyed by `scene.kind`.
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
            GameLobbyBody(scene: scene, chrome: chrome)
        case GameSceneKind.privateView:
            GameKitNotice(kind: .privateView, message: GameCopy.privateViewBody())
        case GameSceneKind.trivia, GameSceneKind.bluff, GameSceneKind.wouldYouRather, GameSceneKind.mostLikelyTo,
             GameSceneKind.reaction, GameSceneKind.imposter:
            // ACT-3 (S60 9): the prompt game scenes, playing and results (Games/Native/Scenes).
            PromptGameSceneBody(games: games)
        // ACT-4 (S60 10): Wordle, every phase (Games/Native/Boards/WordleBoard+iOS.swift).
        case GameSceneKind.wordle:
            WordleSceneBody(games: games)
        // ACT-5 (S60 11): chess, playing and results (Games/Native/Boards/ChessBoard+iOS.swift).
        case GameSceneKind.chess:
            ChessSceneBody(games: games)
        // ACT-6 (S60 12): Zip, every phase after the lobby (Games/Native/Boards/ZipBoard+iOS.swift).
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

/// Lobby (S60 8 b, f): kicker, "Waiting to Start", the option summary, the players and the start hint.
struct GameLobbyBody: View {
    let scene: GameScene
    let chrome: GameChromeModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            GameKitPrompt(kicker: ConclaveStrings.text("Lobby"), title: ConclaveStrings.text("Waiting to Start"),
                          subtitle: GameShellText.optionSummary(scene.options))
            GameKitPlayerChips(players: scene.players, pending: scene.pendingJoiners)
            Text(GameCopy.lobbyLine(scene.lobby, gameName: chrome.name, isHost: chrome.isHost))
                .font(.subheadline)
                .foregroundStyle(HostingTheme.inCallTextSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The generic playing body: round, prompt text the server sent, the countdown leaf, who acted and the scoreboard.
/// It keeps every game readable until its own scene lands (ACT-3 prompt games, ACT-4 Wordle, ACT-5 Chess, ACT-6 Zip),
/// and shows the spectator notice instead of any self status for a person without a seat (INM G7).
struct GameGenericSceneBody: View {
    let scene: GameScene
    let chrome: GameChromeModel
    let games: GameStagePresenter

    var body: some View {
        let common = scene.projection.common
        VStack(alignment: .leading, spacing: 12) {
            GameKitPrompt(kicker: GameCopy.phaseLabel(chrome), title: GameShellText.promptTitle(scene.projection))
            GameShellCountdownSlot(games: games)
            if common.totalPlayers > 0 {
                Text(GameCopy.progress(common.actedCount, common.totalPlayers))
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
            }
            if chrome.seat != .player {
                if scene.kind == GameSceneKind.imposter {
                    GameKitNotice(kind: .spectator, message: GameCopy.rolesSecret())
                } else {
                    GameKitNotice(kind: .spectator, message: GameCopy.spectatorBody(),
                                  buttonTitle: chrome.seat == .canJoin ? ConclaveStrings.text("Join") : "",
                                  onButton: chrome.seat == .canJoin ? { games.join() } : nil)
                }
            }
            GameKitPlayerChips(players: scene.players, pending: scene.pendingJoiners)
            if !common.scoreboard.isEmpty {
                GameKitScoreboard(rows: games.results.scoreboard)
            }
        }
    }
}

/// Observes only `countdown`, so the per-second leaf never re-evaluates the scene.
struct GameShellCountdownSlot: View {
    let games: GameStagePresenter

    var body: some View {
        if let countdown = games.countdown {
            GameKitCountdown(model: countdown)
        }
    }
}

/// Results (S60 8 f): the winner line, the scoreboard and, for participants, "Waiting for the host".
struct GameResultsBody: View {
    let games: GameStagePresenter

    var body: some View {
        let results = games.results
        VStack(alignment: .leading, spacing: 12) {
            GameKitPrompt(kicker: ConclaveStrings.text("Results"), title: GameCopy.winnerLine(results) ?? "")
            GameKitScoreboard(rows: results.scoreboard)
            if !games.chrome.isHost {
                Text(ConclaveStrings.text("Waiting for the host"))
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
            }
        }
    }
}

/// The pinned bar: Start Game or Join in the lobby; Play Again and End Game… in the results (host only).
struct GameShellBottomBar: View {
    let games: GameStagePresenter
    @State private var endPrompt = false

    var body: some View {
        let chrome = games.chrome
        let scene = games.scene
        let results = games.results
        Group {
            if chrome.phase == .lobby && chrome.isHost && scene.lobby.reason != .reconnecting {
                if scene.lobby.showsJoin {
                    GameKitHostBar(primaryTitle: ConclaveStrings.text("Join"), onPrimary: { games.join() })
                } else if scene.lobby.reason != .joinToStart {
                    GameKitHostBar(primaryTitle: ConclaveStrings.text("Start Game"), primaryEnabled: scene.lobby.canStart,
                                   primaryPending: games.interaction.pendingType == "start",
                                   onPrimary: { _ = games.send(GameMoveIntent.start()) })
                }
            } else if chrome.phase == .results && results.canRematch {
                GameKitHostBar(primaryTitle: results.rematchPending ? ConclaveStrings.text("Starting") : ConclaveStrings.text("Play Again"),
                               primaryPending: results.rematchPending, onPrimary: { games.rematch() },
                               secondaryTitle: ConclaveStrings.text("End Game…"), secondaryRole: .destructive,
                               onSecondary: { endPrompt = true })
                    .modifier(GameShellEndDialog(games: games, name: chrome.name, isPresented: $endPrompt))
            } else if chrome.phase == .playing {
                // ACT-3 (S60 9 c): Skip Question, Next, Skip Writing, Reveal Now, Call the Vote, End Vote (seated host only).
                PromptGameHostBar(games: games)
                // ACT-4 (S60 10 f): Next Round at a Wordle round's results (seated host only).
                WordleHostBar(games: games)
                // ACT-6 (S60 12 f): Next Round at a Zip round's results (seated host only).
                ZipHostBar(games: games)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
}

/// Shell-only text assembly (two facts on one line use the localized "%@ · %@", never concatenation).
enum GameShellText {
    static func optionSummary(_ options: [GameOptionSummaryModel]) -> String {
        var line = ""
        for option in options {
            let part = ConclaveStrings.format("Option Summary %@ %@", option.label, option.value)
            line = line.isEmpty ? part : ConclaveStrings.format("Two Facts %@ %@", line, part)
        }
        return line
    }

    /// The server's prompt text for the generic body (verbatim), or the empty string.
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
