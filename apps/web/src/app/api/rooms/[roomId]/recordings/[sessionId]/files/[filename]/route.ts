import { NextResponse } from "next/server";
import { resolveSfuSecret, resolveSfuUrl } from "@/lib/sfu-admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ roomId: string; sessionId: string; filename: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { roomId, sessionId, filename } = await context.params;
  const targetUrl = `${resolveSfuUrl().replace(/\/$/, "")}/rooms/${encodeURIComponent(roomId)}/recordings/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(filename)}`;

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      headers: { "x-sfu-secret": resolveSfuSecret() },
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
    headers.set(
      "Content-Type",
      response.headers.get("content-type") || "application/octet-stream",
    );
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
  } catch {
    return NextResponse.json(
      { error: "Failed to reach recording service" },
      { status: 502 },
    );
  }
}
