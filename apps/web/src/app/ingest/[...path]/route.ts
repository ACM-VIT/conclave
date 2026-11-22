import {
  DEFAULT_INGEST_HOST,
  forwardCapture,
  INGEST_USER_AGENT,
} from "@/app/lib/telemetry-ingest";
import { CHUNK_MANIFEST_URL, parseChunkManifest } from "@/app/lib/telemetry-privacy";

// The build's chunk manifest, read from our own static assets and kept for a
// few minutes. If it cannot be read, chunk frames keep no path.
const MANIFEST_TTL_MS = 5 * 60_000;
let manifest: { origin: string; files: ReadonlyMap<string, string>; at: number } | null = null;

const chunkFilesFor = (origin: string) => async (): Promise<ReadonlyMap<string, string>> => {
  if (manifest?.origin === origin && Date.now() - manifest.at < MANIFEST_TTL_MS) {
    return manifest.files;
  }
  let files: ReadonlyMap<string, string> = new Map();
  try {
    const response = await fetch(new URL(CHUNK_MANIFEST_URL, origin), {
      headers: { "user-agent": INGEST_USER_AGENT },
    });
    if (response.ok) files = parseChunkManifest(await response.json());
  } catch {}
  manifest = { origin, files, at: Date.now() };
  return files;
};

const handle = async (
  request: Request,
  context: RouteContext<"/ingest/[...path]">,
): Promise<Response> => {
  const { path } = await context.params;
  return forwardCapture(request, path, {
    fetch: (url, init) => fetch(url, init),
    ingestHost: process.env.POSTHOG_INGEST_HOST?.trim() || DEFAULT_INGEST_HOST,
    projectKey: process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "",
    chunkFiles: chunkFilesFor(new URL(request.url).origin),
  });
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
