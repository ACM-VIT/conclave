#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct SwipeCase: Sendable, CustomTestStringConvertible {
    let dx: Double
    let dy: Double
    let predictedDx: Double
    let predictedDy: Double
    let expected: NoticeSwipeOutcome

    var testDescription: String { "(\(dx), \(dy)) predicted (\(predictedDx), \(predictedDy))" }
}

struct NoticeSwipePolicyTests {
    @Test(arguments: [
        SwipeCase(dx: 0, dy: -50, predictedDx: 0, predictedDy: -60, expected: .dismissUp),
        SwipeCase(dx: 0, dy: -20, predictedDx: 0, predictedDy: -150, expected: .dismissUp),
        SwipeCase(dx: 0, dy: -20, predictedDx: 0, predictedDy: -40, expected: .settle),
        SwipeCase(dx: 0, dy: 60, predictedDx: 0, predictedDy: 200, expected: .settle),
        SwipeCase(dx: 110, dy: 10, predictedDx: 130, predictedDy: 10, expected: .dismissRight),
        SwipeCase(dx: -40, dy: 5, predictedDx: -260, predictedDy: 5, expected: .dismissLeft),
        SwipeCase(dx: 60, dy: 10, predictedDx: 90, predictedDy: 10, expected: .settle),
    ])
    func aDismissibleCardLeavesOnAnUpwardOrSidewaysSwipeOrFling(_ swipe: SwipeCase) {
        #expect(NoticeSwipePolicy.outcome(dx: swipe.dx, dy: swipe.dy, predictedDx: swipe.predictedDx, predictedDy: swipe.predictedDy,
                                          isDismissible: true) == swipe.expected)
    }

    @Test func aPersistentCardAlwaysSettlesAndOnlyRubberBands() {
        #expect(NoticeSwipePolicy.outcome(dx: 0, dy: -300, predictedDx: 0, predictedDy: -900, isDismissible: false) == .settle)
        let pulled = NoticeSwipePolicy.offset(dx: 0, dy: -300, isDismissible: false)
        #expect(pulled.y < 0 && pulled.y > -NoticeSwipePolicy.resistanceLimit)
    }

    @Test func upwardAndSidewaysDragsFollowTheFingerWhileDownwardDragsResist() {
        #expect(NoticeSwipePolicy.offset(dx: 0, dy: -80, isDismissible: true) == NoticeSwipeOffset(x: NoticeSwipePolicy.resisted(0), y: -80))
        #expect(NoticeSwipePolicy.offset(dx: 120, dy: 10, isDismissible: true).x == 120)
        let down = NoticeSwipePolicy.offset(dx: 0, dy: 200, isDismissible: true)
        #expect(down.y > 0 && down.y < NoticeSwipePolicy.resistanceLimit)
        #expect(NoticeSwipePolicy.resisted(-200) == -NoticeSwipePolicy.resisted(200))
        #expect(NoticeSwipePolicy.resisted(0) == 0)
    }

    @Test func theCardFadesWithTravelButStaysReadable() {
        #expect(NoticeSwipePolicy.opacity(.zero) == 1)
        #expect(NoticeSwipePolicy.opacity(NoticeSwipeOffset(x: 0, y: 40)) == 1)
        #expect(NoticeSwipePolicy.opacity(NoticeSwipeOffset(x: 0, y: -100)) == 0.5)
        #expect(NoticeSwipePolicy.opacity(NoticeSwipeOffset(x: 1000, y: 0)) == NoticeSwipePolicy.minimumOpacity)
    }

    @Test func exitsTravelInTheSwipeDirection() {
        let from = NoticeSwipeOffset(x: 10, y: -50)
        #expect(NoticeSwipePolicy.exitOffset(.dismissUp, from: from).y < from.y)
        #expect(NoticeSwipePolicy.exitOffset(.dismissLeft, from: from).x < from.x)
        #expect(NoticeSwipePolicy.exitOffset(.dismissRight, from: from).x > from.x)
        #expect(NoticeSwipePolicy.exitOffset(.settle, from: from) == .zero)
    }
}
#endif
