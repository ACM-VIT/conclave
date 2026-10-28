#if !SKIP
import Testing
@testable import Conclave

/// Owner chat polish: opening destination precedence, scroll proximity and the grouping/identity contract that the
/// native alignment changes must preserve. Native pixels and iOS scroll interaction still require the viewer pass.
@MainActor
struct OwnerChatPolishTests {
    @Test func openingHasOneDestination() {
        #expect(ChatTimelinePolicy.initialTarget(focusId: "quoted", firstUnreadId: "new", newestId: "last") == "quoted")
        #expect(ChatTimelinePolicy.initialTarget(focusId: "", firstUnreadId: "new", newestId: "last") == "unread")
        #expect(ChatTimelinePolicy.initialTarget(focusId: "", firstUnreadId: "", newestId: "last") == "last")
        #expect(ChatTimelinePolicy.initialTarget(focusId: "", firstUnreadId: "", newestId: "") == "")
    }

    @Test func shortHistoryIsAtTheEndWithoutAnInitialJumpPill() {
        #expect(ChatTimelinePolicy.isAtBottom(offsetY: 0, viewportHeight: 600, contentHeight: 180, bottomInset: 0))
        #expect(ChatTimelinePolicy.isAtBottom(offsetY: -44, viewportHeight: 600, contentHeight: 180, bottomInset: 34))
        #expect(ChatTimelinePolicy.isAtBottom(offsetY: 434, viewportHeight: 600, contentHeight: 1000, bottomInset: 34))
        #expect(ChatTimelinePolicy.isAtBottom(offsetY: 410, viewportHeight: 600, contentHeight: 1000, bottomInset: 34))
        #expect(!ChatTimelinePolicy.isAtBottom(offsetY: 409, viewportHeight: 600, contentHeight: 1000, bottomInset: 34))
        #expect(!ChatTimelinePolicy.isAtBottom(offsetY: 100, viewportHeight: 600, contentHeight: 1000, bottomInset: 0))
    }

    @Test func chronologicalGroupsAndOptimisticIdentitySurviveAcknowledgement() {
        let first = ChatPoliciesTests.peer("first", "First", at: 0)
        let second = ChatPoliciesTests.peer("second", "Second", at: 60_000)
        let pending = ChatPoliciesTests.own("draft", clientId: "draft", "Mine", at: 65_000, delivery: .sending)
        let chat = ChatPoliciesTests.presenter(ChatPoliciesTests.inputs([first, second, pending]))
        let entry = chat.rows.entry(for: "draft")
        #expect(chat.timeline.rowIds == ["first", "second", "draft"])
        #expect(chat.rows.entry(for: "first").row.isGroupStart)
        #expect(!chat.rows.entry(for: "second").row.isGroupStart)
        #expect(chat.rows.entry(for: "second").row.isGroupEnd)
        #expect(chat.rows.entry(for: "draft").row.isOwn)
        let delivered = ChatPoliciesTests.own("server-id", clientId: "draft", "Mine", at: 65_000)
        chat.apply(ChatPoliciesTests.inputs([first, second, delivered]), change: .messages)
        #expect(chat.timeline.rowIds == ["first", "second", "draft"])
        #expect(chat.rows.entry(for: "draft") === entry)
        #expect(entry.row.serverId == "server-id")
    }

    @Test func recoveredReplyFailureKeepsTheCorrectReason() {
        #expect(ChatFailurePolicy.failure(serverMessage: "reply target is no longer available.") == .replyUnavailable)
        #expect(ChatFailurePolicy.failure(serverMessage: "target is no longer available.") == .privateTargetLeft)
        #expect(ChatFailurePolicy.failure(serverMessage: "private replies must stay in their private thread") == .replyPrivateThread)
    }
}
#endif
