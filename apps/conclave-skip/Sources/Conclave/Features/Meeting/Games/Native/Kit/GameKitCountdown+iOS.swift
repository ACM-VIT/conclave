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
        Group {
            if model.durationMillis > 0 {
                GameKitTimerRing(fraction: model.fractionLeft(nowMillis: nowMillis), seconds: seconds, isWarning: warning)
            } else {
                GameKitTimerCapsule(text: GameCopy.seconds(seconds), isWarning: warning)
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

struct GameKitTimerRing: View {
    let fraction: Double
    let seconds: Int
    let isWarning: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let ink = isWarning ? HostingTheme.token(DesignTokens.iosInCallWarning) : HostingTheme.token(DesignTokens.iosInCallText)
        ZStack {
            Circle()
                .stroke(HostingTheme.token(DesignTokens.iosInCallSurfaceHigh), lineWidth: 3)
            Circle()
                .trim(from: 0, to: max(0, min(1, fraction)))
                .stroke(ink, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(reduceMotion ? nil : .linear(duration: 1), value: fraction)
            Text(seconds.formatted(.number))
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(ink)
                .contentTransition(.numericText(countsDown: true))
                .minimumScaleFactor(0.6)
                .lineLimit(1)
        }
        .frame(width: 40, height: 40)
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
