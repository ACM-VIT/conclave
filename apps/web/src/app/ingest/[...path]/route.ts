import {
  createChunkManifestLoader,
  DEFAULT_INGEST_HOST,
  forwardCapture,
} from "@/app/lib/telemetry-ingest";
import { getPublicSiteUrl } from "@/lib/site-url";

// Manifests come from our configured site, never from the request's Host,
// which the client chooses.
const siteOrigin = getPublicSiteUrl();
const manifest = createChunkManifestLoader({
  origin: siteOrigin,
  fetch: (url, init) => fetch(url, init),
});

const handle = async (
  request: Request,
  context: RouteContext<"/ingest/[...path]">,
): Promise<Response> => {
  const { path } = await context.params;
  return forwardCapture(request, path, {
    fetch: (url, init) => fetch(url, init),
    ingestHost: process.env.POSTHOG_INGEST_HOST?.trim() || DEFAULT_INGEST_HOST,
    projectKey: process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "",
    currentBuild: process.env.NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION,
    manifest,
    siteOrigin,
    now: Date.now,
  });
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
