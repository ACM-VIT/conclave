import Foundation

// S60 0.6 L6-11 (SET-1): the one Settings page route, a transpiled `String` raw-value enum shared by the iOS
// `PanelShell` path (R40-9: one homogeneous path per stack) and the Android page stack (`PanelPageStack` keys and the
// app-scope back stack, both saved by raw value). Kotlin uses the transpiled `SettingsRoute` directly; no handwritten
// mirror exists. Host Controls content (S50) is pushed through the flat host mirror cases (R6-3), because a
// `[SettingsRoute]` path cannot hold `PeopleRoute` values.

enum SettingsRoute: String, CaseIterable, Hashable {
    case root, output, microphone, cameraQuality, cameraAdvanced, screenShareQuality, screenShareAdvanced, connection
    case voice, voiceRecord, privacy
    case hostControls, hostInviteCode, hostAccessList, hostNotice, hostWebinar, hostAttendeeCode, hostCustomLink
}

/// Pure route rules (unit tested on both platforms).
enum SettingsRoutePolicy {
    /// The pages pushed when the panel opens (R6-5): `settingsVoice` lands on the Voice Messages page; every other
    /// destination opens the root. Read once per presentation.
    static func initialPath(destination: PanelDestination) -> [SettingsRoute] {
        if destination == PanelDestination.settingsVoice { return [SettingsRoute.voice] }
        return []
    }

    /// S30 2 "Audio Settings" (`settingsAudio`): the root opens scrolled to the Audio section, once per presentation.
    static func scrollsToAudio(destination: PanelDestination) -> Bool {
        destination == PanelDestination.settingsAudio
    }

    /// R6-3: a Host Controls push (`PeopleRoute`) as its Settings mirror case.
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

    /// The S50 page a host mirror case renders; nil for every Settings page.
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

    /// Android pushes the S50 page by its `PeopleRoute` raw value through Host Controls' `onPush`; this maps it back
    /// to the Settings key the page stack holds.
    static func hostRouteForPeopleRoute(rawValue: String) -> SettingsRoute? {
        guard let page = PeopleRoute(rawValue: rawValue) else { return nil }
        return hostRoute(page)
    }

    /// The pages this slice draws. Camera, share, effects and connection pages are SET-3's and SET-6's; until they
    /// land their rows stay hidden (D11), so these routes are never pushed. `voiceRecord` needs the personal voice
    /// capability (W10-4 is out of this push, so it stays unreachable).
    static func isAvailable(_ route: SettingsRoute, canUsePersonalVoice: Bool) -> Bool {
        switch route {
        case .root, .output, .microphone, .voice, .privacy:
            return true
        case .voiceRecord:
            return canUsePersonalVoice
        case .cameraQuality, .cameraAdvanced, .screenShareQuality, .screenShareAdvanced, .connection:
            return false
        case .hostControls, .hostInviteCode, .hostAccessList, .hostNotice, .hostWebinar, .hostAttendeeCode, .hostCustomLink:
            return true
        }
    }

    /// Losing host (or becoming an attendee) pops any pushed host page (S50 12): the path keeps only the pages before
    /// the first host page.
    static func pathAfterHostLoss(_ path: [SettingsRoute]) -> [SettingsRoute] {
        var kept: [SettingsRoute] = []
        for route in path {
            if isHostRoute(route) { break }
            kept.append(route)
        }
        return kept
    }
}
