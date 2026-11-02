#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct TRN3TranscriptSheetPolicyTests {
    @Test func aListRestingAtItsBottomUnderTheSheetBarsIsAtTheLatestLine() {
        let distance = TranscriptFollowPolicy.distanceFromLatest(offset: 199, viewport: 812, content: 977, leadingInset: 117,
                                                                 trailingInset: 34)
        #expect(distance == 0)
        #expect(TranscriptFollowPolicy.isAtLatest(distanceFromLatest: distance))
        #expect(!TranscriptFollowPolicy.showsJumpToLatest(rowCount: 8, distanceFromLatest: distance))
    }

    @Test func contentShorterThanTheViewportNeverOffersAJump() {
        for offset in [-117.0, -40.0, 0.0, 30.0] {
            let distance = TranscriptFollowPolicy.distanceFromLatest(offset: offset, viewport: 812, content: 120, leadingInset: 117,
                                                                     trailingInset: 34)
            #expect(distance == 0)
            #expect(!TranscriptFollowPolicy.showsJumpToLatest(rowCount: 1, distanceFromLatest: distance))
        }
    }

    @Test func scrollingUpPastTheSlopOffersTheJumpAndScrollingBackHidesIt() {
        let nearBottom = TranscriptFollowPolicy.distanceFromLatest(offset: 199 - 20, viewport: 812, content: 977, leadingInset: 117,
                                                                   trailingInset: 34)
        #expect(nearBottom == 20)
        #expect(!TranscriptFollowPolicy.showsJumpToLatest(rowCount: 8, distanceFromLatest: nearBottom))

        let readingBack = TranscriptFollowPolicy.distanceFromLatest(offset: 0, viewport: 812, content: 977, leadingInset: 117,
                                                                    trailingInset: 34)
        #expect(readingBack == 199)
        #expect(TranscriptFollowPolicy.showsJumpToLatest(rowCount: 8, distanceFromLatest: readingBack))

        let overscrolled = TranscriptFollowPolicy.distanceFromLatest(offset: 260, viewport: 812, content: 977, leadingInset: 117,
                                                                     trailingInset: 34)
        #expect(overscrolled == 0)
    }

    @Test func anEmptyListNeverOffersAJump() {
        #expect(!TranscriptFollowPolicy.showsJumpToLatest(rowCount: 0, distanceFromLatest: TranscriptFollowPolicy.farFromLatest))
    }

    @Test func aReversedListMeasuresFromItsNewestItem() {
        #expect(TranscriptFollowPolicy.reversedListDistance(firstVisibleIndex: 0, firstVisibleOffset: 0) == 0)
        #expect(TranscriptFollowPolicy.reversedListDistance(firstVisibleIndex: 0, firstVisibleOffset: 12) == 12)
        #expect(TranscriptFollowPolicy.reversedListDistance(firstVisibleIndex: 0, firstVisibleOffset: -4) == 0)
        let behind = TranscriptFollowPolicy.reversedListDistance(firstVisibleIndex: 3, firstVisibleOffset: 0)
        #expect(TranscriptFollowPolicy.showsJumpToLatest(rowCount: 10, distanceFromLatest: behind))
    }

    @Test func minutesAgeReadsAsJustNowMinutesOrHours() {
        let now = 1_793_101_260_000.0
        #expect(MinutesAgePolicy.age(updatedAtMillis: now, nowMillis: now) == MinutesAge(kind: .justNow, count: 0))
        #expect(MinutesAgePolicy.age(updatedAtMillis: now - 59_000, nowMillis: now) == MinutesAge(kind: .justNow, count: 0))
        #expect(MinutesAgePolicy.age(updatedAtMillis: now - 60_000, nowMillis: now) == MinutesAge(kind: .minutes, count: 1))
        #expect(MinutesAgePolicy.age(updatedAtMillis: now - 125_000, nowMillis: now) == MinutesAge(kind: .minutes, count: 2))
        #expect(MinutesAgePolicy.age(updatedAtMillis: now - 59 * 60_000, nowMillis: now) == MinutesAge(kind: .minutes, count: 59))
        #expect(MinutesAgePolicy.age(updatedAtMillis: now - 60 * 60_000, nowMillis: now) == MinutesAge(kind: .hours, count: 1))
        #expect(MinutesAgePolicy.age(updatedAtMillis: now - 150 * 60_000, nowMillis: now) == MinutesAge(kind: .hours, count: 2))
    }

    @Test func aServerTimestampAheadOfTheDeviceClockReadsAsJustNow() {
        let now = 1_793_101_260_000.0
        #expect(MinutesAgePolicy.age(updatedAtMillis: now + 400, nowMillis: now).kind == MinutesAgeKind.justNow)
        #expect(MinutesAgePolicy.age(updatedAtMillis: now + 90_000, nowMillis: now).kind == MinutesAgeKind.justNow)
    }

    @Test func theShortFixtureSeedsOneSpokenLineAndALivePartial() {
        let driver = TranscriptFixtureDriver(fixture: TranscriptFixtureState.short)
        driver.runsFollowUps = false
        #expect(driver.presenter.snapshot.body == TranscriptBody.content)
        #expect(driver.presenter.feed.rowIds.count == 2)
    }

    @Test func minutesStatusUsesTheRelativeAgeOnceMinutesExist() {
        #expect(MinutesPolicy.statusKind(updating: false, updatedAtMillis: 0) == MinutesStatusKind.automatic)
        #expect(MinutesPolicy.statusKind(updating: true, updatedAtMillis: 10) == MinutesStatusKind.updating)
        #expect(MinutesPolicy.statusKind(updating: false, updatedAtMillis: 10) == MinutesStatusKind.updated)
    }

    @Test func theAutomaticStatusStaysQuietUntilThereIsSomethingToDate() {
        #expect(!MinutesPolicy.showsStatusText(MinutesStatusKind.automatic, hasContent: false))
        #expect(MinutesPolicy.showsStatusText(MinutesStatusKind.automatic, hasContent: true))
        #expect(MinutesPolicy.showsStatusText(MinutesStatusKind.updating, hasContent: false))
        #expect(MinutesPolicy.showsStatusText(MinutesStatusKind.updated, hasContent: false))
    }
}
#endif
