import { z } from "zod";
import { scrubTelemetryEvent } from "./telemetry-privacy";

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
  /** The build's chunk ids by file (see telemetry-privacy's chunk manifest). */
  chunkFiles: () => Promise<ReadonlyMap<string, string>>;
};

const CapturedEvent = z.object({
  uuid: z.uuid().optional(),
  event: z.string().min(1).max(200),
  timestamp: z.string().max(64).optional(),
  properties: z.record(z.string(), z.unknown()),
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

const CLIENT_VERSION = /^[0-9a-f]{7,40}$/;

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

/**
 * One event scrubbed again on our side: our fields are the event's own (the
 * browser already took them from the capture's payload), nothing counts as
 * stored, and chunk paths need the build's manifest here too.
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
  const clientVersion =
    typeof properties.client_version === "string" && CLIENT_VERSION.test(properties.client_version)
      ? properties.client_version
      : undefined;
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
  try {
    const parsed = CaptureBody.safeParse(await decodeBody(request, new URL(request.url)));
    if (!parsed.success) return reply(400);
    const body = parsed.data;
    const events = Array.isArray(body) ? body : "batch" in body ? body.batch : [body];
    const ours = events.filter((event) => event.properties.token === deps.projectKey);
    if (ours.length === 0) return reply(400);
    const chunkFiles = await deps.chunkFiles();
    const forwarded = {
      api_key: deps.projectKey,
      batch: ours.map((event) => scrubForwarded(event, chunkFiles)),
      ...(!Array.isArray(body) && "sent_at" in body && body.sent_at ? { sent_at: body.sent_at } : {}),
    };
    const upstream = await deps.fetch(`${deps.ingestHost.replace(/\/$/, "")}/e/`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": INGEST_USER_AGENT },
      body: JSON.stringify(forwarded),
      redirect: "manual",
    });
    if (upstream.ok) return reply(200);
    return reply(upstream.status >= 500 ? 503 : 400);
  } catch (error) {
    return reply(error instanceof Refused ? error.status : 503);
  }
}
