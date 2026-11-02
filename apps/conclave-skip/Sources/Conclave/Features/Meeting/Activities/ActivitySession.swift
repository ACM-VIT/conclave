import Foundation
import Observation

@MainActor
@Observable
final class ActivitySession {
    @ObservationIgnored let shell: MeetingShellPresenter
    @ObservationIgnored let stage: StagePresenter
    @ObservationIgnored let activities: ActivitiesPresenter
    @ObservationIgnored let games: GameStagePresenter

    @ObservationIgnored let appHost: AppHostPresenter

    @ObservationIgnored let browser: BrowserStagePresenter

    private(set) var appCardPhase: ActivityCardPhase = ActivityCardPhase.opening
    private(set) var browserCardPhase: ActivityCardPhase = ActivityCardPhase.opening

    @ObservationIgnored var storeURL: String = ""

    init(shell: MeetingShellPresenter, stage: StagePresenter) {
        self.shell = shell
        self.stage = stage
        self.activities = ActivitiesPresenter()
        self.games = GameStagePresenter()
        self.appHost = AppHostPresenter()
        self.browser = BrowserStagePresenter()
    }

    func bindStage() {
        stage.onActivityResolved = { [weak self] onStageKind in
            self?.activities.setOnStageActivityKind(onStageKind)
        }

        appHost.onOpenPage = { [weak self] appId in
            self?.stage.openActivities(destination: PanelDestination.activitiesApp, targetId: appId)
        }
    }

    func applyGame(_ inputs: GameStageInputs) {
        games.apply(inputs)
        activities.applyGameSummary(games.summary())
    }

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

    func reset() {
        activities.reset()
        games.reset()
        appHost.reset()
        browser.reset()
        if appCardPhase != ActivityCardPhase.opening { appCardPhase = ActivityCardPhase.opening }
        if browserCardPhase != ActivityCardPhase.opening { browserCardPhase = ActivityCardPhase.opening }
    }
}
