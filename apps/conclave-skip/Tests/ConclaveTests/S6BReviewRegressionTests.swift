#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
@Suite(.serialized)
struct S6BReviewRegressionTests {
    private func queue() -> TtsPlaybackQueue {
        let queue = TtsPlaybackQueue()
        VoicePlaybackQueues.register(queue)
        queue.schedulesTimers = false
        queue.preferences = { VoicePreferenceSnapshot.defaults }
        return queue
    }

    private func item(_ id: String) -> TtsQueueItem {
        TtsQueueItem.make(messageId: id, userId: "speaker", displayName: "Speaker", text: "Message " + id)
    }

    @Test func holdCancelsActiveSpeechAndPendingMessagesAndRejectsLateCompletion() {
        let queue = queue()
        var cancellations = 0
        queue.onCancel = { cancellations += 1 }
        let presence = CallPresence()
        presence.apply(CallPresenceInputs.make(callSession: 1, sessionPhase: .inCall))
        queue.enqueue(item("active"), isOwn: false)
        queue.enqueue(item("waiting"), isOwn: false)
        let token = queue.activeToken
        #expect(presence.handle(.hold, source: .callKit, presenceSession: presence.snapshot.presenceSession) == .dispatched)
        #expect(cancellations == 1)
        #expect(queue.isIdle)
        queue.finished(token: token)
        queue.advanceNow()
        #expect(queue.startedMessageIds == ["active"])
    }

    @Test(arguments: [AudioInterruptionEvent.began, .focusLost, .servicesReset])
    func audioOwnerInterruptionCancelsActiveAndPendingPlayback(_ event: AudioInterruptionEvent) {
        let queue = queue()
        var cancellations = 0
        queue.onCancel = { cancellations += 1 }
        let owner = AudioRouteOwner()
        queue.enqueue(item("active"), isOwn: false)
        queue.enqueue(item("waiting"), isOwn: false)
        owner.reportInterruptionEvent(event)
        #expect(cancellations == 1)
        #expect(queue.isIdle)
    }

    @Test func queuedAutomaticMessagesRecheckPreferenceWhileOwnMessagesAndReplayRemainAllowed() {
        let queue = queue()
        var enabled = true
        queue.preferences = {
            VoicePreferenceSnapshot(showsChatPreviews: true, playsVoiceMessages: enabled, voiceKind: .system, standardVoiceId: "")
        }
        queue.enqueue(item("active"), isOwn: false)
        queue.enqueue(item("remote-b"), isOwn: false)
        queue.enqueue(item("remote-c"), isOwn: false)
        queue.enqueue(item("own"), isOwn: true)
        enabled = false
        queue.finished(token: queue.activeToken)
        for _ in 0..<3 { queue.advanceNow() }
        #expect(queue.startedMessageIds == ["active", "own"])
        #expect(queue.skippedByPreferenceCount == 2)
        queue.replay(item("replay"))
        #expect(queue.activeMessageId == "replay")
    }

    @Test func deferredAutomaticStartRechecksPreference() {
        let queue = queue()
        var enabled = true
        queue.preferences = {
            VoicePreferenceSnapshot(showsChatPreviews: true, playsVoiceMessages: enabled, voiceKind: .system, standardVoiceId: "")
        }
        queue.enqueue(item("personal-fetch"), isOwn: false)
        let token = queue.activeToken
        enabled = false
        #expect(!queue.canStartPlayback(token: token))
        #expect(queue.isIdle)
        queue.replay(item("explicit"))
        #expect(queue.canStartPlayback(token: queue.activeToken))
    }

}
#endif
