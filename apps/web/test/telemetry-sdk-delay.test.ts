// @vitest-environment happy-dom
// posthog-js keeps one instance for the module's life, which vi.resetModules
// does not reset, so only a file's first test initialises it with that test's
// before_send. This test checks the fields an event carries, so it has the
// file to itself.
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
            manifest: async () => null,
        siteOrigin: "https://conclave.example",
        now: () => Date.now(),
        forwarded: createForwardedEvents(),
        admit: async () => ({ ok: true }),
      },
    );
    for (const body of forwarded) events.push(...(JSON.parse(body) as { batch: Event_[] }).batch);
  }
  return events;
};
const names = async (list?: Sent[]) => (await sentEvents(list)).map((event) => event.event).sort();

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

describe("a report made while the SDK downloads", () => {
  it("queues a failed join logged while the SDK downloads, and sends it once it has loaded", async () => {
    holdSdk();
    manifest = "missing";
    const { telemetry } = await import("../src/app/lib/telemetry");
    const { logCallError } = await import("../src/app/lib/call-error-capture");
    telemetry.capture("meet_join_failure", { joinMode: "meeting", failure_reason: "room_not_found" });
    logCallError("[Meets] Error joining room", new Error("Meet Mira is not in this room"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(0);

    sdk.release();
    await loaded();
    await vi.waitFor(async () => expect(await names()).toEqual(["$exception", "meet_join_failure"]));

    const exception = (await sentEvents()).find((event) => event.event === "$exception");
    expect(exception?.properties).toMatchObject({ source: "call_log", call_log: "[Meets] Error joining room" });
    expect(JSON.stringify(await sentEvents())).not.toContain("Meet Mira");
  });

});
