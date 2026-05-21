import { NextResponse } from "next/server";
import { requireSfuSessionUser } from "@/lib/sfu-user-auth";
import {
  buildScheduledMeetingHeaders,
  resolveScheduledMeetingsBase,
} from "@/lib/scheduled-meetings";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const authResult = await requireSfuSessionUser(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status },
    );
  }
  try {
    const url = `${resolveScheduledMeetingsBase()}/${encodeURIComponent(id)}/start`;
    const response = await fetch(url, {
      method: "POST",
      headers: buildScheduledMeetingHeaders(authResult.user, request),
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
      { error: "Failed to reach scheduled-meeting service" },
      { status: 502 },
    );
  }
}
