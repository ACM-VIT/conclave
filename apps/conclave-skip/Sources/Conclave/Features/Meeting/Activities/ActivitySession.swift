import Foundation
import Observation

/// The session-owned activity presenters (S60 0.5, WP9): the Activities launcher (ACT-1) and the game shell (ACT-2),
/// created with the S1 shell and the S20 stage and reset with them. One object threads through the native call root
/// (the activity card on the stage and the Activities panel), so the root signature grows by one parameter only. The
/// view model owns the production instance (HD request B4-T8 R2) and pushes inputs on its own refresh path; the stage
/// fixture owns one per fixture session (R8). The views read the presenters, never `MeetingState`.
@MainActor
@Observable
final class ActivitySession {
    @ObservationIgnored let shell: MeetingShellPresenter
    @ObservationIgnored let stage: StagePresenter
    @ObservationIgnored let activities: ActivitiesPresenter
    @ObservationIgnored let games: GameStagePresenter
    /// ACT-7 (S60 0.5, 13): the SDK app host behind the app card. The view model binds it to its `ActiveAppSession`
    /// (`MeetingViewModel.bindActiveAppSession()`); the stage fixture binds it to a fixture relay (`AppHostFixtures`).
    @ObservationIgnored let appHost: AppHostPresenter
    /// ACT-9 (S60 0.5, 14): the shared browser card. The view model pushes `makeBrowserStageInputs()` and performs its
    /// commands (`MeetingViewModel.bindBrowserStage()`); the stage fixture scripts it (`BrowserStageFixtures`).
    @ObservationIgnored let browser: BrowserStagePresenter

    /// The card's load state for web-backed bodies (S20 11 c). ACT-7 (apps) and ACT-9 (browser) host the web engines
    /// and set these; until then the card shows the opening state for an app or the browser.
    private(set) var appCardPhase: ActivityCardPhase = ActivityCardPhase.opening
    private(set) var browserCardPhase: ActivityCardPhase = ActivityCardPhase.opening
    /// The store listing for "Update App" on an unsupported game (S60 8 f); the core sets it from the same source as
    /// the premeeting update banner. Empty hides the button.
    @ObservationIgnored var storeURL: String = ""

    init(shell: MeetingShellPresenter, stage: StagePresenter) {
        self.shell = shell
        self.stage = stage
        self.activities = ActivitiesPresenter()
        self.games = GameStagePresenter()
        self.appHost = AppHostPresenter()
        self.browser = BrowserStagePresenter()
    }

    /// Wires the stage's activity resolution into the launcher (Now Playing `isOnStage`, HD request B4-T8 R1 adds
    /// `StagePresenter.onActivityResolved`). Called once by the owner after both exist.
    func bindStage() {
        stage.onActivityResolved = { [weak self] onStageKind in
            self?.activities.setOnStageActivityKind(onStageKind)
        }
        // ACT-8 (S60 13 c, R6-5): the Wheel card's Edit Names and Watch Together's Queue open Activities at the app's page.
        appHost.onOpenPage = { [weak self] appId in
            self?.stage.openActivities(destination: PanelDestination.activitiesApp, targetId: appId)
        }
    }

    /// Core only: one game push. The game shell parses it once; the launcher sees only the cheap summary, so a move
    /// never rebuilds the catalog (S60 7 k).
    func applyGame(_ inputs: GameStageInputs) {
        games.apply(inputs)
        activities.applyGameSummary(games.summary())
    }

    /// Core only: the launcher's cold inputs (catalog, vote, apps, browser, role).
    func applyActivities(_ inputs: ActivitiesInputs) {
        activities.apply(inputs)
    }

    func setCardPhase(kind: String, phase: ActivityCardPhase) {
        if kind == ActivityStageKind.app {
            if appCardPhase != phase { appCardPhase = phase }
        } else if kind == ActivityStageKind.browser {
            if browserCardPhase != phase { browserCardPhase = phase }
        }
    }

    func cardPhase(kind: String) -> ActivityCardPhase {
        if kind == ActivityStageKind.app { return appCardPhase }
        if kind == ActivityStageKind.browser { return browserCardPhase }
        return ActivityCardPhase.live
    }

    /// With the S1 reset (S1C 3.3 TEAR): no timer, pending request or draft survives into the next call.
    func reset() {
        activities.reset()
        games.reset()
        appHost.reset()
        browser.reset()
        if appCardPhase != ActivityCardPhase.opening { appCardPhase = ActivityCardPhase.opening }
        if browserCardPhase != ActivityCardPhase.opening { browserCardPhase = ActivityCardPhase.opening }
    }
}
