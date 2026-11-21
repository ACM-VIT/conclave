import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => {
    throw new Error("not running on Cloudflare");
  }),
}));

vi.mock("@/lib/bounded-request-body", () => import("../src/lib/bounded-request-body"));
vi.mock("@/lib/csp-report", () => import("../src/lib/csp-report"));

const { POST } = await import("../src/app/api/csp-report/route");

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
    headers: { "content-type": "application/csp-report", "x-real-ip": clientIp, ...headers },
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

afterEach(() => vi.restoreAllMocks());

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

  it("limits how many reports one client can log per minute", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const statuses = [];
    for (let index = 0; index < 31; index += 1) {
      statuses.push((await post(JSON.stringify(report), {}, "10.9.9.9")).status);
    }
    expect(statuses.slice(0, 30).every((status) => status === 204)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect((await post(JSON.stringify(report), {}, "10.9.9.10")).status).toBe(204);
  });
});
