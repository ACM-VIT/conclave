// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createForwardedEvents, forwardCapture } from "../src/app/lib/telemetry-ingest";

const BUILD = "0b2d3b480f4621392a4151d750c90965b7c8b76c";
const KEY = "phc_test_project";

// Holds the SDK's download until the test releases it. Telemetry loads the
// SDK with its exception-autocapture extension, so this holds the extension:
// mocking posthog-js itself would hand later tests one already-initialised
// instance.
const EXTENSION = "posthog-js/dist/exception-autocapture";
const sdk = { release: () => {} };
const holdSdk = () => {
  const ready = new Promise<void>((resolve) => (sdk.release = resolve));
  vi.doMock(EXTENSION, async (importOriginal) => {
    await ready;
    return importOriginal();
  });
};

type Sent = { via: "beacon" | "fetch"; url: string; body: BodyInit; type: string };
let sent: Sent[] = [];

// The page's fetch of its chunk manifest: pending until a test aborts it, or
// missing at once.
let manifest: "pending" | "missing" = "pending";
let abortManifest: () => void = () => {};

beforeEach(async () => {
  vi.resetModules();
  const { PostHog } = await import("posthog-js");
  vi.spyOn(PostHog.prototype, "init");
  sent = [];
  manifest = "pending";
  sdk.release = () => {};
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", KEY);
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_DEV", "1");
  vi.stubEnv("NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION", BUILD);
  vi.stubGlobal(
    "fetch",
    vi.fn((resource: unknown, init?: RequestInit) => {
      const url = String(resource);
      if (url.includes("posthog-chunk-ids")) {
        if (manifest === "missing") return Promise.resolve(new Response("not found", { status: 404 }));
        return new Promise<Response>((_resolve, reject) => {
          abortManifest = () => reject(new TypeError("Failed to fetch"));
        });
      }
      if (url.includes("/ingest/") && init?.body) {
        sent.push({ via: "fetch", url, body: init.body, type: new Headers(init.headers).get("content-type") ?? "" });
      }
      return Promise.resolve(new Response('{"status":1}', { status: 200 }));
    }),
  );
  // posthog-js drops every event from a browser that says it is automated.
  Object.defineProperty(navigator, "webdriver", { configurable: true, get: () => false });
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: (url: string | URL, body: Blob) => {
      sent.push({ via: "beacon", url: String(url), body, type: body.type });
      return true;
    },
  });
});

afterEach(() => {
  // Telemetry's lifecycle listeners stay for the page's life, so leave
  // nothing pending for a later test's page events to send.
  sdk.release();
  vi.doUnmock(EXTENSION);
  window.dispatchEvent(new Event("pagehide"));
  window.dispatchEvent(new Event("pageshow"));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Event_ = { event: string; properties: Record<string, unknown> };

/** The events in what was sent, as /ingest decodes and forwards them. */
const sentEvents = async (list: Sent[] = sent): Promise<Event_[]> => {
  const events: Event_[] = [];
  for (const item of list) {
    const forwarded: string[] = [];
    await forwardCapture(
      new Request(new URL(item.url, "https://conclave.example"), {
        method: "POST",
        body: item.body,
        headers: { "content-type": item.type || "text/plain" },
      }),
      ["e"],
      {
        fetch: async (_url, init) => {
          forwarded.push(String(init.body));
          return new Response('{"status":1}', { status: 200 });
        },
        ingestHost: "https://ingest.example",
        projectKey: KEY,
        currentBuild: BUILD,
        manifest: async () => null,
        siteOrigin: "https://conclave.example",
        now: () => Date.now(),
        forwarded: createForwardedEvents(),
      },
    );
    for (const body of forwarded) events.push(...(JSON.parse(body) as { batch: Event_[] }).batch);
  }
  return events;
};
const names = async (list?: Sent[]) => (await sentEvents(list)).map((event) => event.event).sort();
const beacons = () => sent.filter((item) => item.via === "beacon");

// Telemetry makes its own posthog-js instance; this finds it as it initialises.
const loaded = async () => {
  const { PostHog } = await import("posthog-js");
  await vi.waitFor(() =>
    expect((initialised(PostHog) as { __loaded?: boolean } | undefined)?.__loaded).toBe(true),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const initialised = (PostHog: { prototype: object }): unknown => {
  const init = (PostHog.prototype as { init: { mock?: { instances: unknown[] } } }).init;
  return init.mock?.instances.at(-1);
};

const loadHeld = async () => {
  const { telemetry } = await import("../src/app/lib/telemetry");
  telemetry.captureException(new Error("first render"), { source: "react_error_boundary", boundary: "route" });
  telemetry.capture("meet_join_attempt", { joinMode: "meeting", isAdmin: false });
  await loaded();
  expect(sent).toHaveLength(0);
};

const hide = () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  try {
    document.dispatchEvent(new Event("visibilitychange"));
  } finally {
    visibility.mockRestore();
  }
};

describe("reports held for the chunk manifest when the page goes away", () => {
  it("sends a held exception by beacon when the tab is hidden", async () => {
    await loadHeld();
    hide();

    expect(await names(beacons())).toEqual(["$exception", "meet_join_attempt"]);
  });

  it("sends a held exception by beacon on pagehide, before posthog-js unloads its queue", async () => {
    await loadHeld();
    let beforeSdkUnload: Sent[] = [];
    // Registered after telemetry's own listener, so it runs right after it.
    window.addEventListener("pagehide", () => (beforeSdkUnload = beacons()), { capture: true, once: true });

    window.dispatchEvent(new Event("pagehide"));

    expect(await names(beforeSdkUnload)).toEqual(["$exception", "meet_join_attempt"]);
  });

  it("sends held reports by beacon when navigating away aborts the manifest fetch first", async () => {
    await loadHeld();
    let beforeSdkUnload: Sent[] = [];
    window.addEventListener("pagehide", () => (beforeSdkUnload = beacons()), { capture: true, once: true });

    // A browser aborts the page's fetches as it navigates, and runs the
    // rejection before telemetry's pagehide listener.
    abortManifest();
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.dispatchEvent(new Event("pagehide"));

    expect(await names(beforeSdkUnload)).toEqual(["$exception", "meet_join_attempt"]);
  });

  it("sends each held report once when the tab is hidden and the page then closes", async () => {
    await loadHeld();
    hide();
    document.dispatchEvent(new Event("freeze"));
    window.dispatchEvent(new Event("pagehide"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await names()).toEqual(["$exception", "meet_join_attempt"]);
  });
});

describe("batches", () => {
  it("sends the events of a few seconds as one request, and the rest as one beacon when the tab is hidden", async () => {
    manifest = "missing";
    const { telemetry, startTelemetry } = await import("../src/app/lib/telemetry");
    startTelemetry();
    await loaded();

    telemetry.capture("meet_join_attempt", { joinMode: "meeting", isAdmin: false });
    telemetry.capture("meet_join_success", { joinMode: "meeting", status: "joined" });
    telemetry.capture("meet_reconnect_attempt", { attempt: 1, maxAttempts: 8, usingTurnFallback: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent).toHaveLength(0);

    hide();
    expect(sent.map((item) => item.via)).toEqual(["beacon"]);
    expect(await names()).toEqual(["meet_join_attempt", "meet_join_success", "meet_reconnect_attempt"]);
  });
});

describe("reports for the whole life of the page", () => {
  it("sends an exception at once after startup, so a tab hidden and frozen right after loses nothing", async () => {
    manifest = "missing";
    const { telemetry, startTelemetry } = await import("../src/app/lib/telemetry");
    startTelemetry();
    await loaded();

    telemetry.captureException(new TypeError("after startup"), { source: "react_error_boundary", boundary: "route" });
    hide();
    document.dispatchEvent(new Event("freeze"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await names()).toEqual(["$exception"]);
  });

  it("sends reports by beacon when the page goes away before the SDK has loaded, and only once", async () => {
    holdSdk();
    const { telemetry } = await import("../src/app/lib/telemetry");
    const { logCallError } = await import("../src/app/lib/call-error-capture");
    telemetry.captureException(new Error("first render"), { source: "react_error_boundary", boundary: "route" });
    telemetry.capture("meet_join_attempt", { joinMode: "meeting", isAdmin: false });
    logCallError("[Meets] Error joining room", new Error("Meet Mira is not in this room"));

    window.dispatchEvent(new Event("pagehide"));
    hide();
    document.dispatchEvent(new Event("freeze"));

    const events = await sentEvents(beacons());
    expect(events.map((event) => event.event).sort()).toEqual(["$exception", "$exception", "meet_join_attempt"]);
    expect(events.map((event) => event.properties.call_log ?? event.properties.boundary).sort()).toEqual([
      "[Meets] Error joining room",
      "route",
      undefined,
    ]);
    for (const event of events) expect(event.properties).toMatchObject({ token: KEY, client_version: BUILD, $host: "conclave-web" });
    expect(JSON.stringify(events)).not.toContain("Meet Mira");

    sdk.release();
    await loaded();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await names()).toEqual(["$exception", "$exception", "meet_join_attempt"]);
  });
});
