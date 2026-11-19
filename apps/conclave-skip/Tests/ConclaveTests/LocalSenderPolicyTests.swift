#if !SKIP
import Testing
@testable import Conclave

struct LocalSenderPolicyTests {
    @Test func microphoneBudgetOnlyDropsAsTheConnectionWorsens() {
        let worsening: [ConnectionQuality] = [.good, .fair, .poor, .emergency]
        let budgets = worsening.map { LocalSenderPolicy.microphoneMaxAverageBitrateBps(for: $0) }
        for index in 1..<budgets.count {
            #expect(budgets[index] < budgets[index - 1])
        }
        #expect(LocalSenderPolicy.microphoneMaxAverageBitrateBps(for: .unknown) == budgets[0])
    }

    @Test func senderFollowsExplicitVideoPreferenceForEitherSource() {
        for type in [ProducerType.webcam, .screen] {
            #expect(LocalSenderPolicy.videoDegradationPreference(for: type, setting: "balanced") == .balanced)
            #expect(LocalSenderPolicy.videoDegradationPreference(for: type, setting: "maintain-resolution") == .maintainResolution)
            #expect(LocalSenderPolicy.videoDegradationPreference(for: type, setting: "maintain-framerate") == .maintainFramerate)
        }
    }

    @Test func invalidVideoPreferencePreservesCameraMotionAndScreenText() {
        #expect(LocalSenderPolicy.videoDegradationPreference(for: .webcam, setting: "") == .maintainFramerate)
        #expect(LocalSenderPolicy.videoDegradationPreference(for: .screen, setting: "unsupported") == .maintainResolution)
    }
}
#endif
