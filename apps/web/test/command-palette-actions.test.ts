import { describe, expect, it, vi } from "vitest";
import {
  buildPaletteActions,
  buildQueryFallbackActions,
  FALLBACK_SECTION,
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

  it("offers the keyboard-shortcuts reference when a handler is provided", () => {
    const showShortcuts = vi.fn();
    const without = buildPaletteActions(baseProps(), noDevices);
    expect(ids(without)).not.toContain("shortcuts-help");

    const withHelp = buildPaletteActions(baseProps(), noDevices, {
      onShowShortcuts: showShortcuts,
    });
    const action = withHelp.find((a) => a.id === "shortcuts-help");
    expect(action?.section).toBe("Help");
    expect(action?.hotkey).toBe("Mod+/");
    action?.run();
    expect(showShortcuts).toHaveBeenCalled();
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

describe("reaction emoji name search", () => {
  it("finds reactions by emoji name, e.g. 'thumbsup' → 👍", () => {
    // Mirrors EMOJI_REACTIONS: real reaction options label with the glyph.
    const emojiOptions = ["👍", "👏", "😂", "❤️", "🎉", "😮"].map((emoji) => ({
      id: `emoji-${emoji}`,
      kind: "emoji" as const,
      value: emoji,
      label: emoji,
    }));
    const actions = buildPaletteActions(
      baseProps({ reactionOptions: emojiOptions }),
      noDevices,
    );

    const expectHit = (query: string, emoji: string) => {
      const hits = filterPaletteActions(actions, query);
      expect(hits.map((a) => a.id), `query "${query}"`).toContain(
        `reaction-emoji-${emoji}`,
      );
    };
    expectHit("thumbsup", "👍");
    expectHit("thumbs up", "👍");
    expectHit("clap", "👏");
    expectHit("lol", "😂");
    expectHit("heart", "❤️"); // variation selector on the glyph is ignored
    expectHit("tada", "🎉");
    expectHit("wow", "😮");
  });
});

describe("buildQueryFallbackActions", () => {
  it("returns nothing for blank queries or when no handler exists", () => {
    expect(
      buildQueryFallbackActions("   ", baseProps(), {
        onSendChatMessage: vi.fn(),
      }),
    ).toHaveLength(0);
    expect(buildQueryFallbackActions("hello", baseProps())).toHaveLength(0);
  });

  it("offers send-to-chat and ask-AI, opening the chat panel when closed", () => {
    const send = vi.fn();
    const toggleChat = vi.fn();
    const actions = buildQueryFallbackActions(
      "hello there",
      baseProps({ isChatOpen: false, onToggleChat: toggleChat }),
      { onSendChatMessage: send },
    );
    expect(actions.map((a) => a.id)).toEqual([
      "fallback-send-chat",
      "fallback-ask-ai",
    ]);
    expect(actions.every((a) => a.section === FALLBACK_SECTION)).toBe(true);

    actions[0]?.run();
    expect(send).toHaveBeenLastCalledWith("hello there");
    actions[1]?.run();
    expect(send).toHaveBeenLastCalledWith("@Conclave hello there");
    expect(toggleChat).toHaveBeenCalledTimes(2);
  });

  it("does not toggle the chat panel when it is already open", () => {
    const toggleChat = vi.fn();
    const actions = buildQueryFallbackActions(
      "hi",
      baseProps({ isChatOpen: true, onToggleChat: toggleChat }),
      { onSendChatMessage: vi.fn() },
    );
    actions[0]?.run();
    expect(toggleChat).not.toHaveBeenCalled();
  });

  it("offers search-together only for hosts with the shared browser free", () => {
    const launch = vi.fn().mockResolvedValue(true);
    const hostProps = baseProps({
      isAdmin: true,
      showBrowserControls: true,
      onLaunchBrowser: launch,
    });
    const actions = buildQueryFallbackActions("rust borrow checker", hostProps);
    expect(actions.map((a) => a.id)).toEqual(["fallback-search-together"]);
    actions[0]?.run();
    expect(launch).toHaveBeenCalledWith(
      "https://www.google.com/search?q=rust%20borrow%20checker",
    );

    expect(
      buildQueryFallbackActions("x", { ...hostProps, isBrowserActive: true }),
    ).toHaveLength(0);
    expect(
      buildQueryFallbackActions("x", { ...hostProps, isAdmin: false }),
    ).toHaveLength(0);
  });
});
