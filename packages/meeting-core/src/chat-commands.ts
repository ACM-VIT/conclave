import type { ChatMessage } from "./types";

export type ChatCommandId =
  | "help"
  | "tts"
  | "me"
  | "action"
  | "raise"
  | "lower"
  | "mute"
  | "unmute"
  | "camera"
  | "leave"
  | "clear";

export interface ChatCommand {
  id: ChatCommandId;
  label: string;
  description: string;
  usage: string;
  insertText: string;
}

export const CHAT_COMMANDS: ChatCommand[] = [
  {
    id: "help",
    label: "help",
    description: "Show available commands",
    usage: "/help",
    insertText: "/help",
  },
  {
    id: "tts",
    label: "tts",
    description: "Speak text to the room",
    usage: "/tts <text>",
    insertText: "/tts ",
  },
  {
    id: "me",
    label: "me",
    description: "Send an action message",
    usage: "/me <action>",
    insertText: "/me ",
  },
  {
    id: "action",
    label: "action",
    description: "Alias for /me",
    usage: "/action <action>",
    insertText: "/action ",
  },
  {
    id: "raise",
    label: "raise",
    description: "Raise your hand",
    usage: "/raise",
    insertText: "/raise",
  },
  {
    id: "lower",
    label: "lower",
    description: "Lower your hand",
    usage: "/lower",
    insertText: "/lower",
  },
  {
    id: "mute",
    label: "mute",
    description: "Mute your mic",
    usage: "/mute",
    insertText: "/mute",
  },
  {
    id: "unmute",
    label: "unmute",
    description: "Unmute your mic",
    usage: "/unmute",
    insertText: "/unmute",
  },
  {
    id: "camera",
    label: "camera",
    description: "Control your camera",
    usage: "/camera on|off|toggle",
    insertText: "/camera ",
  },
  {
    id: "leave",
    label: "leave",
    description: "Leave the meeting",
    usage: "/leave",
    insertText: "/leave",
  },
  {
    id: "clear",
    label: "clear",
    description: "Clear your local chat",
    usage: "/clear",
    insertText: "/clear",
  },
];

export function getCommandSuggestions(input: string): ChatCommand[] {
  if (!input.startsWith("/")) return [];
  const raw = input.slice(1);
  if (/\s/.test(raw)) return [];
  const query = raw.trim().toLowerCase();
  if (!query) return CHAT_COMMANDS;
  return CHAT_COMMANDS.filter((command) => command.label.startsWith(query));
}

export function parseChatCommand(
  input: string
): { command: ChatCommand; args: string } | null {
  if (!input.startsWith("/")) return null;
  const trimmed = input.slice(1).trim();
  if (!trimmed) return null;
  const [label, ...rest] = trimmed.split(/\s+/);
  const command = CHAT_COMMANDS.find((item) => item.label === label.toLowerCase());
  if (!command) return null;
  return { command, args: rest.join(" ").trim() };
}

export function getHelpText(): string {
  const items = CHAT_COMMANDS.map((command) => command.usage).join(", ");
  return `Commands: ${items}`;
}

export function getTtsText(content: string): string | null {
  const match = content.match(/^\/tts\s+(.+)/i);
  if (!match) return null;
  const text = match[1]?.trim();
  return text ? text : null;
}

export function formatTtsContent(text: string): string {
  return `TTS: ${text}`;
}

export function getActionText(content: string): string | null {
  const trimmed = content.trim();
  const match = trimmed.match(/^\/(me|action)\s+(.+)/i);
  if (match?.[2]) return match[2].trim();
  if (trimmed.startsWith("* ")) {
    const text = trimmed.slice(2).trim();
    return text || null;
  }
  return null;
}

export function normalizeChatMessage(message: ChatMessage): {
  message: ChatMessage;
  ttsText?: string;
} {
  if (message.isDirect) {
    return { message };
  }
  const ttsText = getTtsText(message.content);
  if (!ttsText) return { message };
  return {
    message: { ...message, content: formatTtsContent(ttsText) },
    ttsText,
  };
}

export function createLocalChatMessage(content: string): ChatMessage {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId: "system",
    displayName: "System",
    content,
    timestamp: Date.now(),
  };
}

export function formatActionContent(text: string): string {
  return `/me ${text}`;
}
