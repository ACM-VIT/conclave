import { describe, expect, it } from "vitest";
import {
  CHAT_COMMANDS,
  createLocalChatMessage,
  formatActionContent,
  formatTtsContent,
  getActionText,
  getCommandSuggestions,
  getHelpText,
  getTtsText,
  normalizeChatMessage,
  parseChatCommand,
} from "../src/chat-commands";
import type { ChatMessage } from "../src/types";

const baseMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1",
  userId: "u1",
  displayName: "Alice",
  content: "hello",
  timestamp: 1700000000000,
  ...overrides,
});

describe("getCommandSuggestions", () => {
  it("returns nothing for non-slash input", () => {
    expect(getCommandSuggestions("hello")).toEqual([]);
    expect(getCommandSuggestions("")).toEqual([]);
  });

  it("returns the full list for a bare slash", () => {
    expect(getCommandSuggestions("/")).toBe(CHAT_COMMANDS);
  });

  it("filters by label prefix", () => {
    const ids = getCommandSuggestions("/m").map((c) => c.id);
    expect(ids).toContain("me");
    expect(ids).toContain("mute");
    expect(ids).not.toContain("help");
  });

  it("is case-insensitive", () => {
    expect(getCommandSuggestions("/HE").map((c) => c.id)).toEqual(["help"]);
  });

  it("stops suggesting once a space is typed (command is complete)", () => {
    expect(getCommandSuggestions("/dm ")).toEqual([]);
    expect(getCommandSuggestions("/tts hello")).toEqual([]);
  });

  it("returns an empty list for an unmatched prefix", () => {
    expect(getCommandSuggestions("/zzz")).toEqual([]);
  });
});

describe("parseChatCommand", () => {
  it("returns null for plain text", () => {
    expect(parseChatCommand("just chatting")).toBeNull();
  });

  it("returns null for a lone slash", () => {
    expect(parseChatCommand("/")).toBeNull();
    expect(parseChatCommand("/   ")).toBeNull();
  });

  it("parses an argument-free command with empty args", () => {
    const parsed = parseChatCommand("/mute");
    expect(parsed?.command.id).toBe("mute");
    expect(parsed?.args).toBe("");
  });

  it("parses a command and trims/joins its arguments", () => {
    const parsed = parseChatCommand("/dm   bob   hey there ");
    expect(parsed?.command.id).toBe("dm");
    expect(parsed?.args).toBe("bob hey there");
  });

  it("is case-insensitive on the command label", () => {
    expect(parseChatCommand("/MUTE")?.command.id).toBe("mute");
  });

  it("returns null for an unknown command", () => {
    expect(parseChatCommand("/banana split")).toBeNull();
  });

  it("recognizes the /action alias", () => {
    expect(parseChatCommand("/action waves")?.command.id).toBe("action");
  });
});

describe("getTtsText", () => {
  it("extracts trimmed text after /tts", () => {
    expect(getTtsText("/tts  hello world ")).toBe("hello world");
  });

  it("is case-insensitive on the /tts prefix", () => {
    expect(getTtsText("/TTS speak up")).toBe("speak up");
  });

  it("returns null when there is no text", () => {
    expect(getTtsText("/tts")).toBeNull();
    expect(getTtsText("/tts    ")).toBeNull();
  });

  it("returns null for non-tts content", () => {
    expect(getTtsText("hello")).toBeNull();
  });
});

describe("getActionText", () => {
  it("extracts text after /me", () => {
    expect(getActionText("/me waves hello")).toBe("waves hello");
  });

  it("extracts text after /action alias", () => {
    expect(getActionText("/action nods")).toBe("nods");
  });

  it("supports the leading-asterisk shorthand", () => {
    expect(getActionText("* shrugs")).toBe("shrugs");
  });

  it("returns null for a bare asterisk with no text", () => {
    expect(getActionText("* ")).toBeNull();
  });

  it("returns null for plain text", () => {
    expect(getActionText("hello")).toBeNull();
  });

  it("returns null for /me with no body", () => {
    expect(getActionText("/me")).toBeNull();
  });
});

describe("formatters", () => {
  it("formatTtsContent prefixes TTS:", () => {
    expect(formatTtsContent("hi")).toBe("TTS: hi");
  });

  it("formatActionContent prefixes /me", () => {
    expect(formatActionContent("waves")).toBe("/me waves");
  });
});

describe("normalizeChatMessage", () => {
  it("rewrites a /tts message and surfaces ttsText", () => {
    const result = normalizeChatMessage(baseMessage({ content: "/tts hi there" }));
    expect(result.ttsText).toBe("hi there");
    expect(result.message.content).toBe("TTS: hi there");
  });

  it("passes a normal message through untouched", () => {
    const msg = baseMessage({ content: "hello" });
    const result = normalizeChatMessage(msg);
    expect(result.ttsText).toBeUndefined();
    expect(result.message).toBe(msg);
  });

  it("never applies TTS to a direct message", () => {
    const msg = baseMessage({ content: "/tts secret", isDirect: true });
    const result = normalizeChatMessage(msg);
    expect(result.ttsText).toBeUndefined();
    expect(result.message).toBe(msg);
  });
});

describe("getHelpText", () => {
  it("lists every command's usage", () => {
    const help = getHelpText();
    expect(help.startsWith("Commands: ")).toBe(true);
    for (const command of CHAT_COMMANDS) {
      expect(help).toContain(command.usage);
    }
  });
});

describe("createLocalChatMessage", () => {
  it("creates a system-attributed message with the given content", () => {
    const msg = createLocalChatMessage("local note");
    expect(msg.userId).toBe("system");
    expect(msg.displayName).toBe("System");
    expect(msg.content).toBe("local note");
    expect(msg.id.startsWith("local-")).toBe(true);
    expect(typeof msg.timestamp).toBe("number");
  });

  it("generates unique ids across calls", () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => createLocalChatMessage("x").id),
    );
    expect(ids.size).toBe(50);
  });
});
