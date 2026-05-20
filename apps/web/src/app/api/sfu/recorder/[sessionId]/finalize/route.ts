import { NextResponse } from "next/server";
import { resolveSfuUrl } from "@/lib/sfu-admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const token = request.headers.get("x-recorder-token");
  if (!token) {
    return NextResponse.json({ error: "Missing recorder token" }, { status: 401 });
  }
  const targetUrl = `${resolveSfuUrl().replace(/\/$/, "")}/recorder/${encodeURIComponent(sessionId)}/finalize`;
  const body = await request.text();
  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-recorder-token": token,
      },
      body,
      cache: "no-store",
    });
    const text = await response.text();
    return new NextResponse(text, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (_error) {
    return NextResponse.json(
      { error: "Failed to forward finalize" },
      { status: 502 },
    );
  }
}
