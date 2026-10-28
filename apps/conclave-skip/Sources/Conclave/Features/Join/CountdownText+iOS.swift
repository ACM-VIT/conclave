#if os(iOS) && !SKIP
import SwiftUI

// ENT-9 (S10 0.6 L7, 12 c, i, k): the webinar early state's countdown leaf. `Text(timerInterval:countsDown:)` is
// driven by the system, so neither this view nor the landing around it re-evaluates its body once a second; the
// presenter's snapshot carries only the start time. The range is clamped (`max(startsAt, now)`): a `ClosedRange`
// traps when its lower bound passes its upper bound, which happens when the app returns from suspension after the
// start before the scene-active refresh or the open wake-up flips the status (S10 12 l6). VoiceOver reads the timer
// value on focus. Digits are tabular and change without animation (S10 12 h).

struct CountdownText: View {
    let startsAtMillis: Double

    var body: some View {
        let now = Date()
        let endMillis = WebinarLandingPolicy.countdownEndMillis(startsAtMillis: startsAtMillis,
                                                                nowMillis: now.timeIntervalSince1970 * 1000.0)
        let end = Date(timeIntervalSince1970: endMillis / 1000.0)
        // The catalog key is "Starts in %@" (module catalog); the interpolated system timer text fills the argument.
        let key: LocalizedStringKey = "Starts in \(Text(timerInterval: now...end, countsDown: true))"
        Text(key, bundle: .module)
            .font(.title.monospacedDigit())
            .accessibilityIdentifier("webinar.countdown")
    }
}
#endif
