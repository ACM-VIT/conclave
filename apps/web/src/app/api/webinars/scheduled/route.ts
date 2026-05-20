import { NextResponse } from "next/server";
import {
  buildScheduledWebinarHeaders,
  requireSfuSessionUser,
  resolveScheduledWebinarsBase,
} from "@/lib/sfu-user-auth";

export const runtime = "nodejs";

const readError = async (response: Response): Promise<string> => {
  const payload = await response.json().catch(() => null);
  if (payload && typeof payload === "object" && "error" in payload) {
    return String((payload as { error?: string }).error || "Request failed");
  }
  return response.statusText || "Request failed";
};

export async function GET(request: Request) {
  const authResult = await requireSfuSessionUser(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status },
    );
  }

  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(resolveScheduledWebinarsBase());
  const scope = incomingUrl.searchParams.get("scope");
  const status = incomingUrl.searchParams.get("status");
  if (scope) targetUrl.searchParams.set("scope", scope);
  if (status) targetUrl.searchParams.set("status", status);

  try {
    const response = await fetch(targetUrl.toString(), {
      method: "GET",
      headers: buildScheduledWebinarHeaders(authResult.user, request),
      cache: "no-store",
    });
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
}

export async function POST(request: Request) {
  const authResult = await requireSfuSessionUser(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status },
    );
  }

  const body = await request.text();
  try {
    const response = await fetch(resolveScheduledWebinarsBase(), {
      method: "POST",
      headers: buildScheduledWebinarHeaders(authResult.user, request),
      body,
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorMessage =
        typeof data === "object" && data && "error" in data
          ? String((data as { error?: string }).error || "Request failed")
          : "Request failed";
      return NextResponse.json(
        { error: errorMessage },
        { status: response.status },
      );
    }
    return NextResponse.json(data, {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (_error) {
    return NextResponse.json(
      { error: "Failed to reach scheduled-webinar service" },
      { status: 502 },
    );
  }
}
