"use client";

import type { PostHog } from "posthog-js";
import { installCallErrorCapture } from "./call-error-capture";
import {
  chunkManifestUrl,
  isStoredProperty,
  parseChunkManifest,
  scrubTelemetryEvent,
} from "./telemetry-privacy";

export type TelemetryProps = Record<string, unknown>;

export type TelemetryCaptureOptions = {
  /** Send now with sendBeacon; for events captured while the page unloads. */
  immediate?: boolean;
};

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
// Events go to /ingest on our own site (app/ingest), which scrubs them again
// and forwards them to PostHog without the browser's headers.
const INGEST_PATH = "/ingest";
const clientVersion = process.env.NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION;

/** False without a project key, and in `next dev` unless someone opts in. */
export const telemetryEnabled =
  Boolean(posthogKey) &&
  (process.env.NODE_ENV === "production" ||
    process.env.NEXT_PUBLIC_POSTHOG_DEV === "1");

// Reports made while posthog-js loads, such as an error boundary that fires
// on the first render. Capped so a failing load cannot grow it.
const MAX_QUEUED = 50;

/** Sends one report; `closing` when the page is going away. */
type Delivery = (posthog: PostHog, closing: boolean) => void;

// posthog-js merges local storage, then session storage, into every event.
// Storage keeps only the SDK's own ids; anything else, such as a value a
// script seeded there, is removed from both on load.
const dropStoredProperties = (client: PostHog): void => {
  for (const key of Object.keys(client.persistence?.properties() ?? {})) {
    if (!isStoredProperty(key)) client.unregister(key);
  }
  for (const key of Object.keys(client.sessionPersistence?.properties() ?? {})) {
    if (!isStoredProperty(key)) client.unregister_for_session(key);
  }
};

const storedKeys = (client: PostHog): Set<string> =>
  new Set([
    ...Object.keys(client.persistence?.properties() ?? {}),
    ...Object.keys(client.sessionPersistence?.properties() ?? {}),
  ]);

// The payload of the capture in progress. posthog-js calls before_send inside
// capture, so the scrubber takes our fields from here, never from what storage
// merged into the event. An event the SDK raised itself has none.
let emitting: TelemetryProps | null = null;

// This build's chunk ids by file. Until it loads, and in a build with no
// injected chunks, chunk frames keep no path.
let chunkFiles: ReadonlyMap<string, string> = new Map();

const loadChunkManifest = async (): Promise<void> => {
  const url = chunkManifestUrl(clientVersion);
  if (!url) return;
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (response.ok) chunkFiles = parseChunkManifest(await response.json());
  } catch {}
};

// Reports made before the manifest has loaded wait for it this long, so a
// first-render error keeps its chunk paths; past it they go without, and the
// manifest still applies to later reports once it arrives.
const MANIFEST_WAIT_MS = 3000;

const manifestOrTimeout = (): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, MANIFEST_WAIT_MS);
    void loadChunkManifest().finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });

const emit = (payload: TelemetryProps | undefined, capture: () => void): void => {
  const outer = emitting;
  emitting = payload ?? {};
  try {
    capture();
  } finally {
    emitting = outer;
  }
};

let posthog: PostHog | null = null;
let queue: Delivery[] | null = null;

const deliver = (client: PostHog, delivery: Delivery, closing = false): void => {
  try {
    delivery(client, closing);
  } catch {
  }
};

// Reports held once PostHog has loaded, until the chunk manifest is in.
let held: { client: PostHog; pending: Delivery[] } | null = null;

/** Sends the held reports now; `closing` when the page is going away. */
const releaseHeld = (closing: boolean): void => {
  const current = held;
  if (!current) return;
  held = null;
  queue = null;
  posthog = current.client;
  current.pending.forEach((delivery) => deliver(current.client, delivery, closing));
};

// The page can close, or be hidden and then dropped, while reports are held:
// they go out at once, with whatever manifest has loaded (none leaves chunk
// frames as [path]). These listen in the capture phase so they run before
// posthog-js's own pagehide handler, which sends its queue by beacon.
const onPageHide = (): void => releaseHeld(true);
const onVisibilityChange = (): void => {
  if (document.visibilityState === "hidden") releaseHeld(true);
};

const initPostHog = (client: PostHog, key: string): void => {
  client.init(key, {
    api_host: INGEST_PATH,
    ui_host: "https://eu.posthog.com",
    capture_pageview: false,
    capture_pageleave: false,
    autocapture: false,
    disable_session_recording: true,
    disable_surveys: true,
    advanced_disable_flags: true,
    disable_external_dependency_loading: true,
    save_campaign_params: false,
    person_profiles: "identified_only",
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    before_send: (event) =>
      event &&
      scrubTelemetryEvent(event, {
        payload: emitting,
        storedKeys: storedKeys(client),
        clientVersion,
        chunkFiles,
      }),
  });
  dropStoredProperties(client);
  // Through send, so a call failure logged while reports are held waits too.
  installCallErrorCapture((error, props) => {
    send((ready) => emit(props, () => ready.captureException(error, props)));
  });
};

/**
 * Loads PostHog once for the page's lifetime. Every report starts it too, so
 * an error boundary that replaced the root layout can still send. PostHog's
 * own error capture starts as soon as it loads; our reports are held until
 * the chunk manifest has loaded too, or MANIFEST_WAIT_MS has passed, and each
 * is scrubbed once, when it is sent.
 */
export function startTelemetry(): void {
  if (posthog || queue || !posthogKey || !telemetryEnabled) return;
  if (typeof window === "undefined") return;
  const pending: Delivery[] = [];
  queue = pending;
  const manifestReady = manifestOrTimeout();
  void Promise.all([
    import("posthog-js"),
    import("posthog-js/dist/exception-autocapture"),
  ])
    .then(async ([{ default: client }]) => {
      initPostHog(client, posthogKey);
      held = { client, pending };
      window.addEventListener("pagehide", onPageHide, { capture: true });
      document.addEventListener("visibilitychange", onVisibilityChange, { capture: true });
      await manifestReady;
      releaseHeld(false);
    })
    .catch(() => {})
    .finally(() => {
      window.removeEventListener("pagehide", onPageHide, { capture: true });
      document.removeEventListener("visibilitychange", onVisibilityChange, { capture: true });
      queue = null;
    });
}

const send = (delivery: Delivery): void => {
  if (posthog) {
    deliver(posthog, delivery);
    return;
  }
  startTelemetry();
  if (queue && queue.length < MAX_QUEUED) queue.push(delivery);
};

export const telemetry = {
  capture(
    event: string,
    props?: TelemetryProps,
    options?: TelemetryCaptureOptions,
  ): void {
    send((client, closing) => {
      emit(props, () =>
        client.capture(
          event,
          props,
          options?.immediate || closing
            ? { transport: "sendBeacon", send_instantly: true }
            : undefined,
        ),
      );
    });
  },
  captureException(error: unknown, props?: TelemetryProps): void {
    send((client) => {
      emit(props, () => client.captureException(error, props));
    });
  },
};
