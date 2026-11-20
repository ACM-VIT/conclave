#if !SKIP
import Testing
@testable import Conclave

struct ChatClipPlaybackPolicyTests {
    @Test func visibleClipsAreBoundedAndDeduplicated() {
        #expect(select(["a", "a", "b", "c"]) == ["a", "b"])
        #expect(select(["", "c"]) == ["c"])
    }

    @Test func explicitPlaybackTakesPriorityWithoutExceedingTheBudget() {
        #expect(select(["a", "b", "c"], requested: ["c"]) == ["c", "a"])
        #expect(select(["a", "b", "c"], requested: ["c", "b", "a"]) == ["c", "b"])
        #expect(select(["a"], requested: ["offscreen"]) == ["a"])
    }

    @Test func reducedMotionRequiresAnExplicitVisibleRequest() {
        #expect(select(["a", "b"], reduceMotion: true).isEmpty)
        #expect(select(["a", "b"], requested: ["b", "gone"], reduceMotion: true) == ["b"])
        #expect(!ChatClipPlaybackPolicy.autoplayAllowed(reduceMotion: true, panelOpen: true, appActive: true))
    }

    @Test func lifecycleAlwaysOverridesManualPlayback() {
        #expect(select(["a"], requested: ["a"], panelOpen: false).isEmpty)
        #expect(select(["a"], requested: ["a"], appActive: false).isEmpty)
        #expect(select([], requested: ["a"]).isEmpty)
    }

    @Test func scrollingReassignsSlotsAndReturningToForegroundRespectsMotion() {
        #expect(select(["a", "b", "c"]) == ["a", "b"])
        #expect(select(["b", "c"]) == ["b", "c"])
        #expect(select(["b", "c"], appActive: false).isEmpty)
        #expect(select(["b", "c"], reduceMotion: true).isEmpty)
        #expect(select(["b", "c"]) == ["b", "c"])
    }

    private func select(_ visible: [String], requested: [String] = [], reduceMotion: Bool = false,
                        panelOpen: Bool = true, appActive: Bool = true) -> [String] {
        ChatClipPlaybackPolicy.playingIDs(visibleIDs: visible, requestedIDs: requested,
                                         reduceMotion: reduceMotion, panelOpen: panelOpen, appActive: appActive)
    }
}
#endif
