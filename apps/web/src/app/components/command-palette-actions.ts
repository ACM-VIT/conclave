import type { RegisterableHotkey } from "@tanstack/hotkeys";
import {
  AudioLines,
  Bot,
  Copy,
  FlipHorizontal2,
  Globe,
  Keyboard,
  Link2,
  Lock,
  LockOpen,
  MessageSquare,
  MessagesSquare,
  Mic,
  PhoneOff,
  Shield,
  Smile,
  UserCheck,
  UserX,
  Video,
  Volume2,
  VolumeX,
  type LucideIcon,
} from "lucide-react";
import { HOTKEYS } from "../lib/hotkeys";
import { CONCLAVE_MENTION_TOKEN } from "../lib/conclave-assistant";
import {
  buildControlsConfig,
  type ControlsBarProps,
} from "./controls-config";

interface PaletteDevice {
  deviceId: string;
  label: string;
}

export interface PaletteDevices {
  audioInput: PaletteDevice[];
  audioOutput: PaletteDevice[];
  videoInput: PaletteDevice[];
}

export interface PaletteAction {
  id: string;
  section: string;
  label: string;
  keywords: string;
  icon?: LucideIcon;
  reaction?: { kind: "emoji" | "asset"; value: string };
  hotkey?: RegisterableHotkey;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}

export const PALETTE_SECTIONS = [
  "Controls",
  "Panels",
  "Apps & tools",
  "AI",
  "Reactions",
  "Devices",
  "Host",
  "Meeting",
  "Help",
  "Use what you typed",
] as const;

export const FALLBACK_SECTION = "Use what you typed";

const ROW_KEYWORDS: Record<string, string> = {
  mic: "mute unmute microphone audio silence",
  camera: "video cam webcam on off",
  hand: "raise lower hand",
  "screen-share": "present presentation share screen stop",
  chat: "chat messages send message text",
  participants: "people members attendees who",
  games: "games play chess wordle trivia long shot bluff imposter",
  transcript: "captions transcript subtitles cc",
  "host-controls": "host admin moderation settings",
  popout: "mini view picture in picture pip popout floating",
  effects: "backgrounds effects filters blur virtual",
  "adjust-view": "layout grid view tiles arrange",
  "browser-audio": "browser sound audio volume",
  whiteboard: "whiteboard draw sketch board",
  watch: "watch together youtube video party",
  "dev-playground": "dev playground code sandbox",
  "apps-lock": "lock unlock apps editing",
  settings: "settings devices test mic microphone camera speaker gain connection quality stats network",
};

const EMOJI_KEYWORDS: Record<string, string> = {
  "👍": "thumbsup thumbs up like +1 approve yes agree",
  "👎": "thumbsdown thumbs down dislike -1 no disagree",
  "👏": "clap clapping applause bravo",
  "😂": "joy laugh lol funny haha tears crying laughing",
  "🤣": "rofl laughing rolling lol funny",
  "❤": "heart love red like",
  "🎉": "tada party popper celebrate confetti congrats hooray",
  "😮": "wow surprised shocked omg open mouth",
  "😢": "cry sad tear upset",
  "🙏": "pray thanks thank you please folded hands namaste",
  "🔥": "fire lit hot flame",
  "💯": "hundred 100 percent perfect",
  "✋": "hand raised highfive high five stop",
  "🙌": "raised hands hooray praise celebration",
  "😍": "heart eyes love adore",
  "🤔": "thinking hmm hm consider",
  "👌": "ok okay perfect fine",
  "💪": "muscle strong flex biceps",
  "😎": "cool sunglasses",
  "🥳": "party face celebrate birthday",
  "✨": "sparkles magic shiny",
  "😀": "grin grinning smile happy",
  "😊": "smile blush happy",
};

const EMOJI_VARIANT_SELECTORS = new RegExp(
  `[${String.fromCharCode(0xfe0e)}${String.fromCharCode(0xfe0f)}]`,
  "g",
);
const stripEmojiVariants = (value: string): string =>
  value.replace(EMOJI_VARIANT_SELECTORS, "");

const NORMALIZED_EMOJI_KEYWORDS: Record<string, string> = Object.fromEntries(
  Object.entries(EMOJI_KEYWORDS).map(([emoji, names]) => [
    stripEmojiVariants(emoji),
    names,
  ]),
);

function reactionKeywords(reaction: {
  kind: "emoji" | "asset";
  value: string;
  label: string;
}): string {
  const names =
    reaction.kind === "emoji"
      ? (NORMALIZED_EMOJI_KEYWORDS[stripEmojiVariants(reaction.value)] ?? "")
      : "";
  return `reaction emoji send react ${names}`.trim();
}

export function buildPaletteActions(
  p: ControlsBarProps,
  devices: PaletteDevices,
  extras: {
    onCopyMeetingCode?: () => void;
    onCopyMeetingLink?: () => void;
    onShowShortcuts?: () => void;
  } = {},
): PaletteAction[] {
  const actions: PaletteAction[] = [];
  const config = buildControlsConfig({ ...p, compact: false, slim: false });

  for (const d of config.center) {
    if (!d.onPress) continue;
    actions.push({
      id: d.id,
      section: "Controls",
      label: d.label,
      keywords: ROW_KEYWORDS[d.id] ?? "",
      icon: d.icon,
      hotkey: d.hotkey,
      active: d.variant === "active",
      disabled: d.disabled || d.loading,
      run: d.onPress,
    });
  }

  for (const d of config.left) {
    if (!d.onPress) continue;
    actions.push({
      id: d.id,
      section: "Panels",
      label: d.label,
      keywords: ROW_KEYWORDS[d.id] ?? "",
      icon: d.icon,
      hotkey: d.hotkey,
      active: d.variant === "active",
      disabled: d.disabled,
      run: d.onPress,
    });
  }
  if (p.isAdmin && p.onToggleHostControls) {
    actions.push({
      id: "host-controls",
      section: "Panels",
      label: "Host controls",
      keywords: ROW_KEYWORDS["host-controls"],
      icon: Shield,
      active: Boolean(p.isHostControlsOpen),
      run: p.onToggleHostControls,
    });
  }

  for (const row of config.overflow) {
    if (!row.onPress) continue;
    if (row.id === "voice-agent") continue;
    actions.push({
      id: row.id,
      section: "Apps & tools",
      label: row.label,
      keywords: ROW_KEYWORDS[row.id] ?? "",
      icon: row.icon,
      hotkey: row.hotkey,
      active: row.active,
      disabled: row.disabled,
      run: row.onPress,
    });
  }
  const voiceAgentHandler = p.isVoiceAgentRunning
    ? p.onStopVoiceAgent
    : p.onStartVoiceAgent;
  if (voiceAgentHandler) {
    actions.push({
      id: "voice-agent",
      section: "AI",
      label: p.isVoiceAgentRunning
        ? "Stop AI voice agent"
        : p.isVoiceAgentStarting
          ? "AI voice agent is starting…"
          : "Start AI voice agent",
      keywords: "ai assistant voice agent bot companion",
      icon: AudioLines,
      active: Boolean(p.isVoiceAgentRunning),
      disabled: Boolean(p.isVoiceAgentStarting),
      run: voiceAgentHandler,
    });
  }

  if (p.reactionOptions.length > 0 && (!p.isReactionsDisabled || p.isAdmin)) {
    for (const reaction of p.reactionOptions) {
      actions.push({
        id: `reaction-${reaction.id}`,
        section: "Reactions",
        label: `React with ${reaction.label}`,
        keywords: reactionKeywords(reaction),
        reaction: { kind: reaction.kind, value: reaction.value },
        run: () => p.onSendReaction(reaction),
      });
    }
  }

  if (p.onAudioInputDeviceChange) {
    for (const device of devices.audioInput) {
      actions.push({
        id: `device-mic-${device.deviceId}`,
        section: "Devices",
        label: `Microphone: ${device.label}`,
        keywords: "device switch change input audio mic",
        icon: Mic,
        active: device.deviceId === p.selectedAudioInputDeviceId,
        run: () => p.onAudioInputDeviceChange?.(device.deviceId),
      });
    }
  }
  if (p.onAudioOutputDeviceChange) {
    for (const device of devices.audioOutput) {
      actions.push({
        id: `device-speaker-${device.deviceId}`,
        section: "Devices",
        label: `Speaker: ${device.label}`,
        keywords: "device switch change output audio sound",
        icon: Volume2,
        active: device.deviceId === p.selectedAudioOutputDeviceId,
        run: () => p.onAudioOutputDeviceChange?.(device.deviceId),
      });
    }
  }
  if (p.onVideoInputDeviceChange) {
    for (const device of devices.videoInput) {
      actions.push({
        id: `device-camera-${device.deviceId}`,
        section: "Devices",
        label: `Camera: ${device.label}`,
        keywords: "device switch change video webcam",
        icon: Video,
        active: device.deviceId === p.selectedVideoInputDeviceId,
        run: () => p.onVideoInputDeviceChange?.(device.deviceId),
      });
    }
  }
  if (p.onToggleMirror) {
    actions.push({
      id: "mirror-camera",
      section: "Devices",
      label: p.isMirrorCamera ? "Stop mirroring my camera" : "Mirror my camera",
      keywords: "mirror flip camera video",
      icon: FlipHorizontal2,
      active: Boolean(p.isMirrorCamera),
      run: p.onToggleMirror,
    });
  }

  if (p.isAdmin) {
    if (p.onToggleLock) {
      actions.push({
        id: "lock-meeting",
        section: "Host",
        label: p.isRoomLocked ? "Unlock meeting" : "Lock meeting",
        keywords: "lock unlock room meeting joins",
        icon: p.isRoomLocked ? LockOpen : Lock,
        hotkey: HOTKEYS.toggleLockMeeting.keys,
        active: Boolean(p.isRoomLocked),
        run: p.onToggleLock,
      });
    }
    if (p.onToggleNoGuests) {
      actions.push({
        id: "no-guests",
        section: "Host",
        label: p.isNoGuests ? "Allow guest joins" : "Block guest joins",
        keywords: "guests anonymous signed in only",
        icon: p.isNoGuests ? UserCheck : UserX,
        active: Boolean(p.isNoGuests),
        run: p.onToggleNoGuests,
      });
    }
    if (p.onToggleChatLock) {
      actions.push({
        id: "chat-lock",
        section: "Host",
        label: p.isChatLocked ? "Unlock chat" : "Lock chat",
        keywords: "chat lock mute messages",
        icon: MessageSquare,
        active: Boolean(p.isChatLocked),
        run: p.onToggleChatLock,
      });
    }
    if (p.onToggleReactionsDisabled) {
      actions.push({
        id: "reactions-toggle",
        section: "Host",
        label: p.isReactionsDisabled ? "Enable reactions" : "Disable reactions",
        keywords: "reactions emoji allow block",
        icon: Smile,
        active: !p.isReactionsDisabled,
        run: p.onToggleReactionsDisabled,
      });
    }
    if (p.onToggleDmEnabled) {
      actions.push({
        id: "dm-toggle",
        section: "Host",
        label: p.isDmEnabled
          ? "Disable direct messages"
          : "Enable direct messages",
        keywords: "dm direct messages private",
        icon: MessagesSquare,
        active: Boolean(p.isDmEnabled),
        run: p.onToggleDmEnabled,
      });
    }
    if (p.onToggleTtsDisabled) {
      actions.push({
        id: "tts-toggle",
        section: "Host",
        label: p.isTtsDisabled
          ? "Enable text-to-speech"
          : "Disable text-to-speech",
        keywords: "tts text to speech read aloud",
        icon: p.isTtsDisabled ? VolumeX : Volume2,
        active: !p.isTtsDisabled,
        run: p.onToggleTtsDisabled,
      });
    }
  }

  if (p.roomId && extras.onCopyMeetingCode) {
    actions.push({
      id: "copy-code",
      section: "Meeting",
      label: "Copy meeting code",
      keywords: "copy room code id invite",
      icon: Copy,
      run: extras.onCopyMeetingCode,
    });
  }
  if (p.roomId && extras.onCopyMeetingLink) {
    actions.push({
      id: "copy-link",
      section: "Meeting",
      label: "Copy meeting link",
      keywords: "copy invite link url share",
      icon: Link2,
      run: extras.onCopyMeetingLink,
    });
  }
  actions.push({
    id: "leave",
    section: "Meeting",
    label: "Leave call",
    keywords: "leave exit quit hang up call meeting",
    icon: PhoneOff,
    danger: true,
    run: p.onLeave,
  });
  if (p.isAdmin && p.onEndForEveryone) {
    actions.push({
      id: "end-for-everyone",
      section: "Meeting",
      label: "End call for everyone",
      keywords: "end call everyone close meeting terminate",
      icon: PhoneOff,
      danger: true,
      run: p.onEndForEveryone,
    });
  }

  if (extras.onShowShortcuts) {
    actions.push({
      id: "shortcuts-help",
      section: "Help",
      label: "View keyboard shortcuts",
      keywords: "help hotkeys keys bindings cheatsheet",
      icon: Keyboard,
      hotkey: HOTKEYS.shortcutsHelp.keys,
      run: extras.onShowShortcuts,
    });
  }

  return actions;
}

function tokenScore(
  token: string,
  label: string,
  labelWords: string[],
  rest: string,
): number {
  if (label.startsWith(token)) return 4;
  if (labelWords.some((word) => word.startsWith(token))) return 3;
  if (label.includes(token)) return 2;
  if (rest.includes(token)) return 1;
  return 0;
}

export function filterPaletteActions(
  actions: PaletteAction[],
  query: string,
): PaletteAction[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return actions;

  const ranked: { action: PaletteAction; score: number; order: number }[] = [];
  actions.forEach((action, order) => {
    const label = action.label.toLowerCase();
    const labelWords = label.split(/[\s:/-]+/);
    const rest = `${action.section} ${action.keywords}`.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      const s = tokenScore(token, label, labelWords, rest);
      if (s === 0) return;
      score += s;
    }
    ranked.push({ action, score, order });
  });
  ranked.sort((a, b) => b.score - a.score || a.order - b.order);
  return ranked.map((entry) => entry.action);
}

export function buildQueryFallbackActions(
  query: string,
  p: ControlsBarProps,
  extras: { onSendChatMessage?: (content: string) => void } = {},
): PaletteAction[] {
  const text = query.trim();
  if (!text) return [];
  const actions: PaletteAction[] = [];

  if (extras.onSendChatMessage) {
    const sendToChat = (content: string) => {
      extras.onSendChatMessage?.(content);
      if (!p.isChatOpen) p.onToggleChat();
    };
    actions.push({
      id: "fallback-send-chat",
      section: FALLBACK_SECTION,
      label: `Send to chat: “${text}”`,
      keywords: "",
      icon: MessageSquare,
      run: () => sendToChat(text),
    });
    actions.push({
      id: "fallback-ask-ai",
      section: FALLBACK_SECTION,
      label: `Ask Conclave AI: “${text}”`,
      keywords: "",
      icon: Bot,
      run: () => sendToChat(`@${CONCLAVE_MENTION_TOKEN} ${text}`),
    });
  }

  if (
    p.showBrowserControls &&
    p.isAdmin &&
    p.onLaunchBrowser &&
    !p.isBrowserActive
  ) {
    actions.push({
      id: "fallback-search-together",
      section: FALLBACK_SECTION,
      label: `Search together: “${text}”`,
      keywords: "",
      icon: Globe,
      disabled: p.isBrowserLaunching,
      run: () =>
        void p.onLaunchBrowser?.(
          `https://www.google.com/search?q=${encodeURIComponent(text)}`,
        ),
    });
  }

  return actions;
}
