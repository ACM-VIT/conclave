import { z } from "zod";
import {
  buildOutboundEvent,
  chunkManifestUrl,
  isBuildVersion,
  type OutboundEvent,
  parseChunkManifest,
} from "./telemetry-privacy";
import type { IngestAdmission } from "./ingest-rate-limit";
import { type Answer, answerOf } from "./telemetry-answers";
import { createOutboundSchemas, isOutboundEventName, MAX_EVENT_AGE_MS, UNKNOWN_BUILD } from "./telemetry-schema";

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

export type Claim =
  | { kind: "delivered" }
  | { kind: "elsewhere"; outcome: Promise<Answer> }
  | { kind: "own"; event: ForwardedEvent };

export type ForwardedEvents = {
  get: (uuid: string) => { event: ForwardedEvent; delivered: boolean } | undefined;
  /** PostHog took these events. */
  delivered: (uuids: readonly string[]) => void;
  claim: (candidates: readonly ForwardedEvent[], outcome: Promise<Answer>) => Claim[];
};

/**
 * The events this process forwarded, by uuid, the most recent 10,000 within
 * 4 MB: a retry of one is forwarded exactly as the first delivery was,
 * timestamp included, without being built again, and one PostHog already
 * took is not forwarded again.
 */
export const createForwardedEvents = (): ForwardedEvents => {
  const events = new Map<string, { event: ForwardedEvent; bytes: number; delivered: boolean }>();
  const forwarding = new Map<string, Promise<Answer>>();
  let total = 0;
  const remember = (event: ForwardedEvent): ForwardedEvent => {
    const known = events.get(event.uuid);
    if (known) return known.event;
    const bytes = JSON.stringify(event).length;
    events.set(event.uuid, { event, bytes, delivered: false });
    total += bytes;
    while (events.size > MAX_FORWARDED_EVENTS || total > MAX_FORWARDED_BYTES) {
      const [uuid, oldest] = events.entries().next().value as [string, { bytes: number }];
      events.delete(uuid);
      total -= oldest.bytes;
    }
    return event;
  };
  return {
    get: (uuid) => events.get(uuid),
    claim(candidates, outcome) {
      const owned: string[] = [];
      const claims = candidates.map((candidate): Claim => {
        if (events.get(candidate.uuid)?.delivered) return { kind: "delivered" };
        const elsewhere = forwarding.get(candidate.uuid);
        if (elsewhere) return { kind: "elsewhere", outcome: elsewhere };
        forwarding.set(candidate.uuid, outcome);
        owned.push(candidate.uuid);
        return { kind: "own", event: remember(candidate) };
      });
      void outcome.finally(() => {
        for (const uuid of owned) if (forwarding.get(uuid) === outcome) forwarding.delete(uuid);
      });
      return claims;
    },
    delivered(uuids) {
      for (const uuid of uuids) {
        const known = events.get(uuid);
        if (known) known.delivered = true;
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
  uuid: z.uuid(),
  event: z.string().min(1).max(200),
  timestamp: z.iso.datetime(),
  properties: z
    .object({ $exception_list: z.array(CapturedException).max(50).optional() })
    .catchall(z.unknown()),
});
type CapturedEvent = z.infer<typeof CapturedEvent>;

const CaptureBody = z.union([
  z.object({ batch: z.array(z.unknown()).max(MAX_EVENTS) }).loose().transform((body) => body.batch),
  z.array(z.unknown()).max(MAX_EVENTS),
  z.record(z.string(), z.unknown()).transform((event) => [event]),
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

const MAX_BUILDS_PER_REQUEST = 4;

type Pending =
  | { index: number; known: ForwardedEvent }
  | { index: number; event: CapturedEvent; build: string };

/**
 * The build an event says it came from: the one its client_version names,
 * UNKNOWN_BUILD when it names none, or null when it names something that is
 * not a build.
 */
const buildOf = (event: CapturedEvent): string | null => {
  const version = event.properties.client_version;
  if (version === undefined || version === UNKNOWN_BUILD) return UNKNOWN_BUILD;
  return isBuildVersion(version) ? version : null;
};

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

const fresh = (timestamp: string, sentAt: number | null, receivedAt: number): boolean => {
  const time = Date.parse(timestamp);
  if (time >= receivedAt - MAX_EVENT_AGE_MS && time <= receivedAt + MAX_EVENT_LEAD_MS) return true;
  return sentAt !== null && sentAt - time <= MAX_EVENT_AGE_MS && sentAt - time >= -MAX_EVENT_LEAD_MS;
};

const reply = (status: number, retryAfterMs: number | null = null, rejected: readonly number[] = []) => {
  const body =
    status === 200
      ? JSON.stringify(rejected.length ? { status: 1, rejected } : { status: 1 })
      : status === 503 && rejected.length
        ? JSON.stringify({ rejected })
        : null;
  return new Response(body, {
    status,
    headers: {
      ...(body !== null ? { "content-type": "application/json" } : {}),
      ...(retryAfterMs !== null ? { "retry-after": String(Math.ceil(retryAfterMs / 1000)) } : {}),
    },
  });
};

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
  const { body, own, waits, taken, rejected, sent } = prepared;
  let answer: Answer = { outcome: "delivered" };
  try {
    if (body.batch.length > 0) answer = await sendUpstream(ingestHost, body, deps);
  } finally {
    sent(answer);
  }
  const outcomes = [
    ...taken.map((index) => ({ index, answer: { outcome: "delivered" } satisfies Answer })),
    ...own.map((index) => ({ index, answer })),
    ...(await Promise.all(waits.map(async ({ index, outcome }) => ({ index, answer: await outcome })))),
  ];
  return replyFor(outcomes, rejected);
}

/**
 * One answer for a request from what happened to each of its events: any
 * that is worth sending again makes it 503 with the longest wait asked for,
 * every event refused for good is listed, and it is 200 when any went.
 */
const replyFor = (outcomes: Array<{ index: number; answer: Answer }>, rejected: readonly number[]): Response => {
  const refused = [...rejected, ...outcomes.filter(({ answer }) => answer.outcome === "refused").map(({ index }) => index)].sort(
    (a, b) => a - b,
  );
  const retries = outcomes.flatMap(({ answer }) => (answer.outcome === "retry" ? [answer.afterMs] : []));
  if (retries.length > 0) {
    const waits = retries.filter((ms) => ms !== null);
    return reply(503, waits.length > 0 ? Math.max(...waits) : null, refused);
  }
  return outcomes.some(({ answer }) => answer.outcome === "delivered") ? reply(200, null, refused) : reply(400);
};

const sendUpstream = async (
  ingestHost: string,
  body: { api_key: string; batch: ForwardedEvent[] },
  deps: IngestDeps,
): Promise<Answer> => {
  let upstream: { status: number; retryAfter: string | null };
  try {
    upstream = await withinDeadline(UPSTREAM_DEADLINE_MS, async (signal) => {
      const response = await deps.fetch(`${ingestHost}/e/`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": INGEST_USER_AGENT },
        body: JSON.stringify(body),
        redirect: "manual",
        signal,
      });
      // Nothing in PostHog's body is read: the connection can go.
      await response.body?.cancel().catch(() => {});
      return { status: response.status, retryAfter: response.headers.get("retry-after") };
    });
  } catch {
    return { outcome: "retry", afterMs: null };
  }
  // PostHog's answer, through the table the browser's outbox reads ours by.
  const answer = answerOf(upstream.status, upstream.retryAfter, deps.now());
  if (answer.outcome === "delivered") deps.forwarded.delivered(body.batch.map((event) => event.uuid));
  return answer;
};

/**
 * The batch to send PostHog for one request, with the index of each event in
 * it that will never be taken, or a Refused error when none can be.
 */
const prepareForward = async (request: Request, deps: IngestDeps) => {
  const receivedAt = deps.now();
  const url = new URL(request.url);
  const decoded = await decodeBody(request, url);
  const parsed = CaptureBody.safeParse(decoded);
  if (!parsed.success) throw new Refused(400);
  const events = parsed.data.map((item) => {
    const event = CapturedEvent.safeParse(item);
    return event.success && event.data.properties.token === deps.projectKey ? event.data : null;
  });
  const sentAt = clientSentAt(url, decoded);
  const inRequest = new Set<string>();
  const rejected: number[] = [];
  const taken: number[] = [];
  const pending = events.flatMap((event, index): Pending[] => {
    const build = event ? buildOf(event) : null;
    if (!event || build === null) {
      rejected.push(index);
      return [];
    }
    if (inRequest.has(event.uuid)) return [];
    inRequest.add(event.uuid);
    const known = deps.forwarded.get(event.uuid);
    if (known) return [{ index, known: known.event }];
    if (!isOutboundEventName(event.event) || !fresh(event.timestamp, sentAt, receivedAt)) {
      rejected.push(index);
      return [];
    }
    return [{ index, event, build }];
  });
  const builds = [...new Set(pending.flatMap((item) => ("build" in item ? [item.build] : [])))].slice(
    0,
    MAX_BUILDS_PER_REQUEST,
  );
  const contexts = new Map(
    await Promise.all(
      builds.map(async (build) => {
        const manifest = build === UNKNOWN_BUILD ? null : await deps.manifest(build);
        const context = { token: deps.projectKey, clientVersion: build, chunkFiles: manifest };
        return [build, { context, schemas: createOutboundSchemas(context) }] as const;
      }),
    ),
  );
  const batch = pending.flatMap((item) => {
    if ("known" in item) return [{ index: item.index, event: item.known }];
    const { index, event, build } = item;
    const shaped = contexts.get(build);
    const built =
      shaped &&
      buildOutboundEvent(
        { uuid: event.uuid, event: event.event, properties: event.properties },
        { ...shaped.context, payload: event.properties, storedKeys: new Set(), siteOrigin: deps.siteOrigin },
        shaped.schemas,
      );
    if (!built) {
      rejected.push(index);
      return [];
    }
    return [{ index, event: { ...built, timestamp: event.timestamp } }];
  });
  if (batch.length === 0) throw new Refused(400);
  let sent: (answer: Answer) => void = () => {};
  const outcome = new Promise<Answer>((resolve) => (sent = resolve));
  const waits: Array<{ index: number; outcome: Promise<Answer> }> = [];
  const own: Array<{ index: number; event: ForwardedEvent }> = [];
  deps.forwarded.claim(batch.map(({ event }) => event), outcome).forEach((claim, position) => {
    const { index } = batch[position];
    if (claim.kind === "delivered") taken.push(index);
    else if (claim.kind === "elsewhere") waits.push({ index, outcome: claim.outcome });
    else own.push({ index, event: claim.event });
  });
  return {
    body: { api_key: deps.projectKey, batch: own.map(({ event }) => event) },
    own: own.map(({ index }) => index),
    waits,
    taken,
    rejected,
    sent,
  };
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
 * read for that build. One it has never read is null: its frames are then
 * held to their shared forms, and its events still name their build. A
 * version that is not a build's is never fetched.
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
        if (response.ok) return parseChunkManifest(await response.json());
        await response.body?.cancel().catch(() => {});
        return null;
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
