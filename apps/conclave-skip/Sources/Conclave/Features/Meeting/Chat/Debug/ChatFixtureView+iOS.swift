#if DEBUG && os(iOS) && !SKIP
import SwiftUI

// S40 0.9, CH22 (CHT-1 to CHT-3): the iOS Debug chat fixture layer. With `CONCLAVE_STAGE_FIXTURE=<state>` and
// `CONCLAVE_CHAT_FIXTURE=<chat state>`, the stage fixture root installs `ChatFixtureDriver` into its own shell's chat
// presenter and opens the Chat panel (request R2 in HD/requests/B4-T1.md); the panel then shows these script controls
// and readouts in a bar above its content (the panel covers the stage controls on iPhone). Standalone presenters
// only: no view model, socket, network, audio or capture. Labels are Debug-only verbatim text.

@MainActor
enum ChatFixtureLaunch {
    static func state(environment: [String: String] = ProcessInfo.processInfo.environment) -> ChatFixtureState? {
        ChatFixtureDriver.state(named: environment["CONCLAVE_CHAT_FIXTURE"])
    }
}

/// The fixture's controls and readouts (`chat.fixture.<script>`, `chat.fixture.actions`, `chat.openLatency`).
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
        }
        .padding(.vertical, 4)
        .background(Color(uiColor: .secondarySystemBackground))
    }
}
#endif
