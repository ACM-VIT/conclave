import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: vi.fn() }));

vi.mock("@/lib/bounded-request-body", () => import("../src/lib/bounded-request-body"));
vi.mock("@/lib/csp-report", () => import("../src/lib/csp-report"));

const { POST } = await import("../src/app/api/csp-report/route");
const { getCloudflareContext } = await import("@opennextjs/cloudflare");

const report = {
  "csp-report": {
    "document-uri": "https://conclave.example/room-code?token=secret-token",
    "effective-directive": "img-src",
    "blocked-uri": "https://tracker.example/pixel.png?id=123",
    "source-file": "https://conclave.example/_next/static/chunks/app.js?v=1",
    "line-number": 12,
    "column-number": 4,
    disposition: "report",
  },
};

let ip = 0;
const post = (body: BodyInit, headers: Record<string, string> = {}, clientIp = `10.1.0.${++ip}`) =>
  POST(new Request("https://conclave.example/api/csp-report", {
    method: "POST",
    headers: { "content-type": "application/csp-report", "cf-connecting-ip": clientIp, ...headers },
    body,
    duplex: "half",
  } as RequestInit));

const streamOf = (totalBytes: number) => {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) return controller.close();
      const chunk = new Uint8Array(Math.min(4096, totalBytes - sent)).fill(32);
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
};

// Each test starts in a fresh rate-limit window.
let clock = Date.now();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock += 120_000;
  vi.setSystemTime(clock);
  vi.mocked(getCloudflareContext).mockImplementation(async () => {
    throw new Error("not running on Cloudflare");
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A Cloudflare rate-limit binding that allows 30 calls per key. */
const workersLimiter = () => {
  const counts = new Map<string, number>();
  return {
    limit: vi.fn(async ({ key }: { key: string }) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { success: (counts.get(key) ?? 0) <= 30 };
    }),
  };
};

const runOnWorkers = (limiter: ReturnType<typeof workersLimiter> | null) => {
  vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
  vi.mocked(getCloudflareContext).mockResolvedValue({
    env: limiter ? { CSP_REPORT_RATE_LIMITER: limiter } : {},
  } as unknown as Awaited<ReturnType<typeof getCloudflareContext>>);
};

describe("CSP report endpoint", () => {
  it("logs one compact line per report without query strings", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await post(JSON.stringify(report));
    expect(response.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line.startsWith("[csp-report] ")).toBe(true);
    expect(JSON.parse(line.slice("[csp-report] ".length))).toEqual({
      disposition: "report",
      directive: "img-src",
      blocked: "https://tracker.example/pixel.png",
      document: "https://conclave.example/room-code",
      source: "https://conclave.example/_next/static/chunks/app.js",
      line: 12,
      column: 4,
      sample: "",
    });
    expect(line).not.toContain("secret-token");
  });

  it("drops query strings from fields that are not absolute URLs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const relative = {
      "csp-report": {
        "document-uri": "/room-code?token=secret-token",
        "blocked-uri": "inline",
        "source-file": "/app.js?token=secret-token#frag",
        disposition: "report",
      },
    };
    expect((await post(JSON.stringify(relative))).status).toBe(204);
    const line = String(warn.mock.calls[0][0]);
    expect(line).not.toContain("secret-token");
    expect(JSON.parse(line.slice("[csp-report] ".length))).toMatchObject({
      blocked: "inline",
      document: "/room-code",
      source: "/app.js",
    });
  });

  it("rejects bodies that are not CSP reports", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await post(JSON.stringify(report), { "content-type": "text/plain" })).status).toBe(415);
    expect((await post("{not json")).status).toBe(400);
    expect((await post(JSON.stringify({ hello: "world" }))).status).toBe(400);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("refuses oversized reports before or while reading them", async () => {
    expect((await post("x", { "content-length": String(64 * 1024) })).status).toBe(413);
    expect((await post(streamOf(1024 * 1024))).status).toBe(413);
  });

  it("limits each client on Cloudflare by the address Cloudflare reports", async () => {
    runOnWorkers(workersLimiter());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const statuses = [];
    for (let index = 0; index < 31; index += 1) {
      statuses.push((await post(JSON.stringify(report), {}, "198.51.100.9")).status);
    }
    expect(statuses.slice(0, 30).every((status) => status === 204)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect((await post(JSON.stringify(report), {}, "198.51.100.10")).status).toBe(204);
  });

  it("refuses reports on Cloudflare when the limiter binding is missing", async () => {
    runOnWorkers(null);
    vi.stubEnv("NODE_ENV", "production");
    expect((await post(JSON.stringify(report))).status).toBe(503);
  });

  it("off Cloudflare, shares one limit however the caller spells its address", async () => {
    // next start and next dev get a simulated limiter from OpenNext, and the
    // caller chooses cf-connecting-ip there.
    vi.mocked(getCloudflareContext).mockResolvedValue({
      env: { CSP_REPORT_RATE_LIMITER: workersLimiter() },
    } as unknown as Awaited<ReturnType<typeof getCloudflareContext>>);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const statuses = [];
    for (let index = 0; index < 31; index += 1) {
      statuses.push((await post(JSON.stringify(report), {}, `203.0.113.${index}`)).status);
    }
    expect(statuses.slice(0, 30).every((status) => status === 204)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it("limits reports in development even without any limiter", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const statuses = [];
    for (let index = 0; index < 31; index += 1) {
      statuses.push((await post(JSON.stringify(report), {}, `192.0.2.${index}`)).status);
    }
    expect(statuses[29]).toBe(204);
    expect(statuses[30]).toBe(429);
  });

  it("refuses reports on a production server without the Cloudflare limiter", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const statuses = [];
    for (let index = 0; index < 5; index += 1) {
      statuses.push((await post(JSON.stringify(report), { "cf-connecting-ip": `203.0.113.${index}` })).status);
    }
    expect(statuses).toEqual([503, 503, 503, 503, 503]);
    expect(warn).not.toHaveBeenCalled();
  });
});
