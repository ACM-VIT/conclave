import { readdirSync } from "node:fs";
import path from "node:path";
import type { CaptureResult } from "posthog-js";
import { describe, expect, it } from "vitest";
import { createCallMetricsTracker } from "../src/app/lib/call-quality-metrics";
import type { ConnectionState } from "../src/app/lib/types";
import {
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
                "https://conclave.acmvit.in/_next/static/chunks/0f3e9d.js",
              lineno: 1,
              colno: 2048,
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
    const { properties } = scrubTelemetryEvent(exceptionEvent());

    expect(properties.$current_url).toBe("https://conclave.acmvit.in/[code]");
    expect(properties.$pathname).toBe("/[code]");
    expect(properties.$referrer).toBe("https://conclave.acmvit.in/w/[code]");
    expect(properties).not.toHaveProperty("$title");
    expect(properties).not.toHaveProperty("roomId");
    expect(properties).not.toHaveProperty("userId");
    expect(properties.call_log).toBe("[Meets] Failed to produce video for [email]");

    const [entry] = properties.$exception_list;
    expect(entry.value).toBe("[message withheld]");
    expect(entry.stacktrace.frames[1].filename).toBe(
      "https://conclave.acmvit.in/[code]",
    );
    expect(JSON.stringify(properties)).not.toMatch(/yato|ishaan|abc123|xyz/);
  });

  it("keeps what ingestion and symbolication need", () => {
    const { properties } = scrubTelemetryEvent(exceptionEvent());

    expect(properties.token).toBe(
      "phc_test_project_key_00000000000000000000000",
    );
    expect(properties.distinct_id).toBe("0196f0a1-0000-7000-8000-000000000000");
    expect(properties.$browser).toBe("Chrome");
    expect(properties.client_version).toBe(
      "0b2d3b480f4621392a4151d750c90965b7c8b76c",
    );
    expect(properties.$exception_list[0].stacktrace.frames[0]).toEqual({
      filename: "https://conclave.acmvit.in/_next/static/chunks/0f3e9d.js",
      lineno: 1,
      colno: 2048,
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
    const scrubbed = scrubTelemetryEvent(event);

    const keys = [
      ...Object.keys(scrubbed.properties),
      ...Object.keys(scrubbed.$set_once ?? {}),
    ];
    expect(keys.filter((key) => /utm_|clid|fbc|msclkid/.test(key))).toEqual([]);
    expect(JSON.stringify(scrubbed)).not.toMatch(/ishaan|IwAR0|Cj0KCQiA|newsletter/);
    expect(scrubbed).not.toHaveProperty("$set_once");
  });

  it("templates an external referrer even under an asset folder name", () => {
    const event = exceptionEvent();
    event.properties.$referrer = "https://example.org/mediapipe/alice@example.com";
    const { properties } = scrubTelemetryEvent(event);

    expect(properties.$referrer).toBe("https://example.org/[path]");
  });

  it("keeps the path of a stack frame in our script folders", () => {
    const event = exceptionEvent();
    event.properties.$exception_list[0].stacktrace.frames[1].filename =
      "https://conclave.acmvit.in/noise-suppressor/0.4.1/rnnoise-worklet.js";
    const { properties } = scrubTelemetryEvent(event);

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
    const scrubbed = scrubTelemetryEvent(event);

    expect(JSON.stringify(scrubbed)).not.toMatch(/Sylvia|hazel|ph_keyword/);
    expect(scrubbed.properties.$search_engine).toBe("google");
    expect(scrubbed.properties.$referrer).toBe("https://www.google.com/[code]");
  });

  it("drops nested values such as a seeded super property", () => {
    const event = exceptionEvent();
    Object.assign(event.properties, {
      room: { id: "hazel-lime-pine", chat: "see you at five" },
      recent: ["hazel-lime-pine"],
    });
    event.$set = { profile: { note: "see you at five" } };
    const scrubbed = scrubTelemetryEvent(event);

    expect(JSON.stringify(scrubbed)).not.toMatch(/hazel|see you/);
    expect(scrubbed.properties.$exception_list).toHaveLength(1);
  });

  it("keeps an asset path only for frames served from the page's own origin", () => {
    const event = exceptionEvent();
    const frames = event.properties.$exception_list[0].stacktrace.frames;
    frames[0].filename = "https://cdn.example.net/mediapipe/alice@example.com.js";
    frames[1].filename = "https://conclave.acmvit.in/mediapipe/tasks-vision/1.1.0/wasm/vision_wasm_internal.js";
    const scrubbed = scrubTelemetryEvent(event);

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
    const scrubbed = scrubTelemetryEvent(event);

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
    const scrubbed = scrubTelemetryEvent(event);

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
    const { properties } = scrubTelemetryEvent(event);

    expect(properties.$exception_list[0]).toMatchObject({
      type: "ServerError",
      value: "[Meets] Error joining room",
    });
    expect(properties.$exception_list[0].stacktrace.frames[0].filename).toBe(
      "https://conclave.acmvit.in/_next/static/chunks/0f3e9d.js",
    );
    expect(JSON.stringify(properties)).not.toMatch(/Riya|lime-pear-plum/);
  });

  it.each(["/transcript-pcm-processor.js", "/effects/video-effects-output-writer.js"])(
    "keeps the path of our own %s worklet frame",
    (path) => {
      const event = exceptionEvent();
      event.properties.$exception_list[0].stacktrace.frames[1].filename = `https://conclave.acmvit.in${path}`;
      const scrubbed = scrubTelemetryEvent(event);

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
    const scrubbed = scrubTelemetryEvent(event);

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
    ["https://conclave.acmvit.in/_next/static/chunks/app/page-0f3e9d.js", "https://conclave.acmvit.in/_next/static/chunks/app/page-0f3e9d.js"],
  ])("sends the frame path %s as %s", (filename, expected) => {
    const event = exceptionEvent();
    event.properties.$exception_list[0].stacktrace.frames[1].filename = filename;
    const scrubbed = scrubTelemetryEvent(event);

    expect(scrubbed.properties.$exception_list[0].stacktrace.frames[1].filename).toBe(expected);
  });

  it("sends every property the call-quality tracker emits", () => {
    const emitted: Array<Record<string, unknown>> = [];
    const tracker = createCallMetricsTracker({
      emit: (metric) => emitted.push(metric.props),
      newCallId: () => "call-1",
    });
    const snapshot = (state: ConnectionState) => ({
      state,
      error: null,
      joinMode: "meeting" as const,
      reconnectGaveUp: false,
      reconnecting: false,
    });
    tracker.onParticipants(2, 0);
    tracker.onConnectionState(snapshot("connecting"), 0);
    tracker.onConnectionState(snapshot("joined"), 1000);
    tracker.onConnectionState(snapshot("disconnected"), 30_000);
    tracker.onConnectionState(snapshot("connecting"), 31_000);
    tracker.onPageHidden(32_000);
    const keys = [...new Set(emitted.flatMap((props) => Object.keys(props)))];
    expect(keys.length).toBeGreaterThan(30);

    const event = exceptionEvent();
    Object.assign(event.properties, Object.fromEntries(keys.map((key) => [key, 1])));
    const sent = scrubTelemetryEvent(event).properties;
    expect(keys.filter((key) => !(key in sent))).toEqual([]);
  });

  it("keeps the path of every first-party script under public/", () => {
    const publicDir = path.resolve(import.meta.dirname, "../public");
    const scripts = readdirSync(publicDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.m?js$/.test(entry.name))
      .map((entry) => `/${path.relative(publicDir, path.join(entry.parentPath, entry.name))}`);
    expect(scripts.length).toBeGreaterThan(10);

    for (const script of scripts) {
      const event = exceptionEvent();
      event.properties.$exception_list[0].stacktrace.frames[1].filename = `https://conclave.acmvit.in${script}`;
      const frame = scrubTelemetryEvent(event).properties.$exception_list[0].stacktrace.frames[1];
      expect(frame.filename).toBe(`https://conclave.acmvit.in${script}`);
    }
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
    const { properties } = scrubTelemetryEvent(event);

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
    const { properties } = scrubTelemetryEvent(event);

    expect(properties.$referrer).toBe("https://example.org/[path]");
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
    const { properties } = scrubTelemetryEvent(event);

    expect(properties.$exception_list[0].value).toBe("[message withheld]");
  });
});
