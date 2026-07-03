import { describe, expect, it, vi } from "vitest";
import {
  buildPaletteActions,
  filterPaletteActions,
  type PaletteDevices,
} from "../src/app/components/command-palette-actions";
import type { ControlsBarProps } from "../src/app/components/controls-config";

const noop = () => {};

function baseProps(overrides: Partial<ControlsBarProps> = {}): ControlsBarProps {
  return {
    roomId: "test-room",
    isMuted: false,
    isCameraOff: false,
    isScreenSharing: false,
    activeScreenShareId: null,
    isChatOpen: false,
    unreadCount: 0,
    isHandRaised: false,
    reactionOptions: [
      { id: "thumbs", kind: "emoji", value: "👍", label: "thumbs up" },
    ],
    onToggleMute: noop,
    onToggleCamera: noop,
    onToggleScreenShare: noop,
    onToggleChat: noop,
    onToggleHandRaised: noop,
    onSendReaction: noop,
    onLeave: noop,
    ...overrides,
  };
}

const noDevices: PaletteDevices = {
  audioInput: [],
  audioOutput: [],
  videoInput: [],
};

function ids(actions: { id: string }[]): string[] {
  return actions.map((a) => a.id);
}

describe("buildPaletteActions", () => {
  it("includes the core controls with state-aware labels", () => {
    const actions = buildPaletteActions(baseProps({ isMuted: true }), noDevices);
    const mic = actions.find((a) => a.id === "mic");
    expect(mic?.label).toBe("Unmute");
    expect(mic?.section).toBe("Controls");
    expect(ids(actions)).toEqual(
      expect.arrayContaining(["mic", "camera", "hand", "screen-share", "chat", "leave"]),
    );
  });

  it("disables screen share while someone else presents", () => {
    const actions = buildPaletteActions(
      baseProps({ activeScreenShareId: "someone-else", isScreenSharing: false }),
      noDevices,
    );
    const share = actions.find((a) => a.id === "screen-share");
    expect(share?.disabled).toBe(true);
  });

  it("only offers panel toggles whose handlers exist", () => {
    const without = buildPaletteActions(baseProps(), noDevices);
    expect(ids(without)).not.toContain("participants");

    const withPanels = buildPaletteActions(
      baseProps({
        onToggleParticipants: noop,
        onToggleGames: noop,
        onToggleTranscript: noop,
      }),
      noDevices,
    );
    expect(ids(withPanels)).toEqual(
      expect.arrayContaining(["participants", "games", "transcript"]),
    );
  });

  it("gates host actions on isAdmin, not just handler presence", () => {
    const asGuest = buildPaletteActions(
      baseProps({
        isAdmin: false,
        onToggleLock: noop,
        onToggleHostControls: noop,
        onEndForEveryone: noop,
      }),
      noDevices,
    );
    expect(ids(asGuest)).not.toContain("lock-meeting");
    expect(ids(asGuest)).not.toContain("host-controls");
    expect(ids(asGuest)).not.toContain("end-for-everyone");

    const asHost = buildPaletteActions(
      baseProps({
        isAdmin: true,
        onToggleLock: noop,
        onToggleHostControls: noop,
        onEndForEveryone: noop,
        onToggleChatLock: noop,
      }),
      noDevices,
    );
    expect(ids(asHost)).toEqual(
      expect.arrayContaining([
        "lock-meeting",
        "host-controls",
        "end-for-everyone",
        "chat-lock",
      ]),
    );
  });

  it("hides reactions from guests when reactions are disabled, keeps them for admins", () => {
    const guest = buildPaletteActions(
      baseProps({ isReactionsDisabled: true }),
      noDevices,
    );
    expect(ids(guest)).not.toContain("reaction-thumbs");

    const admin = buildPaletteActions(
      baseProps({ isReactionsDisabled: true, isAdmin: true }),
      noDevices,
    );
    expect(ids(admin)).toContain("reaction-thumbs");
  });

  it("lists devices and marks the selected one active", () => {
    const devices: PaletteDevices = {
      audioInput: [
        { deviceId: "mic-a", label: "Headset" },
        { deviceId: "mic-b", label: "Built-in" },
      ],
      audioOutput: [],
      videoInput: [],
    };
    const change = vi.fn();
    const actions = buildPaletteActions(
      baseProps({
        onAudioInputDeviceChange: change,
        selectedAudioInputDeviceId: "mic-b",
      }),
      devices,
    );
    const headset = actions.find((a) => a.id === "device-mic-mic-a");
    const builtIn = actions.find((a) => a.id === "device-mic-mic-b");
    expect(headset?.active).toBe(false);
    expect(builtIn?.active).toBe(true);
    headset?.run();
    expect(change).toHaveBeenCalledWith("mic-a");
  });

  it("offers shared-browser quick launches only for admins without an active browser", () => {
    const launch = vi.fn().mockResolvedValue(true);
    const props = baseProps({
      isAdmin: true,
      showBrowserControls: true,
      onLaunchBrowser: launch,
    });
    const actions = buildPaletteActions(props, noDevices);
    expect(ids(actions)).toContain("browser-launch-youtube");

    const whileActive = buildPaletteActions(
      { ...props, isBrowserActive: true },
      noDevices,
    );
    expect(ids(whileActive)).not.toContain("browser-launch-youtube");
  });

  it("flips the voice agent action with running state", () => {
    const start = vi.fn();
    const stop = vi.fn();
    const idle = buildPaletteActions(
      baseProps({ onStartVoiceAgent: start, onStopVoiceAgent: stop }),
      noDevices,
    );
    expect(idle.find((a) => a.id === "voice-agent")?.label).toBe(
      "Start AI voice agent",
    );

    const running = buildPaletteActions(
      baseProps({
        onStartVoiceAgent: start,
        onStopVoiceAgent: stop,
        isVoiceAgentRunning: true,
      }),
      noDevices,
    );
    const action = running.find((a) => a.id === "voice-agent");
    expect(action?.label).toBe("Stop AI voice agent");
    action?.run();
    expect(stop).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("adds copy actions only when a room id and callback exist", () => {
    const copyCode = vi.fn();
    const withCopy = buildPaletteActions(baseProps(), noDevices, {
      onCopyMeetingCode: copyCode,
    });
    expect(ids(withCopy)).toContain("copy-code");

    const withoutRoom = buildPaletteActions(
      baseProps({ roomId: undefined }),
      noDevices,
      { onCopyMeetingCode: copyCode },
    );
    expect(ids(withoutRoom)).not.toContain("copy-code");
  });
});

describe("filterPaletteActions", () => {
  it("matches all tokens against label, section, and keywords", () => {
    const actions = buildPaletteActions(
      baseProps({ onToggleParticipants: noop }),
      noDevices,
    );
    const hits = filterPaletteActions(actions, "people");
    expect(ids(hits)).toContain("participants");

    expect(filterPaletteActions(actions, "share screen")).toHaveLength(1);
    expect(filterPaletteActions(actions, "zzz-no-match")).toHaveLength(0);
    expect(filterPaletteActions(actions, "  ")).toHaveLength(actions.length);
  });
});
