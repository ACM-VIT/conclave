#if os(iOS) && !SKIP
import SwiftUI

private struct ActivitySessionKey: EnvironmentKey {
    static let defaultValue: ActivitySession? = nil
}

extension EnvironmentValues {
    var activitySession: ActivitySession? {
        get { self[ActivitySessionKey.self] }
        set { self[ActivitySessionKey.self] = newValue }
    }
}

struct ActivityStageContainer: View {
    let stage: StagePresenter
    @Environment(\.activitySession) private var session

    var body: some View {
        ActivityStageCard(kind: stage.layout.activityKind, stage: stage, session: session)
    }
}

struct ActivityStageCard: View {
    let kind: String
    let stage: StagePresenter
    let session: ActivitySession?
    @StateObject private var keyboard = KeyboardFrameObserver()

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: ActivityStageMetrics.cornerRadius, style: .continuous)
        Group {
            if kind == ActivityKind.game.rawValue, let session,
               session.games.scene.kind == GameSceneKind.chess, session.games.scene.chess != nil {
                ChessSceneBody(games: session.games, cardHeader: { compact in
                    AnyView(ActivityStageHeader(kind: kind, stage: stage, session: session, stacked: compact))
                })
                .modifier(KeyboardOverlapAvoidance(keyboardTopY: keyboard.keyboardTopY))
            } else {
                VStack(spacing: 0) {
                    ActivityStageHeader(kind: kind, stage: stage, session: session)
                    Rectangle()
                        .fill(HostingTheme.inCallBorder)
                        .frame(height: 1)
                        .accessibilityHidden(true)
                    ActivityStageBody(kind: kind, stage: stage, session: session)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                        .modifier(KeyboardOverlapAvoidance(keyboardTopY: keyboard.keyboardTopY))
                }
            }
        }
        .background(HostingTheme.token(DesignTokens.iosInCallSurface), in: shape)
        .overlay { shape.strokeBorder(HostingTheme.inCallBorder, lineWidth: 1) }
        .clipShape(shape)
        .environment(\.colorScheme, .dark)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("stage.activity." + kind)
    }
}

enum ActivityStageMetrics {
    static let cornerRadius: CGFloat = 16
}

enum ActivityStageCopy {
    static func kind(_ raw: String) -> ActivityKind {
        ActivityKind(rawValue: raw) ?? ActivityKind.game
    }

    static func displayName(kind raw: String, name: String) -> String {
        switch kind(raw) {
        case .game: return name.isEmpty ? ConclaveStrings.text("Game") : name
        case .app: return ActivitiesCopy.appName(name)
        case .browser: return ConclaveStrings.text("Shared Browser")
        }
    }

    static func announcement(kind: String, name: String) -> String? {
        let display = displayName(kind: ActivityStagePolicy.announcedKind(name), name: ActivityStagePolicy.announcedName(name))
        if kind == ActivityStagePolicy.startedAnnouncement { return ActivitiesCopy.started(display) }
        if kind == ActivityStagePolicy.endedAnnouncement { return ActivitiesCopy.ended(display) }
        return nil
    }

    static func symbol(kind raw: String, appId: String) -> String {
        switch kind(raw) {
        case .game: return ConclaveSymbols.gamecontrollerFill
        case .app: return appId == "whiteboard" ? ConclaveSymbols.pencilAndScribble : ConclaveSymbols.squareGrid2x2
        case .browser: return ConclaveSymbols.globe
        }
    }
}

struct ActivityStageHeader: View {
    let kind: String
    let stage: StagePresenter
    let session: ActivitySession?
    var stacked = false

    var body: some View {
        Group {
            if stacked {
                VStack(alignment: .leading, spacing: 8) {
                    ActivityStageIdentity(kind: kind, session: session)
                    HStack(spacing: 10) {
                        ActivityShowVideoButton(stage: stage)
                        ActivityStageTrailing(kind: kind, session: session)
                    }
                }
            } else {
                HStack(alignment: .center, spacing: 10) {
                    ActivityStageIdentity(kind: kind, session: session)
                    Spacer(minLength: 4)
                    ActivityShowVideoButton(stage: stage)
                    ActivityStageTrailing(kind: kind, session: session)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

struct ActivityStageIdentity: View {
    let kind: String
    let session: ActivitySession?

    var body: some View {
        let parts = ActivityStageIdentity.parts(kind: kind, session: session)
        HStack(spacing: 10) {
            Image(systemName: ActivityStageCopy.symbol(kind: kind, appId: parts.appId))
                .font(.headline)
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(parts.name)
                    .font(.headline)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
                if !parts.status.isEmpty {
                    Text(parts.status)
                        .font(.footnote)
                        .foregroundStyle(HostingTheme.inCallTextSecondary)
                        .lineLimit(1)
                }
            }
        }
    }

    struct Parts {
        let name: String
        let status: String
        let appId: String
    }

    static func parts(kind raw: String, session: ActivitySession?) -> Parts {
        guard let session = session else {
            return Parts(name: ActivityStageCopy.displayName(kind: raw, name: ""), status: "", appId: "")
        }
        let kind = ActivityStageCopy.kind(raw)
        if kind == .game {
            let chrome = session.games.chrome
            return Parts(name: ActivityStageCopy.displayName(kind: raw, name: chrome.name), status: GameCopy.headerStatus(chrome), appId: "")
        }
        if kind == .browser && session.browser.model.isActive {

            return Parts(name: BrowserCopy.title, status: BrowserCopy.headerStatus(session.browser.model), appId: "")
        }
        if let item = session.activities.snapshot.nowPlayingItem(kind: kind) {

            let hostStatus = kind == .app ? AppHostHeader.status(session.appHost) : ""
            return Parts(name: ActivitiesCopy.nowPlayingTitle(item),
                         status: hostStatus.isEmpty ? ActivitiesCopy.nowPlayingStatus(item) : hostStatus, appId: item.appId)
        }
        return Parts(name: ActivityStageCopy.displayName(kind: raw, name: ""), status: "", appId: "")
    }
}

struct ActivityShowVideoButton: View {
    let stage: StagePresenter

    var body: some View {
        Button {
            stage.setShowsVideoOverActivity(true)
        } label: {
            Image(systemName: ConclaveSymbols.videoFill)
                .font(.body.weight(.semibold))
                .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(ConclaveStrings.text("Show Video"))
        .accessibilityValue(ConclaveStrings.text("Showing Activity"))
        .accessibilityAddTraits(.isToggle)
        .accessibilityIdentifier("stage.activity.showVideo")
    }
}

struct ActivityStageTrailing: View {
    let kind: String
    let session: ActivitySession?

    var body: some View {
        if let session = session {
            if ActivityStageCopy.kind(kind) == .game {
                GameShellHeaderActions(games: session.games)
            } else if ActivityStageCopy.kind(kind) == .app {

                NativeAppHostMenu(host: session.appHost)
            } else if session.browser.model.isActive {

                BrowserStageMenu(browser: session.browser)
            } else {
                ActivityCloseButton(kind: ActivityStageCopy.kind(kind), activities: session.activities)
            }
        }
    }
}

struct ActivityCloseButton: View {
    let kind: ActivityKind
    let activities: ActivitiesPresenter
    @State private var prompt = false

    var body: some View {
        if let item = activities.snapshot.nowPlayingItem(kind: kind), item.canEnd || item.endPending {
            Button(role: .destructive) {
                prompt = true
            } label: {
                if item.endPending {
                    ProgressView().tint(HostingTheme.inCallLeave)
                } else {
                    Text(ConclaveStrings.text("Close"))
                }
            }
            .buttonStyle(.bordered)
            .tint(HostingTheme.inCallLeave)
            .frame(minHeight: 44)
            .disabled(item.endPending)
            .accessibilityIdentifier("stage.activity.close")
            .confirmationDialog(ActivitiesCopy.endDialogTitle(item), isPresented: $prompt, titleVisibility: .visible) {
                Button(ActivitiesCopy.endConfirm(item), role: .destructive) { activities.requestEnd(item.id) }
                Button(ConclaveStrings.text("Cancel"), role: .cancel) {}
            } message: {
                Text(ActivitiesCopy.endDialogMessage(item))
            }
        }
    }
}

struct ActivityStageBody: View {
    let kind: String
    let stage: StagePresenter
    let session: ActivitySession?

    var body: some View {
        if let session = session {
            if ActivityStageCopy.kind(kind) == .game {
                GameShellBody(games: session.games, storeURL: session.storeURL,
                              onShowVideo: { stage.setShowsVideoOverActivity(true) })
            } else if ActivityStageCopy.kind(kind) == .app {

                NativeAppHostBody(host: session.appHost, onShowVideo: { stage.setShowsVideoOverActivity(true) })
            } else if session.browser.model.isActive {

                BrowserStageBody(browser: session.browser, stage: stage, onShowVideo: { stage.setShowsVideoOverActivity(true) })
            } else {
                ActivityWebBody(kind: kind, stage: stage, session: session)
            }
        } else {
            Color.clear
        }
    }
}

struct ActivityWebBody: View {
    let kind: String
    let stage: StagePresenter
    let session: ActivitySession

    var body: some View {
        let phase = session.cardPhase(kind: kind)
        let parts = ActivityStageIdentity.parts(kind: kind, session: session)
        VStack(spacing: 12) {
            switch phase {
            case .opening:
                ProgressView()
                    .tint(HostingTheme.token(DesignTokens.iosInCallText))
                Text(ActivitiesCopy.opening(parts.name))
                    .font(.subheadline)
                    .foregroundStyle(HostingTheme.inCallTextSecondary)
            case .failed:
                Text(ActivitiesCopy.couldNotOpen(parts.name))
                    .font(.headline)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
                    .multilineTextAlignment(.center)
                HStack(spacing: 8) {
                    Button(ConclaveStrings.text("Retry")) {
                        session.setCardPhase(kind: kind, phase: ActivityCardPhase.opening)
                        session.activities.refresh()
                    }
                    .buttonStyle(.bordered)
                    .tint(HostingTheme.token(DesignTokens.iosInCallText))
                    .accessibilityIdentifier("stage.activity.retry")
                    Button(ConclaveStrings.text("Show Video")) { stage.setShowsVideoOverActivity(true) }
                        .buttonStyle(.bordered)
                        .tint(HostingTheme.token(DesignTokens.iosInCallText))
                        .accessibilityIdentifier("stage.activity.failedShowVideo")
                }
            case .live:
                Color.clear
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(16)
        .accessibilityElement(children: .contain)
    }
}
#endif
