import Foundation

enum SettingsRoute: String, CaseIterable, Hashable {
    case root, output, microphone, cameraQuality, cameraAdvanced, screenShareQuality, screenShareAdvanced, connection
    case voice, voiceRecord, privacy
    case hostControls, hostInviteCode, hostAccessList, hostNotice, hostWebinar, hostAttendeeCode, hostCustomLink
}

enum SettingsRoutePolicy {

    static func initialPath(destination: PanelDestination) -> [SettingsRoute] {
        if destination == PanelDestination.settingsVoice { return [SettingsRoute.voice] }
        return []
    }

    static func scrollsToAudio(destination: PanelDestination) -> Bool {
        destination == PanelDestination.settingsAudio
    }

    static func hostRoute(_ page: PeopleRoute) -> SettingsRoute {
        switch page {
        case .root, .hostControls: return SettingsRoute.hostControls
        case .inviteCode: return SettingsRoute.hostInviteCode
        case .accessList: return SettingsRoute.hostAccessList
        case .notice: return SettingsRoute.hostNotice
        case .webinar: return SettingsRoute.hostWebinar
        case .attendeeCode: return SettingsRoute.hostAttendeeCode
        case .customLink: return SettingsRoute.hostCustomLink
        }
    }

    static func peopleRoute(_ route: SettingsRoute) -> PeopleRoute? {
        switch route {
        case .hostControls: return PeopleRoute.hostControls
        case .hostInviteCode: return PeopleRoute.inviteCode
        case .hostAccessList: return PeopleRoute.accessList
        case .hostNotice: return PeopleRoute.notice
        case .hostWebinar: return PeopleRoute.webinar
        case .hostAttendeeCode: return PeopleRoute.attendeeCode
        case .hostCustomLink: return PeopleRoute.customLink
        default: return nil
        }
    }

    static func isHostRoute(_ route: SettingsRoute) -> Bool {
        peopleRoute(route) != nil
    }

    static func hostRouteForPeopleRoute(rawValue: String) -> SettingsRoute? {
        guard let page = PeopleRoute(rawValue: rawValue) else { return nil }
        return hostRoute(page)
    }

    static func isAvailable(_ route: SettingsRoute, canUsePersonalVoice: Bool) -> Bool {
        switch route {
        case .root, .output, .microphone, .voice, .privacy:
            return true
        case .voiceRecord:
            return canUsePersonalVoice
        case .cameraQuality, .cameraAdvanced, .screenShareQuality, .screenShareAdvanced, .connection:
            return true
        case .hostControls, .hostInviteCode, .hostAccessList, .hostNotice, .hostWebinar, .hostAttendeeCode, .hostCustomLink:
            return true
        }
    }

    static func advancedRoute(for route: SettingsRoute) -> SettingsRoute? {
        switch route {
        case .cameraQuality: return SettingsRoute.cameraAdvanced
        case .screenShareQuality: return SettingsRoute.screenShareAdvanced
        default: return nil
        }
    }

    static func pathAfterHostLoss(_ path: [SettingsRoute]) -> [SettingsRoute] {
        var kept: [SettingsRoute] = []
        for route in path {
            if isHostRoute(route) { break }
            kept.append(route)
        }
        return kept
    }
}
