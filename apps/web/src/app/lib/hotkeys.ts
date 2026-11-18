import type { RegisterableHotkey } from "@tanstack/hotkeys";

export interface HotkeyDefinition {
  /**
   * Typed so the hotkeys library validates every shortcut string; `null` for
   * an action that is declared but has no binding yet.
   */
  keys: RegisterableHotkey | null;
  label: string;
  description: string;
}

/** A hotkey that is actually bound to a key, as listed in the shortcuts help. */
export interface DisplayableHotkey {
  action: HotkeyAction;
  keys: RegisterableHotkey;
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

// `satisfies` (not an annotation) keeps each entry's literal type, so a bound
// action's `keys` is known to be non-null wherever it is registered or shown.
export const HOTKEYS = {
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
    keys: null,
    label: "Reactions",
    description: "Open or close the reactions panel.",
  },
  toggleApps: {
    keys: null,
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
} as const satisfies Record<HotkeyAction, HotkeyDefinition>;

export const HOTKEY_LIST: (HotkeyDefinition & { action: HotkeyAction })[] =
  (Object.entries(HOTKEYS) as [HotkeyAction, HotkeyDefinition][]).map(
    ([action, definition]) => ({ action, ...definition }),
  );

/**
 * Hotkeys worth showing in the shortcuts reference: some actions are declared
 * here without a binding yet (`keys: null`), and listing those would just be
 * a row with a blank chip. The quick-actions palette leads the list — it is
 * the gateway to every other action, so it gets top billing.
 */
export function getDisplayableHotkeys(): DisplayableHotkey[] {
  const bound: DisplayableHotkey[] = [];
  for (const { action, keys, label, description } of HOTKEY_LIST) {
    if (keys !== null) bound.push({ action, keys, label, description });
  }
  return [
    ...bound.filter((hotkey) => hotkey.action === "commandPalette"),
    ...bound.filter((hotkey) => hotkey.action !== "commandPalette"),
  ];
}
