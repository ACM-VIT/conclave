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
  const url = new URL(request.url);
  const seq = url.searchParams.get("seq") || "";
  const sequence = request.headers.get("x-recorder-sequence") || seq;

  const body = await request.arrayBuffer();
  const targetUrl = `${resolveSfuUrl().replace(/\/$/, "")}/recorder/${encodeURIComponent(sessionId)}/chunk?seq=${encodeURIComponent(sequence)}`;

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-recorder-token": token,
        "x-recorder-sequence": sequence,
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
      { error: "Failed to forward chunk" },
      { status: 502 },
    );
  }
}
