// @vitest-environment happy-dom
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORED_BATCH_PREFIX } from "../src/app/lib/telemetry-outbox";

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  unregister_for_session: vi.fn(),
  capture: vi.fn(),
  captureException: vi.fn(),
  exceptions: { buildProperties: vi.fn(() => ({ $exception_list: [] })) },
  // properties() is what posthog-js attaches to every event from each store.
  persistence: { properties: vi.fn((): Record<string, unknown> => ({})) },
  sessionPersistence: { properties: vi.fn((): Record<string, unknown> => ({})) },
}));
// Telemetry makes its own instance with `new PostHog()`; this one stands in.
vi.mock("posthog-js", () => ({
  default: posthog,
  PostHog: function PostHog() {
    return posthog;
  },
}));
vi.mock("posthog-js/dist/exception-autocapture", () => ({}));
vi.mock("../src/app/components/ErrorStateView", () => ({ default: () => null }));

type BoundaryProps = { error: Error & { digest?: string }; reset: () => void };
type SentEvent = { event: string; properties: Record<string, unknown> };

let built = 0;

const sdkUuid = "0196f0a1-0000-7000-8000-00000000000a";

const originalConsoleError = console.error;
let root: Root | null = null;

const browserRequest = class extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init);
    Object.defineProperty(this, "keepalive", { value: init?.keepalive === true });
  }
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  console.error = () => {};
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test_project");
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_DEV", "1");
  vi.stubGlobal("Request", browserRequest);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: () => false });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  console.error = originalConsoleError;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const renderOnFirstLoad = async (boundary: ComponentType<BoundaryProps>) => {
  const error = Object.assign(new Error("page failed on first render"), {
    digest: "digest-1",
  });
  root = createRoot(document.createElement("div"));
  await act(async () => {
    const Boundary = boundary;
    root?.render(<Boundary error={error} reset={() => {}} />);
  });
  return error;
};

describe("error boundaries on the first page load", () => {
  it("reports a route error caught before telemetry has loaded", async () => {
    const { default: RouteError } = await import("../src/app/error");
    const error = await renderOnFirstLoad(RouteError);

    await vi.waitFor(() =>
      expect(posthog.captureException).toHaveBeenCalledWith(error, {
        source: "react_error_boundary",
        boundary: "route",
        digest: "digest-1",
      }),
    );
    expect(posthog.init).toHaveBeenCalledTimes(1);
    expect(posthog.init).toHaveBeenCalledWith(
      "phc_test_project",
      expect.objectContaining({ api_host: "/ingest", ui_host: "https://eu.posthog.com" }),
    );
  });

  it("reports a root layout failure with no telemetry provider mounted", async () => {
    const { default: GlobalError } = await import("../src/app/global-error");
    const error = await renderOnFirstLoad(GlobalError);

    await vi.waitFor(() =>
      expect(posthog.captureException).toHaveBeenCalledWith(error, {
        source: "react_error_boundary",
        boundary: "root",
        digest: "digest-1",
      }),
    );
  });

  it("keeps only the SDK's own ids in storage", async () => {
    posthog.persistence.properties.mockReturnValue({
      distinct_id: sdkUuid,
      $device_id: sdkUuid,
      $initialization_time: "2026-11-22T00:00:00Z",
      client_version: "0b2d3b48",
      reason: "Meet Mira in sample-room",
      $meeting_note: "Meet Mira in sample-room",
      __meeting_note: "Meet Mira in sample-room",
    });
    posthog.sessionPersistence.properties.mockReturnValue({
      $referrer: "https://example.org/",
      call_log: "[Meets] Fixture meeting note",
    });
    const { default: RouteError } = await import("../src/app/error");
    await renderOnFirstLoad(RouteError);

    await vi.waitFor(() => expect(posthog.captureException).toHaveBeenCalled());
    expect(posthog.unregister.mock.calls.map(([key]) => key).sort()).toEqual([
      "$initialization_time",
      "$meeting_note",
      "__meeting_note",
      "client_version",
      "reason",
    ]);
    expect(posthog.unregister_for_session.mock.calls.map(([key]) => key).sort()).toEqual([
      "$referrer",
      "call_log",
    ]);
    expect(posthog.register).not.toHaveBeenCalled();
  });

  it("loads nothing and sends nothing without a project key", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
    const { default: RouteError } = await import("../src/app/error");
    await renderOnFirstLoad(RouteError);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.captureException).not.toHaveBeenCalled();
  });
});

describe("what each event carries", () => {
  // Merges the stores under the payload the way posthog-js does, then runs the
  // configured before_send, which the SDK calls inside capture.
  // What /ingest is sent for an event the SDK builds: before_send puts it in
  // the outbox, which posts an exception at once; a frozen page sends the
  // rest at once, and with the beacon refused keeps it for the next page
  // load. This finds the event by its uuid in whichever it went.
  const sendThroughSdk = (event: string, payload: Record<string, unknown>): SentEvent => {
    const [, config] = posthog.init.mock.calls[0] as [string, { before_send: (event: SentEvent) => SentEvent | null }];
    const uuid = `0196f0a1-0000-7000-8000-${String(++built).padStart(12, "0")}`;
    expect(
      config.before_send({
        uuid,
        event,
        properties: {
          $os: "Mac OS X",
          token: "phc_test_project",
          ...posthog.persistence.properties(),
          ...posthog.sessionPersistence.properties(),
          ...payload,
        },
      } as SentEvent),
    ).toBeNull();
    document.dispatchEvent(new Event("freeze"));
    document.dispatchEvent(new Event("resume"));
    type Built = SentEvent & { uuid: string };
    const savedKeys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? "").filter(
      (key) => key.startsWith(STORED_BATCH_PREFIX),
    );
    const kept = savedKeys.flatMap((key) => {
      const saved = JSON.parse(localStorage.getItem(key) ?? "null") as { events: Built[] } | null;
      localStorage.removeItem(key);
      return saved?.events ?? [];
    });
    const posted = (fetch as unknown as { mock: { calls: Array<[unknown, RequestInit?]> } }).mock.calls
      .filter(([url]) => String(url).includes("/ingest/e/"))
      .flatMap(([, init]) => (JSON.parse(String(init?.body)) as { batch: Built[] }).batch);
    const events = [...posted, ...kept];
    return events.find((sent) => sent.uuid === uuid) as SentEvent;
  };

  it("reports a meeting panel that fails to render, through before_send", async () => {
    const sent: SentEvent[] = [];
    posthog.captureException.mockImplementation((error: unknown, props?: Record<string, unknown>) => {
      const failure = error as Error;
      sent.push(
        sendThroughSdk("$exception", {
          $exception_list: [{ type: failure.name, value: failure.message, stacktrace: { type: "raw", frames: [] } }],
          ...props,
        }),
      );
    });
    function FailedPanel(): never {
      throw new Error("Meet Mira in sample-room");
    }
    try {
      const { default: MeetingPanelBoundary } = await import("../src/app/components/MeetingPanelBoundary");
      root = createRoot(document.createElement("div"), { onCaughtError: () => {} });
      await act(async () => {
        root?.render(
          <MeetingPanelBoundary name="Chat">
            <FailedPanel />
          </MeetingPanelBoundary>,
        );
      });

      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0].properties).toMatchObject({ source: "react_error_boundary", boundary: "panel" });
      expect((sent[0].properties.$exception_list as Array<unknown>)[0]).toMatchObject({
        type: "Error",
        value: "[message withheld]",
      });
      expect(JSON.stringify(sent)).not.toMatch(/Mira|sample-room/);
    } finally {
      posthog.captureException.mockReset();
    }
  });

  it("reports an AudioStreamPlayer playback failure as one event with only its label", async () => {
    const sent: SentEvent[] = [];
    posthog.captureException.mockImplementation((error: unknown, props?: Record<string, unknown>) => {
      const failure = error as Error;
      sent.push(
        sendThroughSdk("$exception", {
          $exception_list: [{ type: failure.name, value: failure.message, stacktrace: { type: "raw", frames: [] } }],
          ...props,
        }),
      );
    });
    // The player tries again on its own; one attempt fails, the next ones play.
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValueOnce(new DOMException("Meet Mira decode failed", "NotSupportedError"))
      .mockResolvedValue(undefined);
    try {
      const { startTelemetry } = await import("../src/app/lib/telemetry");
      startTelemetry();
      await vi.waitFor(() => expect(posthog.init).toHaveBeenCalled());
      const { default: AudioStreamPlayer } = await import("../src/app/components/AudioStreamPlayer");
      const stream = new MediaStream();
      root = createRoot(document.createElement("div"));
      await act(async () => {
        root?.render(
          <AudioStreamPlayer kind="participant" stream={stream} playbackErrorContext="mira@example.com" />,
        );
      });

      await vi.waitFor(() => expect(sent).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(play.mock.calls.length).toBeGreaterThan(1);
      expect(sent).toHaveLength(1);
      const { properties } = sent[0];
      expect(properties).toMatchObject({ source: "call_log", call_log: "[Meets] Audio play error" });
      expect((properties.$exception_list as Array<unknown>)[0]).toMatchObject({
        type: "NotSupportedError",
        value: "[Meets] Audio play error",
      });
      expect(JSON.stringify(sent)).not.toMatch(/Mira|mira@/);
    } finally {
      play.mockRestore();
      posthog.captureException.mockReset();
    }
  });

  it("holds a first-render report until the build's chunk manifest has loaded", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION", "0b2d3b480f4621392a4151d750c90965b7c8b76c");
    const chunk = "http://localhost:3000/_next/static/chunks/3u-6_1om1fv26.js";
    const manifest = { "147fc2df-e663-5d76-aa13-f67e1e894071": "/_next/static/chunks/3u-6_1om1fv26.js" };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) =>
            setTimeout(() => resolve(new Response(JSON.stringify(manifest), { status: 200 })), 300),
          ),
      ),
    );
    const sent: SentEvent[] = [];
    posthog.captureException.mockImplementation((_error: unknown, props?: Record<string, unknown>) => {
      sent.push(
        sendThroughSdk("$exception", {
          $current_url: "http://localhost:3000/",
          $exception_list: [
            {
              type: "Error",
              value: "x",
              stacktrace: { type: "raw", frames: [{ filename: chunk, lineno: 1, chunk_id: "147fc2df-e663-5d76-aa13-f67e1e894071" }] },
            },
          ],
          ...props,
        }),
      );
    });
    try {
      const { default: RouteError } = await import("../src/app/error");
      await renderOnFirstLoad(RouteError);

      await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 3000 });
      const frames = (sent[0].properties.$exception_list as Array<{ stacktrace: { frames: Array<{ filename: string }> } }>)[0]
        .stacktrace.frames;
      expect(frames[0].filename).toBe("/_next/static/chunks/3u-6_1om1fv26.js");
    } finally {
      posthog.captureException.mockReset();
    }
  });

  it("sends held reports after 3 s when the manifest does not come", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION", "0b2d3b480f4621392a4151d750c90965b7c8b76c");
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { telemetry } = await import("../src/app/lib/telemetry");
      telemetry.captureException(new Error("first render"), { source: "react_error_boundary", boundary: "route" });
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(2900);
      expect(posthog.init).toHaveBeenCalled();
      expect(posthog.captureException).not.toHaveBeenCalled();

      const { logCallError } = await import("../src/app/lib/call-error-capture");
      logCallError("[Meets] Consume error", new Error("while held"));
      expect(posthog.captureException).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);
      expect(posthog.captureException).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends held reports at once when the page closes before the manifest arrives", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION", "0b2d3b480f4621392a4151d750c90965b7c8b76c");
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const { telemetry } = await import("../src/app/lib/telemetry");
    telemetry.captureException(new Error("first render"), { source: "react_error_boundary", boundary: "route" });
    telemetry.capture("meet_join_attempt", { attempt: 1 });
    await vi.waitFor(() => expect(posthog.init).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posthog.captureException).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("pagehide"));

    expect(posthog.captureException).toHaveBeenCalledWith(expect.any(Error), {
      source: "react_error_boundary",
      boundary: "route",
    });
    expect(posthog.capture).toHaveBeenCalledWith("meet_join_attempt", { attempt: 1 });
    telemetry.capture("meet_join_success", { attempt: 1 });
    expect(posthog.capture).toHaveBeenCalledTimes(2);
  });

  it("sends held reports at once when the tab is hidden", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION", "0b2d3b480f4621392a4151d750c90965b7c8b76c");
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const { telemetry } = await import("../src/app/lib/telemetry");
    telemetry.captureException(new Error("first render"), { source: "react_error_boundary", boundary: "route" });
    await vi.waitFor(() => expect(posthog.init).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posthog.captureException).not.toHaveBeenCalled();

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      document.dispatchEvent(new Event("visibilitychange"));
    } finally {
      visibility.mockRestore();
    }

    expect(posthog.captureException).toHaveBeenCalledWith(expect.any(Error), {
      source: "react_error_boundary",
      boundary: "route",
    });
  });

  it("keeps a chunk's path only when the build's manifest pairs its id with that file", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION", "0b2d3b480f4621392a4151d750c90965b7c8b76c");
    const manifest = { "147fc2df-e663-5d76-aa13-f67e1e894071": "/_next/static/chunks/3u-6_1om1fv26.js" };
    const fetchManifest = vi.fn(async (url: string) =>
      url === "/_next/static/posthog-chunk-ids/0b2d3b480f4621392a4151d750c90965b7c8b76c.json"
        ? new Response(JSON.stringify(manifest), { status: 200 })
        : new Response("{}", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchManifest);
    const { startTelemetry } = await import("../src/app/lib/telemetry");
    startTelemetry();
    await vi.waitFor(() => expect(posthog.init).toHaveBeenCalled());
    await vi.waitFor(() => expect(fetchManifest).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    const chunk = "http://localhost:3000/_next/static/chunks/3u-6_1om1fv26.js";
    const sent = sendThroughSdk("$exception", {
      $current_url: "http://localhost:3000/",
      $exception_list: [
        {
          type: "Error",
          value: "x",
          stacktrace: {
            type: "raw",
            frames: [
              { filename: chunk, lineno: 1, chunk_id: "147fc2df-e663-5d76-aa13-f67e1e894071" },
              { filename: chunk, lineno: 2, chunk_id: "0f8c2a1e-5b7d-4c3e-9a10-000000000001" },
            ],
          },
        },
      ],
    });

    const frames = (sent.properties.$exception_list as Array<{ stacktrace: { frames: Array<{ filename: string }> } }>)[0]
      .stacktrace.frames;
    expect(frames.map((frame) => frame.filename)).toEqual(["/_next/static/chunks/3u-6_1om1fv26.js", "[path]"]);
  });

  it("sends application fields only from the capture that set them", async () => {
    posthog.persistence.properties.mockReturnValue({
      distinct_id: sdkUuid,
      reason: "Meet Mira in sample-room",
    });
    posthog.sessionPersistence.properties.mockReturnValue({
      source: "call_log",
      call_log: "[Meets] Fixture meeting note",
    });
    const sent: SentEvent[] = [];
    posthog.capture.mockImplementation((event: string, props?: Record<string, unknown>) => {
      sent.push(sendThroughSdk(event, props ?? {}));
    });
    try {
      const { telemetry } = await import("../src/app/lib/telemetry");
      telemetry.capture("meet_reconnect_attempt", { attempt: 1 });
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      sent.push(
        sendThroughSdk("$exception", {
          $exception_list: [{ type: "TypeError", value: "Mira is not a function" }],
        }),
      );

      expect(sent[0].properties).toMatchObject({ attempt: 1, distinct_id: sdkUuid, $os: "Mac OS X" });
      for (const { properties } of sent) {
        expect(properties).not.toHaveProperty("reason");
        expect(properties).not.toHaveProperty("source");
        expect(properties).not.toHaveProperty("call_log");
      }
      expect(JSON.stringify(sent)).not.toMatch(/Mira|sample-room|Fixture/);
    } finally {
      posthog.capture.mockReset();
      posthog.persistence.properties.mockReset().mockReturnValue({});
      posthog.sessionPersistence.properties.mockReset().mockReturnValue({});
    }
  });
});
