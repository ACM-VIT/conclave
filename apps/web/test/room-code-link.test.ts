import { domainToASCII } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  APP_ROUTE_SEGMENTS,
  codeFieldTenant,
  normalizeCodeField,
  parseCodeFieldPaste,
  resolveCodeField,
  roomCodeFromField,
} from "../src/app/lib/utils";
import { getMeetingLinkOrigins, getPublicSiteUrl } from "../src/lib/site-url";

const KNOWN_ORIGINS = [
  "https://conclave.acmvit.in",
  "http://localhost:3615",
  "https://xn--mnchen-3ya.example",
  "http://127.0.0.1:3615",
  "https://0.0.0.11",
];

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const DEFAULT_PORT: Record<string, string> = { "http:": "80", "https:": "443" };
const FORBIDDEN_HOST = /[\s#%/:<>?@[\\\]^|]/;

const referenceIpv6 = (literal: string): string | null => {
  const inner = literal.slice(1, -1).toLowerCase();
  const halves = inner.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (half: string) => (half ? half.split(":") : []);
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const values = groups.map((group) => parseInt(group, 16).toString(16));
  let runStart = -1;
  let runLength = 1;
  for (let i = 0; i < 8; ) {
    let j = i;
    while (j < 8 && values[j] === "0") j += 1;
    if (j - i > runLength) {
      runStart = i;
      runLength = j - i;
    }
    i = j === i ? i + 1 : j;
  }
  if (runStart === -1) return `[${values.join(":")}]`;
  const before = values.slice(0, runStart).join(":");
  const after = values.slice(runStart + runLength).join(":");
  return `[${before}::${after}]`;
};

const referenceIpv4 = (name: string): string | null | undefined => {
  const parts = name.split(".");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  if (!/^(?:\d+|0x[0-9a-f]*)$/i.test(parts[parts.length - 1])) return undefined;
  if (parts.length > 4) return null;
  const numbers = parts.map((part) =>
    /^0x[0-9a-f]*$/i.test(part)
      ? parseInt(part.slice(2) || "0", 16)
      : /^0[0-7]*$/.test(part)
        ? parseInt(part, 8)
        : /^[1-9]\d*$/.test(part)
          ? Number(part)
          : Number.NaN,
  );
  if (numbers.some(Number.isNaN)) return null;
  if (numbers.slice(0, -1).some((part) => part > 255)) return null;
  if (numbers[numbers.length - 1] >= 256 ** (5 - numbers.length)) return null;
  let address = numbers[numbers.length - 1];
  numbers.slice(0, -1).forEach((part, index) => {
    address += part * 256 ** (3 - index);
  });
  return [3, 2, 1, 0].map((power) => Math.floor(address / 256 ** power) % 256).join(".");
};

const referenceHostname = (host: string): string | null => {
  if (host.startsWith("[")) return host.endsWith("]") ? referenceIpv6(host) : null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(host);
  } catch {
    return null;
  }
  if (!decoded || FORBIDDEN_HOST.test(decoded)) return null;
  const ascii = domainToASCII(decoded);
  if (!ascii) return null;
  const ipv4 = referenceIpv4(ascii);
  return ipv4 === undefined ? ascii : ipv4;
};

const splitAuthority = (authority: string) => {
  const match = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(authority);
  if (!match || !match[1]) return null;
  const port = (match[2] ?? "").replace(/^0+(?=\d)/, "");
  return port && Number(port) > 65535 ? null : { host: match[1], port };
};

const referenceOrigin = (scheme: string, authority: string): string | null => {
  const parts = splitAuthority(authority);
  const hostname = parts && referenceHostname(parts.host);
  if (!parts || !hostname) return null;
  const port = parts.port === DEFAULT_PORT[scheme] ? "" : parts.port;
  return `${scheme}//${hostname}${port ? `:${port}` : ""}`;
};

const referenceSchemelessMatch = (authority: string, knownOrigins: readonly string[]) => {
  const parts = splitAuthority(authority);
  const hostname = parts && referenceHostname(parts.host);
  if (!parts || !hostname) return false;
  if (!parts.host.startsWith("[")) {
    const typed = parts.host.toLowerCase().split(".");
    const labels = hostname.split(".");
    const spelled =
      typed.length === labels.length &&
      typed.every(
        (label, index) =>
          label === labels[index] ||
          (!PRINTABLE_ASCII.test(label) && labels[index].startsWith("xn--")),
      );
    if (!spelled) return false;
  }
  return knownOrigins.some(
    (origin) => referenceOrigin(origin.slice(0, origin.indexOf("//")), authority) === origin,
  );
};

const parse = (text: string) => parseCodeFieldPaste(text, KNOWN_ORIGINS);

const linkCode = (text: string) => {
  const paste = parse(text);
  return paste?.kind === "replace" ? paste.code : null;
};

const APP_DIR = join(__dirname, "../src/app");

const routesUnder = (dir: string): boolean =>
  readdirSync(dir, { withFileTypes: true }).some((entry) =>
    entry.isDirectory()
      ? routesUnder(join(dir, entry.name))
      : /^(page|route)\.(t|j)sx?$/.test(entry.name),
  );

const TOP_LEVEL_ROUTES = readdirSync(APP_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^[a-z0-9-]+$/.test(entry.name))
  .filter((entry) => routesUnder(join(APP_DIR, entry.name)))
  .map((entry) => entry.name)
  .sort();

const APP_PAGES = new Set(["null", "undefined", ...TOP_LEVEL_ROUTES]);

const expectedReplacement = (
  text: string,
  knownOrigins: readonly string[] = KNOWN_ORIGINS,
): string | null => {
  const trimmed = text.trim();
  const scheme = /^(https?:)\/\//i.exec(trimmed);
  const rest = scheme
    ? trimmed.slice(scheme[0].length)
    : trimmed.startsWith("//")
      ? trimmed.slice(2)
      : trimmed;
  const hostEnd = rest.search(/[/?#]/);
  if (hostEnd <= 0 || rest[hostEnd] !== "/") return null;
  const authority = rest.slice(0, hostEnd);
  if (/[\s@\\]/.test(authority)) return null;
  const known = scheme
    ? knownOrigins.includes(referenceOrigin(scheme[1].toLowerCase(), authority) ?? "")
    : referenceSchemelessMatch(authority, knownOrigins);
  if (!known) return null;
  const afterHost = rest.slice(hostEnd);
  const suffixStart = afterHost.search(/[?#]/);
  const path = suffixStart === -1 ? afterHost : afterHost.slice(0, suffixStart);
  const suffix = suffixStart === -1 ? "" : afterHost.slice(suffixStart);
  if (/\s/.test(suffix)) return null;
  const segment = /^\/([^/\\\s]+)\/?$/.exec(path)?.[1];
  if (!segment) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  const code = decoded.toLowerCase();
  const isCode = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(decoded);
  return isCode && !APP_PAGES.has(code) ? code : null;
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
  "abc-defg-hij", "WXYZ", "new-", "-abc", "sign-in", "null", "w", "book", "api",
  "a".repeat(40), "a--".repeat(22), "e".repeat(64),
  "%2F", "%41bc", "%E0%A4%A", "%2e%2e",
  " ", "  ", "\n", "\t",
  "http:", "https:", "http:/", "https://", "http://", "//", "www.", "javascript:", "mailto:",
  "/", "/", "/", "?", "#", ".", "..", ":", "@", "\\", "?ref=chat", "#top",
  "\u212A",
];

const SCHEMES = ["", "", "", "https://", "http://", "HTTPS://", "//", "http:/", "javascript:", "ftp://", " "];
const HOSTS = [
  "M\u00dcNCHEN.example", "xn--mnchen-3ya.example", "XN--MNCHEN-3YA.EXAMPLE", "b\u00fccher.example",
  "127.1:3615", "127.0.0.1:3615", "0x7f.0.0.1:3615", "conclave.acmvit.in:443",
  "conclave.acmvit.in:000443", "conclave.acmvit.in:8443", "\uff43onclave.acmvit.in",
  "m\u00fcnchen.example:8443", "xn--mnchen-3ya.example:8443",
  "[2001:db8::1]:8443", "[2001:0db8:0:0:0:0:0:1]:8443", "[2001:DB8:0::1]:8443", "[2001:db8::2]:8443",
  "127.1:3005", "conclave.example", "conclave.example:443", "conclave.example:80", "Conclave.Example",
  "conclave.acmvit.in:80", "staging.example", "localhost:80", "127.0.0.1:80", "0.0.0.11", "0x0.0.0.0xb",
  "conclave%2eacmvit.in", "m%c3%bcnchen.example", "M%C3%9CNCHEN.example",
  "conclave.acmvit.in", "Conclave.ACMVIT.in", "localhost:3615", "localhost:3005", "localhost",
  "11", "2026", "10.0.0.1", "127.0.0.1:3005", "[::1]", "m\u00fcnchen.example", "meet.example",
  "conclave.app", "999.999.999.999", "user@meet.example", "", " ",
];
const SEGMENTS = [
  "abc-defg-hij", "23", "WXYZ", "sign-in", "null", "w/public-slug", "abc%2Ddefg", "%2F", "%E0%A4%A",
  "", "abc--defg", "\u212A-abc", "abc_defg", "a b", "book", "api", "w",
  "c".repeat(64), "d".repeat(65), "a--".repeat(22),
];
const SUFFIXES = ["", "", "", "/", "?ref=chat", "#top", "//", " ", "\\", "\n"];

describe("pasting into the join code field", () => {
  it("replaces the field with the code from an explicit link to a Conclave host", () => {
    expect(linkCode("https://conclave.acmvit.in/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("http://localhost:3615/abc-defg-hij/")).toBe("abc-defg-hij");
    expect(linkCode("  HTTPS://Conclave.ACMVIT.in/Abc-Defg-Hij  ")).toBe("abc-defg-hij");
    expect(linkCode("https://conclave.acmvit.in/abc-defg-hij?ref=chat#top")).toBe("abc-defg-hij");
    expect(linkCode("https://m\u00fcnchen.example/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("http://127.0.0.1:3615/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("http://127.1:3615/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("https://conclave.acmvit.in:443/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("https://conclave.acmvit.in/abc-defg-hij?ref=a\\b")).toBe("abc-defg-hij");
    expect(linkCode("https://conclave.acmvit.in/abc-defg-hij#a\\b")).toBe("abc-defg-hij");
  });

  it("never treats a link to another site as a meeting link", () => {
    for (const text of [
      "https://example.org/about",
      "http://example.org/about",
      "https://meet.example.com/abc-defg-hij",
      "http://localhost:3005/abc-defg-hij",
      "https://devbox:3005/abc-defg-hij",
      "https://conclave.acmvit.in@evil.example/abc-def",
      "https://evil.example@conclave.acmvit.in/abc-def",
      "https://conclave.acmvit.in:secret@evil.example/abc-def",
      "https://conclave.acmvit.in.evil.example/abc-def",
      "conclave.acmvit.in.evil.example/abc-def",
      "https://evil-conclave.acmvit.in/abc-def",
      "https://conclave-acmvit.in/abc-def",
      "https://conclave.acmvit.in/a/b",
      "https://conclave.acmvit.in/sign-in",
      "https://conclave.acmvit.in/",
      "https://conclave.acmvit.in/w/public-slug",
    ]) {
      expect(parse(text), JSON.stringify(text)).toBeNull();
    }
  });

  it("compares the whole origin, scheme and port included", () => {
    for (const text of [
      "https://conclave.acmvit.in:80/other-room",
      "http://conclave.acmvit.in/other-room",
      "https://conclave.acmvit.in:8443/other-room",
      "https://localhost:3615/other-room",
      "http://localhost/other-room",
      "http://localhost:80/other-room",
      "https://127.0.0.1:3615/other-room",
      "conclave.acmvit.in:80/other-room",
      "localhost/other-room",
      "localhost:443/other-room",
    ]) {
      expect(parse(text), JSON.stringify(text)).toBeNull();
    }
    expect(linkCode("conclave.acmvit.in:443/other-room")).toBe("other-room");
    expect(linkCode("localhost:3615/other-room")).toBe("other-room");
    expect(linkCode("//localhost:3615/other-room")).toBe("other-room");
  });

  it("replaces the field from a Conclave link without a scheme", () => {
    expect(linkCode("conclave.acmvit.in/abc-defg-hij?ref=chat")).toBe("abc-defg-hij");
    expect(linkCode("Conclave.ACMVIT.in/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("localhost:3615/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("conclave.acmvit.in/abc%2Ddefg")).toBe("abc-defg");
    expect(linkCode("//CONCLAVE.ACMVIT.IN/ABC-123/")).toBe("abc-123");
    expect(linkCode("conclave.acmvit.in:443/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("127.0.0.1:3615/abc-defg-hij")).toBe("abc-defg-hij");
  });

  it("matches an internationalized site host however it is typed", () => {
    expect(linkCode("m\u00fcnchen.example/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("M\u00dcNCHEN.Example/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("xn--mnchen-3ya.example/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("XN--MNCHEN-3YA.EXAMPLE/abc-defg-hij")).toBe("abc-defg-hij");
    expect(linkCode("b\u00fccher.example/abc-defg-hij")).toBeNull();
    expect(linkCode("m%c3%bcnchen.example/abc-def")).toBeNull();
    expect(linkCode("M%C3%9CNCHEN.example/abc-def")).toBeNull();
  });

  it("refuses the app's own pages and empty-like words as typed codes too, with one rule", () => {
    for (const word of ["null", "undefined", ...APP_ROUTE_SEGMENTS]) {
      expect({ word, typed: resolveCodeField(word, KNOWN_ORIGINS) }).toEqual({
        word,
        typed: { code: "", clientId: null, tooLong: false },
      });
      expect({ word, link: linkCode(`https://conclave.acmvit.in/${word}`) }).toEqual({ word, link: null });
    }
    for (const word of ["nullable-room", "undefined-x", "true", "0", "null-0", "scheduled", "w-x", "api-team"]) {
      expect({ word, code: roomCodeFromField(word, KNOWN_ORIGINS) }).toEqual({ word, code: word });
    }
  });

  it("keeps the tenant a Conclave link names", () => {
    const resolve = (link: string) => resolveCodeField(link, KNOWN_ORIGINS);
    expect(resolve("https://conclave.acmvit.in/review-room?clientId=review-alt")).toEqual({
      code: "review-room",
      clientId: "review-alt",
      tooLong: false,
    });
    expect(resolve("conclave.acmvit.in/review-room/?ref=chat&clientId=review-alt#top").clientId).toBe("review-alt");
    expect(resolve("https://conclave.acmvit.in/review-room?clientId=default").clientId).toBe("conclave");
    expect(resolve("https://conclave.acmvit.in/review-room?clientId=public").clientId).toBe("conclave");
    expect(resolve("https://conclave.acmvit.in/review-room?clientId=a%20b")).toEqual({
      code: "review-room",
      clientId: null,
      tooLong: false,
    });
    expect(resolve(`https://conclave.acmvit.in/review-room?clientId=${"x".repeat(65)}`).clientId).toBeNull();
    expect(resolve("https://conclave.acmvit.in/review-room?clientId=first&clientId=second").clientId).toBe("first");
    expect(resolve("https://conclave.acmvit.in/review-room#clientId=review-alt").clientId).toBeNull();
    expect(resolve("review-room?clientId=review-alt")).toEqual({ code: "", clientId: null, tooLong: false });
    expect(parseCodeFieldPaste("http://localhost:3615/review-room?clientId=review-alt", KNOWN_ORIGINS)).toEqual({
      kind: "replace",
      code: "review-room",
      clientId: "review-alt",
    });
    expect(codeFieldTenant(resolve("https://conclave.acmvit.in/review-room?clientId=review-alt"), "conclave")).toEqual({
      clientId: "review-alt",
      onThisPage: false,
    });
    expect(codeFieldTenant(resolve("https://conclave.acmvit.in/review-room?clientId=default"), "conclave")).toEqual({
      clientId: "conclave",
      onThisPage: true,
    });
    expect(codeFieldTenant(resolve("review-room"), "review-alt")).toEqual({ clientId: "review-alt", onThisPage: true });
  });

  it("ignores a link to any of the app's own top-level pages", () => {
    expect(TOP_LEVEL_ROUTES).toEqual([...APP_ROUTE_SEGMENTS].sort());
    for (const page of ["book", "w", "api", "sign-in", "privacy", "schedule", "sfu-admin", "delete-account"]) {
      expect({ page, code: linkCode(`https://conclave.acmvit.in/${page}`) }).toEqual({ page, code: null });
      expect({ page, code: linkCode(`conclave.acmvit.in/${page}/`) }).toEqual({ page, code: null });
    }
  });

  it("never lets URL rewriting turn a typed host into a known one", () => {
    for (const text of [
      "11/23",
      "11/abc-defg-hij",
      "127.1:3615/abc-defg-hij",
      "0x7f.0.0.1:3615/abc-defg-hij",
      "conclave%2eacmvit.in/abc-defg-hij",
      "\uff43onclave.acmvit.in/abc-defg-hij",
    ]) {
      expect(parse(text), JSON.stringify(text)).toBeNull();
    }
  });

  it("never treats other text with a slash as a link", () => {
    for (const text of [
      "11/23",
      "2026/11/23",
      "1/2",
      "10.0.0.1/abc-defg-hij",
      "conclave.app/abc-defg-hij",
      "meet.example/abc-defg-hij",
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
      "https://meet.example\\x/abc-defg-hij",
      "conclave.acmvit.in/abc\\defg",
      `https://${"a".repeat(64)}.example/abc-defg-hij`,
      `https://${"a".repeat(100_000)}.example/abc`,
    ]) {
      expect(parse(text), JSON.stringify(text).slice(0, 80)).toBeNull();
    }
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
});

const URL_PUNCTUATION = /[:/.?#@%=&+~\\]/;

const referenceCodeText = (text: string) =>
  text.toLowerCase().replace(/(\S)\s+(?=\S)/g, "$1-").replace(/-+/g, "-");

const referenceTyped = (text: string) => {
  const cut = text.search(URL_PUNCTUATION);
  return cut === -1 ? referenceCodeText(text) : referenceCodeText(text.slice(0, cut)) + text.slice(cut);
};

const typeIntoField = (text: string) => {
  let value = "";
  const steps: string[] = [];
  for (const character of text) {
    value = normalizeCodeField(value + character);
    steps.push(value);
  }
  return { value, steps };
};

const referenceResolution = (value: string, origins: readonly string[]) => {
  const candidate = expectedReplacement(value, origins) ?? value.trim();
  const shaped = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate) && !APP_PAGES.has(candidate);
  return {
    code: shaped && candidate.length <= 64 ? candidate : "",
    tooLong: shaped && candidate.length > 64,
  };
};

const referenceFieldCode = (value: string, origins: readonly string[]) =>
  referenceResolution(value, origins).code;

const CODE_40 = "abcdefgh-abcdefgh-abcdefgh-abcdefgh-abcd";

const TEAM_ORIGINS = [...KNOWN_ORIGINS, "https://team-meet.example"];

describe("typing into the join code field", () => {
  it("tidies plain codes and leaves text with URL punctuation exactly as typed", () => {
    expect(normalizeCodeField("ABC-Def")).toBe("abc-def");
    expect(normalizeCodeField("My Room")).toBe("my-room");
    expect(normalizeCodeField("abc def ghi")).toBe("abc-def-ghi");
    expect(normalizeCodeField("abc--def")).toBe("abc-def");
    expect(normalizeCodeField("abc  -  def")).toBe("abc-def");
    expect(normalizeCodeField("abc_def")).toBe("abc_def");
    for (const mark of [":", "/", ".", "?", "#", "@", "%", "=", "&", "+", "~", "\\"]) {
      const typed = `Team--Name ${mark}X`;
      expect({ mark, value: normalizeCodeField(typed) }).toEqual({ mark, value: typed });
    }
    expect(normalizeCodeField("mailto:Team--Name")).toBe("mailto:Team--Name");
    expect(normalizeCodeField("LOCALHOST:3615")).toBe("LOCALHOST:3615");
    expect(normalizeCodeField("team--meet.example/other room")).toBe("team--meet.example/other room");
    expect(normalizeCodeField("https://Team--Meet.example/Other-Room")).toBe(
      "https://Team--Meet.example/Other-Room",
    );
  });

  it("joins only a valid code or a whole link to a Conclave origin", () => {
    expect(roomCodeFromField("abc-defg-hij", TEAM_ORIGINS)).toBe("abc-defg-hij");
    expect(roomCodeFromField(" abc-defg-hij ", TEAM_ORIGINS)).toBe("abc-defg-hij");
    for (const value of ["abc--def", "abc-", "-abc", "my room", "abc.def", ""]) {
      expect({ value, code: roomCodeFromField(value, TEAM_ORIGINS) }).toEqual({ value, code: "" });
    }
    expect(roomCodeFromField("https://conclave.acmvit.in/abc-def/", TEAM_ORIGINS)).toBe("abc-def");
    expect(roomCodeFromField("https://team-meet.example/other-room", TEAM_ORIGINS)).toBe("other-room");
    for (const value of [
      "https://team--meet.example/other-room",
      "team--meet.example/other-room",
      "https://conclave.acmvit.in:80/other-room",
      "https://example.org/about",
      "https://conclave.acmvit.in/abc-def/extra",
    ]) {
      expect({ value, code: roomCodeFromField(value, TEAM_ORIGINS) }).toEqual({ value, code: "" });
    }
  });

  it("keeps Greptile's two typed links as typed and resolves only the real one", () => {
    const lookalike = typeIntoField("https://team--meet.example/other-room");
    expect(lookalike.value).toBe("https://team--meet.example/other-room");
    expect(roomCodeFromField(lookalike.value, TEAM_ORIGINS)).toBe("");
    const trailing = typeIntoField("https://conclave.acmvit.in/abc-def/");
    expect(trailing.value).toBe("https://conclave.acmvit.in/abc-def/");
    expect(roomCodeFromField(trailing.value, TEAM_ORIGINS)).toBe("abc-def");
  });

  it("keeps a space typed before or after a code joinable, as the field did before tidying", () => {
    expect(typeIntoField("abc def ghi ").value).toBe("abc-def-ghi ");
    expect(roomCodeFromField(typeIntoField("abc def ghi ").value, TEAM_ORIGINS)).toBe("abc-def-ghi");
    expect(typeIntoField(" abc-def").value).toBe(" abc-def");
    expect(roomCodeFromField(typeIntoField(" abc-def").value, TEAM_ORIGINS)).toBe("abc-def");
    expect(typeIntoField("abc - def").value).toBe("abc-def");
  });

  it("types a code read aloud and a doubled hyphen into a joinable code", () => {
    expect(typeIntoField("abc def ghi").value).toBe("abc-def-ghi");
    expect(roomCodeFromField(typeIntoField("abc def ghi").value, TEAM_ORIGINS)).toBe("abc-def-ghi");
    expect(typeIntoField("abc--def").value).toBe("abc-def");
    expect(roomCodeFromField(typeIntoField("abc--def").value, TEAM_ORIGINS)).toBe("abc-def");
  });

  it("never cuts a long typed link and says when the code is too long", () => {
    expect(CODE_40).toHaveLength(40);
    const production = "https://conclave.acmvit.in/";
    const long = typeIntoField(`${production}${CODE_40}`);
    expect(long.value).toBe(`${production}${CODE_40}`);
    expect(resolveCodeField(long.value, KNOWN_ORIGINS)).toEqual({ code: CODE_40, clientId: null, tooLong: false });
    const boundaryCode = "b".repeat(64 - production.length);
    const boundary = typeIntoField(`${production}${boundaryCode}`);
    expect(boundary.value).toHaveLength(64);
    expect(resolveCodeField(boundary.value, KNOWN_ORIGINS)).toEqual({ code: boundaryCode, clientId: null, tooLong: false });
    const past = typeIntoField(`${production}${boundaryCode}x`);
    expect(resolveCodeField(past.value, KNOWN_ORIGINS)).toEqual({ code: `${boundaryCode}x`, clientId: null, tooLong: false });
    const longest = "c".repeat(64);
    expect(resolveCodeField(`${production}${longest}`, KNOWN_ORIGINS)).toEqual({ code: longest, clientId: null, tooLong: false });
    expect(resolveCodeField(`${production}${longest}d`, KNOWN_ORIGINS)).toEqual({ code: "", clientId: null, tooLong: true });
    expect(resolveCodeField(`${longest}d`, KNOWN_ORIGINS)).toEqual({ code: "", clientId: null, tooLong: true });
    expect(parseCodeFieldPaste(`${production}${longest}d`, KNOWN_ORIGINS)).toEqual({
      kind: "replace",
      code: `${longest}d`,
      clientId: null,
    });
    expect(resolveCodeField("abc--def", KNOWN_ORIGINS)).toEqual({ code: "", clientId: null, tooLong: false });
    const foreign = `https://example.org/${"a".repeat(50)}`;
    expect(foreign).toHaveLength(70);
    expect(resolveCodeField(foreign, KNOWN_ORIGINS)).toEqual({ code: "", clientId: null, tooLong: false });
    expect(resolveCodeField("a--".repeat(22), KNOWN_ORIGINS)).toEqual({ code: "", clientId: null, tooLong: false });
    expect(resolveCodeField(`${"a".repeat(65)}-`, KNOWN_ORIGINS)).toEqual({ code: "", clientId: null, tooLong: false });
  });

  it("only tidies text typed before any URL punctuation", () => {
    const schemeless = typeIntoField("team--meet.example/other-room");
    expect(schemeless.value).toBe("team-meet.example/other-room");
    expect(roomCodeFromField(schemeless.value, TEAM_ORIGINS)).toBe("other-room");
    const punycode = typeIntoField("xn--mnchen-3ya.example/abc-defg-hij");
    expect(punycode.value).toBe("xn-mnchen-3ya.example/abc-defg-hij");
    expect(roomCodeFromField(punycode.value, KNOWN_ORIGINS)).toBe("");
    const schemed = typeIntoField("https://xn--mnchen-3ya.example/abc-defg-hij");
    expect(roomCodeFromField(schemed.value, KNOWN_ORIGINS)).toBe("abc-defg-hij");
  });

  it("types every known-origin link character by character, rewriting nothing after URL punctuation", () => {
    const failures: string[] = [];
    const forms: string[] = [];
    for (const origin of TEAM_ORIGINS) {
      const url = new URL(origin);
      const hosts = [url.host, url.host.toUpperCase()];
      if (url.hostname.includes("-")) hosts.push(url.host.replace("-", "--"), url.host.replace("-", "_"));
      hosts.push(`${url.hostname}:${url.protocol === "https:" ? "80" : "443"}`, `evil.${url.host}`);
      for (const host of hosts) {
        for (const prefix of [`${url.protocol}//`, url.protocol === "https:" ? "http://" : "https://", "//", ""]) {
          const base = `${prefix}${host}/`;
          const codes = ["abc-defg-hij", CODE_40, "e".repeat(65)];
          if (base.length < 64) codes.push("f".repeat(64 - base.length));
          for (const code of codes) {
            for (const tail of ["", "/", "?ref=chat", "/?ref=chat#top", "/extra", "?q=a b"]) {
              forms.push(`${base}${code}${tail}`);
            }
          }
        }
      }
    }
    for (const text of forms) {
      const typed = typeIntoField(text);
      const firstPunctuation = typed.steps.findIndex((step) => URL_PUNCTUATION.test(step));
      const rewrote =
        typed.value !== referenceTyped(text) ||
        (firstPunctuation !== -1 &&
          typed.steps.slice(firstPunctuation).some((step, offset) =>
            offset > 0 && step !== typed.steps[firstPunctuation + offset - 1] + [...text][firstPunctuation + offset]));
      const code = roomCodeFromField(typed.value, TEAM_ORIGINS);
      const expected = referenceFieldCode(typed.value, TEAM_ORIGINS);
      if (rewrote || code !== expected) failures.push(JSON.stringify({ text, value: typed.value, code, expected }));
    }
    expect(failures).toEqual([]);
    expect(forms.length).toBeGreaterThan(2000);
  });

  it("is stable and only makes a code from a valid code or a whole Conclave link", () => {
    const random = seededRandom(320);
    const pick = (items: readonly string[]) => items[Math.floor(random() * items.length)];
    const failures: string[] = [];
    let linkCodes = 0;
    let tooLong = 0;
    for (let run = 0; run < 20_000; run += 1) {
      let text = "";
      if (random() < 0.5) {
        text = `${pick(SCHEMES)}${pick(HOSTS)}/${pick(SEGMENTS)}${pick(SUFFIXES)}`;
      } else {
        const count = 1 + Math.floor(random() * 6);
        for (let i = 0; i < count; i += 1) text += pick(PIECES);
      }
      const value = normalizeCodeField(text);
      const resolution = resolveCodeField(value, KNOWN_ORIGINS);
      const code = roomCodeFromField(value, KNOWN_ORIGINS);
      if (URL_PUNCTUATION.test(value) && code) linkCodes += 1;
      if (resolution.tooLong) tooLong += 1;
      const stable = normalizeCodeField(value) === value;
      const expected = referenceResolution(value, KNOWN_ORIGINS);
      if (
        !stable ||
        code !== expected.code ||
        resolution.code !== expected.code ||
        resolution.tooLong !== expected.tooLong
      ) {
        failures.push(JSON.stringify({ text, value, resolution }));
      }
    }
    expect(failures).toEqual([]);
    expect(linkCodes).toBeGreaterThan(300);
    expect(tooLong).toBeGreaterThan(100);
  });
});

const referenceSettingOrigin = (setting: string): string | null => {
  const trimmed = setting.trim();
  if (!trimmed) return null;
  const explicit = /^https?:/i.test(trimmed);
  if (!explicit) {
    const authority = trimmed.split(/[/?#\\]/)[0];
    if (!/^(?:\[[0-9a-f:.]+\]|[^\s@:[\]]+)(?::\d+)?$/i.test(authority)) return null;
  }
  let url: URL;
  try {
    url = new URL(explicit ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  return /^https?:$/.test(url.protocol) && url.hostname ? url.origin : null;
};

const PRODUCTION_ORIGIN = "https://conclave.acmvit.in";
const SITE_KEYS = [
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_APP_URL",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_BASE_URL",
  "VERCEL_URL",
];

const SITE_SETTINGS = [
  { label: "the fixed known origins", setting: null },
  { label: "a bare Unicode site setting", setting: "m\u00fcnchen.example" },
  { label: "a punycode site setting", setting: "xn--mnchen-3ya.example" },
  { label: "a URL-form site setting", setting: "https://M\u00dcNCHEN.example:8443/app" },
  { label: "an IPv6 site setting", setting: "https://[2001:0db8:0:0:0:0:0:1]:8443" },
  { label: "a shortened IPv4 site setting", setting: "http://127.1:3005" },
  { label: "a site setting with a default port", setting: "https://conclave.example:443" },
  { label: "a site setting on port 80 over https", setting: "https://conclave.acmvit.in:80" },
  { label: "a scheme written without slashes", setting: "https:staging.example" },
];

describe("replacing the field only for a link to a Conclave origin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(SITE_SETTINGS)("holds for $label", ({ setting }) => {
    let origins: readonly string[] = KNOWN_ORIGINS;
    let referenceOrigins: readonly string[] = KNOWN_ORIGINS;
    if (setting !== null) {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", setting);
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
      origins = getMeetingLinkOrigins();
      const expected = referenceSettingOrigin(setting);
      expect(expected).not.toBeNull();
      referenceOrigins = [...new Set([PRODUCTION_ORIGIN, expected as string])];
      expect([...origins].sort()).toEqual([...referenceOrigins].sort());
      expect(getPublicSiteUrl()).toBe(expected);
    }
    const random = seededRandom(310);
    let replacements = 0;
    const pick = (items: readonly string[]) => items[Math.floor(random() * items.length)];
    const mismatches: string[] = [];
    for (let run = 0; run < 20_000; run += 1) {
      let text = "";
      if (random() < 0.5) {
        text = `${pick(SCHEMES)}${pick(HOSTS)}/${pick(SEGMENTS)}${pick(SUFFIXES)}`;
      } else {
        const count = 1 + Math.floor(random() * 6);
        for (let i = 0; i < count; i += 1) text += pick(PIECES);
      }
      const paste = parseCodeFieldPaste(text, origins);
      const got = paste?.kind === "replace" ? paste.code : null;
      if (got !== null) replacements += 1;
      if (got !== expectedReplacement(text, referenceOrigins)) mismatches.push(JSON.stringify(text));
    }
    expect(mismatches).toEqual([]);
    expect(replacements).toBeGreaterThan(150);
  });
});

describe("origins a pasted meeting link may point at", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("always includes the production origin", () => {
    expect(getMeetingLinkOrigins()).toContain(PRODUCTION_ORIGIN);
  });

  it("adds the site and app settings", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://staging.example:8443");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "app.example");
    expect(getMeetingLinkOrigins()).toEqual(
      expect.arrayContaining([PRODUCTION_ORIGIN, "https://staging.example:8443", "https://app.example"]),
    );
  });

  it("stores an internationalized site host in its ASCII form however it is set", () => {
    for (const setting of [
      "https://m\u00fcnchen.example",
      "m\u00fcnchen.example",
      "M\u00dcNCHEN.example/",
      "xn--mnchen-3ya.example",
      "https://XN--MNCHEN-3YA.example/app?x=1",
    ]) {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", setting);
      expect(getMeetingLinkOrigins()).toContain("https://xn--mnchen-3ya.example");
      expect(getPublicSiteUrl()).toBe("https://xn--mnchen-3ya.example");
    }
  });

  it("reads a site setting the same way for the site URL and for pasted links", () => {
    for (const key of SITE_KEYS) vi.stubEnv(key, "");
    const fallback = getPublicSiteUrl();
    for (const setting of [
      "m\u00fcnchen.example",
      "xn--mnchen-3ya.example:8443",
      "https://staging.example:8443/path",
      "http://localhost:3615",
      "app.example/",
      "11",
      "127.1",
      "https://[2001:0db8:0:0:0:0:0:1]:8443",
      "http://[::1]:3615",
      "https://staging.example/team meetings/",
      "staging.example/team meetings/",
      "https://staging.example:",
      "https:staging.example",
      "HTTP:Staging.Example:8080/x",
      "https://user:secret@app.example",
      "http://127.0.0.1:443",
      "https://conclave.example:443",
      "http://conclave.example:80",
      "https://conclave.acmvit.in:80",
      "file:///tmp/conclave",
      "file:/tmp",
      "mailto:user@example.com",
      "ftp://app.example",
      "app example",
    ]) {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", setting);
      const expected = referenceSettingOrigin(setting);
      const site = getPublicSiteUrl();
      expect({ setting, site: site === fallback ? null : site }).toEqual({ setting, site: expected });
      const linkOrigins = getMeetingLinkOrigins().filter((origin) => origin !== PRODUCTION_ORIGIN);
      const wanted = expected && expected !== PRODUCTION_ORIGIN ? [expected] : [];
      expect({ setting, linkOrigins }).toEqual({ setting, linkOrigins: wanted });
    }
  });

  it("falls back through the settings in order, then to the default", () => {
    for (const key of SITE_KEYS) vi.stubEnv(key, "");
    expect(getPublicSiteUrl()).toBe("http://localhost:3000");
    SITE_KEYS.forEach((key, index) => {
      for (const earlier of SITE_KEYS.slice(0, index)) vi.stubEnv(earlier, "mailto:user@example.com");
      vi.stubEnv(key, `https://site-${index}.example/app`);
      expect({ key, site: getPublicSiteUrl() }).toEqual({ key, site: `https://site-${index}.example` });
      vi.stubEnv(key, "");
    });
    for (const key of SITE_KEYS) vi.stubEnv(key, "file:///tmp/conclave");
    expect(getPublicSiteUrl()).toBe("http://localhost:3000");
  });

  it("keeps IP and default-port site settings and matches pasted links to them", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    const cases = [
      {
        setting: "https://[2001:0db8:0:0:0:0:0:1]:8443",
        site: "https://[2001:db8::1]:8443",
        links: [
          "[2001:0db8:0:0:0:0:0:1]:8443/abc-defg",
          "[2001:db8::1]:8443/abc-defg",
          "[2001:DB8:0::1]:8443/abc-defg",
          "https://[2001:0db8::1]:8443/abc-defg",
        ],
      },
      { setting: "http://127.1:3005", site: "http://127.0.0.1:3005", links: ["127.0.0.1:3005/abc-defg"] },
      { setting: "http://10.0.0.1", site: "http://10.0.0.1", links: ["10.0.0.1/abc-defg", "10.0.0.1:80/abc-defg"] },
      {
        setting: "https://conclave.example:443",
        site: "https://conclave.example",
        links: ["conclave.example/abc-defg", "conclave.example:443/abc-defg", "Conclave.Example:443/abc-defg"],
      },
    ];
    for (const { setting, site, links } of cases) {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", setting);
      expect({ setting, site: getPublicSiteUrl() }).toEqual({ setting, site });
      for (const link of links) {
        expect({ link, paste: parseCodeFieldPaste(link, getMeetingLinkOrigins()) }).toEqual({
          link,
          paste: { kind: "replace", code: "abc-defg", clientId: null },
        });
      }
    }
  });

  it("still ignores a typed IPv4 host that URL would rewrite", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://127.1:3005");
    expect(parseCodeFieldPaste("127.1:3005/abc-defg", getMeetingLinkOrigins())).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://11");
    expect(parseCodeFieldPaste("11/23", getMeetingLinkOrigins())).toBeNull();
  });

  it("keeps the origin of any http or https setting whatever its path", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    for (const [setting, origin] of [
      ["https://staging.example/team meetings/", "https://staging.example"],
      ["staging.example/team meetings/", "https://staging.example"],
      ["https://staging.example:", "https://staging.example"],
      ["https:staging.example", "https://staging.example"],
      ["https://user:secret@app.example/x", "https://app.example"],
    ]) {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", setting);
      expect({ setting, origin: getPublicSiteUrl() }).toEqual({ setting, origin });
      expect({ setting, origins: getMeetingLinkOrigins() }).toEqual({
        setting,
        origins: [PRODUCTION_ORIGIN, origin],
      });
    }
  });

  it("ignores site settings that are not web addresses", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "file:///tmp/conclave");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://");
    expect(getMeetingLinkOrigins()).toEqual([PRODUCTION_ORIGIN]);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "mailto:user@example.com");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "ftp://app.example");
    expect(getMeetingLinkOrigins()).toEqual([PRODUCTION_ORIGIN]);
  });

  it("only trusts the current page when it is served over http or https", () => {
    vi.stubGlobal("window", { location: { protocol: "https:", host: "staging.example" } });
    expect(getMeetingLinkOrigins()).toContain("https://staging.example");
    vi.stubGlobal("window", { location: { protocol: "file:", host: "local.example" } });
    expect(getMeetingLinkOrigins()).not.toContain("https://local.example");
    expect(getMeetingLinkOrigins()).toEqual([PRODUCTION_ORIGIN]);
  });
});
