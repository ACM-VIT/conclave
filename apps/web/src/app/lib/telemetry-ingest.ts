import { z } from "zod";
import {
  chunkManifestUrl,
  isBuildVersion,
  parseChunkManifest,
  scrubTelemetryEvent,
} from "./telemetry-privacy";

/**
 * The browser's PostHog traffic goes through /ingest on our own site, so the
 * browser's User-Agent, IP address and cookies never reach PostHog, and every
 * body is scrubbed here again rather than trusting the browser's before_send.
 */

/** The capture endpoints posthog-js uses with our config: events only. */
const ENDPOINTS = new Set(["e"]);
const MAX_BODY_BYTES = 256 * 1024;
const MAX_DECODED_BYTES = 1024 * 1024;
const MAX_EVENTS = 200;

/** The only User-Agent PostHog sees from the browser's traffic. */
export const INGEST_USER_AGENT = "conclave-web-ingest/1";
export const DEFAULT_INGEST_HOST = "https://eu.i.posthog.com";

export type IngestDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** PostHog's ingestion host. */
  ingestHost: string;
  /** Our project key: events for any other project are not relayed. */
  projectKey: string;
  /**
   * The chunk manifest of the build an event came from, by its version (the
   * event's client_version), or an empty one when it is not known.
   */
  chunkFiles: (version: string | null) => Promise<ReadonlyMap<string, string>>;
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
  const form = (request.headers.get("content-type") ?? "").includes("x-www-form-urlencoded");
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

/** The build an event came from, when its client_version names one. */
const buildOf = (event: CapturedEvent): string | null =>
  isBuildVersion(event.properties.client_version) ? event.properties.client_version : null;

/**
 * One event scrubbed again on our side: our fields are the event's own (the
 * browser already took them from the capture's payload), nothing counts as
 * stored, and chunk paths need the manifest of the event's own build.
 */
const scrubForwarded = (
  event: CapturedEvent,
  chunkFiles: ReadonlyMap<string, string>,
): CapturedEvent => {
  const { properties } = event;
  const payload = Object.fromEntries(
    Object.entries(properties).filter(
      ([key]) => !key.startsWith("$") && key !== "token" && key !== "distinct_id" && key !== "client_version",
    ),
  );
  const clientVersion = buildOf(event) ?? undefined;
  const scrubbed = scrubTelemetryEvent(
    { uuid: event.uuid ?? "", event: event.event, properties },
    { payload, storedKeys: new Set(), clientVersion, chunkFiles },
  );
  return {
    ...(event.uuid ? { uuid: event.uuid } : {}),
    event: event.event,
    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    properties: scrubbed.properties,
  };
};

const reply = (status: number) =>
  new Response(status === 200 ? '{"status":1}' : null, {
    status,
    headers: status === 200 ? { "content-type": "application/json" } : undefined,
  });

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
  let forwarded: string;
  try {
    forwarded = JSON.stringify(await prepareForward(request, deps));
  } catch (error) {
    // Nothing in a refused body would pass on a retry, and the reply does
    // not say what was wrong with it.
    return reply(error instanceof Refused ? error.status : 400);
  }
  try {
    const upstream = await deps.fetch(`${deps.ingestHost.replace(/\/$/, "")}/e/`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": INGEST_USER_AGENT },
      body: forwarded,
      redirect: "manual",
    });
    if (upstream.ok) return reply(200);
    return reply(upstream.status >= 500 ? 503 : 400);
  } catch {
    return reply(503);
  }
}

/** The batch to send PostHog for one request, or a Refused error. */
const prepareForward = async (request: Request, deps: IngestDeps) => {
  const parsed = CaptureBody.safeParse(await decodeBody(request, new URL(request.url)));
  if (!parsed.success) throw new Refused(400);
  const body = parsed.data;
  const events = Array.isArray(body) ? body : "batch" in body ? body.batch : [body];
  const ours = events.filter((event) => event.properties.token === deps.projectKey);
  if (ours.length === 0) throw new Refused(400);
  // A tab sends only its own build's events, so a request carries one build:
  // the first event's. Events from any other build are dropped, which holds
  // a request to at most one manifest lookup. A tab can still run an older
  // build than the one deployed, so that build's own manifest is used.
  const build = buildOf(ours[0]);
  const sameBuild = ours.filter((event) => buildOf(event) === build);
  const chunkFiles = build ? await deps.chunkFiles(build) : new Map<string, string>();
  return {
    api_key: deps.projectKey,
    batch: sameBuild.map((event) => scrubForwarded(event, chunkFiles)),
    ...(!Array.isArray(body) && "sent_at" in body && body.sent_at ? { sent_at: body.sent_at } : {}),
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
 * loads of one build share a fetch. A manifest it cannot find or read counts
 * as empty, so those frames keep no path or chunk id, and a version that is
 * not a build's is never fetched.
 */
export function createChunkManifestLoader({
  origin,
  fetch,
  now = Date.now,
}: {
  origin: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}): (version: string | null) => Promise<ReadonlyMap<string, string>> {
  const known = new Map<string, { files: ReadonlyMap<string, string>; until: number }>();
  const loading = new Map<string, Promise<ReadonlyMap<string, string>>>();

  const remember = (version: string, files: ReadonlyMap<string, string>) => {
    known.delete(version);
    if (known.size >= MAX_MANIFESTS) known.delete(known.keys().next().value as string);
    known.set(version, { files, until: now() + (files.size > 0 ? MANIFEST_TTL_MS : MISSING_MANIFEST_TTL_MS) });
  };

  const fetchManifest = async (version: string, url: string): Promise<ReadonlyMap<string, string>> => {
    let files: ReadonlyMap<string, string> = new Map();
    try {
      const response = await fetch(`${origin}${url}?dpl=${version}`, {
        headers: { "user-agent": INGEST_USER_AGENT },
      });
      if (response.ok) files = parseChunkManifest(await response.json());
    } catch {}
    remember(version, files);
    return files;
  };

  return (version) => {
    const url = chunkManifestUrl(version);
    if (!url || !version) return Promise.resolve(new Map());
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
