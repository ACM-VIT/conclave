import Foundation
@testable import Conclave

@MainActor
func isolatedViewModel(defaults: UserDefaults = IsolatedDefaults.make()) -> MeetingViewModel {
    MeetingViewModel(defaults: defaults, appState: AppState(defaults: defaults),
                     notifications: SystemNotifications(defaults: defaults))
}
