import { NextResponse } from "next/server";
import {
  buildScheduledWebinarHeaders,
  requireSfuSessionUser,
  resolveScheduledWebinarsBase,
} from "@/lib/sfu-user-auth";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ token: string }>;
};

const readError = async (response: Response): Promise<string> => {
  const payload = await response.json().catch(() => null);
  if (payload && typeof payload === "object" && "error" in payload) {
    return String((payload as { error?: string }).error || "Request failed");
  }
  return response.statusText || "Request failed";
};

export async function POST(request: Request, context: RouteContext) {
  const authResult = await requireSfuSessionUser(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status },
    );
  }

  const { token } = await context.params;
  const url =
    `${resolveScheduledWebinarsBase()}/cohost-invites/${encodeURIComponent(token)}/accept`;

  try {
    const response = await fetch(url, {
      method: "POST",
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
      { error: "Failed to accept co-host invite" },
      { status: 502 },
    );
  }
}
