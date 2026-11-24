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
let limits: typeof import("../src/app/lib/ingest-quota").INGEST_RATE_LIMITS;
let IngestQuota: typeof import("../src/app/lib/ingest-quota").IngestQuota;

beforeEach(async () => {
  vi.resetModules();
  ({ takeIngestRateLimit } = await import("../src/app/lib/ingest-rate-limit"));
  ({ INGEST_RATE_LIMITS: limits, IngestQuota } = await import("../src/app/lib/ingest-quota"));
});

const siteQuota = (answer: () => Promise<Response> = async () => new Response(null, { status: 204 })) => {
  const take = vi.fn(answer);
  const names: string[] = [];
  return {
    take,
    names,
    binding: {
      idFromName: (name: string) => {
        names.push(name);
        return { name };
      },
      get: () => ({ fetch: take }),
    },
  };
};

afterEach(() => {
  cloudflare.context = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const inWorkers = () => vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });

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

  it("keeps both limits in this process under next start, where OpenNext offers wrangler's local bindings", async () => {
    const perClient = vi.fn(async () => ({ success: true }));
    const quota = siteQuota(async () => {
      throw new Error("a Durable Object does not run in the local platform proxy");
    });
    cloudflare.context = { env: { INGEST_RATE_LIMITER: { limit: perClient }, INGEST_QUOTA: quota.binding } };
    for (let index = 0; index < limits.perClient; index++) expect(await takeIngestRateLimit(from("10.0.0.1"))).toEqual({ ok: true });
    expect(await takeIngestRateLimit(from("10.0.0.1"))).toEqual({ ok: false, status: 429, retryAfterMs: 60_000 });
    expect(perClient).not.toHaveBeenCalled();
    expect(quota.take).not.toHaveBeenCalled();
  });

  it("asks the per-client limiter first, and the one site-wide quota only for a client within its limit, on Cloudflare", async () => {
    inWorkers();
    const perClient = vi.fn(async () => ({ success: true }));
    const quota = siteQuota();
    cloudflare.context = { env: { INGEST_RATE_LIMITER: { limit: perClient }, INGEST_QUOTA: quota.binding } };
    expect(await takeIngestRateLimit(from("203.0.113.7"))).toEqual({ ok: true });
    expect(perClient).toHaveBeenCalledWith({ key: "ingest:203.0.113.7" });
    expect(quota.take).toHaveBeenCalledTimes(1);
    expect(quota.names).toEqual(["site"]);

    perClient.mockResolvedValueOnce({ success: false });
    expect(await takeIngestRateLimit(from("203.0.113.7"))).toEqual({ ok: false, status: 429, retryAfterMs: 60_000 });
    expect(quota.take).toHaveBeenCalledTimes(1);

    quota.take.mockResolvedValueOnce(new Response(null, { status: 429 }));
    expect(await takeIngestRateLimit(from("203.0.113.8"))).toEqual({ ok: false, status: 429, retryAfterMs: 60_000 });
  });

  it("refuses with 503 on Cloudflare when a limiter is missing, failing or stalled", async () => {
    inWorkers();
    const allowed = { limit: async () => ({ success: true }) };
    cloudflare.context = { env: { INGEST_RATE_LIMITER: allowed } };
    expect(await takeIngestRateLimit(from("203.0.113.9"))).toEqual({ ok: false, status: 503, retryAfterMs: null });
    cloudflare.context = { env: { INGEST_RATE_LIMITER: allowed, INGEST_QUOTA: siteQuota(async () => { throw new Error("down"); }).binding } };
    expect(await takeIngestRateLimit(from("203.0.113.9"))).toEqual({ ok: false, status: 503, retryAfterMs: null });
    cloudflare.context = { env: { INGEST_RATE_LIMITER: allowed, INGEST_QUOTA: siteQuota(async () => new Response(null, { status: 500 })).binding } };
    expect(await takeIngestRateLimit(from("203.0.113.9"))).toEqual({ ok: false, status: 503, retryAfterMs: null });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cloudflare.context = { env: { INGEST_RATE_LIMITER: allowed, INGEST_QUOTA: siteQuota(() => new Promise<Response>(() => {})).binding } };
    const stalled = takeIngestRateLimit(from("203.0.113.9"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await stalled).toEqual({ ok: false, status: 503, retryAfterMs: null });
  });

  it("admits the site's limit across every location in one minute, then refuses until the next", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const quota = new IngestQuota();
    for (let index = 0; index < limits.total; index++) expect((await quota.fetch()).status).toBe(204);
    expect((await quota.fetch()).status).toBe(429);
    vi.advanceTimersByTime(59_999);
    expect((await quota.fetch()).status).toBe(429);
    vi.advanceTimersByTime(1);
    expect((await quota.fetch()).status).toBe(204);
  });

  it("is deployed with the per-client limiter and the site quota at the limits it applies off Cloudflare", () => {
    const text = readFileSync(path.resolve(import.meta.dirname, "../wrangler.jsonc"), "utf8");
    const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")) as {
      main: string;
      ratelimits: Array<{ name: string; namespace_id: string; simple: { limit: number; period: number } }>;
      durable_objects: { bindings: Array<{ name: string; class_name: string }> };
      migrations: Array<{ tag: string; new_sqlite_classes?: string[] }>;
    };
    const byName = new Map(config.ratelimits.map((limiter) => [limiter.name, limiter]));
    expect(byName.get("INGEST_RATE_LIMITER")?.simple).toEqual({ limit: limits.perClient, period: 60 });
    expect(byName.has("INGEST_GLOBAL_RATE_LIMITER")).toBe(false);
    expect(new Set(config.ratelimits.map((limiter) => limiter.namespace_id)).size).toBe(config.ratelimits.length);
    expect(config.durable_objects.bindings).toContainEqual({ name: "INGEST_QUOTA", class_name: "IngestQuota" });
    expect(config.migrations.flatMap((migration) => migration.new_sqlite_classes ?? [])).toContain("IngestQuota");
    const entry = readFileSync(path.resolve(import.meta.dirname, "..", config.main), "utf8");
    expect(entry).toContain('export { default } from "./.open-next/worker.js";');
    expect(entry).toContain('export { IngestQuota } from "./src/app/lib/ingest-quota";');
  });
});
