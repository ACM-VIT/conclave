import type { CaptureResult } from "posthog-js";
import { describe, expect, it } from "vitest";
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
    expect(entry.value).toBe("Join failed for [email] token [token]");
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
    expect(scrubbed.$set_once?.$initial_browser).toBe("Chrome");
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
      "https://conclave.acmvit.in/mediapipe/vision_bundle.js";
    const { properties } = scrubTelemetryEvent(event);

    expect(properties.$exception_list[0].stacktrace.frames[1].filename).toBe(
      "https://conclave.acmvit.in/mediapipe/vision_bundle.js",
    );
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
      value: "[server message]",
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

    expect(properties.$exception_list[0].value).toBe("Failed to fetch [url]");
  });
});
