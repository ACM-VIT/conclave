enum ScreenShareServiceHost: String, CaseIterable, Equatable {
    case none, callService, captureService
}

enum ScreenShareServiceHostPolicy {
    static func host(callServiceRunning: Bool, callServiceFixtureOnly: Bool) -> ScreenShareServiceHost {
        if callServiceRunning && !callServiceFixtureOnly { return ScreenShareServiceHost.callService }
        return ScreenShareServiceHost.captureService
    }

    static func fallback(refused: ScreenShareServiceHost) -> ScreenShareServiceHost {
        refused == ScreenShareServiceHost.callService ? ScreenShareServiceHost.captureService : ScreenShareServiceHost.none
    }

    static func acceptsStop(stopped: ScreenShareServiceHost, current: ScreenShareServiceHost) -> Bool {
        current == ScreenShareServiceHost.none || current == stopped
    }
}
