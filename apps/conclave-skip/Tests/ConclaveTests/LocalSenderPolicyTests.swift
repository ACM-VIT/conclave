#if !SKIP
import Testing
@testable import Conclave

struct LocalSenderPolicyTests {
    @Test func microphoneKeepsAboveDefaultPriorityAsItsBitrateBudgetDrops() {
        let worsening: [ConnectionQuality] = [.good, .fair, .poor, .emergency]
        let budgets = worsening.map { LocalSenderPolicy.microphoneProfile(for: $0).maxAverageBitrateBps }
        for index in 1..<budgets.count {
            #expect(budgets[index] < budgets[index - 1])
        }
        #expect(LocalSenderPolicy.microphoneProfile(for: .unknown).maxAverageBitrateBps == budgets[0])
        for quality in worsening + [.unknown] {
            #expect(LocalSenderPolicy.microphoneProfile(for: quality).bitratePriority > 1.0)
        }
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
