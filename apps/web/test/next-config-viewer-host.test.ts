import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { compileNonPath, matchHas } from "next/dist/shared/lib/router/utils/prepare-destination";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../next.config";
import { resolveViewerUrl } from "../src/lib/novnc-viewer";

type HeaderRule = {
  source: string;
  has?: Parameters<typeof matchHas>[2];
  missing?: Parameters<typeof matchHas>[3];
  headers: { key: string; value: string }[];
};

// Applies next.config headers the way Next does: every matching rule, later ones winning per key.
const responseHeaders = async (host: string, pathname = "/meeting/abc") => {
  const rules = (await nextConfig.headers?.()) as HeaderRule[];
  const applied = new Map<string, string>();
  for (const rule of rules) {
    const pathParams = getPathMatch(rule.source, { removeUnnamedParams: true, strict: true })(pathname);
    if (!pathParams) continue;
    const hasParams = matchHas({ headers: { host } } as never, {}, rule.has, rule.missing);
    if (!hasParams) continue;
    for (const { key, value } of rule.headers) {
      applied.set(key.toLowerCase(), compileNonPath(value, { ...pathParams, ...hasParams }));
    }
  }
  return applied;
};

const frameSources = async (host: string) =>
  ((await responseHeaders(host)).get("content-security-policy-report-only") ?? "")
    .split(";")
    .map((part) => part.trim().split(/\s+/))
    .find(([name]) => name === "frame-src")
    ?.slice(1) ?? [];

const allows = (sources: string[], framedUrl: string) => {
  const { protocol, hostname, origin } = new URL(framedUrl);
  return sources.some((source) => source === origin || source === `${protocol}//${hostname}:*`);
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("frame-src for a loopback Chromium viewer", () => {
  it("allows the viewer on a named page host that maps to loopback", async () => {
    vi.stubEnv("BROWSER_HOST_ADDRESS", "127.0.0.1");
    vi.stubEnv("BROWSER_PUBLIC_BASE_URL", "");
    const viewer = "http://127.0.0.1:18680/vnc_lite.html";

    expect(allows(await frameSources("review-app.test:3000"), resolveViewerUrl(viewer, "review-app.test"))).toBe(true);
    expect(allows(await frameSources("localhost:3000"), resolveViewerUrl(viewer, "localhost"))).toBe(true);
  });

  it("allows the proxied viewer port on a named page host", async () => {
    vi.stubEnv("BROWSER_HOST_ADDRESS", "");
    vi.stubEnv("BROWSER_PUBLIC_BASE_URL", "http://127.0.0.1:6411/");
    const viewer = "http://127.0.0.1:6411/novnc/6080/vnc_lite.html";

    const sources = await frameSources("review-app.test");
    expect(allows(sources, resolveViewerUrl(viewer, "review-app.test"))).toBe(true);
    expect(sources).not.toContain("http://review-app.test:*");
  });

  it("never copies a host that is not a plain hostname into the policy", async () => {
    vi.stubEnv("BROWSER_HOST_ADDRESS", "127.0.0.1");
    const policy = (await responseHeaders("evil.test'; script-src *")).get("content-security-policy-report-only") ?? "";
    expect(policy).not.toContain("evil.test");
    expect(policy).toContain("http://127.0.0.1:*");
  });

  it("leaves a public viewer's policy the same on every host", async () => {
    vi.stubEnv("BROWSER_HOST_ADDRESS", "");
    vi.stubEnv("BROWSER_PUBLIC_BASE_URL", "https://browser.example.org/");
    const policy = async (host: string) => (await responseHeaders(host)).get("content-security-policy-report-only");
    expect(await policy("review-app.test")).toBe(await policy("conclave.acmvit.in"));
  });
});
