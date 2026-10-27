#if os(iOS) && !SKIP
import SwiftUI

/// Named motion constants (F00 9, 2.6 A5; S10 R3; S20 SR2). Durations come from the shared
/// `ConclaveMotionDurations`, so the Compose specs in `K/ui/theme/ConclaveMotion.kt` read the same numbers.
/// Panels, sheets, menus and pushes keep the system motion; nothing here adds a decorative entrance, a pulse, a
/// shimmer or a loop. Every constant has a Reduce Motion form: travel becomes an opacity change or nothing.
enum ConclaveMotion {
    /// Banner and toast enter and exit: 120 ms ease-out with an 8 pt move (`motion.fast`).
    static let fast = Animation.easeOut(duration: seconds(ConclaveMotionDurations.fastMillis))
    /// The banner and toast travel distance.
    static let bannerTravel = CGFloat(ConclaveMotionDurations.bannerTravel)
    /// Chrome auto-hide fade: opacity only, 200 ms ease-in-out.
    static let chromeFade = Animation.easeInOut(duration: seconds(ConclaveMotionDurations.chromeFadeMillis))
    /// User-driven drag and snap (self view): the system snappy spring.
    static let snap = Animation.snappy
    /// S10 R3: the lobby card expanding into the stage, critically damped.
    static let entryExpand = Animation.spring(response: ConclaveMotionDurations.entryExpandResponseSeconds, dampingFraction: 1.0)
    /// S10 R3: the cross-fade that replaces travel, also the Reduce Motion form of the entry expansion.
    static let crossFade = Animation.easeInOut(duration: seconds(ConclaveMotionDurations.crossFadeMillis))
    /// S20 SR2: tiles moving to new frames.
    static let tileReflow = Animation.snappy(duration: seconds(ConclaveMotionDurations.tileReflowMillis))
    /// S20 SR2: the stage kind changing (grid to spotlight, presentation).
    static let stageSwap = Animation.easeInOut(duration: seconds(ConclaveMotionDurations.stageSwapMillis))
    /// S20 SR2: a pinch zoom settling.
    static let zoomSnap = Animation.snappy(duration: seconds(ConclaveMotionDurations.zoomSnapMillis))

    /// The animation for a motion that travels: nil (no animation, end position at once) under Reduce Motion.
    static func travel(_ animation: Animation, reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : animation
    }

    /// The animation for an opacity change: kept under Reduce Motion (fades are allowed), except chrome, which
    /// F00 9 makes instant.
    static func fade(_ animation: Animation, reduceMotion: Bool, instantWhenReduced: Bool = false) -> Animation? {
        reduceMotion && instantWhenReduced ? nil : animation
    }

    /// The entry expansion, or the cross-fade under Reduce Motion (S10 8).
    static func entry(reduceMotion: Bool) -> Animation {
        reduceMotion ? crossFade : entryExpand
    }

    private static func seconds(_ millis: Int) -> Double {
        Double(millis) / 1000.0
    }
}

/// Banner and toast presence: an 8 pt move plus opacity, opacity alone under Reduce Motion (F00 9, C12 h, C13 h).
/// `edge` is where the element comes from: `.top` for the banner lane, `.bottom` for the toast host.
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
    /// Applies the lane transition; the caller animates the insertion with `ConclaveMotion.fast`.
    func conclaveLanePresence(from edge: VerticalEdge) -> some View {
        modifier(ConclaveLanePresence(edge: edge))
    }
}
#endif
