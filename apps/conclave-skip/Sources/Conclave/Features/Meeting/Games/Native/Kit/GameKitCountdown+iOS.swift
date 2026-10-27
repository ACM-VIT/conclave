#if os(iOS) && !SKIP
import Accessibility
import SwiftUI

/// K2 (S60 8 c): the one countdown leaf. It derives everything from the server deadline plus the push's clock offset
/// (`CountdownModel`), ticks once per second through `TimelineView` only while the scene is active (stopped in the
/// background, recomputed on resume, 8 k), moves the bar once per second without animation (R13), turns the warning
/// color at 5 s with the "5 s left" text twin, and announces politely at 10 s and 5 s only.
struct GameKitCountdown: View {
    let model: CountdownModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        if scenePhase == .active {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                GameKitCountdownFace(model: model, nowMillis: context.date.timeIntervalSince1970 * 1000)
            }
        } else {
            GameKitCountdownFace(model: model, nowMillis: Date().timeIntervalSince1970 * 1000)
        }
    }
}

private struct GameKitCountdownFace: View {
    let model: CountdownModel
    let nowMillis: Double

    var body: some View {
        let seconds = model.secondsLeft(nowMillis: nowMillis)
        let warning = seconds <= CountdownModel.warningSeconds
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                if model.durationMillis > 0 {
                    ProgressView(value: model.fractionLeft(nowMillis: nowMillis))
                        .tint(warning ? HostingTheme.token(DesignTokens.iosInCallWarning) : HostingTheme.token(DesignTokens.iosInCallText))
                        .background(HostingTheme.inCallBorderStrong, in: Capsule())
                        .animation(nil, value: seconds)
                }
                Text(GameCopy.seconds(seconds))
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(warning ? HostingTheme.token(DesignTokens.iosInCallWarning) : HostingTheme.token(DesignTokens.iosInCallText))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .overlay { Capsule().strokeBorder(HostingTheme.inCallBorder, lineWidth: 1) }
            }
            if warning && seconds > 0 {
                Text(GameCopy.warning())
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallWarning))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(GameCopy.secondsLeft(seconds))
        .accessibilityIdentifier("game.countdown")
        .onChange(of: seconds) { _, value in
            if CountdownModel.announcedSeconds.contains(value) {
                AccessibilityNotification.Announcement(GameCopy.secondsLeft(value)).post()
            }
        }
    }
}
#endif
