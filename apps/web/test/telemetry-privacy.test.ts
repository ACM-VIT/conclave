import { fakeSecretKey, fakeSignedToken } from "@conclave/meeting-core/test-fixtures";
import { readdirSync } from "node:fs";
import path from "node:path";
import type { CaptureResult, Properties } from "posthog-js";
import { describe, expect, it } from "vitest";
import {
  type CallMetricEvent,
  type CallStatsSample,
  createCallMetricsTracker,
} from "../src/app/lib/call-quality-metrics";
import { beforeSend, type EventSource } from "../src/app/lib/telemetry-privacy";
import {
  FIRST_PARTY_SCRIPTS,
  TELEMETRY_EVENTS,
  type TelemetryEventProps,
  type TelemetryEventName,
} from "../src/app/lib/telemetry-schema";
import type { ConnectionState } from "../src/app/lib/types";

const sampleJwt = fakeSignedToken({ sub: "1234567890" });

const KEY = fakeSecretKey("phc", `test_project_key_${"0".repeat(23)}`);
const BUILD = "0b2d3b480f4621392a4151d750c90965b7c8b76c";
const SITE = "https://conclave.acmvit.in";
const SDK_ID = "0196f0a1-0000-7000-8000-000000000000";
const CHUNK_ID = "147fc2df-e663-5d76-aa13-f67e1e894071";

// The chunk ids this test's "build" injected, by file.
const buildChunks = new Map([
  ["11079975-c075-50b3-ad5f-87be8f4248d0", "/_next/static/chunks/0yo6oel71v_bh.js"],
  [CHUNK_ID, "/_next/static/chunks/3u-6_1om1fv26.js"],
]);

// As before_send sees an event our own code captured: the event's own
// application fields are the emitter's payload, and nothing came from storage.
const build = (event: CaptureResult, source: Partial<EventSource> = {}) => {
  const built = beforeSend(event, {
    payload: Object.fromEntries(
      Object.entries(event.properties).filter(([key]) => !key.startsWith("$") && key !== "token" && key !== "distinct_id"),
    ),
    storedKeys: new Set(),
    token: KEY,
    clientVersion: BUILD,
    chunkFiles: buildChunks,
    siteOrigin: SITE,
    ...source,
  });
  if (!built) throw new Error(`${event.event} was dropped`);
  return built as CaptureResult & { properties: Properties & { $exception_list: Array<Record<string, any>> } };
};

const exceptionEvent = (): CaptureResult & { properties: Record<string, any> } => ({
  uuid: "0196f0a1-0000-7000-8000-0000000000aa",
  event: "$exception",
  properties: {
    token: KEY,
    distinct_id: SDK_ID,
    $current_url: `${SITE}/yato-sokka-akane?invite=abc123#chat`,
    $host: "conclave.acmvit.in",
    $pathname: "/yato-sokka-akane",
    $referrer: `${SITE}/w/spring-demo?code=xyz`,
    $title: "yato-sokka-akane · c0nclav3",
    $browser: "Chrome",
    client_version: BUILD,
    roomId: "yato-sokka-akane",
    userId: "ishaan@example.com#s1",
    call_log: "[Meets] Failed to produce video for ishaan@example.com",
    $exception_list: [
      {
        type: "Error",
        value: `Join failed for ishaan@example.com token ${sampleJwt}`,
        stacktrace: {
          type: "raw",
          frames: [
            {
              filename: `${SITE}/_next/static/chunks/0yo6oel71v_bh.js`,
              lineno: 1,
              colno: 2048,
              chunk_id: "11079975-c075-50b3-ad5f-87be8f4248d0",
            },
            { filename: `${SITE}/yato-sokka-akane?x=1`, lineno: 4 },
          ],
        },
      },
    ],
  },
});

const frameFiles = (event: ReturnType<typeof build>) =>
  event.properties.$exception_list[0].stacktrace.frames.map((frame: { filename: string }) => frame.filename);

describe("the event the browser sends", () => {
  it("names the route and a constant host, never the site, a room code or a query", () => {
    const { properties } = build(exceptionEvent());

    expect(properties.$current_url).toBe("/[code]");
    expect(properties.$pathname).toBe("/[code]");
    expect(properties.$host).toBe("conclave-web");
    for (const key of ["$referrer", "$title", "roomId", "userId", "call_log"]) {
      expect(properties).not.toHaveProperty(key);
    }
    expect(properties.$exception_list[0].value).toBe("[message withheld]");
    expect(JSON.stringify(properties)).not.toMatch(/https?:|acmvit|yato|ishaan|abc123|xyz|eyJ/);
  });

  it("keeps what ingestion and symbolication need", () => {
    const { properties } = build(exceptionEvent());

    expect(properties).toMatchObject({
      token: KEY,
      distinct_id: SDK_ID,
      $browser: "Chrome",
      client_version: BUILD,
      $lib: "web",
      $process_person_profile: false,
    });
    expect(properties.$exception_list[0].stacktrace.frames[0]).toEqual({
      platform: "web:javascript",
      function: "?",
      filename: "/_next/static/chunks/0yo6oel71v_bh.js",
      lineno: 1,
      colno: 2048,
      chunk_id: "11079975-c075-50b3-ad5f-87be8f4248d0",
    });
  });

  it("drops an event that is not on the list", () => {
    for (const name of ["$pageview", "$identify", "$autocapture", "Meet Mira joined"]) {
      expect(beforeSend({ ...exceptionEvent(), event: name }, {
        payload: {},
        storedKeys: new Set(),
        token: KEY,
        clientVersion: BUILD,
        chunkFiles: buildChunks,
        siteOrigin: SITE,
      })).toBeNull();
    }
  });

  it("sends no person properties and nothing outside the schema", () => {
    const event = exceptionEvent();
    Object.assign(event.properties, {
      utm_source: "newsletter",
      utm_content: "ishaan@example.com",
      fbclid: "IwAR0abcDEF123",
      gclid: "Cj0KCQiA",
      $fbc: "fb.1.1700000000.IwAR0abcDEF123",
      $session_entry_utm_content: "ishaan@example.com",
      $initial_msclkid: "abc123",
      $referring_domain: "alice.example.org",
      $session_entry_url: `${SITE}/yato-sokka-akane`,
      $search_engine: "google",
      ph_keyword: "Meet Sylvia in hazel-lime-pine",
      $timezone: "Asia/Calcutta",
      $insert_id: "a1b2c3d4e5f6g7h8",
      $time: 1795375411.183,
      $lib_custom_api_host: "/ingest",
      $raw_user_agent: "Mozilla/5.0 (Macintosh) Chrome/157.0.0.0 ReviewDevice/FleetAsset123",
      room: { id: "hazel-lime-pine", chat: "see you at five" },
      recent: ["hazel-lime-pine"],
      $meeting_note: "Meet Mira in sample-room",
      __meeting_note: "Meet Mira in sample-room",
    });
    event.$set = { profile: { note: "see you at five" } };
    event.$set_once = { $initial_utm_content: "ishaan@example.com", $initial_ph_keyword: "Sylvia" };
    const built = build(event);

    expect(built).not.toHaveProperty("$set");
    expect(built).not.toHaveProperty("$set_once");
    expect(JSON.stringify(built)).not.toMatch(
      /utm_|clid|fbc|msclkid|newsletter|ishaan|IwAR0|Cj0KCQiA|alice|session_entry|google|Sylvia|hazel|see you|Calcutta|a1b2c3|ingest|ReviewDevice|FleetAsset|Mira|meeting_note/,
    );
  });

  it.each([
    ["Mac OS X", "10.15.7", true],
    ["Windows", "10.0", true],
    ["Xbox", "Fleet Asset 123", false],
    ["Windows", "Vista", false],
  ])("sends %s %s as the OS version only when it is a version number", (os, version, kept) => {
    const event = exceptionEvent();
    Object.assign(event.properties, { $os: os, $os_version: version, $browser: "ReviewBrowser" });
    const { properties } = build(event);

    expect(properties.$os).toBe(os);
    expect(properties.$os_version).toBe(kept ? version : undefined);
    expect(properties).not.toHaveProperty("$browser");
  });

  it.each([
    ["en-US-x-labunit", "en"],
    ["pt_BR", "pt"],
    ["ZH-hant-TW", "zh"],
    ["x-labunit", undefined],
    ["qq-Review", undefined],
    ["Meet Mira", undefined],
  ])("sends the browser language %s as its primary ISO 639-1 subtag (%s), or not at all", (language, sent) => {
    const event = exceptionEvent();
    Object.assign(event.properties, { $browser_language: language, $browser_language_prefix: language });
    const { properties } = build(event);

    expect(properties.$browser_language).toBe(sent);
    expect(properties.$browser_language_prefix).toBe(sent);
    expect(JSON.stringify(properties)).not.toMatch(/labunit|Review|Mira|hant|BR|TW/);
  });

  it.each([
    [`${SITE}/`, "/"],
    [`${SITE}/schedule?tab=1`, "/schedule"],
    [`${SITE}/book/ishaan/coffee-chat`, "/book/[username]/[eventSlug]"],
    ["/my-private-room#x", "/[code]"],
    [`${SITE}/mediapipe/vision.js`, "/[path]"],
    ["https://example.org/users/alice@example.com", "/[path]"],
    [`${SITE}/ishaan.sharma`, "/[code]"],
    [`${SITE}/w/spring-demo`, "/w/[code]"],
    [`${SITE}/privacy/terms`, "/privacy/[path]"],
    ["/[path]", "/[path]"],
    ["chrome-extension://abcdef/content.js", undefined],
    ["Meet Mira", undefined],
  ])("sends the page %s as the route %s", (url, route) => {
    const event = exceptionEvent();
    Object.assign(event.properties, { $current_url: url, $pathname: url });
    const { properties } = build(event);

    expect(properties.$current_url).toBe(route);
    expect(properties.$pathname).toBe(route);
  });
});

describe("exceptions", () => {
  it("keeps the call log's own label as the message, with its type and frames", () => {
    const event = exceptionEvent();
    event.properties.source = "call_log";
    event.properties.call_log = "[Meets] Error joining room";
    event.properties.$exception_list[0].type = "ServerError";
    event.properties.$exception_list[0].value = "Riya, continue in room lime-pear-plum";
    const built = build(event);

    expect(built.properties.$exception_list[0]).toMatchObject({ type: "ServerError", value: "[Meets] Error joining room" });
    expect(built.properties).toMatchObject({ source: "call_log", call_log: "[Meets] Error joining room" });
    expect(frameFiles(built)[0]).toBe("/_next/static/chunks/0yo6oel71v_bh.js");
    expect(JSON.stringify(built)).not.toMatch(/Riya|lime-pear-plum/);
  });

  it("sends a call-log message only for a registered label", () => {
    const event = exceptionEvent();
    event.properties.source = "call_log";
    event.properties.call_log = "[Meets] Fixture meeting note";
    const built = build(event);

    expect(built.properties.$exception_list[0].value).toBe("[message withheld]");
    expect(built.properties).not.toHaveProperty("call_log");
    expect(JSON.stringify(built)).not.toMatch(/Fixture/);
  });

  // Shaped like what posthog-js sends for each case in a real browser.
  it.each([
    ["Cookie inside JSON", "Error", '{"Cookie":"sid=ReviewCookieCanary"}', false, "Error"],
    ["a JSON.parse error echoing its input", "SyntaxError", "Unexpected token 'R', \"ReviewText\" is not valid JSON", false, "SyntaxError"],
    ["a rejected {name, message} object", "Meet Mira in sample-room", "'Meet Mira' captured as exception with message: 'ReviewMessageCanary'", true, "[type withheld]"],
    ["a rejected string", "UnhandledRejection", "Non-Error promise rejection captured with value: Meet Mira in sample-room", true, "UnhandledRejection"],
    ["a server's text", "ServerError", "Riya, continue in room lime-pear-plum", false, "ServerError"],
    ["credentials", "Error", `Authorization: Bearer short_private password=pw_secret1 ${sampleJwt}`, false, "Error"],
  ])("sends only a known type and no message for %s", (_case, type, value, synthetic, sentType) => {
    const event = exceptionEvent();
    event.properties.$exception_list = [
      { type, value, mechanism: { type: "generic", handled: false, synthetic }, stacktrace: { type: "raw", frames: [] } },
    ];
    const built = build(event);

    expect(built.properties.$exception_list[0]).toMatchObject({ type: sentType, value: "[message withheld]" });
    expect(JSON.stringify(built)).not.toMatch(/Review\w*|Mira|sample-room|Riya|lime-pear|short_private|pw_secret1|eyJ/);
  });

  it("rebuilds an entry and its frames from the fields the SDK sets, and nothing else", () => {
    const event = exceptionEvent();
    event.properties.$exception_list = [
      {
        type: "TypeError",
        value: "x",
        module: "QuarterlyReviewRoom",
        thread_id: 7,
        mechanism: { type: "QuarterlyReview", source: "Meet Mira", handled: false, synthetic: false, exception_id: 0 },
        stacktrace: {
          type: "raw",
          note: "Meet Mira",
          frames: [
            {
              platform: "web:javascript",
              filename: `${SITE}/_next/static/chunks/3u-6_1om1fv26.js`,
              function: "Object.QuarterlyReviewRoom",
              module: "QuarterlyReviewRoom",
              abs_path: `${SITE}/quarterly-review-room`,
              context_line: "const note = 'Meet Mira';",
              vars: { note: "Meet Mira" },
              lineno: 3,
              colno: 41,
              in_app: true,
              chunk_id: CHUNK_ID,
            },
            { filename: `${SITE}/quarterly-review-room`, function: "QuarterlyReviewRoom", chunk_id: "QuarterlyReviewRoom", lineno: "3" },
          ],
        },
      },
    ];
    const [entry] = build(event).properties.$exception_list;

    expect(entry).toEqual({
      type: "TypeError",
      value: "[message withheld]",
      mechanism: { type: "generic", handled: false, synthetic: false, exception_id: 0 },
      stacktrace: {
        type: "raw",
        frames: [
          {
            platform: "web:javascript",
            function: "?",
            filename: "/_next/static/chunks/3u-6_1om1fv26.js",
            lineno: 3,
            colno: 41,
            in_app: true,
            chunk_id: CHUNK_ID,
          },
          { platform: "web:javascript", function: "?", filename: "[path]" },
        ],
      },
    });
  });

  it("withholds a value that does not fit its form and keeps the rest of the exception", () => {
    const event = exceptionEvent();
    event.properties.$exception_list[0].stacktrace.frames = Array.from({ length: 600 }, (_, index) => ({
      filename: `${SITE}/_next/static/chunks/3u-6_1om1fv26.js`,
      lineno: index === 0 ? 200_000_000 : index,
      colno: 3,
      chunk_id: CHUNK_ID,
    }));
    const frames = build(event).properties.$exception_list[0].stacktrace.frames;

    expect(frames).toHaveLength(500);
    expect(frames[0]).toEqual({
      platform: "web:javascript",
      function: "?",
      filename: "/_next/static/chunks/3u-6_1om1fv26.js",
      colno: 3,
      chunk_id: CHUNK_ID,
    });
  });

  it("keeps a chunk's path only when the frame carries the chunk id injected at build, on our own origin", () => {
    const event = exceptionEvent();
    event.properties.$exception_list[0].stacktrace.frames = [
      { filename: `${SITE}/_next/static/chunks/3u-6_1om1fv26.js`, lineno: 1, chunk_id: CHUNK_ID },
      { filename: `${SITE}/_next/static/chunks/1team-meeting.js`, lineno: 2 },
      { filename: `${SITE}/_next/static/chunks/0yo6oel71v_bh.js`, lineno: 3, chunk_id: "1team-meeting" },
      { filename: "https://cdn.example.net/_next/static/chunks/3u-6_1om1fv26.js", lineno: 4, chunk_id: CHUNK_ID },
      // A uuid the build never produced, and a real id on another file.
      { filename: `${SITE}/_next/static/chunks/1team-meeting.js`, lineno: 5, chunk_id: "0f8c2a1e-5b7d-4c3e-9a10-000000000001" },
      { filename: `${SITE}/_next/static/chunks/0yo6oel71v_bh.js`, lineno: 6, chunk_id: CHUNK_ID },
    ];
    const built = build(event);

    expect(frameFiles(built)).toEqual([
      "/_next/static/chunks/3u-6_1om1fv26.js",
      "[path]",
      "[path]",
      "[path]",
      "[path]",
      "[path]",
    ]);
    expect(built.properties.$exception_list[0].stacktrace.frames.map((frame: { chunk_id?: string }) => frame.chunk_id)).toEqual([
      CHUNK_ID,
      undefined,
      undefined,
      CHUNK_ID,
      undefined,
      CHUNK_ID,
    ]);
    const unproven = build(event, { chunkFiles: new Map() });
    expect(frameFiles(unproven)[0]).toBe("[path]");
    expect(JSON.stringify(unproven)).not.toContain(CHUNK_ID);
  });

  it("without the build's chunk list, keeps only a chunk id and a chunk file of their forms, for /ingest to check", () => {
    const event = exceptionEvent();
    const other = "0f8c2a1e-5b7d-4c3e-9a10-000000000001";
    event.properties.$exception_list[0].stacktrace.frames = [
      { filename: "/_next/static/chunks/3u-6_1om1fv26.js", lineno: 1, chunk_id: CHUNK_ID },
      { filename: `${SITE}/_next/static/chunks/0yo6oel71v_bh.js`, lineno: 2, chunk_id: other },
      { filename: "/_next/static/chunks/3u-6_1om1fv26.js", lineno: 3 },
      { filename: "https://cdn.example.net/_next/static/chunks/3u-6_1om1fv26.js", lineno: 4, chunk_id: CHUNK_ID },
      { filename: "/_next/static/chunks/review@example.invalid.js", lineno: 5, chunk_id: CHUNK_ID },
      { filename: "/api/telemetry?token=abc.js", lineno: 6, chunk_id: CHUNK_ID },
      { filename: "/_next/static/chunks/3u-6_1om1fv26.js", lineno: 7, chunk_id: "1team-meeting" },
    ];
    const built = build(event, { chunkFiles: null });

    expect(frameFiles(built)).toEqual([
      "/_next/static/chunks/3u-6_1om1fv26.js",
      "/_next/static/chunks/0yo6oel71v_bh.js",
      "[path]",
      "[path]",
      "[path]",
      "[path]",
      "[path]",
    ]);
    expect(built.properties.$exception_list[0].stacktrace.frames.map((frame: { chunk_id?: string }) => frame.chunk_id)).toEqual([
      CHUNK_ID,
      other,
      undefined,
      CHUNK_ID,
      CHUNK_ID,
      CHUNK_ID,
      undefined,
    ]);
  });

  it.each([
    [`${SITE}/mediapipe/review-frame@example.invalid.js`, "[path]"],
    [`${SITE}/_next/static/chunks/review@example.invalid.js`, "[path]"],
    ["file:///home/Review GivenName/config/env.js", "[path]"],
    ["chrome-extension://abcdef/content.js", "[path]"],
    ["https://cdn.example.net/mediapipe/alice@example.com.js", "[path]"],
    ["<anonymous>", "<anonymous>"],
    ["<Meet Mira>", "[path]"],
    [`${SITE}/_next/static/chunks/app/page-0f3e9d.js`, "[path]"],
    [`${SITE}/_next/static/media/3u-6_1om1fv26.js`, "[path]"],
    [`${SITE}/_next/static/chunks/3u-6_1om1fv26.js`, "[path]"],
    [`${SITE}/noise-suppressor/0.4.1/rnnoise-worklet.js`, "/noise-suppressor/0.4.1/rnnoise-worklet.js"],
    ["https://cdn.example.net/noise-suppressor/0.4.1/rnnoise-worklet.js", "[path]"],
  ])("sends the frame file %s as %s", (filename, expected) => {
    const event = exceptionEvent();
    event.properties.$exception_list[0].stacktrace.frames[1].filename = filename;

    expect(frameFiles(build(event))[1]).toBe(expected);
  });

  it("lists exactly the scripts under public/ as first-party, and keeps their paths", () => {
    const publicDir = path.resolve(import.meta.dirname, "../public");
    const scripts = readdirSync(publicDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.m?js$/.test(entry.name))
      .map((entry) => `/${path.relative(publicDir, path.join(entry.parentPath, entry.name))}`);
    expect([...FIRST_PARTY_SCRIPTS].sort()).toEqual([...scripts].sort());

    for (const script of scripts) {
      const event = exceptionEvent();
      event.properties.$exception_list[0].stacktrace.frames[1].filename = `${SITE}${script}`;
      expect(frameFiles(build(event))[1]).toBe(script);
    }
  });
});

describe("our own fields", () => {
  // One payload per event, shaped like what its call site sends.
  const payloads: { [N in TelemetryEventName]: TelemetryEventProps<N> } = {
    call_join: {
      call_id: "8d0f6a0e-3c1b-4b7e-9a51-2f6d1c0b9e11",
      outcome: "failed",
      failure_reason: "room_not_found",
      join_ms: 1133,
      waited: true,
      waiting_ms: 2400,
      join_mode: "meeting",
      prior_failed_attempts: 1,
    },
    call_first_media: {
      call_id: "8d0f6a0e-3c1b-4b7e-9a51-2f6d1c0b9e11",
      first_remote_audio_ms: 1668,
      first_remote_video_ms: null,
      join_ms: 1133,
      remote_present_at_join: true,
      timed_out: false,
      join_mode: "webinar_attendee",
    },
    call_summary: {
      call_id: "8d0f6a0e-3c1b-4b7e-9a51-2f6d1c0b9e11",
      join_mode: "meeting",
      end_reason: "reconnect_abandoned",
      duration_ms: 26522,
      peak_participants: 3,
      waited: false,
      first_remote_audio_ms: 1668,
      first_remote_video_ms: 1080,
      reconnect_count: 1,
      reconnect_total_ms: 1065,
      reconnect_longest_ms: 1065,
      reconnect_unrecovered: false,
      remote_video_ms: 25010,
      video_freeze_count: 1,
      video_freeze_ms: 12000,
      video_stall_count: 0,
      video_stall_ms: 0,
      audio_concealed_pct: 2.5,
      outbound_video_ms: 20004,
      outbound_low_ms: 1063,
      outbound_standard_ms: 18020,
      outbound_profile_switches: 1,
      outbound_video_kbps: 238,
      outbound_video_height: 720,
      outbound_cpu_limited_pct: null,
      outbound_bandwidth_limited_pct: 0.4,
    },
    meet_call_rated: { rating: 4, outcome: "left", durationSeconds: 61 },
    meet_audio_playback_recovered: { kind: "screenShare" },
    meet_audio_playback_stalled: { kind: "participant", autoplayBlocked: true },
    meet_webcam_consumer_generation_reset_completed: {
      reason: "startup-simulcast-jitter-reset",
      failureReason: null,
      attempts: 1,
      durationMs: 12685,
      maximumSpatialLayer: 2,
      observedSpatialLayer: 2,
    },
    meet_webcam_consumer_generation_reset_failed: {
      reason: "startup-simulcast-jitter-reset",
      failureReason: "replacement-deadline-exhausted",
      attempts: 3,
      durationMs: 14205,
      maximumSpatialLayer: 2,
      observedSpatialLayer: null,
    },
    meet_webcam_consumer_generation_reset_cancelled: {
      reason: "startup-simulcast-jitter-reset",
      failureReason: "producer-closed",
      attempts: 0,
      durationMs: 13214,
      maximumSpatialLayer: 2,
      observedSpatialLayer: 0,
    },
    meet_webcam_consumer_generation_reset_attempt: {
      reason: "startup-simulcast-jitter-reset",
      attempt: 1,
      maximumSpatialLayer: 2,
      observedSpatialLayer: 1,
    },
    meet_webcam_consumer_generation_reset_scheduled: { reason: "startup-simulcast-jitter-reset", maximumSpatialLayer: 2 },
    meet_turn_relay_activated: { reason: "media_path_rebuild" },
    meet_media_path_blocked: { transport: "producer", relayOnly: true, silentWhileConnected: false },
    meet_media_path_stalled: { transport: "consumer", condition: "connected-without-media" },
    meet_webcam_codec_policy_changed: { from: "vp8", to: "h264", epoch: 3 },
    meet_consumer_resume_exhausted: { kind: "audio", attempts: 4, reason: "displaced" },
    meet_consumer_resume_recovered: { kind: "video", attempts: 2 },
    meet_stale_consumer_recovery_started: { kind: "video", type: "webcam", reason: "decoder_frozen" },
    meet_stale_consumer_recovered: { kind: "audio", type: "screen", reason: "server_lost_consumer" },
    meet_stale_consumer_recovery_failed: {
      kind: "video",
      type: "webcam",
      reason: "muted_live_track",
      failureReason: "replacement-threw",
    },
    meet_admin_notice_received: { level: "warning" },
    meet_audio_consumer_auto_resumed: { pausedForMs: 4200 },
    meet_participant_connection_state: { state: "reconnected", downtimeMs: 3100 },
    meet_reconnect_attempt: { attempt: 2, maxAttempts: 8, usingTurnFallback: true },
    meet_reconnect_success: { attempt: 2, usingTurnFallback: false },
    meet_reconnect_attempt_failure: { attempt: 2, maxAttempts: 8, failure_reason: "network", usingTurnFallback: false },
    meet_reconnect_give_up: { attempts: 8, failure_reason: "timeout", usingTurnFallback: true },
    meet_join_attempt: { joinMode: "meeting", isAdmin: false },
    meet_join_success: { joinMode: "meeting", status: "waiting" },
    meet_join_failure: { joinMode: "webinar_attendee", failure_reason: "auth" },
    telemetry_reports_dropped: { batches: 2, events: 9, unsent: 1 },
  };

  it.each(Object.keys(TELEMETRY_EVENTS).filter((name) => name !== "$exception") as TelemetryEventName[])(
    "sends every field of %s unchanged",
    (name) => {
      const payload = payloads[name] as Properties;
      const built = build({ uuid: "0196f0a1-0000-7000-8000-0000000000ab", event: name, properties: { token: KEY, distinct_id: SDK_ID, ...payload } }, { payload });

      expect(Object.fromEntries(Object.keys(payload).map((key) => [key, built.properties[key]]))).toEqual(payload);
    },
  );

  it("drops a field with free text where its form is an enum or a number", () => {
    const payload = { joinMode: "Meet Mira", isAdmin: "yes", roomId: "lime-pear-plum" };
    const built = build({ uuid: "u", event: "meet_join_attempt", properties: { token: KEY, ...payload } }, { payload });

    expect(built.properties).not.toHaveProperty("joinMode");
    expect(built.properties).not.toHaveProperty("isAdmin");
    expect(JSON.stringify(built)).not.toMatch(/Mira|lime-pear|yes/);
  });

  it("sends every field the call tracker emits for each call-quality event", () => {
    const emitted: CallMetricEvent[] = [];
    const tracker = createCallMetricsTracker({
      emit: (metric) => emitted.push(metric),
      newCallId: () => "8d0f6a0e-3c1b-4b7e-9a51-2f6d1c0b9e11",
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

    expect([...new Set(emitted.map(({ name }) => name))].sort()).toEqual(["call_first_media", "call_join", "call_summary"]);
    for (const { name, props } of emitted) {
      const built = build({ uuid: "u", event: name, properties: { token: KEY, ...props } }, { payload: props });
      expect(Object.fromEntries(Object.keys(props).map((key) => [key, built.properties[key]])), name).toEqual(props);
    }
  });
});

describe("stored state", () => {
  const sdkUuid = "0196f0a1-0000-7000-8000-000000000001";

  it("takes our fields from the emitter's payload, never from storage", () => {
    const event = exceptionEvent();
    Object.assign(event.properties, {
      source: "call_log",
      call_log: "[Meets] Error joining room",
      boundary: "panel",
    });
    const built = build(event, { payload: { source: "react_error_boundary" }, storedKeys: new Set(["source", "call_log", "boundary"]) });

    expect(built.properties.source).toBe("react_error_boundary");
    expect(built.properties).not.toHaveProperty("call_log");
    expect(built.properties).not.toHaveProperty("boundary");
    expect(built.properties.$exception_list[0].value).toBe("[message withheld]");
  });

  it("sends none of our fields on an event the SDK raised itself", () => {
    const event = exceptionEvent();
    Object.assign(event.properties, { source: "call_log", call_log: "[Meets] Error joining room" });
    const built = build(event, { payload: null });

    expect(built.properties).not.toHaveProperty("source");
    expect(built.properties).not.toHaveProperty("call_log");
    expect(built.properties.$exception_list[0].value).toBe("[message withheld]");
  });

  it("drops an SDK field that came from storage, but keeps the SDK's own ids", () => {
    const event = exceptionEvent();
    Object.assign(event.properties, { $browser: "Chrome", $os: "Mac OS X", $device_id: sdkUuid });
    const built = build(event, { storedKeys: new Set(["$browser", "distinct_id", "$device_id"]) });

    expect(built.properties).not.toHaveProperty("$browser");
    expect(built.properties.$os).toBe("Mac OS X");
    expect(built.properties.distinct_id).toBe(SDK_ID);
    expect(built.properties.$device_id).toBe(sdkUuid);
  });

  it("keeps the SDK's ids only when they are uuids", () => {
    const event = exceptionEvent();
    Object.assign(event.properties, {
      distinct_id: "Meet Mira in sample-room",
      $device_id: sdkUuid,
      $session_id: "sample-room",
      $window_id: sdkUuid,
    });
    const built = build(event);

    expect(built.properties).not.toHaveProperty("distinct_id");
    expect(built.properties).not.toHaveProperty("$session_id");
    expect(built.properties.$device_id).toBe(sdkUuid);
    expect(built.properties.$window_id).toBe(sdkUuid);
  });

  it("sends the build's client version and our host, never a stored or passed one", () => {
    const event = exceptionEvent();
    Object.assign(event.properties, { client_version: "facade00", $host: "audit-operator-site.localhost:5815", token: "phc_other" });
    const built = build(event, { payload: { client_version: "Meet Mira", $host: "Meet Mira" } });

    expect(built.properties).toMatchObject({ client_version: BUILD, $host: "conclave-web", token: KEY });
    expect(build(event, { clientVersion: "unknown" }).properties.client_version).toBe("unknown");
  });
});

describe("guest pass identifiers", () => {
  const PASS_ID = "gp_AbCdEfGhIjKlMnOpQrStUv";
  const SEAT_KEY = "guest-gp_ZyXwVuTsRqPoNmLkJiHgFe";
  const OLDER_KEY = "guest-0196f0a1-0000-7000-8000-000000000123";
  const PASS_COOKIE = "conclave-guest-0a1b2c3d-4e5f6a7b";
  const SIGNED = fakeSignedToken({ guestProof: "fixture" });
  const canaries = [PASS_ID, SEAT_KEY, OLDER_KEY, PASS_COOKIE, SIGNED, "guestProof", "guestGrant"];

  it("sends none of them, wherever an event carries one", () => {
    const event = exceptionEvent();
    event.properties = {
      ...event.properties,
      distinct_id: SEAT_KEY,
      $device_id: PASS_ID,
      $session_id: OLDER_KEY,
      $current_url: `${SITE}/lime-pear-plum?guest=${PASS_ID}&grant=${SIGNED}`,
      $pathname: `/${SEAT_KEY}`,
      $raw_user_agent: `${PASS_COOKIE}=${SIGNED}`,
      guestProof: SIGNED,
      guestGrant: SIGNED,
      userKey: SEAT_KEY,
      cookie: `${PASS_COOKIE}=${SIGNED}`,
    };
    event.properties.$exception_list[0].value = `join failed for ${SEAT_KEY} with ${PASS_ID}`;
    event.properties.$exception_list[0].stacktrace.frames = [
      { filename: `${SITE}/_next/static/chunks/${PASS_ID}.js?grant=${SIGNED}`, function: SEAT_KEY, lineno: 1, chunk_id: CHUNK_ID },
    ];
    const text = JSON.stringify(build(event));

    for (const canary of canaries) expect(text).not.toContain(canary);
  });

  it("refuses an event when one still survives the schema, as a frame path does without the build's chunk list", () => {
    const event = exceptionEvent();
    event.properties.$exception_list[0].stacktrace.frames = [
      { filename: `${SITE}/_next/static/chunks/${PASS_ID}.js`, lineno: 1, chunk_id: CHUNK_ID },
    ];
    const source = {
      payload: { source: "react_error_boundary", boundary: "route" },
      storedKeys: new Set<string>(),
      token: KEY,
      clientVersion: BUILD,
      siteOrigin: SITE,
    };

    expect(beforeSend(event, { ...source, chunkFiles: null })).toBeNull();
    expect(beforeSend({ ...event, properties: { ...event.properties, $exception_list: [{ type: "TypeError", value: "x" }] } }, { ...source, chunkFiles: null })).not.toBeNull();
  });
});
