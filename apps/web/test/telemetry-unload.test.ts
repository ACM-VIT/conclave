// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forwardCapture } from "../src/app/lib/telemetry-ingest";

const BUILD = "0b2d3b480f4621392a4151d750c90965b7c8b76c";
const KEY = "phc_test_project";

type Beacon = { url: string; body: Blob };

let beacons: Beacon[] = [];

// The page's fetch of its chunk manifest, still pending.
let abortManifest: () => void = () => {};

beforeEach(() => {
  vi.resetModules();
  beacons = [];
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", KEY);
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_DEV", "1");
  vi.stubEnv("NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION", BUILD);
  vi.stubGlobal(
    "fetch",
    vi.fn((resource: unknown) =>
      String(resource).includes("posthog-chunk-ids")
        ? new Promise<Response>((_resolve, reject) => {
            abortManifest = () => reject(new TypeError("Failed to fetch"));
          })
        : Promise.resolve(new Response('{"status":1}', { status: 200 })),
    ),
  );
  // posthog-js drops every event from a browser that says it is automated.
  Object.defineProperty(navigator, "webdriver", { configurable: true, get: () => false });
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: (url: string | URL, body: Blob) => {
      beacons.push({ url: String(url), body });
      return true;
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** The events in the beacons sent so far, as /ingest decodes and forwards them. */
const beaconedEvents = async (sent: Beacon[]): Promise<string[]> => {
  const names: string[] = [];
  for (const beacon of sent) {
    const forwarded: string[] = [];
    await forwardCapture(
      new Request(new URL(beacon.url, "https://conclave.example"), {
        method: "POST",
        body: beacon.body,
        headers: { "content-type": beacon.body.type || "text/plain" },
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
      },
    );
    for (const body of forwarded) {
      names.push(...(JSON.parse(body) as { batch: Array<{ event: string }> }).batch.map((event) => event.event));
    }
  }
  return names;
};

const loadHeld = async () => {
  const { telemetry } = await import("../src/app/lib/telemetry");
  const { default: sdk } = await import("posthog-js");
  telemetry.captureException(new Error("first render"), { source: "react_error_boundary", boundary: "route" });
  telemetry.capture("meet_join_attempt", { joinMode: "meeting", isAdmin: false });
  await vi.waitFor(() => expect((sdk as unknown as { __loaded: boolean }).__loaded).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(beacons).toHaveLength(0);
};

describe("reports held for the chunk manifest when the page goes away", () => {
  it("sends a held exception by beacon when the tab is hidden", async () => {
    await loadHeld();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      document.dispatchEvent(new Event("visibilitychange"));
    } finally {
      visibility.mockRestore();
    }

    expect((await beaconedEvents(beacons)).sort()).toEqual(["$exception", "meet_join_attempt"]);
  });

  it("sends a held exception by beacon on pagehide, before posthog-js unloads its queue", async () => {
    await loadHeld();
    let beforeSdkUnload: Beacon[] = [];
    // Registered after telemetry's own listener, so it runs right after it.
    window.addEventListener("pagehide", () => (beforeSdkUnload = [...beacons]), { capture: true });

    window.dispatchEvent(new Event("pagehide"));

    expect((await beaconedEvents(beforeSdkUnload)).sort()).toEqual(["$exception", "meet_join_attempt"]);
  });

  it("sends held reports by beacon when navigating away aborts the manifest fetch first", async () => {
    await loadHeld();
    let beforeSdkUnload: Beacon[] = [];
    window.addEventListener("pagehide", () => (beforeSdkUnload = [...beacons]), { capture: true });

    // A browser aborts the page's fetches as it navigates, and runs the
    // rejection before telemetry's pagehide listener.
    abortManifest();
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.dispatchEvent(new Event("pagehide"));

    expect((await beaconedEvents(beforeSdkUnload)).sort()).toEqual(["$exception", "meet_join_attempt"]);
  });
});
