import { describe, expect, it } from "vitest";
import {
  getEmojiForShortcode,
  replaceEmojiShortcodes,
} from "../src/app/lib/emoji-shortcodes";

describe("emoji shortcodes", () => {
  it("replaces supported shortcuts, including several in one message", () => {
    expect(replaceEmojiShortcodes(":cry:")).toBe("😢");
    expect(replaceEmojiShortcodes("ship it :rocket: :tada: :+1:")).toBe(
      "ship it 🚀 🎉 👍",
    );
    expect(replaceEmojiShortcodes(":fire::fire:")).toBe("🔥🔥");
    expect(replaceEmojiShortcodes(":Smile:")).toBe("😄");
  });

  it("leaves unknown and malformed shortcuts as typed", () => {
    expect(replaceEmojiShortcodes(":notanemoji:")).toBe(":notanemoji:");
    expect(replaceEmojiShortcodes(":smile")).toBe(":smile");
    expect(replaceEmojiShortcodes(": smile :")).toBe(": smile :");
    expect(replaceEmojiShortcodes("::")).toBe("::");
    expect(replaceEmojiShortcodes("meet at 10:30:15")).toBe("meet at 10:30:15");
    expect(replaceEmojiShortcodes(":constructor:")).toBe(":constructor:");
    expect(getEmojiForShortcode("__proto__")).toBeUndefined();
  });

  it("lets a closing colon of an unknown name start a known one", () => {
    expect(replaceEmojiShortcodes(":nope:smile:")).toBe(":nope😄");
  });

  it("does not touch links", () => {
    expect(
      replaceEmojiShortcodes("see https://example.com/a:smile:b :smile:"),
    ).toBe("see https://example.com/a:smile:b 😄");
  });

  it("keeps existing Unicode emoji and plain text unchanged", () => {
    expect(replaceEmojiShortcodes("already 😄 here")).toBe("already 😄 here");
    expect(replaceEmojiShortcodes("no colons")).toBe("no colons");
  });
});
