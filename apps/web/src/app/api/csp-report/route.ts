import { declaredContentLength, readBoundedBody } from "@/lib/bounded-request-body";
import { parseCspReport } from "@/lib/csp-report";
import { takeCspReportRateLimit } from "./rate-limit";

const MAX_REPORT_BYTES = 16 * 1024;
const REPORT_CONTENT_TYPES = /^application\/(csp-report|json)\s*(;|$)/i;

const empty = (status: number): Response => new Response(null, { status });

export async function POST(request: Request): Promise<Response> {
  if (!REPORT_CONTENT_TYPES.test(request.headers.get("content-type") ?? "")) {
    return empty(415);
  }
  if ((declaredContentLength(request) ?? 0) > MAX_REPORT_BYTES) {
    return empty(413);
  }

  const rateLimit = await takeCspReportRateLimit(request);
  if (rateLimit === "limited") return empty(429);
  if (rateLimit === "unavailable") return empty(503);

  const body = await readBoundedBody(request, MAX_REPORT_BYTES);
  if (!body.ok) return empty(body.reason === "too-large" ? 413 : 400);

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body.bytes));
  } catch {
    return empty(400);
  }

  const violation = parseCspReport(payload);
  if (!violation) return empty(400);
  console.warn(`[csp-report] ${JSON.stringify(violation)}`);
  return empty(204);
}
