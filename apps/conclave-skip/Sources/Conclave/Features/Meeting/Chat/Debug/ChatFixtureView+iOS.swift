#if DEBUG && os(iOS) && !SKIP
import SwiftUI

@MainActor
enum ChatFixtureLaunch {
    static func state(environment: [String: String] = NativeRuntimeConfig.debugLaunchEnvironment()) -> ChatFixtureState? {
        ChatFixtureDriver.state(named: environment["CONCLAVE_CHAT_FIXTURE"])
    }
}

struct ChatFixtureControlsBar: View {
    let driver: ChatFixtureDriver
    @State private var refresh = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(ChatFixtureScriptName.allCases, id: \.self) { script in
                        Button {
                            driver.run(script)
                            refresh += 1
                        } label: {
                            Text(verbatim: script.rawValue)
                                .font(.caption.weight(.semibold))
                                .frame(minHeight: 28)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityIdentifier("chat.fixture." + script.rawValue)
                    }
                    Button {
                        refresh += 1
                    } label: {
                        Text(verbatim: "refresh")
                            .font(.caption.weight(.semibold))
                            .frame(minHeight: 28)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("chat.fixture.refresh")
                }
                .padding(.horizontal, 16)
            }
            let _ = refresh
            Text(verbatim: driver.actionsReadout.isEmpty ? "actions: none" : driver.actionsReadout)
                .font(.caption2)
                .lineLimit(4)
                .padding(.horizontal, 16)
                .accessibilityIdentifier("chat.fixture.actions")
            Text(verbatim: driver.openLatencyReadout + " list=" + String(driver.counters.count("chat.recompose.list"))
                 + " composer=" + String(driver.counters.count("chat.recompose.composer"))
                 + " " + driver.assistantAnnouncementReadout)
                .font(.caption2)
                .padding(.horizontal, 16)
                .accessibilityIdentifier("chat.openLatency")
            ChatGateLineReadout(driver: driver)
        }
        .padding(.vertical, 4)
        .background(Color(uiColor: .secondarySystemBackground))
    }
}

private struct ChatGateLineReadout: View {
    let driver: ChatFixtureDriver

    var body: some View {
        Text(verbatim: driver.gateLineReadout)
            .font(.caption2)
            .padding(.horizontal, 16)
            .accessibilityIdentifier("chat.composer.gateLine")
    }
}
#endif
