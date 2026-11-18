#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct S1MoreLargeTextTests {
    @Test func iosCaptionsRowStacksAtAccessibilitySizes() throws {
        let captions = try #require(ControlsFixtureSession(state: .guest).controls.more.item(MoreItemID.captions))
        #expect(MoreMenuPolicy.hasSubtitle(captions), "the captions row always reserves its subtitle line")
    }
}
#endif
