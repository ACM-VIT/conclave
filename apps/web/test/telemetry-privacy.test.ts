import { readdirSync } from "node:fs";
import path from "node:path";
import type { CaptureResult } from "posthog-js";
import { describe, expect, it } from "vitest";
import {
  type CallMetricEvent,
  type CallStatsSample,
  createCallMetricsTracker,
} from "../src/app/lib/call-quality-metrics";
import type { ConnectionState } from "../src/app/lib/types";
import {
  type EventOrigin,
  FIRST_PARTY_SCRIPTS,
  scrubTelemetryEvent,
  scrubText,
  scrubUrl,
} from "../src/app/lib/telemetry-privacy";

// The public jwt.io sample shape ({"alg":"HS256"}, {"sub":"1234567890"}),
// joined at runtime so secret scanners do not read it as a leaked key.
const sampleJwt = [
  "eyJhbGciOiJIUzI1NiJ9",
  "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
  "bm90LWEtcmVhbC1zaWduYXR1cmU",
].join(".");

// The chunk ids this test's "build" injected, by file.
const buildChunks = new Map([
  ["11079975-c075-50b3-ad5f-87be8f4248d0", "/_next/static/chunks/0yo6oel71v_bh.js"],
  ["147fc2df-e663-5d76-aa13-f67e1e894071", "/_next/static/chunks/3u-6_1om1fv26.js"],
]);

// As before_send sees an event our own code captured: the event's own
// application fields are the emitter's payload, and nothing came from storage.
const scrub = (event: CaptureResult, origin: Partial<EventOrigin> = {}) =>
  scrubTelemetryEvent(event, {
    payload: Object.fromEntries(
      Object.entries(event.properties).filter(
        ([key]) => !key.startsWith("$") && key !== "token" && key !== "distinct_id",
      ),
    ),
    storedKeys: new Set(),
    chunkFiles: buildChunks,
    ...origin,
  });

const exceptionEvent = (): CaptureResult => ({
  uuid: "0196-uuid",
  event: "$exception",
  properties: {
    token: "phc_test_project_key_00000000000000000000000",
    distinct_id: "0196f0a1-0000-7000-8000-000000000000",
    $current_url:
      "https://conclave.acmvit.in/yato-sokka-akane?invite=abc123#chat",
    $pathname: "/yato-sokka-akane",
    $referrer: "https://conclave.acmvit.in/w/spring-demo?code=xyz",
    $title: "yato-sokka-akane · c0nclav3",
    $browser: "Chrome",
    client_version: "0b2d3b480f4621392a4151d750c90965b7c8b76c",
    roomId: "yato-sokka-akane",
    userId: "ishaan@example.com#s1",
    call_log: "[Meets] Failed to produce video for ishaan@example.com",
    $exception_list: [
      {
        type: "Error",
        value:
          `Join failed for ishaan@example.com token ${sampleJwt}`,
        stacktrace: {
          type: "raw",
          frames: [
            {
              filename:
                "https://conclave.acmvit.in/_next/static/chunks/0yo6oel71v_bh.js",
              lineno: 1,
              colno: 2048,
              chunk_id: "11079975-c075-50b3-ad5f-87be8f4248d0",
            },
            {
              filename: "https://conclave.acmvit.in/yato-sokka-akane?x=1",
              lineno: 4,
            },
          ],
        },
      },
    ],
  },
});

describe("scrubTelemetryEvent", () => {
  it("removes room codes, query strings, titles, emails and tokens", () => {
    const { properties } = scrub(exceptionEvent());

    expect(properties.$current_url).toBe("https://conclave.acmvit.in/[code]");
    expect(properties.$pathname).toBe("/[code]");
    expect(properties).not.toHaveProperty("$referrer");
    expect(properties).not.toHaveProperty("$title");
    expect(properties).not.toHaveProperty("roomId");
    expect(properties).not.toHaveProperty("userId");
    expect(properties).not.toHaveProperty("call_log");

    const [entry] = properties.$exception_list;
    expect(entry.value).toBe("[message withheld]");
    expect(entry.stacktrace.frames[1].filename).toBe(
      "https://conclave.acmvit.in/[code]",
    );
    expect(JSON.stringify(properties)).not.toMatch(/yato|ishaan|abc123|xyz/);
  });

  it("keeps what ingestion and symbolication need", () => {
    const { properties } = scrub(exceptionEvent(), {
      clientVersion: "0b2d3b480f4621392a4151d750c90965b7c8b76c",
    });

    expect(properties.token).toBe(
      "phc_test_project_key_00000000000000000000000",
    );
    expect(properties.distinct_id).toBe("0196f0a1-0000-7000-8000-000000000000");
    expect(properties.$browser).toBe("Chrome");
    expect(properties.client_version).toBe(
      "0b2d3b480f4621392a4151d750c90965b7c8b76c",
    );
    expect(properties.$exception_list[0].stacktrace.frames[0]).toEqual({
      platform: "web:javascript",
      function: "?",
      filename: "https://conclave.acmvit.in/_next/static/chunks/0yo6oel71v_bh.js",
      lineno: 1,
      colno: 2048,
      chunk_id: "11079975-c075-50b3-ad5f-87be8f4248d0",
    });
  });
});

describe("attribution and asset paths", () => {
  it("drops campaign and click-id properties, including the SDK's copies", () => {
    const event = exceptionEvent();
    Object.assign(event.properties, {
      utm_source: "newsletter",
      utm_content: "ishaan@example.com",
      fbclid: "IwAR0abcDEF123",
      gclid: "Cj0KCQiA",
      $fbc: "fb.1.1700000000.IwAR0abcDEF123",
      $session_entry_utm_content: "ishaan@example.com",
      $session_entry_fbclid: "IwAR0abcDEF123",
      $initial_utm_campaign: "launch",
      $initial_msclkid: "abc123",
    });
    event.$set_once = {
      $initial_utm_content: "ishaan@example.com",
      $initial_fbclid: "IwAR0abcDEF123",
      $initial_browser: "Chrome",
    };
    const scrubbed = scrub(event);

    const keys = [
      ...Object.keys(scrubbed.properties),
      ...Object.keys(scrubbed.$set_once ?? {}),
    ];
    expect(keys.filter((key) => /utm_|clid|fbc|msclkid/.test(key))).toEqual([]);
    expect(JSON.stringify(scrubbed)).not.toMatch(/ishaan|IwAR0|Cj0KCQiA|newsletter/);
    expect(scrubbed).not.toHaveProperty("$set_once");
  });

  it("does not send the referrer, which the SDK keeps in session storage", () => {
    const event = exceptionEvent();
    Object.assign(event.properties, {
      $referrer: "https://example.org/mediapipe/alice@example.com",
      $referring_domain: "alice.example.org",
      $session_entry_referrer: "https://example.org/alice",
      $session_entry_url: "https://conclave.acmvit.in/yato-sokka-akane",
    });
    const { properties } = scrub(event);

    expect(JSON.stringify(properties)).not.toMatch(/alice|referr|session_entry|yato/);
  });

  it("keeps the path of a stack frame in our script folders", () => {
    const event = exceptionEvent();
    event.properties.$exception_list[0].stacktrace.frames[1].filename =
      "https://conclave.acmvit.in/noise-suppressor/0.4.1/rnnoise-worklet.js";
    const { properties } = scrub(event);

    expect(properties.$exception_list[0].stacktrace.frames[1].filename).toBe(
      "https://conclave.acmvit.in/noise-suppressor/0.4.1/rnnoise-worklet.js",
    );
  });
});

describe("referrer keywords, nested values and other origins", () => {
  it("drops search keywords the SDK takes from a search-engine referrer", () => {
    const event = exceptionEvent();
    Object.assign(event.properties, {
      $referrer: "https://www.google.com/search?q=Meet+Sylvia+in+hazel-lime-pine",
      $search_engine: "google",
      ph_keyword: "Meet Sylvia in hazel-lime-pine",
      $session_entry_ph_keyword: "Meet Sylvia in hazel-lime-pine",
    });
    event.$set_once = { $initial_ph_keyword: "Meet Sylvia in hazel-lime-pine" };
    const scrubbed = scrub(event);

    expect(JSON.stringify(scrubbed)).not.toMatch(/Sylvia|hazel|ph_keyword/);
    expect(scrubbed.properties.$search_engine).toBe("google");
    expect(scrubbed.properties).not.toHaveProperty("$referrer");
  });

  it("drops nested values such as a seeded super property", () => {
    const event = exceptionEvent();
    Object.assign(event.properties, {
      room: { id: "hazel-lime-pine", chat: "see you at five" },
      recent: ["hazel-lime-pine"],
    });
    event.$set = { profile: { note: "see you at five" } };
    const scrubbed = scrub(event);

    expect(JSON.stringify(scrubbed)).not.toMatch(/hazel|see you/);
    expect(scrubbed.properties.$exception_list).toHaveLength(1);
  });

  it("keeps an asset path only for frames served from the page's own origin", () => {
    const event = exceptionEvent();
    const frames = event.properties.$exception_list[0].stacktrace.frames;
    frames[0].filename = "https://cdn.example.net/mediapipe/alice@example.com.js";
    frames[1].filename = "https://conclave.acmvit.in/mediapipe/tasks-vision/1.1.0/wasm/vision_wasm_internal.js";
    const scrubbed = scrub(event);

    const [other, own] = scrubbed.properties.$exception_list[0].stacktrace.frames;
    expect(other.filename).toBe("https://cdn.example.net/[path]");
    expect(own.filename).toBe(
      "https://conclave.acmvit.in/mediapipe/tasks-vision/1.1.0/wasm/vision_wasm_internal.js",
    );
    expect(JSON.stringify(scrubbed)).not.toMatch(/alice/);
  });
});

describe("credentials, non-error rejections and first-party scripts", () => {
  it("redacts auth headers, cookies and secret assignments at any length", () => {
    const event = exceptionEvent();
    event.properties.$exception_list[0].value =
      "Request failed: Authorization: Bearer short_private\nretry with Basic dXNlcjpw " +
      "password=pw_secret1 token: tok_secret2\nCookie: theme=dark; session=second_private\n" +
      "api_key=key_secret3 and Proxy-Authorization: Basic cHJveHk";
    const scrubbed = scrub(event);

    expect(JSON.stringify(scrubbed)).not.toMatch(
      /short_private|dXNlcjpw|pw_secret1|tok_secret2|theme=dark|second_private|key_secret3|cHJveHk/,
    );
  });

  // Shaped like what posthog-js sends for each case in a real browser.
  it.each([
    ["Cookie inside JSON", "Error", '{"Cookie":"sid=ReviewCookieCanary"}', false, "Error"],
    ["a JSON.parse error echoing its input", "SyntaxError", "Unexpected token 'R', \"ReviewText\" is not valid JSON", false, "SyntaxError"],
    ["a rejected {name, message} object", "Meet Mira in sample-room", "'Meet Mira in sample-room' captured as exception with message: 'ReviewMessageCanary'", true, "[type withheld]"],
    ["a rejected string", "UnhandledRejection", "Non-Error promise rejection captured with value: Meet Mira in sample-room", true, "UnhandledRejection"],
    ["a stackless TypeError", "TypeError", "ReviewTypeCanary is not a function", true, "TypeError"],
  ])("sends only a known type and no message for %s", (_case, type, value, synthetic, sentType) => {
    const event = exceptionEvent();
    event.properties.$exception_list = [
      { type, value, mechanism: { type: "generic", handled: false, synthetic }, stacktrace: { type: "raw", frames: [] } },
    ];
    const scrubbed = scrub(event);

    expect(scrubbed.properties.$exception_list[0]).toMatchObject({
      type: sentType,
      value: "[message withheld]",
    });
    expect(JSON.stringify(scrubbed)).not.toMatch(/Review\w*Canary|ReviewText|Mira|sample-room/);
  });

  it("keeps the call log's own label as the message, with its type and frames", () => {
    const event = exceptionEvent();
    event.properties.source = "call_log";
    event.properties.call_log = "[Meets] Error joining room";
    event.properties.$exception_list[0].type = "ServerError";
    event.properties.$exception_list[0].value = "Riya, continue in room lime-pear-plum";
    const { properties } = scrub(event);

    expect(properties.$exception_list[0]).toMatchObject({
      type: "ServerError",
      value: "[Meets] Error joining room",
    });
    expect(properties.$exception_list[0].stacktrace.frames[0].filename).toBe(
      "https://conclave.acmvit.in/_next/static/chunks/0yo6oel71v_bh.js",
    );
    expect(JSON.stringify(properties)).not.toMatch(/Riya|lime-pear-plum/);
  });

  it("sends a call-log message only for a registered label", () => {
    const event = exceptionEvent();
    event.properties.source = "call_log";
    event.properties.call_log = "[Meets] Fixture meeting note";
    const scrubbed = scrub(event);

    expect(scrubbed.properties.$exception_list[0].value).toBe("[message withheld]");
    expect(scrubbed.properties).not.toHaveProperty("call_log");
    expect(JSON.stringify(scrubbed)).not.toMatch(/Fixture/);
  });

  it.each(["/transcript-pcm-processor.js", "/effects/video-effects-output-writer.js"])(
    "keeps the path of our own %s worklet frame",
    (path) => {
      const event = exceptionEvent();
      event.properties.$exception_list[0].stacktrace.frames[1].filename = `https://conclave.acmvit.in${path}`;
      const scrubbed = scrub(event);

      expect(scrubbed.properties.$exception_list[0].stacktrace.frames[1].filename).toBe(
        `https://conclave.acmvit.in${path}`,
      );
    },
  );
});

describe("only trusted properties and paths", () => {
  it("sends only known property keys, whatever prefix a seeded one uses", () => {
    const event = exceptionEvent();
    Object.assign(event.properties, {
      $meeting_note: "Meet Mira in sample-room",
      __meeting_note: "Meet Mira in sample-room",
      visit_note: "Meet Mira in sample-room",
      $exception_level: "error",
      source: "react_error_boundary",
    });
    event.$set = { $initial_note: "Meet Mira in sample-room" };
    event.$set_once = { $initial_browser: "Chrome" };
    const scrubbed = scrub(event);

    expect(JSON.stringify(scrubbed)).not.toMatch(/Mira|sample-room|meeting_note|visit_note/);
    expect(scrubbed).not.toHaveProperty("$set");
    expect(scrubbed).not.toHaveProperty("$set_once");
    expect(scrubbed.properties).toMatchObject({
      $exception_level: "error",
      source: "react_error_boundary",
      $browser: "Chrome",
      token: "phc_test_project_key_00000000000000000000000",
    });
  });

  it.each([
    ["https://conclave.acmvit.in/mediapipe/review-frame@example.invalid.js", "https://conclave.acmvit.in/[path]"],
    ["https://conclave.acmvit.in/_next/static/chunks/review@example.invalid.js", "https://conclave.acmvit.in/[path]"],
    ["file:///home/Review GivenName/config/env.js", "file://[path]"],
    ["chrome-extension://abcdef/content.js", "chrome-extension://[path]"],
    ["<anonymous>", "<anonymous>"],
    ["https://conclave.acmvit.in/_next/static/chunks/app/page-0f3e9d.js", "https://conclave.acmvit.in/[path]"],
    ["https://conclave.acmvit.in/_next/static/chunks/quarterly-review-room.js", "https://conclave.acmvit.in/[path]"],
    ["https://conclave.acmvit.in/_next/static/chunks/standup-notes.js", "https://conclave.acmvit.in/[path]"],
    ["https://conclave.acmvit.in/_next/static/media/3u-6_1om1fv26.js", "https://conclave.acmvit.in/[path]"],
    ["https://conclave.acmvit.in/_next/static/chunks/3u-6_1om1fv26.js", "https://conclave.acmvit.in/[path]"],
    ["https://conclave.acmvit.in/_next/static/chunks/1team-meeting.js", "https://conclave.acmvit.in/[path]"],
  ])("sends the frame path %s as %s", (filename, expected) => {
    const event = exceptionEvent();
    event.properties.$exception_list[0].stacktrace.frames[1].filename = filename;
    const scrubbed = scrub(event);

    expect(scrubbed.properties.$exception_list[0].stacktrace.frames[1].filename).toBe(expected);
  });

  it("sends every property of each call-quality event, unchanged", () => {
    const emitted: CallMetricEvent[] = [];
    const tracker = createCallMetricsTracker({
      emit: (metric) => emitted.push(metric),
      newCallId: () => "call-1",
    });
    const snapshot = (state: ConnectionState) => ({
      state,
      error: null,
      joinMode: "meeting" as const,
      reconnectGaveUp: false,
      reconnecting: false,
    });
    const stream = (kind: "audio" | "video", step: number) => ({
      id: `recv:${kind}`,
      kind,
      packetsReceived: 50 * step,
      bytesReceived: 40_000 * step,
      framesDecoded: kind === "video" ? 30 * step : 0,
      freezeCount: kind === "video" ? 0 : null,
      totalFreezesDurationSec: kind === "video" ? 0 : null,
      concealedSamples: kind === "audio" ? 0 : null,
      totalSamplesReceived: kind === "audio" ? 48_000 * step : null,
    });
    const media = (step: number): CallStatsSample => ({
      inbound: [stream("audio", step), stream("video", step)],
      outboundVideo: [
        { id: "send:L1", bytesSent: 60_000 * step, frameHeight: 360, cpuLimitedSec: 0, bandwidthLimitedSec: 0 },
      ],
      outboundProfile: "standard",
    });
    tracker.onParticipants(2, 0);
    tracker.onConnectionState(snapshot("connecting"), 0);
    tracker.onConnectionState(snapshot("joined"), 1000);
    tracker.onStats(media(1), 1250);
    tracker.onStats(media(2), 6250);
    tracker.onConnectionState(snapshot("disconnected"), 30_000);
    tracker.onConnectionState(snapshot("connecting"), 31_000);
    tracker.onPageHidden(32_000);

    expect([...new Set(emitted.map(({ name }) => name))].sort()).toEqual([
      "call_first_media",
      "call_join",
      "call_summary",
    ]);
    for (const { name, props } of emitted) {
      const event: CaptureResult = { uuid: "u", event: name, properties: { ...props } };
      const sent = scrubTelemetryEvent(event, { payload: props, storedKeys: new Set() }).properties;
      expect(
        Object.fromEntries(Object.keys(props).map((key) => [key, sent[key]])),
        name,
      ).toEqual(props);
    }
  });

  it("lists exactly the scripts under public/ as first-party, and keeps their paths", () => {
    const publicDir = path.resolve(import.meta.dirname, "../public");
    const scripts = readdirSync(publicDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.m?js$/.test(entry.name))
      .map((entry) => `/${path.relative(publicDir, path.join(entry.parentPath, entry.name))}`);
    expect([...FIRST_PARTY_SCRIPTS].sort()).toEqual([...scripts].sort());

    for (const script of scripts) {
      const event = exceptionEvent();
      event.properties.$exception_list[0].stacktrace.frames[1].filename = `https://conclave.acmvit.in${script}`;
      const frame = scrub(event).properties.$exception_list[0].stacktrace.frames[1];
      expect(frame.filename).toBe(`https://conclave.acmvit.in${script}`);
    }
  });
});

describe("stack frames", () => {
  const chunkId = "147fc2df-e663-5d76-aa13-f67e1e894071";

  it("sends only a frame's file, line, column, in-app flag and chunk id", () => {
    const event = exceptionEvent();
    event.properties.$exception_list[0].stacktrace.frames = [
      {
        platform: "web:javascript",
        filename: "https://conclave.acmvit.in/_next/static/chunks/3u-6_1om1fv26.js",
        function: "Object.QuarterlyReviewRoom",
        module: "QuarterlyReviewRoom",
        abs_path: "https://conclave.acmvit.in/quarterly-review-room",
        context_line: "const note = 'Meet Mira';",
        vars: { note: "Meet Mira" },
        lineno: 3,
        colno: 41,
        in_app: true,
        chunk_id: chunkId,
      },
      { filename: "https://conclave.acmvit.in/quarterly-review-room", function: "QuarterlyReviewRoom", chunk_id: "QuarterlyReviewRoom", lineno: "3" },
    ];
    const [entry] = scrub(event).properties.$exception_list;

    expect(entry.stacktrace.frames).toEqual([
      {
        platform: "web:javascript",
        function: "?",
        filename: "https://conclave.acmvit.in/_next/static/chunks/3u-6_1om1fv26.js",
        lineno: 3,
        colno: 41,
        in_app: true,
        chunk_id: chunkId,
      },
      { platform: "web:javascript", function: "?", filename: "https://conclave.acmvit.in/[code]" },
    ]);
    expect(JSON.stringify(entry)).not.toMatch(/Quarterly|Mira|quarterly/);
  });

  it("keeps a chunk's path only when the frame carries the chunk id injected at build", () => {
    const event = exceptionEvent();
    event.properties.$exception_list[0].stacktrace.frames = [
      { filename: "https://conclave.acmvit.in/_next/static/chunks/3u-6_1om1fv26.js", lineno: 1, chunk_id: chunkId },
      { filename: "https://conclave.acmvit.in/_next/static/chunks/1team-meeting.js", lineno: 2 },
      { filename: "https://conclave.acmvit.in/_next/static/chunks/0yo6oel71v_bh.js", lineno: 3, chunk_id: "1team-meeting" },
      { filename: "https://cdn.example.net/_next/static/chunks/3u-6_1om1fv26.js", lineno: 4, chunk_id: chunkId },
      // A uuid the build never produced, and a real id on another file.
      { filename: "https://conclave.acmvit.in/_next/static/chunks/1team-meeting.js", lineno: 5, chunk_id: "0f8c2a1e-5b7d-4c3e-9a10-000000000001" },
      { filename: "https://conclave.acmvit.in/_next/static/chunks/0yo6oel71v_bh.js", lineno: 6, chunk_id: chunkId },
    ];
    const frames = scrub(event).properties.$exception_list[0].stacktrace.frames;

    expect(frames.map((frame: { filename: string }) => frame.filename)).toEqual([
      "https://conclave.acmvit.in/_next/static/chunks/3u-6_1om1fv26.js",
      "https://conclave.acmvit.in/[path]",
      "https://conclave.acmvit.in/[path]",
      "https://cdn.example.net/[path]",
      "https://conclave.acmvit.in/[path]",
      "https://conclave.acmvit.in/[path]",
    ]);
    const unproven = scrub(event, { chunkFiles: new Map() }).properties.$exception_list[0].stacktrace.frames;
    expect(unproven[0].filename).toBe("https://conclave.acmvit.in/[path]");
  });

  it("rebuilds an exception entry from the fields the SDK sets", () => {
    const event = exceptionEvent();
    event.properties.$exception_list = [
      {
        type: "TypeError",
        value: "x",
        module: "QuarterlyReviewRoom",
        thread_id: 7,
        mechanism: { type: "QuarterlyReview", source: "Meet Mira", handled: false, synthetic: false, exception_id: 0 },
        stacktrace: { type: "raw", frames: [], note: "Meet Mira" },
      },
    ];
    const [entry] = scrub(event).properties.$exception_list;

    expect(entry).toEqual({
      type: "TypeError",
      value: "[message withheld]",
      mechanism: { type: "generic", handled: false, synthetic: false, exception_id: 0 },
      stacktrace: { type: "raw", frames: [] },
    });
  });
});

describe("user agent", () => {
  it("drops the raw user agent and keeps the parsed browser and OS", () => {
    const event = exceptionEvent();
    Object.assign(event.properties, {
      $raw_user_agent: "Mozilla/5.0 (Macintosh) Chrome/157.0.0.0 Safari/537.36 ReviewDevice/FleetAsset123",
      $browser_version: 157,
      $os: "Mac OS X",
    });
    const scrubbed = scrub(event);

    expect(scrubbed.properties).not.toHaveProperty("$raw_user_agent");
    expect(JSON.stringify(scrubbed)).not.toMatch(/ReviewDevice|FleetAsset/);
    expect(scrubbed.properties).toMatchObject({ $browser: "Chrome", $browser_version: 157, $os: "Mac OS X" });
  });
});

describe("browser language", () => {
  it.each([
    ["en-US-x-labunit", "en"],
    ["pt_BR", "pt"],
    ["ZH-hant-TW", "zh"],
    ["x-labunit", undefined],
    ["qq-Review", undefined],
    ["Meet Mira", undefined],
  ])("sends %s as its primary ISO 639-1 subtag (%s), or not at all", (language, sent) => {
    const event = exceptionEvent();
    Object.assign(event.properties, { $browser_language: language, $browser_language_prefix: language });
    const { properties } = scrub(event);

    expect(properties.$browser_language).toBe(sent);
    expect(properties.$browser_language_prefix).toBe(sent);
    expect(JSON.stringify(properties)).not.toMatch(/labunit|Review|Mira|hant|BR|TW/);
  });
});

describe("stored state", () => {
  const sdkUuid = "0196f0a1-0000-7000-8000-000000000001";

  it("takes application fields from the emitter's payload, never from storage", () => {
    const event = exceptionEvent();
    Object.assign(event.properties, {
      reason: "Meet Mira in sample-room",
      source: "call_log",
      call_log: "[Meets] Fixture meeting note",
      attempt: 2,
    });
    const scrubbed = scrub(event, {
      payload: { attempt: 2 },
      storedKeys: new Set(["reason", "source", "call_log"]),
    });

    expect(JSON.stringify(scrubbed)).not.toMatch(/Mira|sample-room|Fixture/);
    expect(scrubbed.properties).not.toHaveProperty("reason");
    expect(scrubbed.properties).not.toHaveProperty("call_log");
    expect(scrubbed.properties.attempt).toBe(2);
    expect(scrubbed.properties.$exception_list[0].value).toBe("[message withheld]");
  });

  it("sends no application field on an event the SDK raised itself", () => {
    const event = exceptionEvent();
    Object.assign(event.properties, { source: "call_log", reason: "Meet Mira" });
    const scrubbed = scrub(event, { payload: null });

    expect(Object.keys(scrubbed.properties).filter((key) => !key.startsWith("$")).sort()).toEqual([
      "distinct_id",
      "token",
    ]);
    expect(JSON.stringify(scrubbed)).not.toMatch(/Mira|call_log|Failed to produce/);
  });

  it("drops an SDK field that came from storage", () => {
    const event = exceptionEvent();
    Object.assign(event.properties, {
      $browser: "Meet Mira in sample-room",
      $initialization_time: "2026-11-22T00:00:00Z",
      $os: "Mac OS X",
    });
    const scrubbed = scrub(event, {
      storedKeys: new Set(["$browser", "$initialization_time", "distinct_id", "$device_id"]),
    });

    expect(scrubbed.properties).not.toHaveProperty("$browser");
    expect(scrubbed.properties).not.toHaveProperty("$initialization_time");
    expect(scrubbed.properties.$os).toBe("Mac OS X");
    expect(scrubbed.properties.distinct_id).toBe("0196f0a1-0000-7000-8000-000000000000");
  });

  it("keeps the SDK's ids only when they are uuids it made", () => {
    const event = exceptionEvent();
    Object.assign(event.properties, {
      distinct_id: "Meet Mira in sample-room",
      $device_id: sdkUuid,
      $session_id: "sample-room",
      $window_id: sdkUuid,
    });
    const scrubbed = scrub(event, { storedKeys: new Set(["distinct_id", "$device_id"]) });

    expect(scrubbed.properties).not.toHaveProperty("distinct_id");
    expect(scrubbed.properties).not.toHaveProperty("$session_id");
    expect(scrubbed.properties.$device_id).toBe(sdkUuid);
    expect(scrubbed.properties.$window_id).toBe(sdkUuid);
  });

  it("sends the build's client version, never a stored or passed one", () => {
    const event = exceptionEvent();
    event.properties.client_version = "Meet Mira in sample-room";
    const stored = scrub(event, { clientVersion: "0b2d3b48", storedKeys: new Set(["client_version"]) });
    const passed = scrub(event, { payload: { client_version: "Meet Mira" } });

    expect(stored.properties.client_version).toBe("0b2d3b48");
    expect(passed.properties).not.toHaveProperty("client_version");
  });
});

describe("server text", () => {
  it("drops the message of an error the server wrote", () => {
    const event = exceptionEvent();
    event.properties.$exception_list = [
      {
        type: "ServerError",
        value: "Riya, continue in room lime-pear-plum",
        stacktrace: { type: "raw", frames: [] },
      },
    ];
    const { properties } = scrub(event);

    expect(properties.$exception_list[0]).toMatchObject({
      type: "ServerError",
      value: "[message withheld]",
    });
    expect(JSON.stringify(properties)).not.toMatch(/Riya|lime-pear-plum/);
  });
});

describe("scrubUrl", () => {
  it.each([
    ["https://conclave.acmvit.in/", "https://conclave.acmvit.in/"],
    ["https://conclave.acmvit.in/schedule?tab=1", "https://conclave.acmvit.in/schedule"],
    [
      "https://conclave.acmvit.in/book/ishaan/coffee-chat",
      "https://conclave.acmvit.in/book/[username]/[eventSlug]",
    ],
    ["/my-private-room#x", "/[code]"],
    ["https://conclave.acmvit.in/mediapipe/vision.js", "https://conclave.acmvit.in/[path]"],
    ["https://example.org/users/alice@example.com", "https://example.org/[path]"],
    ["https://conclave.acmvit.in/ishaan.sharma", "https://conclave.acmvit.in/[code]"],
    ["https://conclave.acmvit.in/_next/image?url=%2Fa.png", "https://conclave.acmvit.in/[path]"],
  ])("%s becomes %s", (input, expected) => {
    expect(scrubUrl(input)).toBe(expected);
  });

  it("keeps a dotted referrer path out of the event", () => {
    const event = exceptionEvent();
    event.properties.$referrer = "https://example.org/users/alice@example.com";
    const { properties } = scrub(event);

    expect(properties).not.toHaveProperty("$referrer");
    expect(JSON.stringify(properties)).not.toMatch(/alice/);
  });
});

describe("scrubText", () => {
  it("rewrites URLs inside free text", () => {
    expect(
      scrubText("fetch https://sfu-a.acmvit.in/rooms/team-sync?token=1 failed"),
    ).toBe("fetch https://sfu-a.acmvit.in/[path] failed");
  });

  it.each(["Failed to fetch http://%", "Failed to fetch https://["])(
    "redacts the malformed URL in %s",
    (input) => {
      expect(scrubText(input)).toBe("Failed to fetch [url]");
    },
  );

  it("returns an exception event whose message has a malformed URL", () => {
    const event = exceptionEvent();
    event.properties.$exception_list[0].value = "Failed to fetch http://%";
    const { properties } = scrub(event);

    expect(properties.$exception_list[0].value).toBe("[message withheld]");
  });
});
