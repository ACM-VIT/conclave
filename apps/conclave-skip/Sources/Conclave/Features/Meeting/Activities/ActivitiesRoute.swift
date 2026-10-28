import Foundation

enum ActivitiesRoute: String, Hashable, CaseIterable {
    case root, setup, browser, wheel, watch
}

struct ActivitiesLanding: Equatable {
    let route: ActivitiesRoute
    let id: String

    let focusesVote: Bool

    static let root = ActivitiesLanding(route: ActivitiesRoute.root, id: "", focusesVote: false)
}

enum ActivitiesDestinationPolicy {

    static let appPageIds: [String] = ["wheel", "watch"]

    static func landing(destination: PanelDestination, targetId: String) -> ActivitiesLanding {
        switch destination {
        case .activitiesVote:
            return ActivitiesLanding(route: ActivitiesRoute.root, id: "", focusesVote: true)
        case .activitiesApp:
            let id = targetId.trimmingCharacters(in: .whitespacesAndNewlines)
            if id == "wheel" { return ActivitiesLanding(route: ActivitiesRoute.wheel, id: id, focusesVote: false) }
            if id == "watch" { return ActivitiesLanding(route: ActivitiesRoute.watch, id: id, focusesVote: false) }
            return ActivitiesLanding.root
        default:
            return ActivitiesLanding.root
        }
    }

    static func isRenderable(_ route: ActivitiesRoute) -> Bool {
        switch route {
        case .root, .setup, .browser, .wheel, .watch: return true
        }
    }
}
