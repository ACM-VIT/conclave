import {
  createChunkManifestLoader,
  DEFAULT_INGEST_HOST,
  forwardCapture,
} from "@/app/lib/telemetry-ingest";

// Chunk manifests by build, kept per origin we are served from.
const loaders = new Map<string, ReturnType<typeof createChunkManifestLoader>>();

const loaderFor = (origin: string) => {
  let loader = loaders.get(origin);
  if (!loader) {
    loader = createChunkManifestLoader({ origin, fetch: (url, init) => fetch(url, init) });
    loaders.set(origin, loader);
  }
  return loader;
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
    chunkFiles: loaderFor(new URL(request.url).origin),
  });
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
