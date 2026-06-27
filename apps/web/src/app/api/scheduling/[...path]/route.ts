import { NextResponse } from "next/server";
import {
  buildPublicSchedulingHeaders,
  buildSchedulingHeaders,
  readSchedulingError,
  resolveSchedulingBase,
} from "@/lib/scheduling";
import { requireSfuSessionUser } from "@/lib/sfu-user-auth";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ path?: string[] }>;
};

const MAX_PROXY_BODY_BYTES = 32 * 1024;

type StreamingRequestInit = RequestInit & {
  duplex?: "half";
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

  const init: StreamingRequestInit = {
    method,
    headers: resolvedHeaders,
    cache: "no-store",
  };
  if (method !== "GET" && method !== "HEAD") {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_PROXY_BODY_BYTES
    ) {
      return NextResponse.json(
        { error: "Request body is too large" },
        { status: 413 },
      );
    }
    if (request.body) {
      init.body = request.body;
      init.duplex = "half";
    }
  }

  try {
    const response = await fetch(targetUrl, init);
    if (!response.ok) {
      return NextResponse.json(
        { error: await readSchedulingError(response) },
        { status: response.status },
      );
    }
    const data = await response.json().catch(() => ({}));
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
