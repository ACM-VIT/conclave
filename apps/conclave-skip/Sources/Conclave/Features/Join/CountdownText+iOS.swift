#if os(iOS) && !SKIP
import SwiftUI

struct CountdownText: View {
    let startsAtMillis: Double

    var body: some View {
        let now = Date()
        let endMillis = WebinarLandingPolicy.countdownEndMillis(startsAtMillis: startsAtMillis,
                                                                nowMillis: now.timeIntervalSince1970 * 1000.0)
        let end = Date(timeIntervalSince1970: endMillis / 1000.0)

        let key: LocalizedStringKey = "Starts in \(Text(timerInterval: now...end, countsDown: true))"
        Text(key, bundle: .module)
            .font(.title.monospacedDigit())
            .accessibilityIdentifier("webinar.countdown")
    }
}
#endif
