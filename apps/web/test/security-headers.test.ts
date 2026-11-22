import { describe, expect, it } from "vitest";
import { buildSecurityHeaders } from "../src/lib/security-headers";

const headerMap = (isDevelopment: boolean, env: Record<string, string> = {}) =>
  new Map(buildSecurityHeaders({ env, isDevelopment }).map(({ key, value }) => [key, value]));

const directives = (policy: string) =>
  new Map(policy.split(";").map((part) => {
    const [name, ...sources] = part.trim().split(/\s+/);
    return [name, sources];
  }));

describe("web security headers", () => {
  it("forbids framing in both header forms and enforces transport and sniffing rules", () => {
    const headers = headerMap(false);
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(headers.get("Strict-Transport-Security")).toMatch(/^max-age=\d{8,}; includeSubDomains$/);
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("lets chat images load from the SFU that stored them", () => {
    const production = directives(headerMap(false).get("Content-Security-Policy-Report-Only") ?? "");
    expect(production.get("img-src")).toContain("https://*.acmvit.in");
    expect(production.get("img-src")).not.toContain("wss://*.acmvit.in");

    const local = directives(
      headerMap(true, { NEXT_PUBLIC_SFU_URL: "http://localhost:3031" }).get("Content-Security-Policy-Report-Only") ?? "",
    );
    expect(local.get("img-src")).toContain("http://localhost:3031");
    expect(local.get("img-src")).not.toContain("ws://localhost:3031");
  });

  it("lets only this origin use the camera, microphone and screen capture", () => {
    const policy = headerMap(false).get("Permissions-Policy") ?? "";
    for (const feature of ["camera", "microphone", "display-capture"]) {
      expect(policy).toContain(`${feature}=(self)`);
    }
    expect(policy).toMatch(/fullscreen=\(self "https:\/\/www\.youtube-nocookie\.com"/);
    expect(policy).toContain("geolocation=()");
  });

  it("reports, without blocking, anything outside the observed allowlist", () => {
    const headers = headerMap(false);
    const policy = directives(headers.get("Content-Security-Policy-Report-Only") ?? "");
    expect(policy.get("default-src")).toEqual(["'self'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("report-uri")).toEqual(["/api/csp-report"]);
    expect(policy.get("script-src")).toContain("'wasm-unsafe-eval'");
    expect(policy.get("script-src")).not.toContain("'unsafe-eval'");
    expect(policy.get("connect-src")).toEqual(
      expect.arrayContaining(["https://*.acmvit.in", "wss://*.acmvit.in", "https://api.openai.com"]),
    );
    expect(policy.get("frame-src")).toEqual(expect.arrayContaining(["https://www.youtube-nocookie.com", "https://live.browser.run"]));
    expect(policy.get("worker-src")).toEqual(["'self'", "blob:"]);
  });

  it("allows eval only for the development server and adds configured realtime origins", () => {
    const policy = directives(
      headerMap(true, {
        SFU_URLS: "sfu-a=http://localhost:3031, sfu-b=https://sfu.example.org",
        TRANSCRIPT_WORKER_URL: "https://transcribe.example.org/",
        NEXT_PUBLIC_SFU_URL: "not a url",
      }).get("Content-Security-Policy-Report-Only") ?? "",
    );
    expect(policy.get("script-src")).toContain("'unsafe-eval'");
    expect(policy.get("connect-src")).toEqual(expect.arrayContaining([
      "http://localhost:3031",
      "ws://localhost:3031",
      "https://sfu.example.org",
      "wss://sfu.example.org",
      "https://transcribe.example.org",
      "wss://transcribe.example.org",
    ]));
  });
});
