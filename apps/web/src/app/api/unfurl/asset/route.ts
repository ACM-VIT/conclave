import { fetchUnfurlResource } from "../../../lib/unfurl-fetch";
import { parseUnfurlableUrl } from "../../../lib/unfurl-html";
import { takeUnfurlRateLimit } from "../../../lib/unfurl-rate-limit";
import {
  boundedResponseStream,
  readBoundedResponseBytes,
} from "../../../lib/unfurl-response";

const FETCH_TIMEOUT_MS = 6_000;
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
// Streaming cap per response, not a file-size limit — backpressure means a
// paused player stops the transfer, and seeks issue fresh range requests.
const MAX_VIDEO_STREAM_BYTES = 256 * 1024 * 1024;
const ASSET_CACHE_CONTROL = "private, max-age=86400";
const IMAGE_CONTENT_TYPE_PATTERN =
  /^image\/(?:png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon)\b/i;
const VIDEO_CONTENT_TYPE_PATTERN = /^video\/mp4\b/i;
// X's video CDN 403s hotlinked <video> requests, so tweet playback has to
// round-trip through this proxy. Kept to an allowlist so the endpoint can't
// be repurposed as a general video relay.
const VIDEO_STREAM_HOSTS = new Set(["video.twimg.com"]);
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

  // <video> issues Range requests for playback and seeking; forward them so
  // the upstream CDN can answer with 206s. Image loads never carry a range.
  const rangeHeader = request.headers.get("range");

  // The timeout must only bound the connection/headers phase: an
  // AbortSignal.timeout would also sever a video body mid-stream at 6s.
  const abortController = new AbortController();
  const connectTimer = setTimeout(
    () => abortController.abort(),
    FETCH_TIMEOUT_MS,
  );
  let fetched: Awaited<ReturnType<typeof fetchUnfurlResource>>;
  try {
    fetched = await fetchUnfurlResource(target, {
      headers: {
        accept:
          "image/avif,image/webp,image/png,image/jpeg,image/gif,image/x-icon,video/mp4,*/*;q=0.1",
        "user-agent": USER_AGENT,
        ...(rangeHeader ? { range: rangeHeader } : {}),
      },
      signal: abortController.signal,
      cache: "no-store",
    });
  } catch {
    return errorResponse(502);
  } finally {
    clearTimeout(connectTimer);
  }
  if (!fetched) return errorResponse(400);

  const { response, finalUrl } = fetched;
  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    return errorResponse(502);
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (VIDEO_CONTENT_TYPE_PATTERN.test(contentType)) {
    if (!VIDEO_STREAM_HOSTS.has(finalUrl.hostname.toLowerCase())) {
      response.body?.cancel().catch(() => {});
      return errorResponse(415);
    }
    const headers: Record<string, string> = {
      "Accept-Ranges": response.headers.get("accept-ranges") ?? "bytes",
      "Cache-Control": ASSET_CACHE_CONTROL,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    };
    const contentLength = response.headers.get("content-length");
    if (contentLength) headers["Content-Length"] = contentLength;
    const contentRange = response.headers.get("content-range");
    if (contentRange) headers["Content-Range"] = contentRange;

    return new Response(
      response.body
        ? boundedResponseStream(response.body, MAX_VIDEO_STREAM_BYTES)
        : null,
      { status: response.status === 206 ? 206 : 200, headers },
    );
  }

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
