import { NextResponse } from "next/server";
import {
  buildPublicSchedulingHeaders,
  buildSchedulingHeaders,
  readSchedulingError,
  resolveSchedulingBase,
} from "@/lib/scheduling";
import { requireSfuSessionUser } from "@/lib/sfu-user-auth";


type RouteContext = {
  params: Promise<{ path?: string[] }>;
};

const MAX_PROXY_BODY_BYTES = 32 * 1024;

type LimitedBodyResult =
  | { ok: true; body: ArrayBuffer | null }
  | { ok: false };

const bodyTooLargeResponse = (): NextResponse =>
  NextResponse.json({ error: "Request body is too large" }, { status: 413 });

const readLimitedBody = async (request: Request): Promise<LimitedBodyResult> => {
  const rawContentLength = request.headers.get("content-length");
  if (rawContentLength) {
    const contentLength = Number(rawContentLength);
    if (
      !Number.isFinite(contentLength) ||
      contentLength < 0 ||
      contentLength > MAX_PROXY_BODY_BYTES
    ) {
      return { ok: false };
    }
  }
  if (!request.body) return { ok: true, body: null };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_PROXY_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  if (received === 0) return { ok: true, body: null };

  const body = new ArrayBuffer(received);
  const view = new Uint8Array(body);
  let offset = 0;
  for (const chunk of chunks) {
    view.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body };
};

const getOrigin = (request: Request): string => {
  const url = new URL(request.url);
  return url.origin;
};

const buildTargetUrl = async (
  request: Request,
  context: RouteContext,
): Promise<{ targetUrl: string; isPublic: boolean }> => {
  const { path = [] } = await context.params;
  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(
    `${resolveSchedulingBase()}/${path.map(encodeURIComponent).join("/")}`,
  );
  incomingUrl.searchParams.forEach((value, key) => {
    targetUrl.searchParams.append(key, value);
  });
  return {
    targetUrl: targetUrl.toString(),
    isPublic: path[0] === "public",
  };
};

const proxySchedulingRequest = async (
  request: Request,
  context: RouteContext,
): Promise<NextResponse> => {
  const { targetUrl, isPublic } = await buildTargetUrl(request, context);
  const method = request.method.toUpperCase();
  let resolvedHeaders: Headers;
  if (!isPublic) {
    const authResult = await requireSfuSessionUser(request);
    if (!authResult.ok) {
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status },
      );
    }
    resolvedHeaders = buildSchedulingHeaders(authResult.user, request);
  } else {
    resolvedHeaders = buildPublicSchedulingHeaders(request);
  }

  resolvedHeaders.set("x-app-origin", getOrigin(request));

  const init: RequestInit = {
    method,
    headers: resolvedHeaders,
    cache: "no-store",
  };
  if (method !== "GET" && method !== "HEAD") {
    const body = await readLimitedBody(request);
    if (!body.ok) return bodyTooLargeResponse();
    if (body.body) init.body = body.body;
  }

  try {
    const response = await fetch(targetUrl, init);
    if (!response.ok) {
      return NextResponse.json(
        { error: await readSchedulingError(response) },
        { status: response.status },
      );
    }
    const data: unknown = await response.json().catch(() => ({}));
    return NextResponse.json(data, {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to reach scheduling service" },
      { status: 502 },
    );
  }
};

export async function GET(request: Request, context: RouteContext) {
  return proxySchedulingRequest(request, context);
}

export async function POST(request: Request, context: RouteContext) {
  return proxySchedulingRequest(request, context);
}

export async function PUT(request: Request, context: RouteContext) {
  return proxySchedulingRequest(request, context);
}

export async function PATCH(request: Request, context: RouteContext) {
  return proxySchedulingRequest(request, context);
}

export async function DELETE(request: Request, context: RouteContext) {
  return proxySchedulingRequest(request, context);
}
