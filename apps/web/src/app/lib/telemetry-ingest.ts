import { z } from "zod";
import {
  buildOutboundEvent,
  chunkManifestUrl,
  isBuildVersion,
  type OutboundEvent,
  parseChunkManifest,
} from "./telemetry-privacy";
import type { IngestAdmission } from "./ingest-rate-limit";
import { answerOf } from "./telemetry-answers";
import { createOutboundSchemas, MAX_EVENT_AGE_MS, UNKNOWN_BUILD } from "./telemetry-schema";

/**
 * The browser's PostHog traffic goes through /ingest on our own site, so the
 * browser's User-Agent, IP address and cookies never reach PostHog, and every
 * event is built here again from the outbound schema rather than trusting the
 * browser's before_send.
 */

/** The capture endpoints posthog-js uses with our config: events only. */
const ENDPOINTS = new Set(["e"]);
const MAX_BODY_BYTES = 256 * 1024;
const MAX_DECODED_BYTES = 1024 * 1024;
const MAX_EVENTS = 200;

/** The only User-Agent PostHog sees from the browser's traffic. */
export const INGEST_USER_AGENT = "conclave-web-ingest/1";

/**
 * Where /ingest forwards to: POSTHOG_INGEST_HOST, else the
 * NEXT_PUBLIC_POSTHOG_HOST a deployment set before /ingest existed, as an
 * http(s) origin. Null when neither is set, or neither is a URL: then nothing
 * is forwarded, rather than to a collector the deployment never chose.
 */
export const ingestHostFrom = (env: {
  POSTHOG_INGEST_HOST?: string;
  NEXT_PUBLIC_POSTHOG_HOST?: string;
}): string | null => {
  const configured = env.POSTHOG_INGEST_HOST?.trim() || env.NEXT_PUBLIC_POSTHOG_HOST?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === "https:" || url.protocol === "http:" ? configured.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
};

// The content types posthog-js sends: plain JSON, a gzip body as text/plain,
// and a base64 `data=` form.
const CONTENT_TYPES = new Set(["application/json", "text/plain", "application/x-www-form-urlencoded"]);

const mediaType = (request: Request): string =>
  (request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();

export type IngestDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** PostHog's ingestion host (ingestHostFrom), or null: forward nothing. */
  ingestHost: string | null;
  /** Our project key: events for any other project are not relayed. */
  projectKey: string;
  /** The build this deployment serves. */
  currentBuild: string | undefined;
  /**
   * The chunk manifest of a build, by its version (the event's
   * client_version), or null when this deployment has none for it: a build
   * it did not ship.
   */
  manifest: (version: string) => Promise<ReadonlyMap<string, string> | null>;
  /** Our site's origin: a frame of a script served from any other names no file. */
  siteOrigin: string;
  now: () => number;
  /** The events this process forwarded, by uuid (createForwardedEvents). */
  forwarded: ForwardedEvents;
  admit: (request: Request) => Promise<IngestAdmission>;
};

// How far ahead of when we received it an event's time may be: a browser
// clock a little ahead is fine. The outbox sends nothing older than
// MAX_EVENT_AGE_MS.
const MAX_EVENT_LEAD_MS = 60_000;
const MAX_FORWARDED_EVENTS = 10_000;
const MAX_FORWARDED_BYTES = 4 * 1024 * 1024;

type ForwardedEvent = OutboundEvent & { timestamp: string };

export type ForwardedEvents = {
  get: (uuid: string) => { event: ForwardedEvent; delivered: boolean } | undefined;
  remember: (event: ForwardedEvent) => void;
  /** PostHog took these events. */
  delivered: (uuids: readonly string[]) => void;
};

/**
 * The events this process forwarded, by uuid, the most recent 10,000 within
 * 4 MB: a retry of one is forwarded exactly as the first delivery was,
 * timestamp included, without being built again, and one PostHog already
 * took is not forwarded again.
 */
export const createForwardedEvents = (): ForwardedEvents => {
  const events = new Map<string, { event: ForwardedEvent; bytes: number; delivered: boolean }>();
  let total = 0;
  return {
    get: (uuid) => events.get(uuid),
    delivered(uuids) {
      for (const uuid of uuids) {
        const known = events.get(uuid);
        if (known) known.delivered = true;
      }
    },
    remember(event) {
      if (events.has(event.uuid)) return;
      const bytes = JSON.stringify(event).length;
      events.set(event.uuid, { event, bytes, delivered: false });
      total += bytes;
      while (events.size > MAX_FORWARDED_EVENTS || total > MAX_FORWARDED_BYTES) {
        const [uuid, oldest] = events.entries().next().value as [string, { bytes: number }];
        events.delete(uuid);
        total -= oldest.bytes;
      }
    },
  };
};

// The parts of an exception posthog-js sends that the scrubber reads, typed
// as posthog-js writes them; anything else in an entry or frame is dropped.
const CapturedFrame = z.object({
  filename: z.string().max(4096).optional(),
  lineno: z.number().optional(),
  colno: z.number().optional(),
  in_app: z.boolean().optional(),
  chunk_id: z.string().max(64).optional(),
});
const CapturedException = z.object({
  type: z.string().max(256).optional(),
  value: z.string().max(16_384).optional(),
  mechanism: z
    .object({
      type: z.string().max(64).optional(),
      handled: z.boolean().optional(),
      synthetic: z.boolean().optional(),
      exception_id: z.number().optional(),
      parent_id: z.number().optional(),
    })
    .optional(),
  stacktrace: z
    .object({ type: z.string().max(64).optional(), frames: z.array(CapturedFrame).max(500) })
    .optional(),
});

const CapturedEvent = z.object({
  uuid: z.uuid().optional(),
  event: z.string().min(1).max(200),
  timestamp: z.string().max(64).optional(),
  properties: z
    .object({ $exception_list: z.array(CapturedException).max(50).optional() })
    .catchall(z.unknown()),
});
type CapturedEvent = z.infer<typeof CapturedEvent>;

const CaptureBody = z.union([
  z.object({
    batch: z.array(CapturedEvent).max(MAX_EVENTS),
    sent_at: z.string().max(64).optional(),
  }),
  z.array(CapturedEvent).max(MAX_EVENTS),
  CapturedEvent,
]);


class Refused extends Error {
  constructor(readonly status: number) {
    super(`refused with ${status}`);
  }
}

/** Reads a stream, refusing it once it passes `limit` bytes. */
const readLimited = async (
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream?.getReader();
  if (!reader) return new Uint8Array();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Refused(413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const fromBase64 = (text: string): Uint8Array => {
  try {
    return Uint8Array.from(atob(text.trim()), (char) => char.charCodeAt(0));
  } catch {
    throw new Refused(400);
  }
};

/**
 * The JSON posthog-js sent, in whichever of its encodings: gzip (found by its
 * magic bytes, as posthog-js drops the query flag for it), base64 as a beacon
 * body or a `data=` form field, or plain JSON.
 */
const decodeBody = async (request: Request, url: URL): Promise<unknown> => {
  const type = mediaType(request);
  if (!CONTENT_TYPES.has(type)) throw new Refused(400);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Refused(413);
  let bytes = await readLimited(request.body, MAX_BODY_BYTES);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = await readLimited(stream, MAX_DECODED_BYTES).catch((error: unknown) => {
      throw error instanceof Refused ? error : new Refused(400);
    });
  }
  let text = new TextDecoder().decode(bytes);
  const form = type === "application/x-www-form-urlencoded";
  if (form) text = new URLSearchParams(text).get("data") ?? "";
  if (form || url.searchParams.get("compression") === "base64") {
    const decoded = fromBase64(text);
    if (decoded.byteLength > MAX_DECODED_BYTES) throw new Refused(413);
    text = new TextDecoder().decode(decoded);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Refused(400);
  }
};

/** The build an event says it came from, when its client_version names one. */
const buildOf = (event: CapturedEvent): string | null =>
  isBuildVersion(event.properties.client_version) ? event.properties.client_version : null;

const timeOf = (value: unknown): number | null => {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
};

/** When the browser sent the request, by its own clock: posthog-js's query flag or the body's. */
const clientSentAt = (url: URL, body: unknown): number | null => {
  const query = url.searchParams.get("sent_at");
  if (query && /^\d{1,15}$/.test(query)) return Number(query);
  return body !== null && typeof body === "object" && "sent_at" in body ? timeOf(body.sent_at) : null;
};

/**
 * A new event's time: the browser's own when it lies within MAX_EVENT_AGE_MS
 * before we received it (or a minute after). Otherwise a skewed or made-up
 * clock moves nothing: the event is as old as the browser says it was when
 * sent, at most MAX_EVENT_AGE_MS, or with no send time, held to that window.
 * A retry never comes here: it is forwarded as its first delivery was.
 */
const eventTime = (timestamp: unknown, sentAt: number | null, receivedAt: number): string => {
  const time = timeOf(timestamp);
  if (time !== null && time >= receivedAt - MAX_EVENT_AGE_MS && time <= receivedAt + MAX_EVENT_LEAD_MS) {
    return new Date(time).toISOString();
  }
  const at =
    time === null
      ? receivedAt
      : sentAt === null
        ? Math.min(Math.max(time, receivedAt - MAX_EVENT_AGE_MS), receivedAt)
        : receivedAt - Math.min(Math.max(sentAt - time, 0), MAX_EVENT_AGE_MS);
  return new Date(at).toISOString();
};

const reply = (status: number, retryAfterMs: number | null = null) =>
  new Response(status === 200 ? '{"status":1}' : null, {
    status,
    headers: {
      ...(status === 200 ? { "content-type": "application/json" } : {}),
      ...(retryAfterMs !== null ? { "retry-after": String(Math.ceil(retryAfterMs / 1000)) } : {}),
    },
  });

// How long /ingest waits for PostHog, and for one of our own chunk
// manifests, body included: a server that holds a response open must not
// hold every report waiting on it.
export const UPSTREAM_DEADLINE_MS = 10_000;
export const MANIFEST_DEADLINE_MS = 2000;

class DeadlinePassed extends Error {}

/**
 * Runs one outbound request, its body read included, with a signal that
 * aborts at the deadline; it rejects then even if the request ignores it.
 */
const withinDeadline = <T>(ms: number, request: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const passed = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DeadlinePassed());
    }, ms);
  });
  return Promise.race([request(controller.signal), passed]).finally(() => clearTimeout(timer));
};

/**
 * Handles one request to /ingest/<path>: decodes the capture body, scrubs
 * each event for our project again, and forwards the batch to PostHog as
 * plain JSON with a fixed User-Agent and no header of the browser's.
 */
export async function forwardCapture(
  request: Request,
  path: string[],
  deps: IngestDeps,
): Promise<Response> {
  if (path.length !== 1 || !ENDPOINTS.has(path[0])) return reply(404);
  if (request.method !== "POST") return reply(405);
  if (!deps.projectKey) return reply(404);
  const { ingestHost } = deps;
  if (!ingestHost) return reply(503);
  const admission = await deps.admit(request);
  if (!admission.ok) return reply(admission.status, admission.retryAfterMs);
  let prepared: Awaited<ReturnType<typeof prepareForward>>;
  try {
    prepared = await prepareForward(request, deps);
  } catch (error) {
    // Nothing in a refused body would pass on a retry, and the reply does
    // not say what was wrong with it.
    return reply(error instanceof Refused ? error.status : 400);
  }
  // Every event in it already reached PostHog: a page sending what it saved
  // as it went away, or a beacon's batch again.
  if (!prepared) return reply(200);
  let upstream: { status: number; retryAfter: string | null };
  try {
    upstream = await withinDeadline(UPSTREAM_DEADLINE_MS, async (signal) => {
      const response = await deps.fetch(`${ingestHost}/e/`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": INGEST_USER_AGENT },
        body: JSON.stringify(prepared),
        redirect: "manual",
        signal,
      });
      // Nothing in PostHog's body is read: the connection can go.
      await response.body?.cancel().catch(() => {});
      return { status: response.status, retryAfter: response.headers.get("retry-after") };
    });
  } catch {
    return reply(503);
  }
  // PostHog's answer, through the table the browser's outbox reads ours by.
  const answer = answerOf(upstream.status, upstream.retryAfter, deps.now());
  if (answer.outcome === "delivered") {
    deps.forwarded.delivered(prepared.batch.map((event) => event.uuid));
    return reply(200);
  }
  return answer.outcome === "retry" ? reply(503, answer.afterMs) : reply(400);
}

/**
 * The batch to send PostHog for one request; null when PostHog already took
 * every event in it, or a Refused error.
 */
const prepareForward = async (request: Request, deps: IngestDeps) => {
  const receivedAt = deps.now();
  const url = new URL(request.url);
  const decoded = await decodeBody(request, url);
  const parsed = CaptureBody.safeParse(decoded);
  if (!parsed.success) throw new Refused(400);
  const body = parsed.data;
  const events = Array.isArray(body) ? body : "batch" in body ? body.batch : [body];
  const ours = events.filter((event) => event.properties.token === deps.projectKey);
  if (ours.length === 0) throw new Refused(400);
  // A batch holds one tab's events, so a request carries one build:
  // the first event's. Events naming any other build are dropped, which holds
  // a request to at most one manifest lookup. A tab can still run an older
  // build than the one deployed, so that build's own manifest is used, and a
  // build is named only when this deployment shipped it: the one it serves,
  // or one whose manifest it still has.
  const build = buildOf(ours[0]);
  const sameBuild = ours.filter((event) => buildOf(event) === build);
  const manifest = build ? await deps.manifest(build) : null;
  const shipped = build !== null && (build === deps.currentBuild || manifest !== null);
  const context = {
    token: deps.projectKey,
    clientVersion: shipped ? build : UNKNOWN_BUILD,
    chunkFiles: manifest ?? new Map<string, string>(),
  };
  const schemas = createOutboundSchemas(context);
  const sentAt = clientSentAt(url, decoded);
  const inRequest = new Set<string>();
  let delivered = 0;
  const batch = sameBuild.flatMap((event) => {
    const uuid = event.uuid ?? crypto.randomUUID();
    if (inRequest.has(uuid)) return [];
    inRequest.add(uuid);
    // A retry, or an event sent again, goes exactly as it went the first
    // time, and not at all once PostHog has it.
    const known = deps.forwarded.get(uuid);
    if (known?.delivered) delivered += 1;
    if (known) return known.delivered ? [] : [known.event];
    const built = buildOutboundEvent(
      { uuid, event: event.event, properties: event.properties },
      // Our fields are the event's own: the browser took them from the
      // capture's payload, and nothing here counts as stored.
      { ...context, payload: event.properties, storedKeys: new Set(), siteOrigin: deps.siteOrigin },
      schemas,
    );
    if (!built) return [];
    const forwarded = { ...built, timestamp: eventTime(event.timestamp, sentAt, receivedAt) };
    deps.forwarded.remember(forwarded);
    return [forwarded];
  });
  if (batch.length === 0) {
    if (delivered > 0) return null;
    throw new Refused(400);
  }
  return { api_key: deps.projectKey, batch };
};

const MANIFEST_TTL_MS = 10 * 60_000;
const MISSING_MANIFEST_TTL_MS = 60_000;
const MAX_MANIFESTS = 16;

/**
 * Loads a build's chunk manifest from our own static files, by the build's
 * version, and keeps the 16 most recently used, found or not; an older
 * build's tabs report against their own manifest, which `dpl` (the build's
 * deployment id) can reach while that build is still served. Concurrent
 * loads of one build share a fetch, which has MANIFEST_DEADLINE_MS, body
 * included. A load that fails or runs out of time gives the last manifest
 * read for that build. One it has never read is null: that build was not
 * shipped here, its frames keep no path or chunk id, and its events name no
 * build. A version that is not a build's is never fetched.
 */
export function createChunkManifestLoader({
  origin,
  fetch,
  now = Date.now,
}: {
  origin: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}): (version: string) => Promise<ReadonlyMap<string, string> | null> {
  type Manifest = ReadonlyMap<string, string> | null;
  const known = new Map<string, { files: Manifest; until: number }>();
  const loading = new Map<string, Promise<Manifest>>();

  const remember = (version: string, files: Manifest) => {
    known.delete(version);
    if (known.size >= MAX_MANIFESTS) known.delete(known.keys().next().value as string);
    known.set(version, { files, until: now() + (files ? MANIFEST_TTL_MS : MISSING_MANIFEST_TTL_MS) });
  };

  // A build's manifest never changes, so the last one read stands in for a
  // load that fails or passes its deadline.
  const fetchManifest = async (version: string, url: string): Promise<Manifest> => {
    let files: Manifest = null;
    try {
      files = await withinDeadline(MANIFEST_DEADLINE_MS, async (signal) => {
        const response = await fetch(`${origin}${url}?dpl=${version}`, {
          headers: { "user-agent": INGEST_USER_AGENT },
          signal,
        });
        return response.ok ? parseChunkManifest(await response.json()) : null;
      });
    } catch {}
    const loaded = files ?? known.get(version)?.files ?? null;
    remember(version, loaded);
    return loaded;
  };

  return (version) => {
    const url = chunkManifestUrl(version);
    if (!url) return Promise.resolve(null);
    const cached = known.get(version);
    if (cached && cached.until > now()) {
      known.delete(version);
      known.set(version, cached);
      return Promise.resolve(cached.files);
    }
    const inFlight = loading.get(version);
    if (inFlight) return inFlight;
    const load = fetchManifest(version, url).finally(() => loading.delete(version));
    loading.set(version, load);
    return load;
  };
}
