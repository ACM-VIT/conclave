import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  createChunkManifestLoader,
  forwardCapture,
  INGEST_USER_AGENT,
  type IngestDeps,
} from "../src/app/lib/telemetry-ingest";

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
    chunkFiles: async (version) =>
      new Map(version === BUILD ? [[CHUNK_ID, "/_next/static/chunks/3u-6_1om1fv26.js"]] : []),
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

  it("checks a tab's chunks against its own build's manifest, after a newer build is live", async () => {
    const releaseA = "aaaaaaa1111111111111111111111111111111aa";
    const releaseB = "bbbbbbb2222222222222222222222222222222bb";
    const idA = "0196f0a1-0000-7000-8000-00000000a001";
    const idB = "0196f0a1-0000-7000-8000-00000000b001";
    const manifests = new Map([
      [releaseA, new Map([[idA, "/_next/static/chunks/0aaaaaaaaaaaa.js"]])],
      [releaseB, new Map([[idB, "/_next/static/chunks/0bbbbbbbbbbbb.js"]])],
    ]);
    const requested: Array<string | null> = [];
    const chunkFiles = async (version: string | null) => {
      requested.push(version);
      return manifests.get(version ?? "") ?? new Map();
    };
    const exceptionFrom = (release: string | undefined, id: string, file: string) => ({
      event: "$exception",
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
      const { upstream } = await forward(post(JSON.stringify(captureBody(events)), "application/json"), ["e"], { chunkFiles });
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
      expect.objectContaining({ filename: "https://conclave.acmvit.in/_next/static/chunks/0aaaaaaaaaaaa.js", chunk_id: idA }),
      { platform: "web:javascript", function: "?", filename: "https://conclave.acmvit.in/[path]", lineno: 1 },
    ]);
    expect(fromB).toEqual([
      expect.objectContaining({ filename: "https://conclave.acmvit.in/_next/static/chunks/0bbbbbbbbbbbb.js", chunk_id: idB }),
    ]);
    expect(fromUnknown).toEqual([{ platform: "web:javascript", function: "?", filename: "https://conclave.acmvit.in/[path]", lineno: 1 }]);
    expect(fromNoBuild).toEqual([{ platform: "web:javascript", function: "?", filename: "https://conclave.acmvit.in/[path]", lineno: 1 }]);
    expect(requested).toEqual([releaseA, releaseB, "ccccccc3333333333333333333333333333333cc"]);
  });

  it("looks up at most one build's manifest per request, however many builds the batch names", async () => {
    const calls: Array<string | null> = [];
    const events = Array.from({ length: 200 }, (_, index) =>
      event({ client_version: index.toString(16).padStart(40, "0").replace(/^0/, "a") }),
    );
    const { response, upstream } = await forward(post(JSON.stringify(captureBody(events)), "application/json"), ["e"], {
      chunkFiles: async (version) => {
        calls.push(version);
        return new Map();
      },
    });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(sentBody(upstream).batch).toHaveLength(1);
    expect(sentBody(upstream).batch[0].properties).toMatchObject({ client_version: events[0].properties.client_version });
  });

  it("checks chunk paths against the build's manifest and leaves a scrubbed event as it was", async () => {
    const chunk = "https://conclave.acmvit.in/_next/static/chunks/3u-6_1om1fv26.js";
    const exception = {
      uuid: "0196f0a1-0000-7000-8000-0000000000ab",
      event: "$exception",
      properties: {
        token: KEY,
        distinct_id: UUID,
        client_version: BUILD,
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

    expect([...(await load(BUILD))]).toEqual([[CHUNK_ID, "/_next/static/chunks/3u-6_1om1fv26.js"]]);
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

  it("trusts no manifest it cannot find, and fetches nothing for an id that is not a build's", async () => {
    const urls: string[] = [];
    const load = createChunkManifestLoader({
      origin: "https://conclave.acmvit.in",
      fetch: async (url) => {
        urls.push(url);
        if (url.includes("deadbee")) throw new TypeError("fetch failed");
        return new Response("not found", { status: 404 });
      },
    });

    expect([...(await load(BUILD))]).toEqual([]);
    expect([...(await load("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"))]).toEqual([]);
    expect([...(await load(null))]).toEqual([]);
    expect([...(await load("../../secrets"))]).toEqual([]);
    expect([...(await load("local"))]).toEqual([]);
    expect(urls).toHaveLength(2);
  });
});
