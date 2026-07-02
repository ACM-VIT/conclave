import { NextResponse } from "next/server";
import {
  requireSfuAdminUser,
  resolveSfuSecret,
  resolveSfuUrl,
} from "@/lib/sfu-admin-auth";
import { normalizeSfuUrl, resolveSfuUrls } from "@/lib/sfu-url";
import { readResponseError } from "@/app/lib/utils";
import { canonicalizeSfuClientId } from "@/lib/sfu-client-id";

type RouteContext = {
  params: Promise<{
    path?: string[];
  }>;
};

const readError = readResponseError;

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

  // Multi-instance pools: the dashboard may target a specific SFU. The value
  // must exactly match a configured pool url, never a caller-supplied host.
  const requestedInstance = incomingUrl.searchParams.get("instance")?.trim();
  let baseUrl = resolveSfuUrl();
  if (requestedInstance) {
    const normalized = normalizeSfuUrl(requestedInstance);
    const allowed = resolveSfuUrls().find((url) => url === normalized);
    if (!allowed) {
      return NextResponse.json(
        { error: "Unknown SFU instance" },
        { status: 400 },
      );
    }
    baseUrl = allowed;
  }

  const targetUrl = new URL(
    `/admin/${path.map((segment) => encodeURIComponent(segment)).join("/")}`,
    baseUrl,
  );

  for (const [key, value] of incomingUrl.searchParams.entries()) {
    if (key === "clientId" || key === "instance") {
      continue;
    }
    targetUrl.searchParams.append(key, value);
  }

  // Forward only an EXPLICIT client filter from the dashboard. An absent
  // clientId means "all clients" and the SFU admin endpoints treat it that
  // way; injecting the env default here (as join flows do) silently hid every
  // other tenant's rooms from the admin room list.
  const clientId =
    canonicalizeSfuClientId(incomingUrl.searchParams.get("clientId")) ||
    canonicalizeSfuClientId(request.headers.get("x-sfu-client")) ||
    "";
  if (clientId) {
    targetUrl.searchParams.set("clientId", clientId);
  }

  const outgoingHeaders = new Headers();
  outgoingHeaders.set("x-sfu-secret", resolveSfuSecret());
  outgoingHeaders.set("accept", "application/json");
  // Operator identity rides along so the SFU audit trail can name who did it.
  outgoingHeaders.set(
    "x-sfu-operator",
    authResult.user.email || authResult.user.id || "operator",
  );
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
      const data: unknown = await response.json().catch(() => ({}));
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
