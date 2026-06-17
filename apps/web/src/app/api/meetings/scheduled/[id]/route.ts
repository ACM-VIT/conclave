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

const resolveTargetUrl = async (context: RouteContext): Promise<string> => {
  const { id } = await context.params;
  return `${resolveScheduledMeetingsBase()}/${encodeURIComponent(id)}`;
};

const proxyScheduledMeetingRequest = async (
  request: Request,
  context: RouteContext,
): Promise<NextResponse> => {
  const authResult = await requireSfuSessionUser(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status },
    );
  }

  const method = request.method.toUpperCase();
  const init: RequestInit = {
    method,
    headers: buildScheduledMeetingHeaders(authResult.user, request),
    cache: "no-store",
  };

  if (method !== "GET" && method !== "HEAD") {
    const body = await request.text().catch(() => "");
    if (body) init.body = body;
  }

  try {
    const response = await fetch(await resolveTargetUrl(context), init);
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
};

export async function GET(request: Request, context: RouteContext) {
  return proxyScheduledMeetingRequest(request, context);
}

export async function PATCH(request: Request, context: RouteContext) {
  return proxyScheduledMeetingRequest(request, context);
}

export async function DELETE(request: Request, context: RouteContext) {
  return proxyScheduledMeetingRequest(request, context);
}
