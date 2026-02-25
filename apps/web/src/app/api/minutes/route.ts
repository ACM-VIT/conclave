import { NextResponse } from "next/server";

const SFU_URL = process.env.SFU_URL || "http://localhost:3031";
const SFU_SECRET = process.env.SFU_SECRET || "development-secret";
const SFU_CLIENT_ID = process.env.SFU_CLIENT_ID || "default";

export async function POST(request: Request) {
  const { roomId } = await request.json().catch(() => ({ roomId: undefined }));
  if (!roomId || typeof roomId !== "string") {
    return NextResponse.json({ error: "roomId required" }, { status: 400 });
  }

  const res = await fetch(`${SFU_URL}/minutes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-sfu-secret": SFU_SECRET,
    },
    body: JSON.stringify({ roomId, clientId: SFU_CLIENT_ID }),
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: text || "Failed to generate" }, { status: res.status });
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="minutes-${roomId}.pdf"`,
    },
  });
}
