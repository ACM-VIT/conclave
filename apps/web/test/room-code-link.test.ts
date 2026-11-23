import { describe, expect, it } from "vitest";
import { parseCodeFieldPaste } from "../src/app/lib/utils";

const linkCode = (text: string) => {
  const paste = parseCodeFieldPaste(text);
  return paste?.kind === "replace" ? paste.code : null;
};

describe("pasting into the join code field", () => {
  it("keeps the room code from a full link", () => {
    expect(linkCode("https://meet.example.com/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("http://localhost:3005/abc-defg-hij/")).toBe("abc-defg-hij");
    expect(linkCode("//meet.example.com/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("  HTTPS://Meet.Example.com/Abc-Defg-Hij  ")).toBe(
      "abc-defg-hij",
    );
  });

  it("ignores the query and hash", () => {
    expect(linkCode("https://meet.example.com/abc-defg-hij?ref=chat#top")).toBe(
      "abc-defg-hij",
    );
  });

  it("accepts a link without a scheme", () => {
    expect(linkCode("conclave.app/abc-defg-hij?ref=chat")).toBe("abc-defg-hij");
    expect(linkCode("localhost:3005/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("[::1]/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("[::1]:3005/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("/abc-defg-hij")).toBe("abc-defg-hij");
  });

  it("decodes the code once", () => {
    expect(linkCode("conclave.app/abc%2Ddefg")).toBe("abc-defg");
    expect(linkCode("conclave.app/abc%2Fdefg")).toBeNull();
    expect(linkCode("conclave.app/abc%E0%A4%A")).toBeNull();
  });

  it("finds no code in a link that has none", () => {
    expect(linkCode("https://meet.example.com/")).toBeNull();
    expect(linkCode("conclave.app/")).toBeNull();
    expect(linkCode("conclave.app/?code=abc-defg-hij")).toBeNull();
  });

  it("finds no code in a link to another page", () => {
    expect(linkCode("https://meet.example.com/w/public-slug")).toBeNull();
    expect(linkCode("https://meet.example.com/w/%2e%2e/abc-defg-hij")).toBeNull();
    expect(linkCode("https://meet.example.com//abc-defg-hij")).toBeNull();
    expect(linkCode("/abc-defg-hij//")).toBeNull();
    expect(linkCode("conclave.app/abc_defg")).toBeNull();
    expect(linkCode("abc/defg")).toBeNull();
  });

  it("finds no code in a link to an app page or a placeholder", () => {
    expect(linkCode("https://conclave.app/sign-in")).toBeNull();
    expect(linkCode("conclave.app/privacy")).toBeNull();
    expect(linkCode("/null")).toBeNull();
    expect(linkCode("/undefined")).toBeNull();
  });

  it("accepts any host a browser can open after an explicit prefix", () => {
    expect(linkCode("https://devbox/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("//devbox/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("https://devbox:3005/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("https://conclave.app./abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("conclave.app./abc-defg-hij")).toBe("abc-defg-hij");
  });

  it("rejects hosts a browser could not open", () => {
    expect(linkCode("https://[:::]/abc-defg-hij")).toBeNull();
    expect(linkCode("https://999.999.999.999/abc-defg-hij")).toBeNull();
    expect(linkCode("https://127.0.0.1:3005/abc-defg-hij")).toBe("abc-defg-hij");
  });

  it("only reads web links", () => {
    expect(linkCode("javascript:/abc-defg-hij")).toBeNull();
    expect(linkCode("javascript://meet.example.com/abc-defg-hij")).toBeNull();
    expect(linkCode("ftp://meet.example.com/abc-defg-hij")).toBeNull();
    expect(linkCode("https://user@meet.example.com/abc-defg-hij")).toBeNull();
    expect(linkCode("localhost:65536/abc-defg-hij")).toBeNull();
    expect(linkCode("javascript:123/abc-defg-hij")).toBeNull();
    expect(linkCode("ftp:21/abc-defg-hij")).toBeNull();
    expect(linkCode("devbox:3005/abc-defg-hij")).toBeNull();
  });

  it("inserts pasted room code characters where the cursor is", () => {
    expect(parseCodeFieldPaste("abc-defg-hij")).toEqual({ kind: "insert", text: "abc-defg-hij" });
    expect(parseCodeFieldPaste("  WXYZ \n")).toEqual({ kind: "insert", text: "wxyz" });
    expect(parseCodeFieldPaste("new-")).toEqual({ kind: "insert", text: "new-" });
    expect(parseCodeFieldPaste("-abc")).toEqual({ kind: "insert", text: "-abc" });
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
    ]) {
      expect(parseCodeFieldPaste(text), JSON.stringify(text)).toBeNull();
    }
  });

  it("reads internationalized hosts", () => {
    expect(linkCode("m\u00fcnchen.example/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("https://m\u00fcnchen.example/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("xn--mnchen-3ya.example/abc-defg-hij")).toBe("abc-defg-hij");
  });

  it("rejects backslashes anywhere and empty host labels", () => {
    expect(linkCode("https://meet.example/abc-defg-hij?ref=a\\b")).toBeNull();
    expect(linkCode("//meet.example/abc-defg-hij#a\\b")).toBeNull();
    expect(linkCode("meet..example/abc-defg-hij")).toBeNull();
    expect(linkCode(".example/abc-defg-hij")).toBeNull();
    expect(linkCode("https://./abc-defg-hij")).toBeNull();
  });

  it("lets the URL parser judge bare ports", () => {
    expect(linkCode("meet.example:000443/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("meet.example:/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("[::1]:000443/abc-defg-hij")).toBe("abc-defg-hij");
  });

  it("rejects hosts longer than DNS allows", () => {
    expect(linkCode(`https://${"a".repeat(64)}.example/abc-defg-hij`)).toBeNull();
    expect(
      linkCode(`${Array.from({ length: 5 }, () => "a".repeat(60)).join(".")}.example/abc`),
    ).toBeNull();
    expect(linkCode(`https://${"a".repeat(100_000)}.example/abc`)).toBeNull();
    const longestName = [61, 63, 63, 63].map((n) => "a".repeat(n)).join(".");
    expect(longestName).toHaveLength(253);
    expect(linkCode(`${longestName}/abc-defg-hij`)).toBe("abc-defg-hij");
    expect(linkCode(`${longestName}./abc-defg-hij`)).toBe("abc-defg-hij");
    expect(linkCode(`a${longestName}/abc-defg-hij`)).toBeNull();
  });
});
