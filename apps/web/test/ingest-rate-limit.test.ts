import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cloudflare = vi.hoisted(() => ({ context: null as null | { env: Record<string, unknown> } }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => {
    if (!cloudflare.context) throw new Error("not running on Cloudflare");
    return cloudflare.context;
  }),
}));

const from = (ip: string) =>
  new Request("https://conclave.acmvit.in/ingest/e/", { method: "POST", headers: { "cf-connecting-ip": ip } });

let takeIngestRateLimit: typeof import("../src/app/lib/ingest-rate-limit").takeIngestRateLimit;
let limits: typeof import("../src/app/lib/ingest-rate-limit").INGEST_RATE_LIMITS;

beforeEach(async () => {
  vi.resetModules();
  ({ takeIngestRateLimit, INGEST_RATE_LIMITS: limits } = await import("../src/app/lib/ingest-rate-limit"));
});

afterEach(() => {
  cloudflare.context = null;
  vi.useRealTimers();
});

describe("the /ingest rate limit", () => {
  it("limits each client and the whole site, in this process, off Cloudflare", async () => {
    for (let index = 0; index < limits.perClient; index++) expect(await takeIngestRateLimit(from("10.0.0.1"))).toEqual({ ok: true });
    expect(await takeIngestRateLimit(from("10.0.0.1"))).toEqual({ ok: false, status: 429, retryAfterMs: 60_000 });
    expect(await takeIngestRateLimit(from("10.0.0.2"))).toEqual({ ok: true });

    let allowed = limits.perClient + 1;
    for (let client = 3; allowed < limits.total; client++) {
      for (let index = 0; index < limits.perClient && allowed < limits.total; index++, allowed++) {
        expect(await takeIngestRateLimit(from(`10.0.${Math.floor(client / 250)}.${client % 250}`))).toEqual({ ok: true });
      }
    }
    expect(await takeIngestRateLimit(from("10.9.9.9"))).toEqual({ ok: false, status: 429, retryAfterMs: 60_000 });
  });

  it("opens again once the window has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let index = 0; index < limits.perClient; index++) await takeIngestRateLimit(from("10.0.0.1"));
    expect((await takeIngestRateLimit(from("10.0.0.1"))).ok).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(await takeIngestRateLimit(from("10.0.0.1"))).toEqual({ ok: true });
  });

  it("asks the per-client limiter first, and the site-wide one only for a client within its limit, on Cloudflare", async () => {
    const perClient = vi.fn(async () => ({ success: true }));
    const total = vi.fn(async () => ({ success: true }));
    cloudflare.context = { env: { INGEST_RATE_LIMITER: { limit: perClient }, INGEST_GLOBAL_RATE_LIMITER: { limit: total } } };
    expect(await takeIngestRateLimit(from("203.0.113.7"))).toEqual({ ok: true });
    expect(perClient).toHaveBeenCalledWith({ key: "ingest:203.0.113.7" });
    expect(total).toHaveBeenCalledWith({ key: "ingest:all" });

    perClient.mockResolvedValueOnce({ success: false });
    expect(await takeIngestRateLimit(from("203.0.113.7"))).toEqual({ ok: false, status: 429, retryAfterMs: 60_000 });
    expect(total).toHaveBeenCalledTimes(1);

    total.mockResolvedValueOnce({ success: false });
    expect(await takeIngestRateLimit(from("203.0.113.8"))).toEqual({ ok: false, status: 429, retryAfterMs: 60_000 });
  });

  it("refuses with 503 on Cloudflare when a limiter is missing or failing", async () => {
    cloudflare.context = { env: { INGEST_RATE_LIMITER: { limit: async () => ({ success: true }) } } };
    expect(await takeIngestRateLimit(from("203.0.113.9"))).toEqual({ ok: false, status: 503, retryAfterMs: null });
    cloudflare.context = {
      env: {
        INGEST_RATE_LIMITER: { limit: async () => ({ success: true }) },
        INGEST_GLOBAL_RATE_LIMITER: { limit: async () => { throw new Error("down"); } },
      },
    };
    expect(await takeIngestRateLimit(from("203.0.113.9"))).toEqual({ ok: false, status: 503, retryAfterMs: null });
  });

  it("is deployed with both limiters at the limits it applies off Cloudflare", () => {
    const text = readFileSync(path.resolve(import.meta.dirname, "../wrangler.jsonc"), "utf8");
    const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")) as {
      ratelimits: Array<{ name: string; namespace_id: string; simple: { limit: number; period: number } }>;
    };
    const byName = new Map(config.ratelimits.map((limiter) => [limiter.name, limiter]));
    expect(byName.get("INGEST_RATE_LIMITER")?.simple).toEqual({ limit: limits.perClient, period: 60 });
    expect(byName.get("INGEST_GLOBAL_RATE_LIMITER")?.simple).toEqual({ limit: limits.total, period: 60 });
    expect(new Set(config.ratelimits.map((limiter) => limiter.namespace_id)).size).toBe(config.ratelimits.length);
  });
});
