import { NextResponse } from "next/server";
import {
  buildScheduledMeetingHeaders,
  readScheduledMeetingError,
  resolveScheduledMeetingsBase,
} from "@/lib/scheduled-meetings";
import { requireSfuSessionUser } from "@/lib/sfu-user-auth";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const authResult = await requireSfuSessionUser(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status },
    );
  }

  const { id } = await context.params;

  try {
    const response = await fetch(
      `${resolveScheduledMeetingsBase()}/${encodeURIComponent(id)}/start`,
      {
        method: "POST",
        headers: buildScheduledMeetingHeaders(authResult.user, request),
        cache: "no-store",
      },
    );
    if (!response.ok) {
      return NextResponse.json(
        { error: await readScheduledMeetingError(response) },
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
      { error: "Failed to reach scheduled meetings service" },
      { status: 502 },
    );
  }
}
