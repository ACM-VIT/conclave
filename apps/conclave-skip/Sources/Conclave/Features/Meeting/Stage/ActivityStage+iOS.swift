#if os(iOS) && !SKIP
import SwiftUI

// S20 11 and SL12 (STG-9) on iOS: the activity takeover container. The `activity` slot of the canvas holds one flat
// card (`iosInCallSurface`, radius 16, 1 pt `inCallBorder`) with a header owned here (identity glyph, name as a
// heading, status line, the Show Video toggle, then the trailing host or seat actions spec 60 places) and a body slot
// filled by the activity: the game shell (ACT-2) or the web-backed app and browser bodies (ACT-7, ACT-9) with their
// opening and failed states. People stay in the strip (you always included, last before "+N"); the card never floats
// a self view. The meeting column ignores the keyboard; only the card body pads by the real keyboard overlap, so the
// stage never compresses (AGENTS.md game stage layout rules). The container reads only `layout.activityKind`; the body
// observes its own presenter, so game pushes never invalidate the stage (S20 11 k).

/// The session's activity presenters for the card and the Activities panel, provided once by the call root (HD request
/// B4-T8 R5). Nil outside a native call root (the card then shows its frame with an empty body).
private struct ActivitySessionKey: EnvironmentKey {
    static let defaultValue: ActivitySession? = nil
}

extension EnvironmentValues {
    var activitySession: ActivitySession? {
        get { self[ActivitySessionKey.self] }
        set { self[ActivitySessionKey.self] = newValue }
    }
}

/// The `activity` slot content (SlotView's activity branch, HD request B4-T8 R6).
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

/// Copy and glyphs the stage chrome and announcements share (HD request B4-T8 R7: the Now Playing chip and the stage
/// announcer call these, so the chip names an app by its localized name, not its id).
enum ActivityStageCopy {
    static func kind(_ raw: String) -> ActivityKind {
        ActivityKind(rawValue: raw) ?? ActivityKind.game
    }

    /// The chip and announcement name: the server game name, the app's localized name, or "Shared Browser".
    static func displayName(kind raw: String, name: String) -> String {
        switch kind(raw) {
        case .game: return name.isEmpty ? ConclaveStrings.text("Game") : name
        case .app: return ActivitiesCopy.appName(name)
        case .browser: return ConclaveStrings.text("Shared Browser")
        }
    }

    /// `activityStarted` and `activityEnded` (S20 11 g); nil for any other announcement kind. `name` is the encoded
    /// `ActivityStagePolicy.announcementName(kind:names:)`.
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

/// The card header: identity, name (heading), status line, Show Video, then the trailing actions. Its controls come
/// before the body in reading order.
struct ActivityStageHeader: View {
    let kind: String
    let stage: StagePresenter
    let session: ActivitySession?

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            ActivityStageIdentity(kind: kind, session: session)
            Spacer(minLength: 4)
            ActivityShowVideoButton(stage: stage)
            ActivityStageTrailing(kind: kind, session: session)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

/// Glyph, name and status. A game reads the shell's `chrome` (per phase, never per move); an app or the browser reads
/// the launcher's Now Playing row.
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
        if let item = session.activities.snapshot.nowPlayingItem(kind: kind) {
            // ACT-7 (HD request B7-T1 R2): an app's status comes from its host ("%lld editing", "Editing locked").
            let hostStatus = kind == .app ? AppHostHeader.status(session.appHost) : ""
            return Parts(name: ActivitiesCopy.nowPlayingTitle(item),
                         status: hostStatus.isEmpty ? ActivitiesCopy.nowPlayingStatus(item) : hostStatus, appId: item.appId)
        }
        return Parts(name: ActivityStageCopy.displayName(kind: raw, name: ""), status: "", appId: "")
    }
}

/// Show Video (S20 11 c, i): a local, reversible toggle with its state as the value. While video shows, the card leaves
/// the stage and the Now Playing chip brings it back, so the visible button always reads "Showing Activity".
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

/// The trailing slot: the game's seat control and host End (ACT-2), or the host Close for an app or the browser with
/// its confirmation (R09). Participants get no close.
struct ActivityStageTrailing: View {
    let kind: String
    let session: ActivitySession?

    var body: some View {
        if let session = session {
            if ActivityStageCopy.kind(kind) == .game {
                GameShellHeaderActions(games: session.games)
            } else if ActivityStageCopy.kind(kind) == .app {
                // ACT-7 (HD request B7-T1 R2): Lock Editing and Close in the host menu (S60 13 c).
                NativeAppHostMenu(host: session.appHost)
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

/// The body slot: the game shell, or the web-backed body with its opening and failed states (S60R 25).
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
                // ACT-7 (HD request B7-T1 R2): the one retained web view per app session, its states and the tools.
                NativeAppHostBody(host: session.appHost, onShowVideo: { stage.setShowsVideoOverActivity(true) })
            } else {
                ActivityWebBody(kind: kind, stage: stage, session: session)
            }
        } else {
            Color.clear
        }
    }
}

/// Apps and the shared browser before their hosts land (ACT-7, ACT-9): "Opening %@" with a system spinner, or
/// "Couldn't Open %@" with Retry and Show Video. A live body is the host's (one retained web engine per active app).
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
