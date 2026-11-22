import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/lib/telemetry-ingest", () => import("../src/app/lib/telemetry-ingest"));
vi.mock("@/lib/site-url", () => import("../src/lib/site-url"));

const KEY = "phc_test_project";
const body = JSON.stringify({
  api_key: KEY,
  batch: [
    {
      uuid: "0196f0a1-0000-7000-8000-0000000000aa",
      event: "meet_join_attempt",
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
