import { NextResponse } from "next/server";
import {
  buildScheduledWebinarHeaders,
  requireSfuSessionUser,
  resolveScheduledWebinarsBase,
} from "@/lib/sfu-user-auth";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string; sessionId: string; filename: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const authResult = await requireSfuSessionUser(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status },
    );
  }
  const { id, sessionId, filename } = await context.params;
  const url = `${resolveScheduledWebinarsBase()}/${encodeURIComponent(id)}/recordings/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(filename)}`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: buildScheduledWebinarHeaders(authResult.user, request),
      cache: "no-store",
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      const message =
        data && typeof data === "object" && "error" in data
          ? String((data as { error?: string }).error || "Download failed")
          : "Download failed";
      return NextResponse.json(
        { error: message },
        { status: response.status },
      );
    }
    const headers = new Headers();
    const ct = response.headers.get("content-type") || "application/octet-stream";
    headers.set("Content-Type", ct);
    headers.set(
      "Content-Disposition",
      response.headers.get("content-disposition") ||
        `attachment; filename="${filename}"`,
    );
    headers.set("Cache-Control", "no-store");
    return new NextResponse(response.body, {
      status: 200,
      headers,
    });
  } catch (_error) {
    return NextResponse.json(
      { error: "Failed to reach recording service" },
      { status: 502 },
    );
  }
}
