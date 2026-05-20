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

export async function GET(request: Request, context: RouteContext) {
  const authResult = await requireSfuSessionUser(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status },
    );
  }
  const { id } = await context.params;
  const url = `${resolveScheduledWebinarsBase()}/${encodeURIComponent(id)}/recordings`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: buildScheduledWebinarHeaders(authResult.user, request),
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        typeof data === "object" && data && "error" in data
          ? String((data as { error?: string }).error || "Request failed")
          : "Request failed";
      return NextResponse.json(
        { error: message },
        { status: response.status },
      );
    }
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (_error) {
    return NextResponse.json(
      { error: "Failed to reach recording service" },
      { status: 502 },
    );
  }
}
