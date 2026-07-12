import { fetchUnfurlResource } from "../../../lib/unfurl-fetch";
import { parseUnfurlableUrl } from "../../../lib/unfurl-html";
import { takeUnfurlRateLimit } from "../../../lib/unfurl-rate-limit";
import { readBoundedResponseBytes } from "../../../lib/unfurl-response";

const FETCH_TIMEOUT_MS = 6_000;
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const ASSET_CACHE_CONTROL = "private, max-age=86400";
const IMAGE_CONTENT_TYPE_PATTERN =
  /^image\/(?:png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon)\b/i;
const USER_AGENT =
  "Mozilla/5.0 (compatible; ConclaveLinkPreview/1.0; +https://conclave.acmvit.in)";

const errorResponse = (status: number): Response =>
  new Response(null, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

export async function GET(request: Request) {
  const requestedUrl = new URL(request.url).searchParams.get("url") ?? "";
  const target = parseUnfurlableUrl(requestedUrl);
  if (!target) return errorResponse(400);

  const rateLimit = await takeUnfurlRateLimit(request);
  if (!rateLimit.ok) return errorResponse(rateLimit.status);

  let fetched: Awaited<ReturnType<typeof fetchUnfurlResource>>;
  try {
    fetched = await fetchUnfurlResource(target, {
      headers: {
        accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/x-icon,*/*;q=0.1",
        "user-agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return errorResponse(502);
  }
  if (!fetched) return errorResponse(400);

  const { response } = fetched;
  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    return errorResponse(502);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!IMAGE_CONTENT_TYPE_PATTERN.test(contentType)) {
    response.body?.cancel().catch(() => {});
    return errorResponse(415);
  }

  const declaredLength = Number.parseInt(
    response.headers.get("content-length") ?? "",
    10,
  );
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ASSET_BYTES) {
    response.body?.cancel().catch(() => {});
    return errorResponse(413);
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await readBoundedResponseBytes(response, MAX_ASSET_BYTES);
  } catch {
    return errorResponse(502);
  }
  if (!bytes) return errorResponse(413);

  const responseBody = Uint8Array.from(bytes).buffer;
  const proxyResponse = new Response(responseBody, {
    headers: {
      "Cache-Control": ASSET_CACHE_CONTROL,
      "Content-Length": String(bytes.byteLength),
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    },
  });

  return proxyResponse;
}
