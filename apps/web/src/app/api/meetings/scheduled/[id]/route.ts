import { NextResponse } from "next/server";
import { requireSfuSessionUser } from "@/lib/sfu-user-auth";
import {
  buildScheduledMeetingHeaders,
  resolveScheduledMeetingsBase,
} from "@/lib/scheduled-meetings";

export const runtime = "nodejs";

const readError = async (response: Response): Promise<string> => {
  const payload = await response.json().catch(() => null);
  if (payload && typeof payload === "object" && "error" in payload) {
    return String((payload as { error?: string }).error || "Request failed");
  }
  return response.statusText || "Request failed";
};

const proxy = async (
  request: Request,
  id: string,
  method: "GET" | "PATCH" | "DELETE" | "POST",
  body?: string,
  suffix: string = "",
) => {
  const authResult = await requireSfuSessionUser(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status },
    );
  }
  try {
    const url = `${resolveScheduledMeetingsBase()}/${encodeURIComponent(id)}${suffix}`;
    const response = await fetch(url, {
      method,
      headers: buildScheduledMeetingHeaders(authResult.user, request),
      body,
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
      { error: "Failed to reach scheduled-meeting service" },
      { status: 502 },
    );
  }
};

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return proxy(request, id, "GET");
}

export async function PATCH(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = await request.text();
  return proxy(request, id, "PATCH", body);
}

export async function DELETE(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return proxy(request, id, "DELETE");
}
