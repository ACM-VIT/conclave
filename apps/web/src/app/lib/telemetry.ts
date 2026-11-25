"use client";

import type { CaptureResult, PostHog } from "posthog-js";
import { installCallErrorCapture } from "./call-error-capture";
import { randomUuid } from "./random-uuid";
import { RejectedEvents } from "./telemetry-answers";
import { telemetryFetch } from "./telemetry-fetch";
import {
  countDropped,
  createBatchStore,
  createOutbox,
  MEMORY_ONLY_STORE,
  type Outbox,
  type OutboxDeps,
  type OutboxEvent,
  type Reply,
  SEND_DEADLINE_MS,
  STORED_BATCH_PREFIX,
} from "./telemetry-outbox";
import {
  beforeSend,
  buildOutboundEvent,
  chunkManifestUrl,
  type EventSource,
  isBuildVersion,
  isStoredProperty,
  parseChunkManifest,
} from "./telemetry-privacy";
import {
  type ExceptionProps,
  type TelemetryEventName,
  type TelemetryEventProps,
  UNKNOWN_BUILD,
} from "./telemetry-schema";

type TelemetryProps = Record<string, unknown>;

export type TelemetryCaptureOptions = {
  /** Send now with sendBeacon; for events captured while the page unloads. */
  immediate?: boolean;
};

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
// Events go to /ingest on our own site (app/ingest), which builds them again
// and forwards them to PostHog without the browser's headers.
const INGEST_PATH = "/ingest";
const buildVersion = process.env.NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION;
const clientVersion = isBuildVersion(buildVersion) ? buildVersion : UNKNOWN_BUILD;

/** False without a project key, and in `next dev` unless someone opts in. */
export const telemetryEnabled =
  Boolean(posthogKey) &&
  (process.env.NODE_ENV === "production" ||
    process.env.NEXT_PUBLIC_POSTHOG_DEV === "1");

/** One report our code made, kept as data until it can be sent. */
type Report =
  | { kind: "event"; name: TelemetryEventName; props: TelemetryProps; immediate: boolean; at: number }
  | { kind: "exception"; error: unknown; props: ExceptionProps; at: number };

/**
 * Where telemetry is in the page's life. Reports wait in `pending` while the
 * SDK downloads and, once it has loaded, until the chunk manifest has too;
 * then each goes straight to the SDK. The SDK only builds events: before_send
 * hands each one to the outbox (one it captured during that wait waits too),
 * so nothing is ever left queued in posthog-js.
 */
type Phase =
  | { name: "idle" }
  | { name: "loading"; pending: Report[] }
  | { name: "holding"; client: PostHog; pending: Report[] }
  | { name: "open"; client: PostHog }
  | { name: "failed" };

let phase: Phase = { name: "idle" };
let outbox: Outbox | null = null;

// True while reports are built for a page that is going away: they all go in
// the one beacon that follows, so an exception asks for no early send.
let buildingForUnload = false;

/** Builds reports with `build`, then sends the whole outbox by beacon. */
const sendForUnload = (build: () => void): void => {
  const outer = buildingForUnload;
  buildingForUnload = true;
  try {
    build();
  } finally {
    buildingForUnload = outer;
  }
  outbox?.flushForUnload();
};

// Capped so a load that never finishes cannot grow the queue.
const MAX_PENDING = 50;

type HeldEvent = { event: CaptureResult; source: Omit<EventSource, "chunkFiles">; at: number | null };
let awaitingChunks = true;
const heldEvents: HeldEvent[] = [];

const buildHeld = (chunks: ReadonlyMap<string, string> | null): void => {
  for (const { event, source, at } of heldEvents.splice(0)) {
    const built = beforeSend(event, { ...source, chunkFiles: chunks });
    if (built) queueBuilt(built, at);
  }
};

const REPLAY_LOCK = "conclave:telemetry:replay";

const outboxStorage = (): Pick<OutboxDeps, "store" | "lock"> => {
  const locks = typeof navigator === "undefined" ? null : (navigator.locks ?? null);
  if (!locks) return { store: MEMORY_ONLY_STORE, lock: (run) => void run() };
  return {
    store: createBatchStore(() => localStorage),
    lock: (run) => locks.request(REPLAY_LOCK, run),
  };
};

// The page has started to go away: pagehide until a pageshow brings it back,
// freeze until it resumes, or hidden.
let unloading = false;
let frozen = false;
const leaving = (): boolean => unloading || frozen || document.visibilityState === "hidden";

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
let emittingAt: number | null = null;

// This build's chunk ids by file, null until it loads. A report built before
// then keeps no chunk path; a saved one resent keeps its own for /ingest.
let chunkFiles: ReadonlyMap<string, string> | null = null;
const NO_CHUNKS: ReadonlyMap<string, string> = new Map();

// Rejects when the request gets no answer: a network failure, or the page
// navigating away.
const loadChunkManifest = async (): Promise<void> => {
  const url = chunkManifestUrl(clientVersion);
  if (!url) return;
  const response = await telemetryFetch(url, { deadlineMs: MANIFEST_WAIT_MS });
  if (!response.ok) return;
  try {
    chunkFiles = parseChunkManifest(await response.json()) ?? chunkFiles;
  } catch {}
};

// Reports made before the manifest has loaded wait for it this long, so a
// first-render error keeps its chunk paths; past it they go without, and the
// manifest still applies to later reports once it arrives. Only an answer
// ends the wait early. A page that navigates away aborts the fetch before
// the pagehide listener runs, and that rejection must not send the held
// reports as if the page stayed: the listener sends them, by beacon.
const MANIFEST_WAIT_MS = 5000;

const manifestOrTimeout = (): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, MANIFEST_WAIT_MS);
    loadChunkManifest().then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {},
    );
  });

const emit = (payload: TelemetryProps, at: number, capture: () => void): void => {
  const [outer, outerAt] = [emitting, emittingAt];
  [emitting, emittingAt] = [payload, at];
  try {
    capture();
  } finally {
    [emitting, emittingAt] = [outer, outerAt];
  }
};

/** Has the SDK build one report, which before_send puts in the outbox. */
const buildWithSdk = (client: PostHog, report: Report): void => {
  try {
    emit(report.props, report.at, () => {
      if (report.kind === "event") client.capture(report.name, report.props);
      else client.captureException(report.error, report.props);
    });
  } catch {}
};

// A report that must go now, as a call summary captured while the page
// unloads does.
const isImmediate = (report: Report): boolean => report.kind === "event" && report.immediate;

const queueBuilt = (built: CaptureResult, at: number | null): void => {
  const own: unknown = built.timestamp;
  const timestamp =
    at !== null
      ? new Date(at).toISOString()
      : own instanceof Date
        ? own.toISOString()
        : typeof own === "string"
          ? own
          : new Date().toISOString();
  const event: OutboxEvent = { uuid: built.uuid, event: built.event, properties: built.properties, timestamp };
  outbox?.add(event, { urgent: built.event === "$exception", deferred: buildingForUnload });
};

const storedDistinctId = (key: string): string | null => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(`ph_${key}_posthog`) ?? "null");
    const id = stored !== null && typeof stored === "object" && "distinct_id" in stored ? stored.distinct_id : null;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
};

/**
 * Puts reports in the outbox without the SDK, for a page going away before
 * it has loaded (or one whose SDK failed to load): each event is built from
 * the outbound schema with the fields we can vouch for ourselves. An
 * exception keeps its type and, for a call-log label, its message, but no
 * frames, which only the SDK can read.
 */
const queueWithoutSdk = (reports: Report[]): void => {
  if (!posthogKey || reports.length === 0) return;
  const distinctId = storedDistinctId(posthogKey) ?? randomUuid();
  const source = {
    storedKeys: new Set<string>(),
    token: posthogKey,
    clientVersion,
    chunkFiles: chunkFiles ?? NO_CHUNKS,
    siteOrigin: window.location.origin,
  };
  const batch = reports.flatMap((report) => {
    const exception =
      report.kind === "exception"
        ? {
            $exception_level: "error",
            $exception_list: [
              {
                type: report.error instanceof Error ? report.error.name : undefined,
                mechanism: { type: "generic", handled: true },
              },
            ],
          }
        : {};
    const built = buildOutboundEvent(
      {
        uuid: randomUuid(),
        event: report.kind === "event" ? report.name : "$exception",
        properties: { distinct_id: distinctId, ...exception },
      },
      { ...source, payload: report.props },
    );
    return built ? [{ ...built, timestamp: new Date(report.at).toISOString() }] : [];
  });
  for (const event of batch) outbox?.add(event, { urgent: event.event === "$exception", deferred: buildingForUnload });
};

/**
 * Builds every pending report through the SDK, and from now on each report
 * straight away; when the page is going away they all go in one beacon.
 */
const open = (client: PostHog, closing: boolean): void => {
  const pending = phase.name === "holding" ? phase.pending : [];
  phase = { name: "open", client };
  const build = () => pending.forEach((report) => buildWithSdk(client, report));
  if (closing || pending.some(isImmediate)) sendForUnload(build);
  else build();
};

// The page is going away, or may be dropped while hidden or frozen: every
// pending report and the whole outbox go now, by beacon. With the SDK loaded
// the reports are built through it, and during the wait for the manifest a
// chunk frame goes as it is, for /ingest to check; before it has, without it.
// A report is sent once: this empties every queue.
const flushForLifecycle = (): void => {
  sendForUnload(() => {
    if (awaitingChunks) buildHeld(null);
    if (phase.name === "holding") open(phase.client, true);
    else if (phase.name === "loading") queueWithoutSdk(phase.pending.splice(0));
  });
};

// For the page's whole life, from before the SDK downloads, never removed.
// They listen in the capture phase so they run before posthog-js's own.
const installLifecycleFlush = (): void => {
  window.addEventListener(
    "pagehide",
    () => {
      unloading = true;
      flushForLifecycle();
    },
    { capture: true },
  );
  // A page back in view sends what it saved as it went, and any other tab's.
  const returned = () => {
    if (!leaving()) outbox?.replaySaved();
  };
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key.startsWith(STORED_BATCH_PREFIX)) outbox?.replaySaved();
  });
  window.addEventListener(
    "pageshow",
    () => {
      unloading = false;
      returned();
    },
    { capture: true },
  );
  document.addEventListener(
    "resume",
    () => {
      frozen = false;
      returned();
    },
    { capture: true },
  );
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") flushForLifecycle();
      else returned();
    },
    { capture: true },
  );
  document.addEventListener(
    "freeze",
    () => {
      frozen = true;
      flushForLifecycle();
    },
    { capture: true },
  );
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
    // posthog-js only builds events: each goes to the outbox, never out
    // through the SDK's own requests.
    before_send: (event) => {
      if (!event) return null;
      const source = {
        payload: emitting,
        storedKeys: storedKeys(client),
        token: key,
        clientVersion,
        siteOrigin: window.location.origin,
      };
      if (awaitingChunks && !buildingForUnload && !leaving()) {
        if (heldEvents.length < MAX_PENDING) heldEvents.push({ event, source, at: emittingAt });
        return null;
      }
      const built = beforeSend(event, { ...source, chunkFiles: awaitingChunks ? null : (chunkFiles ?? NO_CHUNKS) });
      if (built) queueBuilt(built, emittingAt);
      return null;
    },
  });
  dropStoredProperties(client);
};

const keepaliveRequests = (): boolean => {
  try {
    return new Request(window.location.origin, { keepalive: true }).keepalive === true;
  } catch {
    return false;
  }
};

const ingestRequest = (body: string, keepalive: boolean, signal?: AbortSignal): Promise<Response> =>
  telemetryFetch(`${INGEST_PATH}/e/`, {
    method: "POST",
    body,
    keepalive,
    signal,
    deadlineMs: SEND_DEADLINE_MS,
    headers: { "content-type": "application/json" },
  });

const replyOf = async (response: Response): Promise<Reply> => {
  const answer = RejectedEvents.safeParse(await response.json().catch(() => null));
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    rejected: answer.success ? answer.data.rejected : [],
  };
};

const rebuilt = (key: string) => (event: OutboxEvent): OutboxEvent | null => {
  const own = event.properties.client_version;
  const build = isBuildVersion(own) ? own : UNKNOWN_BUILD;
  const built = buildOutboundEvent(
    { uuid: event.uuid, event: event.event, properties: event.properties },
    {
      storedKeys: new Set(),
      token: key,
      clientVersion: build,
      chunkFiles: build === clientVersion ? chunkFiles : null,
      siteOrigin: window.location.origin,
      payload: event.properties,
    },
  );
  return built ? { ...built, ...(event.timestamp ? { timestamp: event.timestamp } : {}) } : null;
};

/**
 * Starts telemetry once for the page's lifetime: the lifecycle flush at once,
 * then the SDK and the chunk manifest. Every report starts it too, so an
 * error boundary that replaced the root layout can still send. PostHog's own
 * error capture starts as soon as it loads; its reports and ours wait until
 * the manifest has loaded too, or MANIFEST_WAIT_MS has passed, and each is built
 * when it is sent, and again at every later send.
 */
export function startTelemetry(): void {
  if (phase.name !== "idle" || !posthogKey || !telemetryEnabled) return;
  if (typeof window === "undefined") return;
  phase = { name: "loading", pending: [] };
  const unloadRequests = keepaliveRequests();
  outbox = createOutbox({
    token: posthogKey,
    now: Date.now,
    setTimer: (run, ms) => window.setTimeout(run, ms),
    clearTimer: (timer) => window.clearTimeout(timer as number),
    post: (body, keepalive, signal) => ingestRequest(body, keepalive, signal).then(replyOf),
    beacon: (body) => {
      if (!unloadRequests) return null;
      try {
        return ingestRequest(body, true).then(replyOf, () => null);
      } catch {
        return null;
      }
    },
    shape: rebuilt(posthogKey),
    newId: randomUuid,
    ...outboxStorage(),
    onStale: (dropped) => telemetry.capture("telemetry_reports_dropped", countDropped(dropped)),
  });
  outbox.replaySaved();
  installLifecycleFlush();
  const manifestReady = manifestOrTimeout().then(() => {
    awaitingChunks = false;
    buildHeld(chunkFiles ?? NO_CHUNKS);
  });
  void Promise.all([
    import("posthog-js"),
    import("posthog-js/dist/exception-autocapture"),
  ]).then(
    async ([{ PostHog: Client }]) => {
      // Our own instance, never the module's shared one.
      const client = new Client();
      initPostHog(client, posthogKey);
      phase = { name: "holding", client, pending: phase.name === "loading" ? phase.pending : [] };
      await manifestReady;
      if (phase.name === "holding") open(client, leaving());
    },
    () => {
      const pending = phase.name === "loading" ? phase.pending : [];
      phase = { name: "failed" };
      queueWithoutSdk(pending);
    },
  );
}

const report = (next: Report): void => {
  if (!telemetryEnabled || typeof window === "undefined") return;
  startTelemetry();
  // Once the page has started to go away, and for a report that must go now,
  // nothing waits for a timer, the SDK or the manifest: it goes out at once
  // by unload transport, whatever state telemetry is in.
  const now = leaving() || isImmediate(next);
  switch (phase.name) {
    case "open": {
      const { client } = phase;
      if (now) sendForUnload(() => buildWithSdk(client, next));
      else buildWithSdk(client, next);
      return;
    }
    case "holding":
      if (now || phase.pending.length < MAX_PENDING) phase.pending.push(next);
      if (now) flushForLifecycle();
      return;
    case "loading":
      if (now) sendForUnload(() => queueWithoutSdk([next]));
      else if (phase.pending.length < MAX_PENDING) phase.pending.push(next);
      return;
    case "failed":
      if (now) sendForUnload(() => queueWithoutSdk([next]));
      else queueWithoutSdk([next]);
      return;
    case "idle":
      return;
  }
};

const captureException = (error: unknown, props: ExceptionProps): void =>
  report({ kind: "exception", error, props, at: Date.now() });

// Installed as this module loads, before the SDK downloads, so a call failure
// logged at any point is queued like any other report.
installCallErrorCapture(captureException);

export const telemetry = {
  capture<N extends TelemetryEventName>(
    event: N,
    props: TelemetryEventProps<N>,
    options?: TelemetryCaptureOptions,
  ): void {
    report({ kind: "event", name: event, props, immediate: options?.immediate ?? false, at: Date.now() });
  },
  captureException,
};
