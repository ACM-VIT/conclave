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

    @Test func theIosPillFloatsOverTheListSoItNeverChangesTheScrollInsets() throws {
        let timeline = try source(Self.iosTimeline)
        #expect(!timeline.contains(".safeAreaInset(edge: .bottom"))
        let pill = try section(timeline, from: ".overlay(alignment: .bottom) {", to: ".accessibilityRotor(")
        #expect(pill.contains("ChatTimelinePolicy.showsJumpToLatest(isAtBottom: isAtBottom, unseenCount: unseen)"))
        #expect(pill.contains("ChatJumpPill(unseen: unseen) { jumpToLatest(proxy, timeline: chat.timeline) }"))
        #expect(pill.contains(".padding(.bottom, CGFloat(DesignTokens.space8))"))
        #expect(timeline.contains("Text(ConclaveStrings.format(\"%lld New Messages\", unseen))"))
        #expect(timeline.contains(".modifier(ChatBottomProximity(isAtBottom: $isAtBottom))"))
    }

    @Test func theIosFollowAndClearReadTheEndSentinelNotAnyRow() throws {
        let timeline = try source(Self.iosTimeline)
        let state = try section(timeline, from: "private final class ChatBottomSentinelState {", to: "private final class ChatRowVisibilityBox {")
        #expect(state.contains("var isVisible = !ChatTimelinePlatform.usesScrollGeometry"))
        #expect(state.contains("var hiddenAtNewestId = \"\""))

        let box = try section(timeline, from: "private final class ChatRowVisibilityBox {", to: "private struct ChatRotorEntry")
        #expect(!box.contains("newestId") && !box.contains("onNewestVisible"))
        #expect(!box.contains("@Observable"))

        let list = try section(timeline, from: "LazyVStack(alignment: .leading, spacing: 0) {", to: ".scrollTargetLayout()")
        #expect(list.contains(".modifier(ChatBottomSentinelProbe { visible in setBottomVisible(visible) })"))
        #expect(list.contains("Color.clear\n                            .frame(height: 1)\n                            .accessibilityHidden(true)"))
        #expect(!list.contains("usesScrollGeometry"))

        let probe = try section(timeline, from: "private struct ChatBottomSentinelProbe: ViewModifier {", to: "private struct ChatRowVisibilityProbe")
        #expect(probe.contains("if #available(iOS 18.0, *) {"))
        #expect(probe.contains("content.onScrollVisibilityChange { visible in onVisibleChange(visible) }"))
        #expect(probe.contains(".onAppear { onVisibleChange(true) }") && probe.contains(".onDisappear { onVisibleChange(false) }"))

        let sentinel = try section(timeline, from: "private func setBottomVisible(_ visible: Bool) {", to: "private func place(")
        #expect(sentinel.contains("sentinel.isVisible = visible"))
        #expect(sentinel.contains("if !visible { sentinel.hiddenAtNewestId = chat.timeline.newestId }"))
        #expect(sentinel.contains("if visible && unseen != 0 { unseen = 0 }"))
        #expect(sentinel.contains("if !ChatTimelinePlatform.usesScrollGeometry && isAtBottom != visible { isAtBottom = visible }"))

        let task = try section(timeline, from: ".task {", to: ".onChange(of: timeline.newestId)")
        #expect(task.contains("place(proxy, timeline: timeline)") && !task.contains("unseen"))

        let atBottom = try section(timeline, from: ".onChange(of: isAtBottom) { _, atBottom in", to: ".accessibilityIdentifier(\"chat.timeline\")")
        #expect(atBottom.contains("ChatTimelinePolicy.clearsUnseen(isAtBottom: atBottom, endVisible: sentinel.isVisible) && unseen != 0 { unseen = 0 }"))
        #expect(!atBottom.contains("visibility."))

        let follow = try section(timeline, from: "private func follow(_ proxy: ScrollViewProxy, timeline: ChatTimelineSnapshot) {",
                                 to: "private func jumpToLatest(")
        #expect(follow.contains("let atBottom = ChatTimelinePlatform.usesScrollGeometry ? isAtBottom : sentinel.isVisible"))
        #expect(follow.contains("ChatTimelinePolicy.endVisibleAtInsert(endVisible: sentinel.isVisible, endHiddenAtNewestId: sentinel.hiddenAtNewestId,"))
        #expect(follow.contains("ChatTimelinePolicy.followsNewest(isAtBottom: atBottom, endVisible: endVisible, newestIsOwn: timeline.newestIsOwn)"))
        #expect(follow.contains("ChatTimelinePolicy.unseenAfterNewest(unseen: unseen, follows: follows,"))
        #expect(follow.contains("if nextUnseen != unseen { unseen = nextUnseen }"))
        #expect(!follow.contains("visibility."), "the follow rule never reads a row's visibility")
        #expect(!timeline.contains("unseen += 1"))

        let jump = try section(timeline, from: "private func jumpToLatest(", to: "private func scrollToFocus(")
        #expect(jump.contains("unseen = 0\n        guard ChatTimelinePolicy.jumpScrolls(isAtBottom: isAtBottom) else { return }"))

        let place = try section(timeline, from: "private func place(_ proxy: ScrollViewProxy, timeline: ChatTimelineSnapshot) {",
                                to: "private func follow(")
        #expect(!place.contains("visibility."))

        #expect(timeline.contains("let follows = visibility.isVisible(newest)"), "the composer focus rule keeps the row box")
        #expect(timeline.contains("onScrollVisibilityChange(threshold: ChatRowVisibilityBox.partlyVisibleThreshold)"))
        #expect(timeline.contains("ChatStreamingFollow17(chat: chat, proxy: proxy, isAtBottom: isAtBottom)"))
        #expect(timeline.contains(".defaultScrollAnchor(.bottom)") && timeline.contains("onScrollGeometryChange"))
        #expect(!chatHasDash(timeline))
    }

    @Test func theAndroidTimelineKeepsItsPillOutsideTheListAndReadsTheBottomBeforeTheInsert() throws {
        let timeline = try source(Self.androidTimeline)
        #expect(timeline.contains("derivedStateOf { !listState.canScrollBackward ||"))
        #expect(timeline.contains("LaunchedEffect(atBottom) {\n        wasAtBottom = atBottom\n        if (atBottom) unseen = 0\n    }"))
        #expect(timeline.contains("if (wasAtBottom || snapshot.newestIsOwn) {"))
        let list = try section(timeline, from: "Column(Modifier.fillMaxSize()) {", to: "LaunchedEffect(jumpRequests) {")
        let lazy = try #require(list.range(of: "LazyColumn("))
        let pill = try #require(list.range(of: "FilledTonalButton("))
        #expect(lazy.upperBound < pill.lowerBound)
        #expect(list.contains("ChatTimelinePolicy.showsJumpToLatest(isAtBottom = atBottom, unseenCount = unseen)"))
        #expect(!timeline.contains("safeAreaInset") && !timeline.contains("contentWindowInsets"))
    }
}
#endif
