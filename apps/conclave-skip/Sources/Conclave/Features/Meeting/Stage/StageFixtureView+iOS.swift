#if DEBUG && os(iOS) && !SKIP
import SwiftUI

// S20 SL14 (STG-1, STG-4): the iOS Debug stage fixture root. Mounted by the Debug root hook in `ConclaveApp.swift` when
// `CONCLAVE_STAGE_FIXTURE=<state>` is set (request in HD/requests/B3-T2.md); `CONCLAVE_STAGE_FIXTURE_PATTERN=live`
// switches the probes to the live pattern and `CONCLAVE_STAGE_FORCE_SCREEN_READER=1` makes auto-hide and toasts behave
// as if VoiceOver ran. Standalone presenters only: never `MeetingViewModel`, WebRTC, audio, capture or network.

enum StageFixtureLaunch {
    static func state(environment: [String: String] = NativeRuntimeConfig.debugLaunchEnvironment()) -> StageFixtureState? {
        guard let raw = environment["CONCLAVE_STAGE_FIXTURE"] else { return nil }
        return StageFixtureScript.state(named: raw)
    }

    static func pattern(environment: [String: String] = NativeRuntimeConfig.debugLaunchEnvironment()) -> RendererProbePattern {
        StageFixtureScript.pattern(named: environment["CONCLAVE_STAGE_FIXTURE_PATTERN"])
    }

    static func forcesScreenReader(environment: [String: String] = NativeRuntimeConfig.debugLaunchEnvironment()) -> Bool {
        environment["CONCLAVE_STAGE_FORCE_SCREEN_READER"] == "1"
    }
}

struct StageFixtureView: View {
    @State private var session: StageFixtureSession

    init(state: StageFixtureState, pattern: RendererProbePattern = StageFixtureLaunch.pattern(),
         forceScreenReader: Bool = StageFixtureLaunch.forcesScreenReader()) {
        _session = State(initialValue: StageFixtureSession(state: state, pattern: pattern, forceScreenReader: forceScreenReader))
    }

    var body: some View {
        ZStack(alignment: .leading) {
            CallRoot(shell: session.shell, stage: session.stage,
                     renderers: StageRendererProvider.probes(ledger: session.renderers, pattern: session.pattern),
                     forceScreenReader: session.forceScreenReader, activitySession: session.activity,
                     webinarLinkProvider: { await session.ensureWebinarLink() })
                // STG-3 (S20 SL14, HD request B5-T8 R10): one renderTargetResize per settled share zoom.
                .environment(\.stageRenderTargetResize, { session.counters.recordRenderTargetResize() })
            // Readouts and scripts sit beside the stage, never inside its subtree (PS 7.6), so refreshing them never
            // re-evaluates a tile or a renderer.
            StageFixtureControls(session: session)
        }
        .task {
            // S40 0.9 (HD request B4-T1 R2): `CONCLAVE_CHAT_FIXTURE=<state>` layers the chat fixture on this stage
            // fixture and opens Chat. The driver stays alive through `ChatDiagnostics.driver`.
            if let chatState = ChatFixtureLaunch.state() {
                _ = ChatFixtureDriver.installOnStage(state: chatState, shell: session.shell)
            }
            // TRN-2 (S60 L6-12, HD request B7-T5 R5): `CONCLAVE_TRANSCRIPT_FIXTURE=<state>` layers the Transcript fixture
            // (FakeTranscriptOwner) on this stage fixture and opens the panel.
            if let transcriptState = TranscriptFixtureDriver.fixtureState(named: NativeRuntimeConfig.debugLaunchValue(forKey: "CONCLAVE_TRANSCRIPT_FIXTURE")) {
                TranscriptFixtureDriver.installOnStage(state: transcriptState, shell: session.shell)
            }
        }
    }
}

private struct StageFixtureControls: View {
    let session: StageFixtureSession
    @State private var expanded = true
    @State private var refresh = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            fixtureButton("Fixture", identifier: "stage.fixture.toggle") { expanded.toggle() }
            if expanded {
                fixtureButton("Magic Tap", identifier: "stage.fixture.magicTap") { session.magicTap(); refresh += 1 }
                fixtureButton("Speakers", identifier: "stage.fixture.speakers") { session.runSpeakerScript(); refresh += 1 }
                fixtureButton("Speak Hidden", identifier: "stage.fixture.speakHidden") { session.speakHiddenParticipant(); refresh += 1 }
                fixtureButton("Next Role", identifier: "stage.fixture.rolesNext") { session.nextRolesSweepStep(); refresh += 1 }
                fixtureButton("Reactions", identifier: "stage.fixture.reactions") { session.replayReactions(); refresh += 1 }
                fixtureButton("Join Burst", identifier: "stage.fixture.joinBurst") { session.postJoinBurst(); refresh += 1 }
                fixtureButton("Dismiss Toast", identifier: "stage.fixture.dismissToast") { session.dismissCurrentToast(); refresh += 1 }
                fixtureButton("Previews 1 Sender", identifier: "stage.fixture.previews.sameSender3") { session.postChatPreviewScript(named: "sameSender3"); refresh += 1 }
                fixtureButton("Previews 3 Senders", identifier: "stage.fixture.previews.mixed3") { session.postChatPreviewScript(named: "mixed3"); refresh += 1 }
                fixtureButton("Suspend Toasts", identifier: "stage.fixture.suspendToasts") { session.toggleToastSuspension(); refresh += 1 }
                fixtureButton("Next Caption", identifier: "stage.fixture.nextCaption") { session.nextCaption(); refresh += 1 }
                fixtureButton("Reconnect", identifier: "stage.fixture.reconnect") { session.toggleReconnecting(); refresh += 1 }
                fixtureButton("Toggle Lock", identifier: "stage.fixture.lock") { session.toggleRoomLock(); refresh += 1 }
                fixtureButton("Refresh", identifier: "stage.fixture.refresh") { refresh += 1 }
                StageFixtureReadouts(session: session, refresh: refresh)
            }
        }
        .padding(8)
        .frame(maxWidth: 220, alignment: .leading)
        .background(HostingTheme.inCallLabelScrim, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .padding(.leading, 8)
        .environment(\.colorScheme, .dark)
    }

    private func fixtureButton(_ title: String, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(verbatim: title)
                .font(.caption.weight(.semibold))
                .frame(minHeight: 28)
        }
        .buttonStyle(.borderless)
        .tint(HostingTheme.inCallCoralText)
        .accessibilityIdentifier(identifier)
    }
}

private struct StageFixtureReadouts: View {
    let session: StageFixtureSession
    let refresh: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            readout(session.renderersReadout(), identifier: "stage.renderers")
            readout(session.layoutReadout(), identifier: "stage.layout")
            readout(session.countersReadout(), identifier: "stage.counters")
            readout(session.announcementsReadout(), identifier: "stage.announcements")
            readout(session.noticesReadout(), identifier: "stage.notices")
            readout(session.chatPreviewReadout(), identifier: "chat.preview")
            readout(session.settingsCallsReadout(), identifier: "wp3.calls")
            readout(session.speakerTestReadout(), identifier: "speakerTest.count")
            readout(session.voicePreviewReadout(), identifier: "voicePreview.count")
            // SET-5, SET-6 (L6-12): the Layout panel's intents and the fake WP10 engine's calls.
            readout(session.layoutCallsReadout(), identifier: "layout.calls")
            readout(session.effectsCallsReadout(), identifier: "wp10.calls")
            // SET-3 (S60 2 l3, l4): Connection polls and the last publish ceiling.
            readout(session.statsPollsReadout(), identifier: "stats.polls")
            readout(session.publishCeilingReadout(), identifier: "wp3.ceiling")
            readout(session.captionsReadout(), identifier: "stage.captions.readout")
            readout(session.activityReadout(), identifier: "game.emits")
            readout(session.panelReadout(), identifier: "panel.current")
            readout(session.meetingInfoReadout(), identifier: "stage.meetingInfo")
            readout(session.attendeeReadout(), identifier: "stage.attendee.readout")
            readout(session.chromeReadout(), identifier: "chrome.transient")
            readout(session.recomposeReadout(), identifier: "stage.recompose")
            readout("refresh " + String(refresh), identifier: "stage.fixture.refreshCount")
        }
    }

    private func readout(_ text: String, identifier: String) -> some View {
        Text(verbatim: text)
            .font(.caption2.monospaced())
            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            .lineLimit(3)
            .accessibilityIdentifier(identifier)
    }
}
#endif
