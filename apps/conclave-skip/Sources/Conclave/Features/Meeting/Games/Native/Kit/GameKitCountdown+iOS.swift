#if os(iOS) && !SKIP
import Accessibility
import SwiftUI

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
        HStack(spacing: 12) {
            if model.durationMillis > 0 {
                ProgressView(value: model.fractionLeft(nowMillis: nowMillis))
                    .tint(warning ? HostingTheme.token(DesignTokens.iosInCallWarning) : HostingTheme.token(DesignTokens.iosInCallText))
                    .animation(nil, value: seconds)
            } else {
                Spacer(minLength: 0)
            }
            GameKitTimerCapsule(text: GameCopy.seconds(seconds), isWarning: warning)
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

struct GameKitTimerCapsule: View {
    let text: String
    let isWarning: Bool

    var body: some View {
        let ink = isWarning ? HostingTheme.token(DesignTokens.iosInCallWarning) : HostingTheme.token(DesignTokens.iosInCallText)
        Label {
            Text(text)
                .contentTransition(.numericText(countsDown: true))
        } icon: {
            Image(systemName: ConclaveSymbols.timer)
                .accessibilityHidden(true)
        }
        .labelStyle(GameKitCompactLabelStyle())
        .font(.subheadline.weight(.semibold))
        .monospacedDigit()
        .foregroundStyle(ink)
        .lineLimit(1)
        .fixedSize()
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .overlay { Capsule().strokeBorder(isWarning ? ink : HostingTheme.inCallBorder, lineWidth: 1) }
    }
}

struct GameKitCompactLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon
            configuration.title
        }
    }
}
#endif
