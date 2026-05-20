import { NextResponse } from "next/server";
import {
  buildScheduledWebinarHeaders,
  requireSfuSessionUser,
  resolveScheduledWebinarsBase,
} from "@/lib/sfu-user-auth";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

const readError = async (response: Response): Promise<string> => {
  const payload = await response.json().catch(() => null);
  if (payload && typeof payload === "object" && "error" in payload) {
    return String((payload as { error?: string }).error || "Request failed");
  }
  return response.statusText || "Request failed";
};

const proxyTo = async (
  request: Request,
  id: string,
  options: { method: "GET" | "PATCH" | "DELETE" | "POST"; suffix?: string },
): Promise<NextResponse> => {
  const authResult = await requireSfuSessionUser(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status },
    );
  }
  const base = resolveScheduledWebinarsBase();
  const url = `${base}/${encodeURIComponent(id)}${options.suffix ?? ""}`;
  const init: RequestInit = {
    method: options.method,
    headers: buildScheduledWebinarHeaders(authResult.user, request),
    cache: "no-store",
  };
  if (options.method === "PATCH" || options.method === "POST") {
    init.body = await request.text();
  }
  try {
    const response = await fetch(url, init);
    if (!response.ok) {
      return NextResponse.json(
        { error: await readError(response) },
        { status: response.status },
      );
    }
    const data = await response.json().catch(() => ({}));
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (_error) {
    return NextResponse.json(
      { error: "Failed to reach scheduled-webinar service" },
      { status: 502 },
    );
  }
};

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return proxyTo(request, id, { method: "GET" });
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return proxyTo(request, id, { method: "PATCH" });
}

export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return proxyTo(request, id, { method: "DELETE" });
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const incomingUrl = new URL(request.url);
  const action = incomingUrl.searchParams.get("action");
  const validActions = new Set(["start", "end", "cancel"]);
  if (!action || !validActions.has(action)) {
    return NextResponse.json(
      { error: "Unknown scheduled-webinar action" },
      { status: 400 },
    );
  }
  return proxyTo(request, id, {
    method: "POST",
    suffix: `/${action}`,
  });
}
