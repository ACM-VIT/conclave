import { describe, expect, it } from "vitest";
import { roomCodeFromLink } from "../src/app/lib/utils";

describe("pasting a meeting link into the code field", () => {
  it("keeps the room code from a full link", () => {
    expect(roomCodeFromLink("https://meet.example.com/abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromLink("http://localhost:3005/abc-defg-hij/")).toBe("abc-defg-hij");
    expect(roomCodeFromLink("//meet.example.com/abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromLink("  HTTPS://Meet.Example.com/Abc-Defg-Hij  ")).toBe(
      "abc-defg-hij",
    );
  });

  it("ignores the query and hash", () => {
    expect(roomCodeFromLink("https://meet.example.com/abc-defg-hij?ref=chat#top")).toBe(
      "abc-defg-hij",
    );
  });

  it("accepts a link without a scheme", () => {
    expect(roomCodeFromLink("conclave.app/abc-defg-hij?ref=chat")).toBe("abc-defg-hij");
    expect(roomCodeFromLink("localhost:3005/abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromLink("[::1]/abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromLink("[::1]:3005/abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromLink("/abc-defg-hij")).toBe("abc-defg-hij");
  });

  it("decodes the code once", () => {
    expect(roomCodeFromLink("conclave.app/abc%2Ddefg")).toBe("abc-defg");
    expect(roomCodeFromLink("conclave.app/abc%2Fdefg")).toBeNull();
    expect(roomCodeFromLink("conclave.app/abc%E0%A4%A")).toBeNull();
  });

  it("finds no code in a link that has none", () => {
    expect(roomCodeFromLink("https://meet.example.com/")).toBeNull();
    expect(roomCodeFromLink("conclave.app/")).toBeNull();
    expect(roomCodeFromLink("conclave.app/?code=abc-defg-hij")).toBeNull();
  });

  it("finds no code in a link to another page", () => {
    expect(roomCodeFromLink("https://meet.example.com/w/public-slug")).toBeNull();
    expect(roomCodeFromLink("https://meet.example.com/w/%2e%2e/abc-defg-hij")).toBeNull();
    expect(roomCodeFromLink("https://meet.example.com//abc-defg-hij")).toBeNull();
    expect(roomCodeFromLink("/abc-defg-hij//")).toBeNull();
    expect(roomCodeFromLink("conclave.app/abc_defg")).toBeNull();
    expect(roomCodeFromLink("abc/defg")).toBeNull();
  });

  it("finds no code in a link to an app page or a placeholder", () => {
    expect(roomCodeFromLink("https://conclave.app/sign-in")).toBeNull();
    expect(roomCodeFromLink("conclave.app/privacy")).toBeNull();
    expect(roomCodeFromLink("/null")).toBeNull();
    expect(roomCodeFromLink("/undefined")).toBeNull();
  });

  it("accepts any host a browser can open after an explicit prefix", () => {
    expect(roomCodeFromLink("https://devbox/abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromLink("//devbox/abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromLink("https://devbox:3005/abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromLink("https://conclave.app./abc-defg-hij")).toBe("abc-defg-hij");
    expect(roomCodeFromLink("conclave.app./abc-defg-hij")).toBe("abc-defg-hij");
  });

  it("rejects hosts a browser could not open", () => {
    expect(roomCodeFromLink("https://[:::]/abc-defg-hij")).toBeNull();
    expect(roomCodeFromLink("https://999.999.999.999/abc-defg-hij")).toBeNull();
    expect(roomCodeFromLink("https://127.0.0.1:3005/abc-defg-hij")).toBe("abc-defg-hij");
  });

  it("only reads web links", () => {
    expect(roomCodeFromLink("javascript:/abc-defg-hij")).toBeNull();
    expect(roomCodeFromLink("javascript://meet.example.com/abc-defg-hij")).toBeNull();
    expect(roomCodeFromLink("ftp://meet.example.com/abc-defg-hij")).toBeNull();
    expect(roomCodeFromLink("https://user@meet.example.com/abc-defg-hij")).toBeNull();
    expect(roomCodeFromLink("localhost:65536/abc-defg-hij")).toBeNull();
    expect(roomCodeFromLink("javascript:123/abc-defg-hij")).toBeNull();
    expect(roomCodeFromLink("ftp:21/abc-defg-hij")).toBeNull();
    expect(roomCodeFromLink("devbox:3005/abc-defg-hij")).toBeNull();
  });

  it("leaves plain codes to the regular input path", () => {
    expect(roomCodeFromLink("abc-defg-hij")).toBeNull();
  });
});
