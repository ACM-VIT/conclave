// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createForwardedEvents, forwardCapture } from "../src/app/lib/telemetry-ingest";
import { STORED_BATCH_PREFIX } from "../src/app/lib/telemetry-outbox";

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
let ingestInits: RequestInit[] = [];
let sendBeaconCalls = 0;
let refuseBeacons = false;
let ingestAnswers: number[] = [];

// While set, /ingest answers only once the test releases it.
let ingestHeld: Promise<void> | null = null;

// The page's fetch of its chunk manifest: pending until a test aborts it, or
// missing at once.
let manifest: "pending" | "missing" = "pending";
let abortManifest: () => void = () => {};

const browserRequest = class extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init);
    Object.defineProperty(this, "keepalive", { value: init?.keepalive === true });
  }
};

beforeEach(async () => {
  vi.resetModules();
  const { PostHog } = await import("posthog-js");
  vi.spyOn(PostHog.prototype, "init");
  sent = [];
  ingestInits = [];
  sendBeaconCalls = 0;
  refuseBeacons = false;
  ingestAnswers = [];
  ingestHeld = null;
  localStorage.clear();
  manifest = "pending";
  sdk.release = () => {};
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", KEY);
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_DEV", "1");
  vi.stubEnv("NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION", BUILD);
  vi.stubGlobal("Request", browserRequest);
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
      let answer = new Response('{"status":1}', { status: 200 });
      if (url.includes("/ingest/") && init?.body) {
        const status = init.signal ? ingestAnswers.shift() : undefined;
        if (status !== undefined) answer = new Response("{}", { status });
        const via = init.signal ? "fetch" : "beacon";
        if (via === "beacon" && refuseBeacons) throw new TypeError("keepalive request refused");
        ingestInits.push(init);
        sent.push({ via, url, body: init.body, type: new Headers(init.headers).get("content-type") ?? "" });
        if (ingestHeld && via === "fetch") return ingestHeld.then(() => answer);
      }
      return Promise.resolve(answer);
    }),
  );
  // posthog-js drops every event from a browser that says it is automated.
  Object.defineProperty(navigator, "webdriver", { configurable: true, get: () => false });
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: (url: string | URL, body: Blob) => {
      sendBeaconCalls += 1;
      sent.push({ via: "beacon", url: String(url), body, type: body.type });
      return !refuseBeacons;
    },
  });
});

afterEach(() => {
  // Telemetry's lifecycle listeners stay for the page's life, so leave
  // nothing pending for a later test's page events to send.
  sdk.release();
  vi.doUnmock(EXTENSION);
  window.dispatchEvent(new Event("pagehide"));
  // What that saved would otherwise be sent by a later test's page.
  localStorage.clear();
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
const savedKeys = () =>
  Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? "").filter((key) =>
    key.startsWith(STORED_BATCH_PREFIX),
  );
const fetches = () => sent.filter((item) => item.via === "fetch");

/**
 * The Web Locks API as a browser has it: each request waits its turn, and
 * one made `ifAvailable` while the lock is held gets null at once.
 */
const webLocks = () => {
  const requests: Array<{ name: string; ifAvailable: boolean }> = [];
  const waiting: Array<() => void> = [];
  let held = false;
  const grantNext = () => waiting.shift()?.();
  type Run = (lock: { name: string } | null) => Promise<void> | void;
  const request = (name: string, optionsOrRun: Run | { ifAvailable?: boolean }, maybeRun?: Run) => {
    const run = (typeof optionsOrRun === "function" ? optionsOrRun : maybeRun) as Run;
    const ifAvailable = typeof optionsOrRun === "function" ? false : (optionsOrRun.ifAvailable ?? false);
    requests.push({ name, ifAvailable });
    if (held && ifAvailable) return Promise.resolve(run(null));
    return new Promise<void>((resolve, reject) => {
      const start = () => {
        held = true;
        Promise.resolve(run({ name }))
          .then(resolve, reject)
          .finally(() => {
            held = false;
            grantNext();
          });
      };
      if (held) waiting.push(start);
      else start();
    });
  };
  // Another tab takes the lock; the returned function lets it go.
  const hold = () => {
    held = true;
    return () => {
      held = false;
      grantNext();
    };
  };
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
  return { requests, hold };
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

describe("reports after the page started to go away", () => {
  it("sends a call summary emitted after the pagehide flush at once, even when the SDK failed to load", async () => {
    vi.doMock(EXTENSION, () => {
      throw new Error("chunk failed to load");
    });
    const { telemetry, startTelemetry } = await import("../src/app/lib/telemetry");
    startTelemetry();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Telemetry's own listener runs first, then the call tracker reports.
    window.dispatchEvent(new Event("pagehide"));
    telemetry.capture(
      "call_summary",
      { call_id: "8d0f6a0e-3c1b-4b7e-9a51-2f6d1c0b9e11", join_mode: "meeting", end_reason: "page_closed", duration_ms: 26522 } as never,
      { immediate: true },
    );
    telemetry.capture("meet_reconnect_give_up", { attempts: 8, failure_reason: "network", usingTurnFallback: false });

    expect(await names(beacons())).toEqual(["call_summary", "meet_reconnect_give_up"]);
  });

  it("sends an immediate report at once while the page stays, whatever the SDK's state", async () => {
    holdSdk();
    const { telemetry } = await import("../src/app/lib/telemetry");
    telemetry.capture(
      "call_join",
      { call_id: "8d0f6a0e-3c1b-4b7e-9a51-2f6d1c0b9e11", outcome: "abandoned", join_mode: "meeting", waited: false } as never,
      { immediate: true },
    );

    expect(await names(beacons())).toEqual(["call_join"]);
  });
});

describe("batches the browser will not take as the page goes away", () => {
  it("keeps them for the next page load, which sends each of them once", async () => {
    manifest = "missing";
    const { telemetry, startTelemetry } = await import("../src/app/lib/telemetry");
    startTelemetry();
    await loaded();
    telemetry.capture("meet_join_attempt", { joinMode: "meeting", isAdmin: false });
    telemetry.capture("meet_join_success", { joinMode: "meeting", status: "joined" });
    refuseBeacons = true;
    window.dispatchEvent(new Event("pagehide"));
    expect(sent).toEqual([]);
    expect(savedKeys()).toHaveLength(1);

    vi.resetModules();
    const nextLoad = await import("../src/app/lib/telemetry");
    nextLoad.startTelemetry();
    await vi.waitFor(() => expect(sent.filter((item) => item.via === "fetch")).toHaveLength(1));

    expect(await names()).toEqual(["meet_join_attempt", "meet_join_success"]);
    await vi.waitFor(() => expect(savedKeys()).toEqual([]));
  });

  it("sends them again when the page comes back, and keeps each until its send is answered", async () => {
    manifest = "missing";
    const { telemetry, startTelemetry } = await import("../src/app/lib/telemetry");
    startTelemetry();
    await loaded();
    telemetry.capture("meet_join_attempt", { joinMode: "meeting", isAdmin: false });
    refuseBeacons = true;
    hide();
    expect(sent).toEqual([]);
    expect(savedKeys()).toHaveLength(1);

    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(sent.filter((item) => item.via === "fetch").length).toBeGreaterThan(0));
    expect(new Set(await names(sent.filter((item) => item.via === "fetch")))).toEqual(new Set(["meet_join_attempt"]));
    await vi.waitFor(() => expect(savedKeys()).toEqual([]));
  });

  it("drops what was saved more than 5 minutes ago and counts it, never sending it to be dated now", async () => {
    manifest = "missing";
    const savedAt = Date.now() - 5 * 60_000 - 1000;
    const old = (n: number) => ({
      uuid: `0196f0a1-0000-7000-8000-0000000000f${n}`,
      event: "meet_join_attempt",
      timestamp: new Date(savedAt).toISOString(),
      properties: { token: KEY, distinct_id: "0196f0a1-0000-7000-8000-00000000d15d", joinMode: "meeting", isAdmin: false },
    });
    const id = "0196f0a1-0000-7000-9000-0000000000f0";
    localStorage.setItem(`${STORED_BATCH_PREFIX}${id}`, JSON.stringify({ id, events: [old(1), old(2)], oldestAt: savedAt, sent: false }));

    const { startTelemetry } = await import("../src/app/lib/telemetry");
    startTelemetry();
    await loaded();
    await vi.waitFor(() => expect(savedKeys()).toEqual([]));
    hide();

    const events = await sentEvents();
    expect(events.map((event) => event.event)).toEqual(["telemetry_reports_dropped"]);
    expect(events[0].properties).toMatchObject({ batches: 1, events: 2, unsent: 1 });
  });

  it("waits its turn for the tabs' lock, and replays once the tab holding it lets go", async () => {
    manifest = "missing";
    const id = "0196f0a1-0000-7000-9000-0000000000e0";
    const recent = {
      uuid: "0196f0a1-0000-7000-8000-0000000000e1",
      event: "meet_join_attempt",
      timestamp: new Date().toISOString(),
      properties: { token: KEY, distinct_id: "0196f0a1-0000-7000-8000-00000000d15d", joinMode: "meeting", isAdmin: false },
    };
    localStorage.setItem(`${STORED_BATCH_PREFIX}${id}`, JSON.stringify({ id, events: [recent], oldestAt: Date.now(), sent: false }));
    const locks = webLocks();
    const otherTabLetsGo = locks.hold();
    try {
      const { startTelemetry } = await import("../src/app/lib/telemetry");
      startTelemetry();
      await loaded();
      expect(locks.requests).toEqual([{ name: "conclave:telemetry:replay", ifAvailable: false }]);
      expect(sent).toEqual([]);
      expect(savedKeys()).toHaveLength(1);

      otherTabLetsGo();
      await vi.waitFor(() => expect(fetches().length).toBeGreaterThan(0));
      expect(new Set((await sentEvents()).map((event) => event.event))).toEqual(new Set(["meet_join_attempt"]));
      await vi.waitFor(() => expect(savedKeys()).toEqual([]));
    } finally {
      delete (navigator as unknown as { locks?: unknown }).locks;
    }
  });

  it("sends a batch saved while a replay waited for its answer, once that replay ends", async () => {
    manifest = "missing";
    const id = "0196f0a1-0000-7000-9000-0000000000c0";
    const earlier = {
      uuid: "0196f0a1-0000-7000-8000-0000000000c1",
      event: "meet_join_attempt",
      timestamp: new Date().toISOString(),
      properties: { token: KEY, distinct_id: "0196f0a1-0000-7000-8000-00000000d15d", joinMode: "meeting", isAdmin: false },
    };
    localStorage.setItem(`${STORED_BATCH_PREFIX}${id}`, JSON.stringify({ id, events: [earlier], oldestAt: Date.now(), sent: false }));
    webLocks();
    let answer = () => {};
    ingestHeld = new Promise<void>((resolve) => (answer = resolve));
    try {
      const { telemetry, startTelemetry } = await import("../src/app/lib/telemetry");
      startTelemetry();
      await loaded();
      await vi.waitFor(() => expect(fetches()).toHaveLength(1));

      // The page hides, saving what it holds, and comes back while the
      // replay still waits for its answer.
      refuseBeacons = true;
      telemetry.capture("meet_join_success", { joinMode: "meeting", status: "joined" });
      hide();
      expect(savedKeys()).toHaveLength(2);
      document.dispatchEvent(new Event("visibilitychange"));
      ingestHeld = null;
      answer();

      await vi.waitFor(async () => expect(await names(fetches())).toContain("meet_join_success"));
      await vi.waitFor(() => expect(savedKeys()).toEqual([]));
    } finally {
      delete (navigator as unknown as { locks?: unknown }).locks;
    }
  });
});

describe("what a telemetry request carries", () => {
  it("sends every report without cookies or a referrer, and never by sendBeacon", async () => {
    manifest = "missing";
    const { telemetry, startTelemetry } = await import("../src/app/lib/telemetry");
    startTelemetry();
    await loaded();
    telemetry.captureException(new TypeError("while the page stays"), { source: "react_error_boundary", boundary: "route" });
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    telemetry.capture("meet_join_attempt", { joinMode: "meeting", isAdmin: false });
    hide();

    expect(sendBeaconCalls).toBe(0);
    expect(ingestInits.length).toBeGreaterThanOrEqual(2);
    for (const init of ingestInits) expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
    expect(ingestInits.some((init) => init.keepalive === true && !init.signal)).toBe(true);
  });

  it("builds a saved batch through the outbound schema again before it replays it", async () => {
    manifest = "missing";
    const id = "0196f0a1-0000-7000-9000-0000000000b0";
    const tampered = {
      uuid: "0196f0a1-0000-7000-8000-0000000000b1",
      event: "meet_join_attempt",
      timestamp: new Date().toISOString(),
      properties: { token: KEY, distinct_id: "0196f0a1-0000-7000-8000-00000000d15d", joinMode: "meeting", isAdmin: false, roomId: "lime-pear-plum" },
    };
    localStorage.setItem(`${STORED_BATCH_PREFIX}${id}`, JSON.stringify({ id, events: [tampered], oldestAt: Date.now(), sent: false }));

    const { startTelemetry } = await import("../src/app/lib/telemetry");
    startTelemetry();
    await vi.waitFor(() => expect(sent.filter((item) => item.via === "fetch").length).toBeGreaterThan(0));

    const bodies = await Promise.all(sent.map((item) => new Response(item.body).text()));
    expect(bodies.join("\n")).not.toContain("lime-pear");
    expect(bodies.join("\n")).toContain(tampered.uuid);
  });
});

describe("a saved report replayed on another page", () => {
  const OLDER_BUILD = "5f1c0e9a7d2b4c6e8f0a1b3c5d7e9f1a2b4c6d8e";
  const CHUNK_ID = "147fc2df-e663-5d76-aa13-f67e1e894071";
  const CHUNK = "/_next/static/chunks/3u-6_1om1fv26.js";
  const BATCH_ID = "0196f0a1-0000-7000-9000-0000000000c0";
  const savedException = (version: string) => ({
    uuid: "0196f0a1-0000-7000-8000-0000000000c1",
    event: "$exception",
    timestamp: new Date().toISOString(),
    properties: {
      token: KEY,
      distinct_id: "0196f0a1-0000-7000-8000-00000000d15d",
      client_version: version,
      source: "react_error_boundary",
      boundary: "route",
      $exception_list: [
        {
          type: "TypeError",
          value: "[message withheld]",
          stacktrace: {
            type: "raw",
            frames: [{ platform: "web:javascript", function: "?", filename: CHUNK, lineno: 1, colno: 2, in_app: true, chunk_id: CHUNK_ID }],
          },
        },
      ],
    },
  });
  const save = (event: ReturnType<typeof savedException>) =>
    localStorage.setItem(`${STORED_BATCH_PREFIX}${BATCH_ID}`, JSON.stringify({ id: BATCH_ID, events: [event], oldestAt: Date.now(), sent: false }));
  const stored = () => JSON.parse(localStorage.getItem(`${STORED_BATCH_PREFIX}${BATCH_ID}`) ?? "null") as { attempt?: number; events: unknown[] } | null;
  const firstPosted = async () => {
    const body = JSON.parse(await new Response(fetches()[0].body).text()) as { batch: Array<{ properties: Record<string, unknown> }> };
    return body.batch[0].properties;
  };
  const firstFrame = (properties: Record<string, unknown>) =>
    (properties.$exception_list as Array<{ stacktrace: { frames: Array<Record<string, unknown>> } }>)[0].stacktrace.frames[0];

  it("keeps a saved exception's chunk frames when it replays before this build's chunk list has loaded", async () => {
    manifest = "pending";
    save(savedException(BUILD));
    const { startTelemetry } = await import("../src/app/lib/telemetry");
    startTelemetry();
    await vi.waitFor(() => expect(fetches().length).toBeGreaterThan(0));

    const properties = await firstPosted();
    expect(properties.client_version).toBe(BUILD);
    expect(firstFrame(properties)).toMatchObject({ filename: CHUNK, chunk_id: CHUNK_ID, lineno: 1, colno: 2 });
  });

  it("keeps a saved event's own build on a page of a newer one, and its stored copy as it was", async () => {
    manifest = "missing";
    ingestAnswers = [503];
    const original = savedException(OLDER_BUILD);
    save(original);
    const { startTelemetry } = await import("../src/app/lib/telemetry");
    startTelemetry();
    await vi.waitFor(() => expect(fetches().length).toBeGreaterThan(0));

    const properties = await firstPosted();
    expect(properties.client_version).toBe(OLDER_BUILD);
    expect(firstFrame(properties)).toMatchObject({ filename: CHUNK, chunk_id: CHUNK_ID });
    await vi.waitFor(() => expect(stored()?.attempt).toBe(1));
    expect(stored()?.events).toEqual([original]);
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
