import { describe, expect, it } from "vitest";
import { parseCodeFieldPaste, sanitizeRoomCode } from "../src/app/lib/utils";

const KNOWN_HOSTS = ["conclave.acmvit.in", "localhost:3615"];

const parse = (text: string) => parseCodeFieldPaste(text, KNOWN_HOSTS);

const linkCode = (text: string) => {
  const paste = parse(text);
  return paste?.kind === "replace" ? paste.code : null;
};

const APP_PAGES = new Set([
  "null",
  "undefined",
  "delete-account",
  "privacy",
  "schedule",
  "sfu-admin",
  "sign-in",
]);

const expectedReplacement = (text: string): string | null => {
  const trimmed = text.trim();
  const scheme = /^https?:\/\//i.exec(trimmed);
  const rest = scheme ? trimmed.slice(scheme[0].length) : trimmed;
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const host = rest.slice(0, slash);
  if (!scheme && !KNOWN_HOSTS.includes(host.toLowerCase())) return null;
  const path = rest.slice(slash).split(/[?#]/)[0];
  const segment = /^\/([^/]+)\/?$/.exec(path)?.[1];
  if (!segment) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (!/^[a-z0-9-]+$/i.test(decoded)) return null;
  const code = decoded.toLowerCase();
  return !APP_PAGES.has(code) && sanitizeRoomCode(code) === code ? code : null;
};

const seededRandom = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const PIECES = [
  "11", "23", "2026", "11/23", "2026/11/23", "11/23/2026", "1/2", "100/abc",
  "10.0.0.1", "127.0.0.1:3005", "999.999.999.999", "[::1]", "[:::]",
  "m\u00fcnchen.example", "xn--mnchen-3ya.example", "meet.example", "conclave.app",
  "conclave.acmvit.in", "Conclave.ACMVIT.in", "localhost:3615", "localhost:3005", "localhost",
  "abc-defg-hij", "WXYZ", "new-", "-abc", "sign-in", "null", "w",
  "%2F", "%41bc", "%E0%A4%A", "%2e%2e",
  " ", "  ", "\n", "\t",
  "http:", "https:", "http:/", "https://", "http://", "//", "www.", "javascript:", "mailto:",
  "/", "/", "/", "?", "#", ".", "..", ":", "@", "\\", "?ref=chat", "#top",
  "\u212A",
];

const SCHEMES = ["", "", "", "https://", "http://", "HTTPS://", "//", "http:/", "javascript:", "ftp://", " "];
const HOSTS = [
  "conclave.acmvit.in", "Conclave.ACMVIT.in", "localhost:3615", "localhost:3005", "localhost",
  "11", "2026", "10.0.0.1", "127.0.0.1:3005", "[::1]", "m\u00fcnchen.example", "meet.example",
  "conclave.app", "999.999.999.999", "user@meet.example", "", " ",
];
const SEGMENTS = [
  "abc-defg-hij", "23", "WXYZ", "sign-in", "null", "w/public-slug", "abc%2Ddefg", "%2F", "%E0%A4%A",
  "", "abc--defg", "\u212A-abc", "abc_defg", "a b",
];
const SUFFIXES = ["", "", "", "/", "?ref=chat", "#top", "//", " ", "\\", "\n"];

describe("pasting into the join code field", () => {
  it("replaces the field with the code from an explicit http or https link", () => {
    expect(linkCode("https://meet.example.com/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("http://localhost:3005/abc-defg-hij/")).toBe("abc-defg-hij");
    expect(linkCode("  HTTPS://Meet.Example.com/Abc-Defg-Hij  ")).toBe("abc-defg-hij");
    expect(linkCode("https://meet.example.com/abc-defg-hij?ref=chat#top")).toBe("abc-defg-hij");
    expect(linkCode("https://m\u00fcnchen.example/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("https://devbox:3005/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("https://127.0.0.1:3005/abc-defg-hij")).toBe("abc-defg-hij");
  });

  it("replaces the field from a Conclave link without a scheme", () => {
    expect(linkCode("conclave.acmvit.in/abc-defg-hij?ref=chat")).toBe("abc-defg-hij");
    expect(linkCode("Conclave.ACMVIT.in/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("localhost:3615/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("conclave.acmvit.in/abc%2Ddefg")).toBe("abc-defg");
  });

  it("never treats other text with a slash as a link", () => {
    for (const text of [
      "11/23",
      "2026/11/23",
      "1/2",
      "10.0.0.1/abc-defg-hij",
      "conclave.app/abc-defg-hij",
      "meet.example/abc-defg-hij",
      "m\u00fcnchen.example/abc-defg-hij",
      "xn--mnchen-3ya.example/abc-defg-hij",
      "[::1]/abc-defg-hij",
      "devbox:3005/abc-defg-hij",
      "localhost:3005/abc-defg-hij",
      "//meet.example.com/abc-defg-hij",
      "/abc-defg-hij",
      "abc/defg",
      "javascript:/abc-defg-hij",
      "javascript://meet.example.com/abc-defg-hij",
      "javascript:123/abc-defg-hij",
      "ftp://meet.example.com/abc-defg-hij",
      "https://user@meet.example.com/abc-defg-hij",
    ]) {
      expect(parse(text), JSON.stringify(text)).toBeNull();
    }
  });

  it("finds no code in a link that has none or points elsewhere", () => {
    for (const text of [
      "https://meet.example.com/",
      "conclave.acmvit.in/",
      "conclave.acmvit.in/?code=abc-defg-hij",
      "https://meet.example.com/w/public-slug",
      "https://meet.example.com/w/%2e%2e/abc-defg-hij",
      "https://meet.example.com//abc-defg-hij",
      "conclave.acmvit.in/abc-defg-hij//",
      "conclave.acmvit.in/abc_defg",
      "conclave.acmvit.in/abc%2Fdefg",
      "conclave.acmvit.in/abc%E0%A4%A",
      "https://conclave.acmvit.in/sign-in",
      "conclave.acmvit.in/privacy",
      "conclave.acmvit.in/null",
      "https://meet.example/\u212A-abc",
    ]) {
      expect(parse(text), JSON.stringify(text)).toBeNull();
    }
  });

  it("rejects links a browser could not open", () => {
    for (const text of [
      "https://[:::]/abc-defg-hij",
      "https://999.999.999.999/abc-defg-hij",
      "https://meet..example/abc-defg-hij",
      "https://./abc-defg-hij",
      "https://localhost:65536/abc-defg-hij",
      "https://meet.example/abc-defg-hij?ref=a\\b",
      `https://${"a".repeat(64)}.example/abc-defg-hij`,
      `https://${"a".repeat(100_000)}.example/abc`,
    ]) {
      expect(parse(text), JSON.stringify(text).slice(0, 80)).toBeNull();
    }
    const longestName = [61, 63, 63, 63].map((n) => "a".repeat(n)).join(".");
    expect(longestName).toHaveLength(253);
    expect(linkCode(`https://${longestName}./abc-defg-hij`)).toBe("abc-defg-hij");
    expect(linkCode(`https://a${longestName}/abc-defg-hij`)).toBeNull();
  });

  it("inserts pasted room code characters where the cursor is", () => {
    expect(parse("abc-defg-hij")).toEqual({ kind: "insert", text: "abc-defg-hij" });
    expect(parse("  WXYZ \n")).toEqual({ kind: "insert", text: "wxyz" });
    expect(parse("new-")).toEqual({ kind: "insert", text: "new-" });
    expect(parse("-abc")).toEqual({ kind: "insert", text: "-abc" });
  });

  it("ignores text that is neither room code characters nor a Conclave link", () => {
    for (const text of [
      "",
      "   ",
      "meet.example",
      "mailto:guest@example.com",
      "tel:+15555550123",
      "data:text/plain,abc-defg-hij",
      "see you at the standup",
      "meet.example\\abc-defg-hij",
      "\u212A-abc",
    ]) {
      expect(parse(text), JSON.stringify(text)).toBeNull();
    }
  });

  it("only replaces the field when the text is unambiguously a Conclave meeting link", () => {
    const random = seededRandom(310);
    let replacements = 0;
    const pick = (items: readonly string[]) => items[Math.floor(random() * items.length)];
    for (let run = 0; run < 20_000; run += 1) {
      let text = "";
      if (random() < 0.5) {
        text = `${pick(SCHEMES)}${pick(HOSTS)}/${pick(SEGMENTS)}${pick(SUFFIXES)}`;
      } else {
        const count = 1 + Math.floor(random() * 6);
        for (let i = 0; i < count; i += 1) text += pick(PIECES);
      }
      const paste = parse(text);
      if (paste?.kind !== "replace") continue;
      replacements += 1;
      expect(expectedReplacement(text), JSON.stringify(text)).toBe(paste.code);
    }
    expect(replacements).toBeGreaterThan(500);
  });
});
