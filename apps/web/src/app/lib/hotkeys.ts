
export interface HotkeyDefinition {
  keys: string;
  label: string;
  description: string;
}

export type HotkeyAction =
  | "toggleMute"
  | "toggleCamera"
  | "toggleHandRaise"
  | "toggleChat"
  | "toggleLockMeeting"
  | "toggleReactions"
  | "toggleScreenShare"
  | "toggleApps"
  | "toggleMiniView"
  | "toggleParticipants"
  | "commandPalette"
  | "shortcutsHelp";

export const HOTKEYS: Record<HotkeyAction, HotkeyDefinition> = {
  toggleMute: {
    keys: "Mod+D",
    label: "Mute / Unmute",
    description: "Toggle your microphone on or off.",
  },
  toggleCamera: {
    keys: "Mod+E",
    label: "Camera on / off",
    description: "Toggle your camera on or off.",
  },
  toggleHandRaise: {
    keys: "Mod+Alt+H",
    label: "Raise / Lower hand",
    description: "Raise or lower your hand to get the presenter's attention.",
  },
  toggleChat: {
    keys: "Mod+Shift+C",
    label: "Chat",
    description: "Open or close the chat panel.",
  },
  toggleParticipants: {
    keys: "Mod+Shift+P",
    label: "Participants",
    description: "Open or close the participants panel.",
  },
  toggleLockMeeting: {
    keys: "Mod+Shift+L",
    label: "Lock Meeting",
    description: "Locks the meeting, preventing new participants from joining.",
  },
  toggleScreenShare: {
    keys: "Mod+Shift+S",
    label: "Share Screen",
    description: "Start or stop sharing your screen.",
  },
  toggleReactions: {
    keys: "",
    label: "Reactions",
    description: "Open or close the reactions panel.",
  },
  toggleApps: {
    keys: "",
    label: "Apps",
    description: "Open or close the apps panel.",
  },
  toggleMiniView: {
    keys: "Mod+M",
    label: "Pop out Mini-view",
    description: "Pops out a mini view panel.",
  },
  commandPalette: {
    keys: "Mod+K",
    label: "Quick actions",
    description: "Search for and run any meeting action.",
  },
  shortcutsHelp: {
    keys: "Mod+/",
    label: "Keyboard shortcuts",
    description: "Show this list of keyboard shortcuts.",
  },
} as const;

export const HOTKEY_LIST: (HotkeyDefinition & { action: HotkeyAction })[] =
  (Object.entries(HOTKEYS) as [HotkeyAction, HotkeyDefinition][]).map(
    ([action, definition]) => ({ action, ...definition }),
  );

/**
 * Hotkeys worth showing in the shortcuts reference: some actions are declared
 * here without a binding yet (empty `keys`), and listing those would just be
 * a row with a blank chip. The quick-actions palette leads the list — it is
 * the gateway to every other action, so it gets top billing.
 */
export function getDisplayableHotkeys(): (HotkeyDefinition & {
  action: HotkeyAction;
})[] {
  const bound = HOTKEY_LIST.filter((hotkey) => hotkey.keys.length > 0);
  return [
    ...bound.filter((hotkey) => hotkey.action === "commandPalette"),
    ...bound.filter((hotkey) => hotkey.action !== "commandPalette"),
  ];
}
