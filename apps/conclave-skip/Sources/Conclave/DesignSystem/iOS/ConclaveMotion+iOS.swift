#if os(iOS) && !SKIP
import SwiftUI

enum ConclaveMotion {

    static let fast = Animation.easeOut(duration: seconds(ConclaveMotionDurations.fastMillis))

    static let bannerTravel = CGFloat(ConclaveMotionDurations.bannerTravel)

    static let chromeFade = Animation.easeInOut(duration: seconds(ConclaveMotionDurations.chromeFadeMillis))

    static let snap = Animation.snappy

    static let entryExpand = Animation.spring(response: ConclaveMotionDurations.entryExpandResponseSeconds, dampingFraction: 1.0)

    static let crossFade = Animation.easeInOut(duration: seconds(ConclaveMotionDurations.crossFadeMillis))

    static let tileReflow = Animation.snappy(duration: seconds(ConclaveMotionDurations.tileReflowMillis))

    static let stageSwap = Animation.easeInOut(duration: seconds(ConclaveMotionDurations.stageSwapMillis))

    static let zoomSnap = Animation.snappy(duration: seconds(ConclaveMotionDurations.zoomSnapMillis))

    static func travel(_ animation: Animation, reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : animation
    }

    static func fade(_ animation: Animation, reduceMotion: Bool, instantWhenReduced: Bool = false) -> Animation? {
        reduceMotion && instantWhenReduced ? nil : animation
    }

    static func entry(reduceMotion: Bool) -> Animation {
        reduceMotion ? crossFade : entryExpand
    }

    private static func seconds(_ millis: Int) -> Double {
        Double(millis) / 1000.0
    }
}

struct ConclaveLanePresence: ViewModifier {
    let edge: VerticalEdge
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content.transition(transition)
    }

    private var transition: AnyTransition {
        if reduceMotion { return .opacity }
        let offset = edge == .top ? -ConclaveMotion.bannerTravel : ConclaveMotion.bannerTravel
        return .opacity.combined(with: .offset(y: offset))
    }
}

extension View {

    func conclaveLanePresence(from edge: VerticalEdge) -> some View {
        modifier(ConclaveLanePresence(edge: edge))
    }
}
#endif
