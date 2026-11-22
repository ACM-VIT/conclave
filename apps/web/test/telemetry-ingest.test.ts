import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { forwardCapture, INGEST_USER_AGENT, type IngestDeps } from "../src/app/lib/telemetry-ingest";

const KEY = "phc_test_project";
const UUID = "0196f0a1-0000-7000-8000-000000000000";
const CHUNK_ID = "147fc2df-e663-5d76-aa13-f67e1e894071";

// An event as the browser sends it, with what a modified or buggy client might add.
const event = (properties: Record<string, unknown> = {}) => ({
  uuid: "0196f0a1-0000-7000-8000-0000000000aa",
  event: "meet_join_attempt",
  timestamp: "2026-11-22T00:00:00.000Z",
  $set: { email: "mira@example.com" },
  properties: {
    token: KEY,
    distinct_id: UUID,
    $os: "Mac OS X",
    $raw_user_agent: "Mozilla/5.0 ReviewDevice/FleetAsset123",
    $browser_language: "en-US-x-labunit",
    $current_url: "https://conclave.acmvit.in/[code]",
    attempt: 1,
    note: "Meet Mira in sample-room",
    ...properties,
  },
});
const captureBody = (events: unknown[]) => ({ api_key: KEY, batch: events, sent_at: "2026-11-22T00:00:01.000Z" });

const browserHeaders = {
  "user-agent": "Mozilla/5.0 (Macintosh) Chrome/157.0.0.0 ReviewDevice/FleetAsset123",
  "x-forwarded-for": "203.0.113.7",
  "x-real-ip": "203.0.113.7",
  "cf-connecting-ip": "203.0.113.7",
  cookie: "session=MiraSession",
  referer: "https://conclave.acmvit.in/lime-pear-plum",
};

const post = (body: BodyInit, contentType: string, query = "?ver=1.453.1") =>
  new Request(`https://conclave.acmvit.in/ingest/e/${query}`, {
    method: "POST",
    body,
    headers: { ...browserHeaders, "content-type": contentType },
  });

const forward = async (request: Request, path = ["e"], deps: Partial<IngestDeps> = {}) => {
  const upstream: Array<{ url: string; init: RequestInit }> = [];
  const response = await forwardCapture(request, path, {
    fetch: async (url, init) => {
      upstream.push({ url: String(url), init: init ?? {} });
      return new Response('{"status":1}', { status: 200 });
    },
    ingestHost: "https://eu.i.posthog.com",
    projectKey: KEY,
    chunkFiles: async () => new Map([[CHUNK_ID, "/_next/static/chunks/3u-6_1om1fv26.js"]]),
    ...deps,
  });
  return { response, upstream };
};

const sentBody = (upstream: Array<{ init: RequestInit }>) =>
  JSON.parse(String(upstream[0].init.body)) as { api_key: string; batch: Array<Record<string, unknown>>; sent_at?: string };

describe("forwardCapture", () => {
  it("forwards a gzip batch scrubbed again, with a fixed user agent and none of the browser's headers", async () => {
    const json = JSON.stringify(captureBody([event()]));
    const { response, upstream } = await forward(post(gzipSync(json), "text/plain"));

    expect(response.status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0].url).toBe("https://eu.i.posthog.com/e/");
    expect(upstream[0].init.headers).toEqual({
      "content-type": "application/json",
      "user-agent": INGEST_USER_AGENT,
    });
    const body = sentBody(upstream);
    expect(body.api_key).toBe(KEY);
    expect(body.sent_at).toBe("2026-11-22T00:00:01.000Z");
    expect(body.batch).toEqual([
      {
        uuid: "0196f0a1-0000-7000-8000-0000000000aa",
        event: "meet_join_attempt",
        timestamp: "2026-11-22T00:00:00.000Z",
        properties: {
          token: KEY,
          distinct_id: UUID,
          $os: "Mac OS X",
          $browser_language: "en",
          $current_url: "https://conclave.acmvit.in/[code]",
          attempt: 1,
        },
      },
    ]);
    expect(String(upstream[0].init.body)).not.toMatch(/Mira|ReviewDevice|labunit|203\.0\.113|MiraSession|lime-pear/);
  });

  it.each([
    ["a base64 beacon", () => post(Buffer.from(JSON.stringify(captureBody([event()]))).toString("base64"), "text/plain", "?compression=base64")],
    ["a base64 form", () => post(`data=${encodeURIComponent(Buffer.from(JSON.stringify(captureBody([event()]))).toString("base64"))}`, "application/x-www-form-urlencoded", "?compression=base64")],
    ["plain JSON", () => post(JSON.stringify(captureBody([event()])), "application/json")],
  ])("decodes %s the same way", async (_case, request) => {
    const { response, upstream } = await forward(request());

    expect(response.status).toBe(200);
    expect(sentBody(upstream).batch[0].properties).toMatchObject({ attempt: 1, $browser_language: "en" });
  });

  it("accepts only the event capture endpoint", async () => {
    const json = JSON.stringify(captureBody([event()]));
    for (const path of [["decide"], ["flags"], ["s"], ["i", "v0", "e"], ["e", "extra"]]) {
      const { response, upstream } = await forward(post(json, "application/json"), path);
      expect(response.status).toBe(404);
      expect(upstream).toEqual([]);
    }
  });

  it("refuses bodies over the size limits, compressed or not", async () => {
    const big = JSON.stringify(captureBody([event({ padding: "x".repeat(300_000) })]));
    const bomb = gzipSync(JSON.stringify(captureBody([event({ padding: "0".repeat(2_000_000) })])));

    expect((await forward(post(big, "application/json"))).response.status).toBe(413);
    expect(bomb.byteLength).toBeLessThan(256 * 1024);
    const { response, upstream } = await forward(post(bomb, "text/plain"));
    expect(response.status).toBe(413);
    expect(upstream).toEqual([]);
  });

  it("refuses a body that is not a capture batch, and events for another project", async () => {
    expect((await forward(post("not json", "application/json"))).response.status).toBe(400);
    expect((await forward(post(JSON.stringify({ batch: "x" }), "application/json"))).response.status).toBe(400);
    const foreign = JSON.stringify({ ...captureBody([event({ token: "phc_someone_else" })]), api_key: "phc_someone_else" });
    const { response, upstream } = await forward(post(foreign, "application/json"));
    expect(response.status).toBe(400);
    expect(upstream).toEqual([]);
  });

  it("asks the browser to retry when PostHog fails, and drops what it rejects", async () => {
    const json = JSON.stringify(captureBody([event()]));
    const failing = (status: number) => async () => new Response("", { status });

    expect((await forward(post(json, "application/json"), ["e"], { fetch: failing(502) })).response.status).toBe(503);
    expect((await forward(post(json, "application/json"), ["e"], { fetch: failing(400) })).response.status).toBe(400);
    const offline = async () => {
      throw new TypeError("fetch failed");
    };
    expect((await forward(post(json, "application/json"), ["e"], { fetch: offline })).response.status).toBe(503);
  });

  it("checks chunk paths against the build's manifest and leaves a scrubbed event as it was", async () => {
    const chunk = "https://conclave.acmvit.in/_next/static/chunks/3u-6_1om1fv26.js";
    const exception = {
      uuid: "0196f0a1-0000-7000-8000-0000000000ab",
      event: "$exception",
      properties: {
        token: KEY,
        distinct_id: UUID,
        $current_url: "https://conclave.acmvit.in/[code]",
        $exception_list: [
          {
            type: "TypeError",
            value: "[message withheld]",
            mechanism: { type: "generic", handled: false },
            stacktrace: {
              type: "raw",
              frames: [
                { platform: "web:javascript", function: "?", filename: chunk, lineno: 1, colno: 2, chunk_id: CHUNK_ID },
                { platform: "web:javascript", function: "?", filename: chunk, lineno: 3, chunk_id: "0f8c2a1e-5b7d-4c3e-9a10-000000000001" },
                { platform: "web:javascript", function: "?", filename: "https://conclave.acmvit.in/[path]", lineno: 4 },
              ],
            },
          },
        ],
      },
    };
    const { upstream } = await forward(post(JSON.stringify(captureBody([exception])), "application/json"));

    const [sent] = sentBody(upstream).batch as Array<typeof exception>;
    const frames = sent.properties.$exception_list[0].stacktrace.frames;
    expect(frames.map((frame) => frame.filename)).toEqual([chunk, "https://conclave.acmvit.in/[path]", "https://conclave.acmvit.in/[path]"]);
    expect({ ...sent.properties, $exception_list: undefined }).toEqual({ ...exception.properties, $exception_list: undefined });
    expect(frames[0]).toEqual(exception.properties.$exception_list[0].stacktrace.frames[0]);
  });
});
