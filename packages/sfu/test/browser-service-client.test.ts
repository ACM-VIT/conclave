import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callBrowserService,
  getCachedBrowserServiceCapabilities,
  getBrowserServiceCapabilities,
  isMissingBrowserSessionError,
  parseBrowserInteger,
  shutdownBrowserBackend,
} from "../server/browserServiceClient.js";

const originalBackend = process.env.SFU_BROWSER_BACKEND;
const originalServiceUrl = process.env.BROWSER_SERVICE_URL;
const originalCloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const originalCloudflareToken = process.env.CLOUDFLARE_BROWSER_RUN_TOKEN;
const originalCloudflareBaseUrl = process.env.CLOUDFLARE_BROWSER_RUN_BASE_URL;

afterEach(async () => {
  await shutdownBrowserBackend();
  vi.unstubAllGlobals();
  if (originalBackend === undefined) delete process.env.SFU_BROWSER_BACKEND;
  else process.env.SFU_BROWSER_BACKEND = originalBackend;
  if (originalServiceUrl === undefined) delete process.env.BROWSER_SERVICE_URL;
  else process.env.BROWSER_SERVICE_URL = originalServiceUrl;
  if (originalCloudflareAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
  else process.env.CLOUDFLARE_ACCOUNT_ID = originalCloudflareAccountId;
  if (originalCloudflareToken === undefined) delete process.env.CLOUDFLARE_BROWSER_RUN_TOKEN;
  else process.env.CLOUDFLARE_BROWSER_RUN_TOKEN = originalCloudflareToken;
  if (originalCloudflareBaseUrl === undefined) {
    delete process.env.CLOUDFLARE_BROWSER_RUN_BASE_URL;
  } else {
    process.env.CLOUDFLARE_BROWSER_RUN_BASE_URL = originalCloudflareBaseUrl;
  }
});

describe("external browser service errors", () => {
  it("preserves a missing session response as an authoritative 404", async () => {
    process.env.SFU_BROWSER_BACKEND = "service";
    process.env.BROWSER_SERVICE_URL = "https://browser-service.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "Session not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        })),
    );

    const error = await callBrowserService("/sessions/expired-room").catch(
      (caught: unknown) => caught,
    );

    expect(isMissingBrowserSessionError(error)).toBe(true);
    expect(error).toMatchObject({ status: 404, message: "Session not found" });
  });

  it("uses legacy Chromium capabilities only when the endpoint is missing", async () => {
    process.env.SFU_BROWSER_BACKEND = "service";
    process.env.BROWSER_SERVICE_URL = "https://browser-service.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        })),
    );

    await expect(getBrowserServiceCapabilities()).resolves.toEqual({
      provider: "chromium",
      audio: true,
      video: true,
      agentic: false,
    });
  });

  it("propagates browser-service outages from capability discovery", async () => {
    process.env.SFU_BROWSER_BACKEND = "service";
    process.env.BROWSER_SERVICE_URL = "https://browser-service.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "Unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        })),
    );

    await expect(getBrowserServiceCapabilities()).rejects.toMatchObject({
      status: 503,
      message: "Unavailable",
    });
  });

  it("rejects a successful but malformed capabilities response", async () => {
    process.env.SFU_BROWSER_BACKEND = "service";
    process.env.BROWSER_SERVICE_URL = "https://browser-service.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })),
    );

    await expect(getBrowserServiceCapabilities()).rejects.toThrow(
      "invalid capabilities response",
    );
  });

  it("verifies embedded Kitesurf credentials before reporting capabilities", async () => {
    process.env.SFU_BROWSER_BACKEND = "kitesurf";
    process.env.CLOUDFLARE_ACCOUNT_ID = "account-1";
    process.env.CLOUDFLARE_BROWSER_RUN_TOKEN = "expired-token";
    process.env.CLOUDFLARE_BROWSER_RUN_BASE_URL = "https://api.cloudflare.test/browser-run";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ errors: [{ message: "Invalid token" }] }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getBrowserServiceCapabilities()).rejects.toThrow("Invalid token");
    const [input, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(input).toBe("https://api.cloudflare.test/browser-run/devtools/session");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer expired-token",
    );
  });

  it("coalesces and caches managed capability checks", async () => {
    process.env.SFU_BROWSER_BACKEND = "kitesurf";
    process.env.CLOUDFLARE_ACCOUNT_ID = "account-1";
    process.env.CLOUDFLARE_BROWSER_RUN_TOKEN = "valid-token";
    process.env.CLOUDFLARE_BROWSER_RUN_BASE_URL = "https://api.cloudflare.test/browser-run";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([
      getCachedBrowserServiceCapabilities(),
      getCachedBrowserServiceCapabilities(),
    ]);
    const third = await getCachedBrowserServiceCapabilities();

    expect(first.provider).toBe("kitesurf");
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("embedded browser configuration", () => {
  it("falls back when viewport dimensions are below their supported minimums", () => {
    expect(parseBrowserInteger("1", 1920, 3840, 800)).toBe(1920);
    expect(parseBrowserInteger("1", 1080, 2160, 600)).toBe(1080);
    expect(parseBrowserInteger("800", 1920, 3840, 800)).toBe(800);
    expect(parseBrowserInteger("600", 1080, 2160, 600)).toBe(600);
  });
});
