import type { CaptureResult } from "posthog-js";
import { describe, expect, it } from "vitest";
import {
  scrubTelemetryEvent,
  scrubText,
  scrubUrl,
} from "../src/app/lib/telemetry-privacy";

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
          "Join failed for ishaan@example.com token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
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

describe("scrubUrl", () => {
  it.each([
    ["https://conclave.acmvit.in/", "https://conclave.acmvit.in/"],
    ["https://conclave.acmvit.in/schedule?tab=1", "https://conclave.acmvit.in/schedule"],
    [
      "https://conclave.acmvit.in/book/ishaan/coffee-chat",
      "https://conclave.acmvit.in/book/[username]/[eventSlug]",
    ],
    ["/my-private-room#x", "/[code]"],
    ["https://conclave.acmvit.in/mediapipe/vision.js", "https://conclave.acmvit.in/mediapipe/vision.js"],
  ])("%s becomes %s", (input, expected) => {
    expect(scrubUrl(input)).toBe(expected);
  });
});

describe("scrubText", () => {
  it("rewrites URLs inside free text", () => {
    expect(
      scrubText("fetch https://sfu-a.acmvit.in/rooms/team-sync?token=1 failed"),
    ).toBe("fetch https://sfu-a.acmvit.in/[path] failed");
  });
});
