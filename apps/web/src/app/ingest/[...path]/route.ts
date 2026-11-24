import {
  createChunkManifestLoader,
  createForwardedEvents,
  forwardCapture,
  ingestHostFrom,
} from "@/app/lib/telemetry-ingest";
import { takeIngestRateLimit } from "@/app/lib/ingest-rate-limit";
import { getPublicSiteUrl } from "@/lib/site-url";

// Manifests come from our configured site, never from the request's Host,
// which the client chooses.
const siteOrigin = getPublicSiteUrl();
const manifest = createChunkManifestLoader({
  origin: siteOrigin,
  fetch: (url, init) => fetch(url, init),
});

const forwarded = createForwardedEvents();
let warnedUnconfigured = false;

const handle = async (
  request: Request,
  context: RouteContext<"/ingest/[...path]">,
): Promise<Response> => {
  const { path } = await context.params;
  const ingestHost = ingestHostFrom({
    POSTHOG_INGEST_HOST: process.env.POSTHOG_INGEST_HOST,
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  });
  if (!ingestHost && !warnedUnconfigured) {
    warnedUnconfigured = true;
    console.error(
      "[ingest] No PostHog ingestion host: set POSTHOG_INGEST_HOST (or the older NEXT_PUBLIC_POSTHOG_HOST) to an http(s) URL. Telemetry is not forwarded.",
    );
  }
  return forwardCapture(request, path, {
    fetch: (url, init) => fetch(url, init),
    ingestHost,
    projectKey: process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "",
    currentBuild: process.env.NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION,
    manifest,
    siteOrigin,
    now: Date.now,
    forwarded,
    admit: takeIngestRateLimit,
  });
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
