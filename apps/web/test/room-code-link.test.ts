import { describe, expect, it } from "vitest";
import { roomCodeFromPaste } from "../src/app/lib/utils";

describe("pasting into the join code field", () => {
  it("keeps the room code from a full link", () => {
    expect(roomCodeFromPaste("https://meet.example.com/abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromPaste("http://localhost:3005/abc-defg-hij/")).toBe("abc-defg-hij");
    expect(roomCodeFromPaste("//meet.example.com/abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromPaste("  HTTPS://Meet.Example.com/Abc-Defg-Hij  ")).toBe(
      "abc-defg-hij",
    );
  });

  it("ignores the query and hash", () => {
    expect(roomCodeFromPaste("https://meet.example.com/abc-defg-hij?ref=chat#top")).toBe(
      "abc-defg-hij",
    );
  });

  it("accepts a link without a scheme", () => {
    expect(roomCodeFromPaste("conclave.app/abc-defg-hij?ref=chat")).toBe("abc-defg-hij");
    expect(roomCodeFromPaste("localhost:3005/abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromPaste("[::1]/abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromPaste("[::1]:3005/abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromPaste("/abc-defg-hij")).toBe("abc-defg-hij");
  });

  it("decodes the code once", () => {
    expect(roomCodeFromPaste("conclave.app/abc%2Ddefg")).toBe("abc-defg");
    expect(roomCodeFromPaste("conclave.app/abc%2Fdefg")).toBeNull();
    expect(roomCodeFromPaste("conclave.app/abc%E0%A4%A")).toBeNull();
  });

  it("finds no code in a link that has none", () => {
    expect(roomCodeFromPaste("https://meet.example.com/")).toBeNull();
    expect(roomCodeFromPaste("conclave.app/")).toBeNull();
    expect(roomCodeFromPaste("conclave.app/?code=abc-defg-hij")).toBeNull();
  });

  it("finds no code in a link to another page", () => {
    expect(roomCodeFromPaste("https://meet.example.com/w/public-slug")).toBeNull();
    expect(roomCodeFromPaste("https://meet.example.com/w/%2e%2e/abc-defg-hij")).toBeNull();
    expect(roomCodeFromPaste("https://meet.example.com//abc-defg-hij")).toBeNull();
    expect(roomCodeFromPaste("/abc-defg-hij//")).toBeNull();
    expect(roomCodeFromPaste("conclave.app/abc_defg")).toBeNull();
    expect(roomCodeFromPaste("abc/defg")).toBeNull();
  });

  it("finds no code in a link to an app page or a placeholder", () => {
    expect(roomCodeFromPaste("https://conclave.app/sign-in")).toBeNull();
    expect(roomCodeFromPaste("conclave.app/privacy")).toBeNull();
    expect(roomCodeFromPaste("/null")).toBeNull();
    expect(roomCodeFromPaste("/undefined")).toBeNull();
  });

  it("accepts any host a browser can open after an explicit prefix", () => {
    expect(roomCodeFromPaste("https://devbox/abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromPaste("//devbox/abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromPaste("https://devbox:3005/abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromPaste("https://conclave.app./abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromPaste("conclave.app./abc-defg-hij")).toBe("abc-defg-hij");
  });

  it("rejects hosts a browser could not open", () => {
    expect(roomCodeFromPaste("https://[:::]/abc-defg-hij")).toBeNull();
    expect(roomCodeFromPaste("https://999.999.999.999/abc-defg-hij")).toBeNull();
    expect(roomCodeFromPaste("https://127.0.0.1:3005/abc-defg-hij")).toBe("abc-defg-hij");
  });

  it("only reads web links", () => {
    expect(roomCodeFromPaste("javascript:/abc-defg-hij")).toBeNull();
    expect(roomCodeFromPaste("javascript://meet.example.com/abc-defg-hij")).toBeNull();
    expect(roomCodeFromPaste("ftp://meet.example.com/abc-defg-hij")).toBeNull();
    expect(roomCodeFromPaste("https://user@meet.example.com/abc-defg-hij")).toBeNull();
    expect(roomCodeFromPaste("localhost:65536/abc-defg-hij")).toBeNull();
    expect(roomCodeFromPaste("javascript:123/abc-defg-hij")).toBeNull();
    expect(roomCodeFromPaste("ftp:21/abc-defg-hij")).toBeNull();
    expect(roomCodeFromPaste("devbox:3005/abc-defg-hij")).toBeNull();
  });

  it("accepts a room code on its own", () => {
    expect(roomCodeFromPaste("abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromPaste("  ABC-DEFG-HIJ \n")).toBe("abc-defg-hij");
    expect(roomCodeFromPaste("standup")).toBe("standup");
  });

  it("ignores text that is neither a room code nor a meeting link", () => {
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
      "meet.example/\u212A-abc",
      "abc--defg",
      "-abc",
      "null",
    ]) {
      expect(roomCodeFromPaste(text), JSON.stringify(text)).toBeNull();
    }
  });

  it("reads internationalized hosts", () => {
    expect(roomCodeFromPaste("münchen.example/abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromPaste("https://münchen.example/abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromPaste("xn--mnchen-3ya.example/abc-defg-hij")).toBe("abc-defg-hij");
  });

  it("rejects backslashes anywhere and empty host labels", () => {
    expect(roomCodeFromPaste("https://meet.example/abc-defg-hij?ref=a\\b")).toBeNull();
    expect(roomCodeFromPaste("//meet.example/abc-defg-hij#a\\b")).toBeNull();
    expect(roomCodeFromPaste("meet..example/abc-defg-hij")).toBeNull();
    expect(roomCodeFromPaste(".example/abc-defg-hij")).toBeNull();
    expect(roomCodeFromPaste("https://./abc-defg-hij")).toBeNull();
  });

  it("lets the URL parser judge bare ports", () => {
    expect(roomCodeFromPaste("meet.example:000443/abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromPaste("meet.example:/abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromPaste("[::1]:000443/abc-defg-hij")).toBe("abc-defg-hij");
  });

  it("rejects hosts longer than DNS allows", () => {
    expect(roomCodeFromPaste(`https://${"a".repeat(64)}.example/abc-defg-hij`)).toBeNull();
    expect(
      roomCodeFromPaste(`${Array.from({ length: 5 }, () => "a".repeat(60)).join(".")}.example/abc`),
    ).toBeNull();
    expect(roomCodeFromPaste(`https://${"a".repeat(100_000)}.example/abc`)).toBeNull();
    const longestName = [61, 63, 63, 63].map((n) => "a".repeat(n)).join(".");
    expect(longestName).toHaveLength(253);
    expect(roomCodeFromPaste(`${longestName}/abc-defg-hij`)).toBe("abc-defg-hij");
    expect(roomCodeFromPaste(`${longestName}./abc-defg-hij`)).toBe("abc-defg-hij");
    expect(roomCodeFromPaste(`a${longestName}/abc-defg-hij`)).toBeNull();
  });
});
