import { NextResponse } from "next/server";
import { resolveSfuSecret, resolveSfuUrl } from "@/lib/sfu-admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ roomId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { roomId } = await context.params;
  const targetUrl = `${resolveSfuUrl().replace(/\/$/, "")}/rooms/${encodeURIComponent(roomId)}/recordings`;

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      headers: {
        "x-sfu-secret": resolveSfuSecret(),
        accept: "application/json",
      },
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        data && typeof data === "object" && "error" in data
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
  } catch {
    return NextResponse.json(
      { error: "Failed to reach recording service" },
      { status: 502 },
    );
  }
}
