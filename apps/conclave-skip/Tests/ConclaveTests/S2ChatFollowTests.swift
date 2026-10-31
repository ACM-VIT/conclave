#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct S2ChatFollowTests {
    static let iosTimeline = "Sources/Conclave/Features/Meeting/Chat/ChatTimeline+iOS.swift"
    static let androidTimeline = "Sources/Conclave/Skip/ui/chat/ChatTimeline.kt"

    private struct Reader {
        var isAtBottom: Bool
        var endVisible: Bool
        var endHiddenAtNewestId = ""
        var newestId = "m0"
        var arrivals = 0
        var unseen = 0
        var scrolls = 0

        var showsPill: Bool { ChatTimelinePolicy.showsJumpToLatest(isAtBottom: isAtBottom, unseenCount: unseen) }

        mutating func arrives(isOwn: Bool = false, isRemoteMessage: Bool = true, insertHidesTheEndFirst: Bool = false) {
            arrivals += 1
            newestId = "m" + String(arrivals)
            if insertHidesTheEndFirst { endScrolledAway() }
            let end = ChatTimelinePolicy.endVisibleAtInsert(endVisible: endVisible, endHiddenAtNewestId: endHiddenAtNewestId,
                                                            newestId: newestId)
            let follows = ChatTimelinePolicy.followsNewest(isAtBottom: isAtBottom, endVisible: end, newestIsOwn: isOwn)
            unseen = ChatTimelinePolicy.unseenAfterNewest(unseen: unseen, follows: follows, newestIsRemoteMessage: isRemoteMessage)
            if follows {
                scrolls += 1
                endCameIntoView()
            }
        }

        mutating func endScrolledAway() {
            endVisible = false
            endHiddenAtNewestId = newestId
        }

        mutating func endCameIntoView() {
            endVisible = true
            if unseen != 0 { unseen = 0 }
        }

        mutating func geometry(atBottom: Bool) {
            isAtBottom = atBottom
            if ChatTimelinePolicy.clearsUnseen(isAtBottom: atBottom, endVisible: endVisible) { unseen = 0 }
        }

        mutating func tapPill() {
            unseen = 0
            if ChatTimelinePolicy.jumpScrolls(isAtBottom: isAtBottom) {
                scrolls += 1
                endCameIntoView()
            }
        }
    }

    private func source(_ path: String) throws -> String {
        try chatSource(path)
    }

    private func section(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try #require(text.range(of: start), "missing \(start)")
        let upper = try #require(text.range(of: end, range: lower.upperBound..<text.endIndex), "missing \(end) after \(start)")
        return String(text[lower.upperBound..<upper.lowerBound])
    }

    @Test func theFollowRuleFollowsAtTheBottomWhenTheEndIsVisibleAndForYourOwnSend() {
        #expect(ChatTimelinePolicy.followsNewest(isAtBottom: true, endVisible: false, newestIsOwn: false))
        #expect(ChatTimelinePolicy.followsNewest(isAtBottom: false, endVisible: true, newestIsOwn: false))
        #expect(ChatTimelinePolicy.followsNewest(isAtBottom: false, endVisible: false, newestIsOwn: true))
        #expect(!ChatTimelinePolicy.followsNewest(isAtBottom: false, endVisible: false, newestIsOwn: false))
    }

    @Test func theEndCountsAsVisibleAtTheInsertOnlyIfTheInsertItselfHidIt() {
        #expect(ChatTimelinePolicy.endVisibleAtInsert(endVisible: true, endHiddenAtNewestId: "", newestId: "m1"))
        #expect(ChatTimelinePolicy.endVisibleAtInsert(endVisible: true, endHiddenAtNewestId: "m0", newestId: "m1"))
        #expect(ChatTimelinePolicy.endVisibleAtInsert(endVisible: false, endHiddenAtNewestId: "m1", newestId: "m1"))
        #expect(!ChatTimelinePolicy.endVisibleAtInsert(endVisible: false, endHiddenAtNewestId: "m0", newestId: "m1"))
        #expect(!ChatTimelinePolicy.endVisibleAtInsert(endVisible: false, endHiddenAtNewestId: "", newestId: "m1"))
        #expect(!ChatTimelinePolicy.endVisibleAtInsert(endVisible: false, endHiddenAtNewestId: "", newestId: ""))
    }

    @Test func unseenCountsOnlyRemoteMessagesThatAreNotFollowed() {
        #expect(ChatTimelinePolicy.unseenAfterNewest(unseen: 0, follows: false, newestIsRemoteMessage: true) == 1)
        #expect(ChatTimelinePolicy.unseenAfterNewest(unseen: 3, follows: false, newestIsRemoteMessage: true) == 4)
        #expect(ChatTimelinePolicy.unseenAfterNewest(unseen: 3, follows: false, newestIsRemoteMessage: false) == 3)
        #expect(ChatTimelinePolicy.unseenAfterNewest(unseen: 3, follows: true, newestIsRemoteMessage: true) == 0)
        #expect(ChatTimelinePolicy.unseenAfterNewest(unseen: 3, follows: true, newestIsRemoteMessage: false) == 0)
        #expect(ChatTimelinePolicy.unseenAfterNewest(unseen: -2, follows: false, newestIsRemoteMessage: true) == 1)
    }

    @Test func thePillClearsAtTheEndAndATapAtTheEndNeverScrolls() {
        #expect(ChatTimelinePolicy.clearsUnseen(isAtBottom: true, endVisible: false))
        #expect(ChatTimelinePolicy.clearsUnseen(isAtBottom: false, endVisible: true))
        #expect(!ChatTimelinePolicy.clearsUnseen(isAtBottom: false, endVisible: false))
        #expect(ChatTimelinePolicy.jumpScrolls(isAtBottom: false))
        #expect(!ChatTimelinePolicy.jumpScrolls(isAtBottom: true))
    }

    @Test func aRemoteMessageAtTheBottomIsFollowedWithNoPillEvenIfTheInsertReadsAsAwayFromTheBottom() {
        var reader = Reader(isAtBottom: true, endVisible: true)
        reader.arrives()
        #expect(reader.unseen == 0 && reader.scrolls == 1 && !reader.showsPill)

        var transient = Reader(isAtBottom: false, endVisible: true)
        transient.arrives()
        #expect(transient.unseen == 0 && transient.scrolls == 1 && !transient.showsPill)

        var pushed = Reader(isAtBottom: false, endVisible: true)
        pushed.arrives(insertHidesTheEndFirst: true)
        #expect(pushed.unseen == 0 && pushed.scrolls == 1 && !pushed.showsPill)

        var burst = Reader(isAtBottom: true, endVisible: true)
        for _ in 0..<5 {
            burst.geometry(atBottom: false)
            burst.arrives(insertHidesTheEndFirst: true)
        }
        #expect(burst.unseen == 0 && burst.scrolls == 5)
    }

    @Test func aReaderAtTheStartOfATallLastRowGetsThePillAndTheListStaysPut() {
        var reader = Reader(isAtBottom: true, endVisible: true)
        reader.arrives()
        #expect(reader.scrolls == 1)
        reader.geometry(atBottom: false)
        reader.endScrolledAway()
        reader.arrives()
        #expect(reader.unseen == 1 && reader.scrolls == 1 && reader.showsPill)
        reader.arrives()
        #expect(reader.unseen == 2 && reader.scrolls == 1 && reader.showsPill)
        reader.endCameIntoView()
        #expect(reader.unseen == 0 && !reader.showsPill)
    }

    @Test func scrolledUpThePillCountsAndClearsAtTheEndBySwipeFollowOrTap() {
        var swipe = Reader(isAtBottom: false, endVisible: false)
        swipe.arrives()
        swipe.arrives(isRemoteMessage: false)
        swipe.arrives()
        #expect(swipe.unseen == 2 && swipe.showsPill && swipe.scrolls == 0)
        swipe.endCameIntoView()
        #expect(!swipe.showsPill)
        swipe.endScrolledAway()
        swipe.arrives()
        #expect(swipe.showsPill)
        swipe.geometry(atBottom: true)
        #expect(swipe.unseen == 0 && !swipe.showsPill)

        var follow = Reader(isAtBottom: false, endVisible: false)
        follow.arrives()
        #expect(follow.showsPill)
        follow.arrives(isOwn: true, isRemoteMessage: false)
        #expect(follow.unseen == 0 && !follow.showsPill && follow.scrolls == 1)

        var tap = Reader(isAtBottom: false, endVisible: false)
        tap.arrives()
        tap.tapPill()
        #expect(tap.unseen == 0 && tap.scrolls == 1 && !tap.showsPill)

        var ended = Reader(isAtBottom: false, endVisible: false)
        ended.arrives()
        ended.isAtBottom = true
        ended.tapPill()
        #expect(ended.unseen == 0 && ended.scrolls == 0)
    }

    @Test func theExistingPillAndSlackRulesStay() {
        #expect(ChatTimelinePolicy.showsJumpToLatest(isAtBottom: false, unseenCount: 1))
        #expect(!ChatTimelinePolicy.showsJumpToLatest(isAtBottom: true, unseenCount: 1))
        #expect(!ChatTimelinePolicy.showsJumpToLatest(isAtBottom: false, unseenCount: 0))
        #expect(ChatTimelinePolicy.isAtBottom(offsetY: 410, viewportHeight: 600, contentHeight: 1000, bottomInset: 34))
        #expect(!ChatTimelinePolicy.isAtBottom(offsetY: 409, viewportHeight: 600, contentHeight: 1000, bottomInset: 34))
    }

}
#endif
