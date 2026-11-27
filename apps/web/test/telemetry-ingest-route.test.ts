import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/lib/telemetry-ingest", () => import("../src/app/lib/telemetry-ingest"));
vi.mock("@/lib/site-url", () => import("../src/lib/site-url"));
vi.mock("@/app/lib/ingest-rate-limit", () => import("../src/app/lib/ingest-rate-limit"));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: async () => {
    throw new Error("not running on Cloudflare");
  },
}));

const KEY = "phc_test_project";
const body = JSON.stringify({
  api_key: KEY,
  batch: [
    {
      uuid: "0196f0a1-0000-7000-8000-0000000000aa",
      event: "meet_join_attempt",
      timestamp: new Date().toISOString(),
      properties: { token: KEY, distinct_id: "0196f0a1-0000-7000-8000-000000000000", joinMode: "meeting", isAdmin: false },
    },
  ],
});

let upstream: string[] = [];

beforeEach(() => {
  vi.resetModules();
  upstream = [];
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", KEY);
  vi.stubEnv("POSTHOG_INGEST_HOST", "");
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/e/")) upstream.push(String(url));
      return new Response(String(url).includes("posthog-chunk-ids") ? "not found" : '{"status":1}', {
        status: String(url).includes("posthog-chunk-ids") ? 404 : 200,
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const post = async () => {
  const { POST } = await import("../src/app/ingest/[...path]/route");
  return POST(
    new Request("https://conclave.example/ingest/e/", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ path: ["e"] }) } as never,
  );
};

describe("the /ingest route's PostHog host", () => {
  it("forwards to POSTHOG_INGEST_HOST first", async () => {
    vi.stubEnv("POSTHOG_INGEST_HOST", "https://ingest.example");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://legacy.example");

    expect((await post()).status).toBe(200);
    expect(upstream).toEqual(["https://ingest.example/e/"]);
  });

  it("falls back to the legacy NEXT_PUBLIC_POSTHOG_HOST a deployment already sets", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://staging-collector.example/");

    expect((await post()).status).toBe(200);
    expect(upstream).toEqual(["https://staging-collector.example/e/"]);
  });

  it.each(["", "not a url", "ftp://collector.example"])(
    "forwards nothing and says so once when no host is configured (%j)",
    async (host) => {
      vi.stubEnv("POSTHOG_INGEST_HOST", host);
      const warn = vi.spyOn(console, "error").mockImplementation(() => {});

      expect((await post()).status).toBe(503);
      expect((await post()).status).toBe(503);
      expect(upstream).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    },
  );
});

describe("the /ingest route's rate limit", () => {
  it("answers 429 with Retry-After once the process budget is spent and forwards nothing more", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.advanceTimersByTime(60_000);
    vi.stubEnv("POSTHOG_INGEST_HOST", "https://ingest.example");
    const { INGEST_RATE_LIMITS } = await import("../src/app/lib/ingest-quota");
    const { POST } = await import("../src/app/ingest/[...path]/route");
    const from = (ip: string) =>
      POST(
        new Request("https://conclave.example/ingest/e/", {
          method: "POST",
          body,
          headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        }),
        { params: Promise.resolve({ path: ["e"] }) } as never,
      );
    for (let index = 0; index < INGEST_RATE_LIMITS.perClient; index++) expect((await from("198.51.100.7")).status).toBe(200);
    const forwarded = upstream.length;

    const limited = await from("198.51.100.7");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(upstream).toHaveLength(forwarded);
    expect((await from("198.51.100.8")).status).toBe(429);
    expect(upstream).toHaveLength(forwarded);
  });
});
