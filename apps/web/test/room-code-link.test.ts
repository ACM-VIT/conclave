import { domainToASCII } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCodeFieldPaste } from "../src/app/lib/utils";
import { getMeetingLinkHosts, getPublicSiteUrl } from "../src/lib/site-url";

const KNOWN_HOSTS = [
  "conclave.acmvit.in",
  "localhost:3615",
  "xn--mnchen-3ya.example",
  "127.0.0.1:3615",
  "0.0.0.11",
];

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

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

const referenceHost = (host: string): string | null => {
  const lower = host.toLowerCase();
  const portMatch = /:(\d*)$/.exec(lower);
  const name = portMatch ? lower.slice(0, portMatch.index) : lower;
  const port = portMatch ? portMatch[1].replace(/^0+(?=\d)/, "") : "";
  if (port && Number(port) > 65535) return null;
  const ascii = name.startsWith("[")
    ? referenceIpv6(name)
    : PRINTABLE_ASCII.test(name)
      ? name
      : domainToASCII(name);
  if (!ascii) return null;
  if (ascii !== name && !name.startsWith("[")) {
    const typedLabels = name.split(".");
    const asciiLabels = ascii.split(".");
    if (typedLabels.length !== asciiLabels.length) return null;
    const onlyIdn = typedLabels.every(
      (label, index) =>
        label === asciiLabels[index] ||
        (!PRINTABLE_ASCII.test(label) && asciiLabels[index].startsWith("xn--")),
    );
    if (!onlyIdn) return null;
  }
  return port && port !== "80" && port !== "443" ? `${ascii}:${port}` : ascii;
};

const KNOWN_REFERENCE_HOSTS = KNOWN_HOSTS.map(referenceHost);

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

const expectedReplacement = (
  text: string,
  referenceHosts: readonly (string | null)[] = KNOWN_REFERENCE_HOSTS,
): string | null => {
  const trimmed = text.trim();
  const scheme = /^https?:\/\//i.exec(trimmed);
  const rest = scheme
    ? trimmed.slice(scheme[0].length)
    : trimmed.startsWith("//")
      ? trimmed.slice(2)
      : trimmed;
  const hostEnd = rest.search(/[/?#]/);
  if (hostEnd <= 0 || rest[hostEnd] !== "/") return null;
  const host = rest.slice(0, hostEnd);
  if (/[\s@\\]/.test(host)) return null;
  if (!scheme) {
    const typed = referenceHost(host);
    if (!typed || !referenceHosts.includes(typed)) return null;
  }
  let hostname: string;
  try {
    hostname = new URL(`https://${host}/`).hostname;
  } catch {
    return null;
  }
  if (!hostname.startsWith("[")) {
    const name = hostname.replace(/\.$/, "");
    const labels = name.split(".");
    if (name.length > 253 || labels.some((label) => label.length < 1 || label.length > 63)) {
      return null;
    }
  }
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
  return isCode && code.length <= 64 && !APP_PAGES.has(code) ? code : null;
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
  "M\u00dcNCHEN.example", "xn--mnchen-3ya.example", "XN--MNCHEN-3YA.EXAMPLE", "b\u00fccher.example",
  "127.1:3615", "127.0.0.1:3615", "0x7f.0.0.1:3615", "conclave.acmvit.in:443",
  "conclave.acmvit.in:000443", "conclave.acmvit.in:8443", "\uff43onclave.acmvit.in",
  "m\u00fcnchen.example:8443", "xn--mnchen-3ya.example:8443",
  "[2001:db8::1]:8443", "[2001:0db8:0:0:0:0:0:1]:8443", "[2001:DB8:0::1]:8443", "[2001:db8::2]:8443",
  "127.1:3005", "conclave.example", "conclave.example:443", "conclave.example:80", "Conclave.Example",
  "conclave%2eacmvit.in",
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
    expect(linkCode("https://conclave.acmvit.in/abc-defg-hij?ref=a\\b")).toBe("abc-defg-hij");
    expect(linkCode("https://conclave.acmvit.in/abc-defg-hij#a\\b")).toBe("abc-defg-hij");
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
});

const referenceSettingHost = (setting: string): string | null => {
  const trimmed = setting.trim();
  const scheme = /^https?:\/\//i.exec(trimmed)?.[0] ?? "https://";
  const authority = trimmed.replace(/^https?:\/\//i, "").split(/[/?#\\]/)[0];
  if (!/^(?:\[[0-9a-f:.]+\]|[^\s@:[\]]+)(?::\d+)?$/i.test(authority)) return null;
  let url: URL;
  try {
    url = new URL(`${scheme}${authority}/`);
  } catch {
    return null;
  }
  return url.port && url.port !== "80" && url.port !== "443"
    ? `${url.hostname}:${url.port}`
    : url.hostname;
};

const PRODUCTION_HOST = "conclave.acmvit.in";

const SITE_SETTINGS = [
  { label: "the fixed known hosts", setting: null },
  { label: "a bare Unicode site setting", setting: "m\u00fcnchen.example" },
  { label: "a punycode site setting", setting: "xn--mnchen-3ya.example" },
  { label: "a URL-form site setting", setting: "https://M\u00dcNCHEN.example:8443/app" },
  { label: "an IPv6 site setting", setting: "https://[2001:0db8:0:0:0:0:0:1]:8443" },
  { label: "a shortened IPv4 site setting", setting: "http://127.1:3005" },
  { label: "a site setting with a default port", setting: "https://conclave.example:443" },
];

describe("replacing the field only for an unambiguous Conclave meeting link", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(SITE_SETTINGS)("holds for $label", ({ setting }) => {
    let hosts: readonly string[] = KNOWN_HOSTS;
    let referenceHosts: readonly (string | null)[] = KNOWN_REFERENCE_HOSTS;
    if (setting !== null) {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", setting);
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
      hosts = getMeetingLinkHosts();
      referenceHosts = [referenceHost(PRODUCTION_HOST), referenceSettingHost(setting)];
      expect(referenceHosts[1]).not.toBeNull();
      expect(hosts.map(referenceHost).sort()).toEqual([...referenceHosts].sort());
      expect(hosts).toContain(referenceHost(new URL(getPublicSiteUrl()).host));
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
      const paste = parseCodeFieldPaste(text, hosts);
      const got = paste?.kind === "replace" ? paste.code : null;
      if (got !== null) replacements += 1;
      if (got !== expectedReplacement(text, referenceHosts)) mismatches.push(JSON.stringify(text));
    }
    expect(mismatches).toEqual([]);
    expect(replacements).toBeGreaterThan(500);
  });
});

describe("hosts a pasted meeting link may use without a scheme", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("always includes the production host", () => {
    expect(getMeetingLinkHosts()).toContain("conclave.acmvit.in");
  });

  it("adds the browser-visible site host", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://staging.example:8443");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "app.example");
    expect(getMeetingLinkHosts()).toEqual(
      expect.arrayContaining(["conclave.acmvit.in", "staging.example:8443", "app.example"]),
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
      expect(getMeetingLinkHosts()).toContain("xn--mnchen-3ya.example");
      expect(getPublicSiteUrl()).toBe("https://xn--mnchen-3ya.example");
    }
  });

  it("reads a site setting the same way for the site URL and for pasted links", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("BETTER_AUTH_URL", "");
    vi.stubEnv("BETTER_AUTH_BASE_URL", "");
    vi.stubEnv("VERCEL_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
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
      "https://conclave.example:443",
      "http://conclave.example:80",
      "file:///tmp/conclave",
      "file:/tmp",
      "mailto:user@example.com",
      "https://user:secret@app.example",
      "ftp://app.example",
      "app example",
    ]) {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", setting);
      const expected = referenceSettingHost(setting);
      const siteHost = getPublicSiteUrl() === fallback ? null : new URL(getPublicSiteUrl()).host;
      expect({ setting, siteHost: siteHost && referenceHost(siteHost) }).toEqual({ setting, siteHost: expected });
      const linkHosts = getMeetingLinkHosts().filter((host) => host !== PRODUCTION_HOST);
      expect({ setting, linkHosts }).toEqual({ setting, linkHosts: expected ? [expected] : [] });
    }
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
        expect({ link, paste: parseCodeFieldPaste(link, getMeetingLinkHosts()) }).toEqual({
          link,
          paste: { kind: "replace", code: "abc-defg" },
        });
      }
    }
  });

  it("still ignores a typed IPv4 host that URL would rewrite", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://127.1:3005");
    expect(parseCodeFieldPaste("127.1:3005/abc-defg", getMeetingLinkHosts())).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://11");
    expect(parseCodeFieldPaste("11/23", getMeetingLinkHosts())).toBeNull();
  });

  it("ignores site settings that are not web addresses", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "file:///tmp/conclave");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://");
    expect(getMeetingLinkHosts()).toEqual(["conclave.acmvit.in"]);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "mailto:user@example.com");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://user:secret@app.example");
    expect(getMeetingLinkHosts()).toEqual(["conclave.acmvit.in"]);
  });

  it("only trusts the current page when it is served over http or https", () => {
    vi.stubGlobal("window", { location: { protocol: "https:", host: "staging.example" } });
    expect(getMeetingLinkHosts()).toContain("staging.example");
    vi.stubGlobal("window", { location: { protocol: "file:", host: "local.example" } });
    expect(getMeetingLinkHosts()).not.toContain("local.example");
  });
});
