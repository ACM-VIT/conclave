import { NextResponse } from "next/server";
import {
  requireSfuAdminUser,
  resolveSfuClientId,
  resolveSfuSecret,
  resolveSfuUrl,
} from "@/lib/sfu-admin-auth";

type RouteContext = {
  params: Promise<{
    path?: string[];
  }>;
};

const readError = async (response: Response): Promise<string> => {
  const payload = await response.json().catch(() => null);
  if (payload && typeof payload === "object" && "error" in payload) {
    return String((payload as { error?: string }).error || "Request failed");
  }
  return response.statusText || "Request failed";
};

const proxyAdminRequest = async (
  request: Request,
  context: RouteContext,
): Promise<NextResponse> => {
  const authResult = await requireSfuAdminUser(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status },
    );
  }

  const { path = [] } = await context.params;
  if (path.length === 0) {
    return NextResponse.json(
      { error: "Missing SFU admin path" },
      { status: 400 },
    );
  }

  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(
    `/admin/${path.map((segment) => encodeURIComponent(segment)).join("/")}`,
    resolveSfuUrl(),
  );

  for (const [key, value] of incomingUrl.searchParams.entries()) {
    if (key === "clientId") {
      continue;
    }
    targetUrl.searchParams.append(key, value);
  }

  const clientId = resolveSfuClientId(request);
  if (clientId) {
    targetUrl.searchParams.set("clientId", clientId);
  }

  const outgoingHeaders = new Headers();
  outgoingHeaders.set("x-sfu-secret", resolveSfuSecret());
  outgoingHeaders.set("accept", "application/json");
  if (clientId) {
    outgoingHeaders.set("x-sfu-client", clientId);
  }

  const method = request.method.toUpperCase();
  const init: RequestInit = {
    method,
    headers: outgoingHeaders,
    cache: "no-store",
  };

  if (method !== "GET" && method !== "HEAD") {
    const body = await request.text();
    const contentType = request.headers.get("content-type");
    if (contentType) {
      outgoingHeaders.set("content-type", contentType);
    }
    if (body) {
      init.body = body;
    }
  }

  try {
    const response = await fetch(targetUrl.toString(), init);
    const contentType = response.headers.get("content-type") || "application/json";

    if (!response.ok) {
      return NextResponse.json(
        { error: await readError(response) },
        { status: response.status },
      );
    }

    if (contentType.includes("application/json")) {
      const data = await response.json().catch(() => ({}));
      return NextResponse.json(data, {
        status: response.status,
        headers: {
          "Cache-Control": "no-store",
        },
      });
    }

    const text = await response.text();
    return new NextResponse(text, {
      status: response.status,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      },
    });
  } catch (_error) {
    return NextResponse.json(
      { error: "Failed to reach SFU admin service" },
      { status: 502 },
    );
  }
};

export async function GET(request: Request, context: RouteContext) {
  return proxyAdminRequest(request, context);
}

export async function POST(request: Request, context: RouteContext) {
  return proxyAdminRequest(request, context);
}

export async function PUT(request: Request, context: RouteContext) {
  return proxyAdminRequest(request, context);
}

export async function PATCH(request: Request, context: RouteContext) {
  return proxyAdminRequest(request, context);
}

export async function DELETE(request: Request, context: RouteContext) {
  return proxyAdminRequest(request, context);
}
