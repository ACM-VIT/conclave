import { NextResponse } from "next/server";
import {
  buildScheduledMeetingHeaders,
  readScheduledMeetingError,
  resolveScheduledMeetingsBase,
} from "@/lib/scheduled-meetings";
import { requireSfuSessionUser } from "@/lib/sfu-user-auth";


const buildTargetUrl = (request: Request): string => {
  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(resolveScheduledMeetingsBase());
  const status = incomingUrl.searchParams.get("status")?.trim();
  const scope = incomingUrl.searchParams.get("scope")?.trim();
  if (status) targetUrl.searchParams.set("status", status);
  if (scope) targetUrl.searchParams.set("scope", scope);
  return targetUrl.toString();
};

export async function GET(request: Request) {
  const authResult = await requireSfuSessionUser(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status },
    );
  }

  try {
    const response = await fetch(buildTargetUrl(request), {
      method: "GET",
      headers: buildScheduledMeetingHeaders(authResult.user, request),
      cache: "no-store",
    });
    if (!response.ok) {
      return NextResponse.json(
        { error: await readScheduledMeetingError(response) },
        { status: response.status },
      );
    }
    const data: unknown = await response.json().catch(() => ({}));
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to reach scheduled meetings service" },
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

  let body = "";
  try {
    body = await request.text();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const response = await fetch(resolveScheduledMeetingsBase(), {
      method: "POST",
      headers: buildScheduledMeetingHeaders(authResult.user, request),
      body,
      cache: "no-store",
    });
    if (!response.ok) {
      return NextResponse.json(
        { error: await readScheduledMeetingError(response) },
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
      { error: "Failed to reach scheduled meetings service" },
      { status: 502 },
    );
  }
}
