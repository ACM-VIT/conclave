#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct S5ShareFoldTests {
    @Test func aShareFoldsIntoTheRunningCallServiceAndOtherwiseUsesTheCaptureService() {
        for running in [false, true] {
            for fixtureOnly in [false, true] {
                let expected = running && !fixtureOnly ? ScreenShareServiceHost.callService : ScreenShareServiceHost.captureService
                #expect(ScreenShareServiceHostPolicy.host(callServiceRunning: running, callServiceFixtureOnly: fixtureOnly) == expected)
            }
        }
    }

    @Test func aRefusedHostFallsBackOnlyOnce() {
        #expect(ScreenShareServiceHostPolicy.fallback(refused: ScreenShareServiceHost.callService) == ScreenShareServiceHost.captureService)
        #expect(ScreenShareServiceHostPolicy.fallback(refused: ScreenShareServiceHost.captureService) == ScreenShareServiceHost.none)
        #expect(ScreenShareServiceHostPolicy.fallback(refused: ScreenShareServiceHost.none) == ScreenShareServiceHost.none)
    }

    @Test func onlyTheCurrentHostOrAnUnownedShareAcceptsAStop() {
        for current in ScreenShareServiceHost.allCases {
            for stopped in ScreenShareServiceHost.allCases {
                #expect(ScreenShareServiceHostPolicy.acceptsStop(stopped: stopped, current: current)
                    == (current == ScreenShareServiceHost.none || current == stopped))
            }
        }
    }
}
#endif
