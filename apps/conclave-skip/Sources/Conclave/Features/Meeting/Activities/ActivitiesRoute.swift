import Foundation

/// S60 L6-11: the pages inside `MeetingPanel.activities`. One transpiled `String` raw-value enum, used by the iOS
/// `PanelShell` path (paired with an id in the iOS-only `ActivitiesPage`) and by the Android back stack inside
/// `InCallPage` (paired with an id in the Kotlin `ActivitiesKey`, saved by `rawValue`). Handwritten Kotlin uses this
/// transpiled type and never redeclares it.
enum ActivitiesRoute: String, Hashable, CaseIterable {
    case root, setup, browser, wheel, watch
}

/// Where a panel request lands (S20 SR7, S60 R6-5, RECONCILE R11). Pure, so both platforms and both test hosts map
/// a destination the same way, once, when the panel opens or receives a destination request.
struct ActivitiesLanding: Equatable {
    let route: ActivitiesRoute
    let id: String
    /// The vote section should be scrolled to and announced (the `voteOpened` toast's Vote action).
    let focusesVote: Bool

    static let root = ActivitiesLanding(route: ActivitiesRoute.root, id: "", focusesVote: false)
}

enum ActivitiesDestinationPolicy {
    /// SDK app ids whose host pages land with ACT-8; the whiteboard opens on the stage, never a page.
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

    /// The routes this push can render. Wheel and Watch pages arrive with ACT-8; until then they fall back to the root.
    static func isRenderable(_ route: ActivitiesRoute) -> Bool {
        switch route {
        case .root, .setup, .browser: return true
        case .wheel, .watch: return false
        }
    }
}
