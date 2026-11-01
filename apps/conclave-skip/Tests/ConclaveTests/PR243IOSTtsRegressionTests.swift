#if os(iOS) && !SKIP
import Testing
@testable import Conclave

@MainActor
struct PR243IOSTtsRegressionTests {
    @Test func delayedPlaybackRechecksInterruptionAndPreservesNewerToken() {
        let queue = TtsPlaybackQueue()
        let speaker = TtsSpeaker(queue: queue)
        queue.schedulesTimers = false
        queue.onStart = { _, _ in }
        queue.preferences = { VoicePreferenceSnapshot.defaults }
        var blocked = false
        queue.isOutputBlocked = { blocked }
        queue.enqueue(TtsQueueItem.make(messageId: "one", userId: "own", displayName: "Own", text: "Silent", voiceToken: ""), isOwn: true)
        let first = queue.activeToken
        #expect(first != 0 && speaker.canStartPlayback(token: first))
        blocked = true
        #expect(!speaker.canStartPlayback(token: first))
        #expect(queue.activeToken == 0)
        blocked = false
        queue.stop()
        queue.enqueue(TtsQueueItem.make(messageId: "two", userId: "own", displayName: "Own", text: "Silent", voiceToken: ""), isOwn: true)
        let second = queue.activeToken
        #expect(second != 0 && second != first)
        #expect(!speaker.canStartPlayback(token: first))
        #expect(queue.activeToken == second && speaker.canStartPlayback(token: second))
        speaker.reset()
    }
}
#endif
