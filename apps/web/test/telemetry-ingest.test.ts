import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChunkManifestLoader,
  createForwardedEvents,
  forwardCapture,
  INGEST_USER_AGENT,
  type IngestDeps,
  MANIFEST_DEADLINE_MS,
  UPSTREAM_DEADLINE_MS,
} from "../src/app/lib/telemetry-ingest";
import { beforeSend } from "../src/app/lib/telemetry-privacy";

const KEY = "phc_test_project";
const UUID = "0196f0a1-0000-7000-8000-000000000000";
const CHUNK_ID = "147fc2df-e663-5d76-aa13-f67e1e894071";
const BUILD = "0b2d3b480f4621392a4151d750c90965b7c8b76c";

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
    joinMode: "meeting",
    isAdmin: false,
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

const NOW = Date.parse("2026-11-22T00:00:05.000Z");

const forward = async (request: Request, path = ["e"], deps: Partial<IngestDeps> = {}) => {
  const upstream: Array<{ url: string; init: RequestInit }> = [];
  const response = await forwardCapture(request, path, {
    fetch: async (url, init) => {
      upstream.push({ url: String(url), init: init ?? {} });
      return new Response('{"status":1}', { status: 200 });
    },
    ingestHost: "https://eu.i.posthog.com",
    projectKey: KEY,
    manifest: async (version) =>
      version === BUILD ? new Map([[CHUNK_ID, "/_next/static/chunks/3u-6_1om1fv26.js"]]) : null,
    siteOrigin: "https://conclave.acmvit.in",
    now: () => NOW,
    forwarded: createForwardedEvents(),
    admit: async () => ({ ok: true }),
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
    expect(body).not.toHaveProperty("sent_at");
    expect(body.batch).toEqual([
      {
        uuid: "0196f0a1-0000-7000-8000-0000000000aa",
        event: "meet_join_attempt",
        timestamp: "2026-11-22T00:00:00.000Z",
        properties: {
          token: KEY,
          distinct_id: UUID,
          client_version: "unknown",
          $host: "conclave-web",
          $lib: "web",
          $process_person_profile: false,
          $os: "Mac OS X",
          $browser_language: "en",
          $current_url: "/[code]",
          joinMode: "meeting",
          isAdmin: false,
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
    expect(sentBody(upstream).batch[0].properties).toMatchObject({ joinMode: "meeting", $browser_language: "en" });
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

  it("refuses a malformed exception for good, and says nothing of what failed", async () => {
    const malformed = [
      [null],
      [{ type: "TypeError", stacktrace: { frames: [null] } }],
      [{ type: "TypeError", mechanism: "generic", stacktrace: { frames: [{ filename: 7, lineno: "3" }] } }],
      "not a list",
    ];
    for (const list of malformed) {
      const json = JSON.stringify(captureBody([event({ $exception_list: list })]));
      const { response } = await forward(post(json, "application/json"));
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("");
      expect([...response.headers.keys()]).toEqual([]);
    }
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

  it("checks a tab's chunks against its own build's manifest, after a newer build is live", async () => {
    const releaseA = "aaaaaaa1111111111111111111111111111111aa";
    const releaseB = "bbbbbbb2222222222222222222222222222222bb";
    const idA = "0196f0a1-0000-7000-8000-00000000a001";
    const idB = "0196f0a1-0000-7000-8000-00000000b001";
    const manifests = new Map([
      [releaseA, new Map([[idA, "/_next/static/chunks/0aaaaaaaaaaaa.js"]])],
      [releaseB, new Map([[idB, "/_next/static/chunks/0bbbbbbbbbbbb.js"]])],
    ]);
    const requested: string[] = [];
    const manifest = async (version: string) => {
      requested.push(version);
      return manifests.get(version) ?? null;
    };
    let sequence = 0;
    const exceptionFrom = (release: string | undefined, id: string, file: string) => ({
      uuid: `0196f0a1-0000-7000-8000-${String(++sequence).padStart(12, "0")}`,
      event: "$exception",
      timestamp: "2026-11-22T00:00:00.000Z",
      properties: {
        token: KEY,
        distinct_id: UUID,
        ...(release ? { client_version: release } : {}),
        $current_url: "https://conclave.acmvit.in/[code]",
        $exception_list: [
          {
            type: "Error",
            value: "x",
            stacktrace: { type: "raw", frames: [{ filename: `https://conclave.acmvit.in${file}`, lineno: 1, chunk_id: id }] },
          },
        ],
      },
    });
    const sendFrom = async (events: unknown[]) => {
      const { upstream } = await forward(post(JSON.stringify(captureBody(events)), "application/json"), ["e"], { manifest });
      return sentBody(upstream).batch.map(
        (event) => (event.properties as { $exception_list: Array<{ stacktrace: { frames: Array<{ filename: string; chunk_id?: string }> } }> })
          .$exception_list[0].stacktrace.frames[0],
      );
    };

    // A tab still on release A, then one on B: each is checked against its own build.
    const fromA = await sendFrom([
      exceptionFrom(releaseA, idA, "/_next/static/chunks/0aaaaaaaaaaaa.js"),
      exceptionFrom(releaseA, idB, "/_next/static/chunks/0bbbbbbbbbbbb.js"),
    ]);
    const fromB = await sendFrom([exceptionFrom(releaseB, idB, "/_next/static/chunks/0bbbbbbbbbbbb.js")]);
    const fromUnknown = await sendFrom([exceptionFrom("ccccccc3333333333333333333333333333333cc", idA, "/_next/static/chunks/0aaaaaaaaaaaa.js")]);
    const fromNoBuild = await sendFrom([exceptionFrom(undefined, idA, "/_next/static/chunks/0aaaaaaaaaaaa.js")]);

    expect(fromA).toEqual([
      expect.objectContaining({ filename: "/_next/static/chunks/0aaaaaaaaaaaa.js", chunk_id: idA }),
      { platform: "web:javascript", function: "?", filename: "[path]", lineno: 1 },
    ]);
    expect(fromB).toEqual([expect.objectContaining({ filename: "/_next/static/chunks/0bbbbbbbbbbbb.js", chunk_id: idB })]);
    expect(fromUnknown).toEqual([expect.objectContaining({ filename: "/_next/static/chunks/0aaaaaaaaaaaa.js", chunk_id: idA })]);
    expect(fromNoBuild).toEqual([expect.objectContaining({ filename: "/_next/static/chunks/0aaaaaaaaaaaa.js", chunk_id: idA })]);
    expect(requested).toEqual([releaseA, releaseB, "ccccccc3333333333333333333333333333333cc"]);
  });

  it("looks up at most one build's manifest per request, however many builds the batch names", async () => {
    const calls: string[] = [];
    const events = Array.from({ length: 200 }, (_, index) =>
      event({ client_version: index.toString(16).padStart(40, "0").replace(/^0/, "a") }),
    );
    const { response, upstream } = await forward(post(JSON.stringify(captureBody(events)), "application/json"), ["e"], {
      manifest: async (version) => {
        calls.push(version);
        return new Map();
      },
    });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(sentBody(upstream).batch).toHaveLength(1);
    expect(sentBody(upstream).batch[0].properties).toMatchObject({ client_version: events[0].properties.client_version });
  });

  it("forwards an event the browser built unchanged, building it again from the schema", async () => {
    const chunk = "https://conclave.acmvit.in/_next/static/chunks/3u-6_1om1fv26.js";
    const captured = {
      uuid: "0196f0a1-0000-7000-8000-0000000000ab",
      event: "$exception",
      timestamp: "2026-11-22T00:00:00.000Z",
      properties: {
        token: KEY,
        distinct_id: UUID,
        $current_url: "https://conclave.acmvit.in/lime-pear-plum?invite=1",
        $browser_language: "en-US-x-labunit",
        $exception_list: [
          {
            type: "TypeError",
            value: "Meet Mira",
            mechanism: { type: "generic", handled: false },
            stacktrace: {
              type: "raw",
              frames: [
                { filename: chunk, function: "joinRoom", lineno: 1, colno: 2, chunk_id: CHUNK_ID },
                { filename: chunk, lineno: 3, chunk_id: "0f8c2a1e-5b7d-4c3e-9a10-000000000001" },
                { filename: "https://conclave.acmvit.in/lime-pear-plum", lineno: 4 },
              ],
            },
          },
        ],
      },
    };
    const browserBuilt = beforeSend(captured, {
      payload: null,
      storedKeys: new Set(),
      token: KEY,
      clientVersion: BUILD,
      chunkFiles: new Map([[CHUNK_ID, "/_next/static/chunks/3u-6_1om1fv26.js"]]),
      siteOrigin: "https://conclave.acmvit.in",
    });
    const { upstream } = await forward(post(JSON.stringify(captureBody([browserBuilt])), "application/json"));

    const [sent] = sentBody(upstream).batch as Array<{ properties: Record<string, unknown> }>;
    expect(sent.properties).toEqual(browserBuilt?.properties);
    expect((sent.properties.$exception_list as Array<{ stacktrace: { frames: unknown[] } }>)[0].stacktrace.frames).toEqual([
      { platform: "web:javascript", function: "?", filename: "/_next/static/chunks/3u-6_1om1fv26.js", lineno: 1, colno: 2, chunk_id: CHUNK_ID },
      { platform: "web:javascript", function: "?", filename: "[path]", lineno: 3 },
      { platform: "web:javascript", function: "?", filename: "[path]", lineno: 4 },
    ]);
  });
});

describe("the rate limit at /ingest", () => {
  const body = () => post(JSON.stringify(captureBody([event()])), "application/json");

  it("answers 429 with its Retry-After, before reading the body or forwarding, when the limit is reached", async () => {
    const admit = vi.fn(async () => ({ ok: false, status: 429, retryAfterMs: 60_000 }) as const);
    const request = body();
    const { response, upstream } = await forward(request, ["e"], { admit });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(admit).toHaveBeenCalledWith(request);
    expect(request.bodyUsed).toBe(false);
    expect(upstream).toEqual([]);
  });

  it("answers 503 when the limiter cannot be asked", async () => {
    const { response, upstream } = await forward(body(), ["e"], {
      admit: async () => ({ ok: false, status: 503, retryAfterMs: null }),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(upstream).toEqual([]);
  });

  it("forwards a request the limiter admits", async () => {
    const { response, upstream } = await forward(body());

    expect(response.status).toBe(200);
    expect(upstream).toHaveLength(1);
  });
});

describe("the outbound schema at /ingest", () => {
  const RECEIVED = Date.parse("2026-11-22T12:00:00.000Z");
  const OLD_BUILD = "aaaaaaa1111111111111111111111111111111aa";
  const manifests = new Map<string, ReadonlyMap<string, string>>([
    [BUILD, new Map([[CHUNK_ID, "/_next/static/chunks/3u-6_1om1fv26.js"]])],
    [OLD_BUILD, new Map()],
  ]);
  const deps = {
    manifest: async (version: string) => manifests.get(version) ?? null,
    now: () => RECEIVED,
  } as Partial<IngestDeps>;
  const send = async (events: unknown[], body: Record<string, unknown> = {}) => {
    const { response, upstream } = await forward(
      post(JSON.stringify({ ...captureBody(events), ...body }), "application/json"),
      ["e"],
      deps,
    );
    return { response, upstream, batch: upstream.length ? sentBody(upstream).batch : [] };
  };

  it("sends a constant host and only templated paths, never an origin", async () => {
    const { batch, upstream } = await send([
      event({
        client_version: BUILD,
        $host: "audit-operator-site.localhost:5815",
        $current_url: "http://audit-operator-site.localhost:5815/privacy?from=mail",
        $pathname: "/privacy",
      }),
      {
        uuid: "0196f0a1-0000-7000-8000-0000000000ab",
        event: "$exception",
        timestamp: "2026-11-22T11:59:59.000Z",
        properties: {
          token: KEY,
          distinct_id: UUID,
          client_version: BUILD,
          $host: "audit-operator-site.localhost:5815",
          $current_url: "https://conclave.acmvit.in/lime-pear-plum",
          $exception_list: [
            {
              type: "TypeError",
              value: "x",
              stacktrace: {
                type: "raw",
                frames: [
                  { filename: "https://conclave.acmvit.in/_next/static/chunks/3u-6_1om1fv26.js", lineno: 1, chunk_id: CHUNK_ID },
                  { filename: "https://audit-operator-site.localhost:5815/_next/static/chunks/3u-6_1om1fv26.js", lineno: 2, chunk_id: CHUNK_ID },
                  { filename: "chrome-extension://fleetassetabcdefgh/inject.js", lineno: 3 },
                  { filename: "https://conclave.acmvit.in/transcript-pcm-processor.js", lineno: 4 },
                ],
              },
            },
          ],
        },
      },
    ]);

    expect(batch.map((sent) => (sent.properties as Record<string, unknown>).$host)).toEqual(["conclave-web", "conclave-web"]);
    expect(batch.map((sent) => (sent.properties as Record<string, unknown>).$current_url)).toEqual(["/privacy", "/[code]"]);
    const frames = (batch[1].properties as { $exception_list: Array<{ stacktrace: { frames: Array<{ filename: string }> } }> })
      .$exception_list[0].stacktrace.frames;
    expect(frames.map((frame) => frame.filename)).toEqual([
      "/_next/static/chunks/3u-6_1om1fv26.js",
      "[path]",
      "[path]",
      "/transcript-pcm-processor.js",
    ]);
    expect(String(upstream[0].init.body)).not.toMatch(/https?:|chrome-extension|audit-operator|acmvit|localhost|fleetasset|from=mail/);
  });

  it("names the event's own build whenever it has a build's form, its manifest found or not, and any other as unknown", async () => {
    const { batch: current } = await send([event({ client_version: BUILD })]);
    const { batch: older } = await send([event({ client_version: OLD_BUILD })]);
    const { batch: gone } = await send([event({ client_version: "facade00" })]);
    const { batch: none } = await send([event({ client_version: "Meet Mira" })]);

    expect([current, older, gone, none].map((batch) => (batch[0].properties as Record<string, unknown>).client_version)).toEqual([
      BUILD,
      OLD_BUILD,
      "facade00",
      "unknown",
    ]);
  });

  it("keeps an old build's frames of the shared forms when this deployment no longer has its manifest, and strips the rest", async () => {
    const gone = "c0ffee0c0ffee0c0ffee0c0ffee0c0ffee0c0ff";
    const frames = [
      { filename: "https://conclave.acmvit.in/_next/static/chunks/3u-6_1om1fv26.js?v=2", lineno: 1, colno: 2, in_app: true, chunk_id: CHUNK_ID },
      { filename: "https://cdn.example.net/_next/static/chunks/3u-6_1om1fv26.js", lineno: 2, chunk_id: CHUNK_ID },
      { filename: "https://conclave.acmvit.in/_next/static/chunks/3u-6_1om1fv26.js", lineno: 3, chunk_id: "1team-meeting" },
      { filename: "/_next/static/chunks/../../../api/auth/session.js", lineno: 4, chunk_id: CHUNK_ID },
      { filename: "/_next/static/chunks/review@example.invalid.js", lineno: 5, chunk_id: CHUNK_ID },
    ];
    const { response, batch } = await send([
      {
        uuid: "0196f0a1-0000-7000-8000-0000000000ac",
        event: "$exception",
        timestamp: "2026-11-22T11:59:59.000Z",
        properties: {
          token: KEY,
          client_version: gone,
          $exception_list: [{ type: "TypeError", value: "x", stacktrace: { type: "raw", frames } }],
        },
      },
    ]);

    expect(response.status).toBe(200);
    const sent = batch[0].properties as { client_version: string; $exception_list: Array<{ stacktrace: { frames: unknown[] } }> };
    expect(sent.client_version).toBe(gone);
    expect(sent.$exception_list[0].stacktrace.frames).toEqual([
      { platform: "web:javascript", function: "?", filename: "/_next/static/chunks/3u-6_1om1fv26.js", lineno: 1, colno: 2, in_app: true, chunk_id: CHUNK_ID },
      { platform: "web:javascript", function: "?", filename: "[path]", lineno: 2, chunk_id: CHUNK_ID },
      { platform: "web:javascript", function: "?", filename: "[path]", lineno: 3 },
      { platform: "web:javascript", function: "?", filename: "[path]", lineno: 4, chunk_id: CHUNK_ID },
      { platform: "web:javascript", function: "?", filename: "[path]", lineno: 5, chunk_id: CHUNK_ID },
    ]);
  });

  it("forwards only the events on the list", async () => {
    const { batch } = await send([
      event(),
      { ...event(), event: "$pageview" },
      { ...event(), event: "Meet Mira joined sample-room" },
      { ...event(), event: "$identify" },
    ]);

    expect(batch.map((sent) => sent.event)).toEqual(["meet_join_attempt"]);
  });

  it("forwards each event's own time unchanged when its window or the browser's own send time vouches for it, and no other", async () => {
    let n = 0;
    const at = (timestamp: string) => ({
      ...event(),
      uuid: `0196f0a1-0000-7000-8000-0000000001${String(++n).padStart(2, "0")}`,
      timestamp,
    });
    const { batch: skewed, upstream } = await send(
      [at("2031-01-01T00:00:00.000Z"), at("2031-01-01T00:00:00.000Z"), at("2030-12-31T23:59:58.500Z"), at("2030-12-31T22:00:00.000Z")],
      { sent_at: "2031-01-01T00:00:00.000Z" },
    );
    const { batch: unsent } = await send(
      [at("1999-01-01T00:00:00.000Z"), at("2099-01-01T00:00:00.000Z"), at("2026-11-22T11:59:30.000Z")],
      { sent_at: undefined },
    );

    expect(skewed.map((sent) => sent.timestamp)).toEqual([
      "2031-01-01T00:00:00.000Z",
      "2031-01-01T00:00:00.000Z",
      "2030-12-31T23:59:58.500Z",
    ]);
    expect(sentBody(upstream)).not.toHaveProperty("sent_at");
    expect(unsent.map((sent) => sent.timestamp)).toEqual(["2026-11-22T11:59:30.000Z"]);
  });

  it("drops every field the schema does not list, at any depth, and any value not in its form", async () => {
    const { batch, upstream } = await send([
      {
        uuid: "0196f0a1-0000-7000-8000-0000000000ac",
        event: "$exception",
        timestamp: "2026-11-22T12:00:00.000Z",
        $set: { email: "mira@example.com" },
        extra: "UnknownTopLevelCanary",
        properties: {
          token: KEY,
          distinct_id: UUID,
          $device_id: "not-a-uuid UnknownIdCanary",
          client_version: BUILD,
          $browser: "ReviewBrowser UnknownBrowserCanary",
          $browser_version: 157,
          $os: "Mac OS X",
          $os_version: "Xbox FleetAsset123",
          $lib: "web",
          $lib_version: "1.453.1",
          $timezone: "Asia/Calcutta",
          $insert_id: "UnknownInsertCanary",
          $unknown_sdk_field: "UnknownSdkCanary",
          unknown_app_field: "UnknownAppCanary",
          source: "react_error_boundary UnknownSourceCanary",
          boundary: "panel",
          digest: "UnknownDigestCanary",
          $exception_list: [
            {
              type: "TypeError",
              value: "UnknownMessageCanary",
              module: "UnknownModuleCanary",
              mechanism: { type: "generic", handled: true, data: "UnknownMechanismCanary" },
              stacktrace: {
                type: "raw",
                extra: "UnknownStacktraceCanary",
                frames: [
                  {
                    filename: "https://conclave.acmvit.in/_next/static/chunks/3u-6_1om1fv26.js",
                    function: "UnknownFunctionCanary",
                    lineno: 1,
                    colno: 2,
                    in_app: true,
                    chunk_id: CHUNK_ID,
                    abs_path: "UnknownAbsPathCanary",
                    context_line: "UnknownContextCanary",
                    vars: { secret: "UnknownVarsCanary" },
                  },
                ],
              },
            },
          ],
        },
      },
    ]);

    expect(batch).toEqual([
      {
        uuid: "0196f0a1-0000-7000-8000-0000000000ac",
        event: "$exception",
        timestamp: "2026-11-22T12:00:00.000Z",
        properties: {
          token: KEY,
          distinct_id: UUID,
          client_version: BUILD,
          $browser_version: 157,
          $os: "Mac OS X",
          $lib: "web",
          $lib_version: "1.453.1",
          $host: "conclave-web",
          $process_person_profile: false,
          boundary: "panel",
          $exception_list: [
            {
              type: "TypeError",
              value: "[message withheld]",
              mechanism: { type: "generic", handled: true },
              stacktrace: {
                type: "raw",
                frames: [
                  {
                    platform: "web:javascript",
                    function: "?",
                    filename: "/_next/static/chunks/3u-6_1om1fv26.js",
                    lineno: 1,
                    colno: 2,
                    in_app: true,
                    chunk_id: CHUNK_ID,
                  },
                ],
              },
            },
          ],
        },
      },
    ]);
    expect(String(upstream[0].init.body)).not.toMatch(/Canary|mira@|FleetAsset|ReviewBrowser|Calcutta/);
  });
});

describe("round 9 at /ingest", () => {
  const RECEIVED = Date.parse("2026-11-22T12:00:00.000Z");
  const at = (now: number, extra: Partial<IngestDeps> = {}) => ({ now: () => now, ...extra }) as Partial<IngestDeps>;
  const timesOf = (upstream: Array<{ init: RequestInit }>) => sentBody(upstream).batch.map((sent) => sent.timestamp);

  it("takes only the content types posthog-js sends", async () => {
    const json = JSON.stringify(captureBody([event()]));
    for (const type of ["text/html", "image/png", "multipart/form-data; boundary=x", ""]) {
      const { response, upstream } = await forward(post(json, type));
      expect(response.status, type).toBe(400);
      expect(await response.text()).toBe("");
      expect(upstream).toEqual([]);
    }
    for (const type of ["application/json", "application/json; charset=utf-8", "text/plain;charset=UTF-8"]) {
      expect((await forward(post(json, type))).response.status, type).toBe(200);
    }
  });

  const failing = async () => new Response(null, { status: 503 });

  it("sends a retried event as it sent it the first time, and no event too old or too far ahead to vouch for", async () => {
    const forwarded = createForwardedEvents();
    const events = [
      { ...event(), uuid: "0196f0a1-0000-7000-8000-0000000000b1", timestamp: "2026-11-22T11:59:58.000Z" },
      { ...event(), uuid: "0196f0a1-0000-7000-8000-0000000000b2", timestamp: "2026-11-22T09:00:00.000Z" },
      { ...event(), uuid: "0196f0a1-0000-7000-8000-0000000000b3", timestamp: "2031-01-01T00:00:00.000Z" },
    ];
    const json = JSON.stringify({ ...captureBody(events), sent_at: undefined });
    const sentFirst: string[] = [];
    const first = await forward(post(json, "application/json"), ["e"], at(RECEIVED, {
      forwarded,
      fetch: async (_url, init) => {
        sentFirst.push(String(init?.body));
        return failing();
      },
    }));
    expect(first.response.status).toBe(503);
    first.upstream.push({ url: "", init: { body: sentFirst[0] } });
    const retry = await forward(post(json, "application/json"), ["e"], at(RECEIVED + 20_000, { forwarded }));

    expect(sentBody(retry.upstream).batch).toEqual(sentBody(first.upstream).batch);
    expect(timesOf(first.upstream)).toEqual(["2026-11-22T11:59:58.000Z"]);
  });

  it("forwards a retry exactly as the first delivery, even from a browser clock 90 s ahead", async () => {
    const forwarded = createForwardedEvents();
    const ahead = { ...event(), uuid: "0196f0a1-0000-7000-8000-0000000000c1", timestamp: "2026-11-22T12:01:30.000Z" };
    const json = JSON.stringify({ ...captureBody([ahead]), sent_at: "2026-11-22T12:01:30.000Z" });
    const sentFirst: string[] = [];
    const first = await forward(post(json, "application/json"), ["e"], at(RECEIVED, {
      forwarded,
      fetch: async (_url, init) => {
        sentFirst.push(String(init?.body));
        return failing();
      },
    }));
    first.upstream.push({ url: "", init: { body: sentFirst[0] } });
    const retry = await forward(post(json, "application/json"), ["e"], at(RECEIVED + 40_000, { forwarded }));

    expect(sentBody(first.upstream).batch).toHaveLength(1);
    expect(sentBody(retry.upstream).batch).toEqual(sentBody(first.upstream).batch);
    expect(timesOf(first.upstream)).toEqual(["2026-11-22T12:01:30.000Z"]);
  });

  it("forwards a replayed event's uuid and timestamp byte for byte, from a skewed clock and a fresh instance", async () => {
    const captured = { ...event(), uuid: "0196f0a1-0000-7000-8000-0000000000f1", timestamp: "2026-11-22T13:59:50.000Z" };
    const sent = async (sentAt: string, receivedAt: number) => {
      const { response, upstream } = await forward(
        post(JSON.stringify({ ...captureBody([captured]), sent_at: sentAt }), "application/json"),
        ["e"],
        at(receivedAt, { forwarded: createForwardedEvents() }),
      );
      expect(response.status).toBe(200);
      const [one] = sentBody(upstream).batch;
      return { uuid: one.uuid, timestamp: one.timestamp };
    };

    const first = await sent("2026-11-22T14:00:00.000Z", RECEIVED + 250);
    const replay = await sent("2026-11-22T14:03:10.000Z", RECEIVED + 190_900);
    expect(first).toEqual({ uuid: captured.uuid, timestamp: captured.timestamp });
    expect(replay).toEqual(first);
  });

  it("forwards an event already in flight on this instance once, and answers the second request by that outcome", async () => {
    const forwarded = createForwardedEvents();
    const calls: string[] = [];
    const answers: Array<(response: Response) => void> = [];
    const slow = async (_url: string, init: RequestInit) => {
      calls.push(String(init.body));
      return new Promise<Response>((resolve) => answers.push(resolve));
    };
    const json = JSON.stringify(captureBody([event()]));
    const twice = async (status: number) => {
      const earlier = calls.length;
      const first = forward(post(json, "application/json"), ["e"], at(RECEIVED, { forwarded, fetch: slow }));
      const second = forward(post(json, "application/json"), ["e"], at(RECEIVED, { forwarded, fetch: slow }));
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(earlier));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const before = calls.length;
      for (const answer of answers.splice(0)) answer(new Response(status === 200 ? '{"status":1}' : null, { status }));
      return { before, statuses: [(await first).response.status, (await second).response.status] };
    };

    const failed = await twice(503);
    expect(failed).toEqual({ before: 1, statuses: [503, 503] });
    const delivered = await twice(200);
    expect(delivered).toEqual({ before: 2, statuses: [200, 200] });
    expect(calls).toHaveLength(2);
  });

  it("forwards nothing again for events PostHog already took, and answers the browser that they arrived", async () => {
    const forwarded = createForwardedEvents();
    const taken = { ...event(), uuid: "0196f0a1-0000-7000-8000-0000000000d1", timestamp: "2026-11-22T11:59:58.000Z" };
    const fresh = { ...event(), uuid: "0196f0a1-0000-7000-8000-0000000000d2", timestamp: "2026-11-22T11:59:59.000Z" };
    await forward(post(JSON.stringify(captureBody([taken])), "application/json"), ["e"], at(RECEIVED, { forwarded }));

    const again = await forward(post(JSON.stringify(captureBody([taken])), "application/json"), ["e"], at(RECEIVED + 5000, { forwarded }));
    expect(again.response.status).toBe(200);
    expect(again.upstream).toEqual([]);

    const mixed = await forward(post(JSON.stringify(captureBody([taken, fresh])), "application/json"), ["e"], at(RECEIVED + 6000, { forwarded }));
    expect(sentBody(mixed.upstream).batch.map((sent) => sent.uuid)).toEqual([fresh.uuid]);
  });

  it("forwards an event once when one request names its uuid twice", async () => {
    const { upstream } = await forward(post(JSON.stringify(captureBody([event(), event()])), "application/json"));

    expect(sentBody(upstream).batch.map((sent) => sent.uuid)).toEqual(["0196f0a1-0000-7000-8000-0000000000aa"]);
  });

  it("forwards no exception without an exception list", async () => {
    const exception = (properties: Record<string, unknown>) => ({
      ...event(),
      uuid: "0196f0a1-0000-7000-8000-0000000000e1",
      event: "$exception",
      properties: { ...event().properties, ...properties },
    });
    for (const list of [undefined, []]) {
      const { response, upstream } = await forward(post(JSON.stringify(captureBody([exception({ $exception_list: list })])), "application/json"));
      expect(response.status).toBe(400);
      expect(upstream).toEqual([]);
    }
    const mixed = await forward(post(JSON.stringify(captureBody([exception({ $exception_list: [] }), event()])), "application/json"));
    expect(sentBody(mixed.upstream).batch.map((sent) => sent.event)).toEqual(["meet_join_attempt"]);
  });
});

describe("createChunkManifestLoader", () => {
  const manifest = { [CHUNK_ID]: "/_next/static/chunks/3u-6_1om1fv26.js" };

  it("fetches a build's own manifest once, by its id, and keeps it", async () => {
    const urls: string[] = [];
    const load = createChunkManifestLoader({
      origin: "https://conclave.acmvit.in",
      fetch: async (url) => {
        urls.push(url);
        return new Response(JSON.stringify(manifest), { status: 200 });
      },
    });

    expect([...((await load(BUILD)) ?? [])]).toEqual([[CHUNK_ID, "/_next/static/chunks/3u-6_1om1fv26.js"]]);
    await load(BUILD);
    expect(urls).toEqual([`https://conclave.acmvit.in/_next/static/posthog-chunk-ids/${BUILD}.json?dpl=${BUILD}`]);
  });

  it("fetches a build's manifest once for concurrent requests, and remembers a missing one", async () => {
    let fetches = 0;
    let release: (response: Response) => void = () => {};
    const load = createChunkManifestLoader({
      origin: "https://conclave.acmvit.in",
      fetch: (url) => {
        fetches += 1;
        if (url.includes(BUILD)) return new Promise<Response>((resolve) => (release = resolve));
        return Promise.resolve(new Response("not found", { status: 404 }));
      },
    });

    const both = Promise.all([load(BUILD), load(BUILD)]);
    release(new Response(JSON.stringify(manifest), { status: 200 }));
    const [first, second] = await both;
    expect(first).toBe(second);
    expect(fetches).toBe(1);

    const missing = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    await load(missing);
    await load(missing);
    expect(fetches).toBe(2);
  });

  it("keeps a few builds' manifests, dropping the least recently used", async () => {
    const urls: string[] = [];
    const load = createChunkManifestLoader({
      origin: "https://conclave.acmvit.in",
      fetch: async (url) => {
        urls.push(url);
        return new Response(JSON.stringify(manifest), { status: 200 });
      },
    });
    const builds = Array.from({ length: 17 }, (_, index) => `${index.toString(16)}`.padStart(40, "a"));

    for (const build of builds.slice(0, 16)) await load(build);
    await load(builds[0]);
    await load(builds[16]);
    await load(builds[0]);
    await load(builds[1]);

    expect(urls).toHaveLength(18);
    expect(urls.at(-1)).toContain(builds[1]);
  });

  it("finds no manifest for a build it cannot fetch or read, and fetches nothing for an id that is not a build's", async () => {
    const urls: string[] = [];
    const load = createChunkManifestLoader({
      origin: "https://conclave.acmvit.in",
      fetch: async (url) => {
        urls.push(url);
        if (url.includes("deadbee")) throw new TypeError("fetch failed");
        if (url.includes("facade0")) return new Response('{"not-a-uuid": "x"}', { status: 200 });
        return new Response("not found", { status: 404 });
      },
    });

    expect(await load(BUILD)).toBeNull();
    expect(await load("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).toBeNull();
    expect(await load("facade00")).toBeNull();
    expect(await load("../../secrets")).toBeNull();
    expect(await load("local")).toBeNull();
    expect(urls).toHaveLength(3);
  });
});

describe("PostHog's answers and slow requests at /ingest", () => {
  const json = () => JSON.stringify(captureBody([event()]));
  const answering = (status: number, headers: Record<string, string> = {}) => async () =>
    new Response(status === 204 ? null : "", { status, headers });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [200, 200],
    [204, 200],
    [408, 503],
    [425, 503],
    [429, 503],
    [500, 503],
    [502, 503],
    [503, 503],
    [504, 503],
    [400, 400],
    [401, 400],
    [403, 400],
    [404, 400],
    [413, 400],
  ])("answers the browser for PostHog's %i with %i", async (upstream, expected) => {
    const { response } = await forward(post(json(), "application/json"), ["e"], { fetch: answering(upstream) });

    expect(response.status).toBe(expected);
  });

  it("passes PostHog's Retry-After on, in seconds and at most a minute", async () => {
    const retryAfter = async (status: number, value: string) =>
      (await forward(post(json(), "application/json"), ["e"], { fetch: answering(status, { "retry-after": value }) })).response.headers.get(
        "retry-after",
      );

    expect(await retryAfter(429, "30")).toBe("30");
    expect(await retryAfter(503, new Date(NOW + 20_000).toUTCString())).toBe("20");
    expect(await retryAfter(429, "3600")).toBe("60");
    expect(await retryAfter(429, "soon")).toBeNull();
  });

  it("gives up on PostHog after its deadline and asks the browser to send again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let signal: AbortSignal | undefined;
    const pending = forward(post(json(), "application/json"), ["e"], {
      fetch: (_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      },
    });
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(UPSTREAM_DEADLINE_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).response.status).toBe(503);
    expect(signal?.aborted).toBe(true);
  });

  const manifestBody = JSON.stringify({ [CHUNK_ID]: "/_next/static/chunks/3u-6_1om1fv26.js" });

  it("gives up on a manifest request that never answers, or whose body never ends, at its deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stalls = [
      () => new Promise<Response>(() => {}),
      () => Promise.resolve(new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode("{")) }))),
    ];
    for (const stall of stalls) {
      const signals: AbortSignal[] = [];
      const load = createChunkManifestLoader({
        origin: "https://conclave.acmvit.in",
        fetch: (_url, init) => {
          if (init?.signal) signals.push(init.signal);
          return stall();
        },
      });
      const loading = load(BUILD);
      await vi.advanceTimersByTimeAsync(MANIFEST_DEADLINE_MS);
      expect(await loading).toBeNull();
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    }
  });

  it("keeps the last manifest it read when a later load fails or stalls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let now = NOW;
    let answer: "good" | "error" | "stall" = "good";
    const load = createChunkManifestLoader({
      origin: "https://conclave.acmvit.in",
      now: () => now,
      fetch: () => {
        if (answer === "stall") return new Promise<Response>(() => {});
        return Promise.resolve(answer === "good" ? new Response(manifestBody, { status: 200 }) : new Response("", { status: 500 }));
      },
    });
    const good = await load(BUILD);
    expect(good?.get(CHUNK_ID)).toBe("/_next/static/chunks/3u-6_1om1fv26.js");

    for (const next of ["error", "stall"] as const) {
      now += 11 * 60_000;
      answer = next;
      const loading = load(BUILD);
      await vi.advanceTimersByTimeAsync(MANIFEST_DEADLINE_MS);
      expect((await loading)?.get(CHUNK_ID), next).toBe("/_next/static/chunks/3u-6_1om1fv26.js");
    }
  });

  it("forwards a request while the manifest server stalls, once the manifest's deadline passes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let asked = false;
    const manifest = createChunkManifestLoader({
      origin: "https://conclave.acmvit.in",
      fetch: () => {
        asked = true;
        return new Promise<Response>(() => {});
      },
    });
    const ofBuild = JSON.stringify(captureBody([event({ client_version: BUILD })]));
    const pending = forward(post(ofBuild, "application/json"), ["e"], { manifest });
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(MANIFEST_DEADLINE_MS - 1);
    expect(asked).toBe(true);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const { response, upstream } = await pending;
    expect(response.status).toBe(200);
    expect(upstream).toHaveLength(1);
  });
});
