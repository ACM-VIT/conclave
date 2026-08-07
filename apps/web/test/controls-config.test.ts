import { describe, expect, it } from "vitest";
import {
  buildControlsConfig,
  type ControlsBarProps,
} from "../src/app/components/controls-config";

const noop = () => {};

const buildProps = (isMuted: boolean): ControlsBarProps => ({
  roomId: "test-room",
  isMuted,
  isCameraOff: false,
  isScreenSharing: false,
  activeScreenShareId: null,
  isChatOpen: false,
  unreadCount: 0,
  isHandRaised: false,
  reactionOptions: [],
  onToggleMute: noop,
  onToggleCamera: noop,
  onToggleScreenShare: noop,
  onToggleChat: noop,
  onToggleHandRaised: noop,
  onSendReaction: noop,
  onLeave: noop,
});

describe("microphone control", () => {
  it.each([
    { isMuted: false, label: "Mute" },
    { isMuted: true, label: "Unmute" },
  ])("shows $label immediately", ({ isMuted, label }) => {
    const mic = buildControlsConfig(buildProps(isMuted)).center.find(
      (control) => control.id === "mic",
    );

    expect(mic?.label).toBe(label);
    expect(mic?.loading).not.toBe(true);
  });
});
