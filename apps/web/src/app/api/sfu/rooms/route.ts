import { NextResponse } from "next/server";

export const runtime = "nodejs";

type RoomsResponse = {
  rooms?: Array<{ id: string; clients?: number; userCount?: number }>;
};

const resolveSfuUrl = () =>
  process.env.SFU_URL || process.env.NEXT_PUBLIC_SFU_URL || "http://localhost:3031";

export async function GET() {
  const sfuUrl = resolveSfuUrl();
  const secret = process.env.SFU_SECRET || "development-secret";

  try {
    const response = await fetch(`${sfuUrl}/rooms`, {
      headers: { "x-sfu-secret": secret },
      cache: "no-store",
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "Failed to load rooms" },
        { status: response.status }
      );
    }

    const data = (await response.json()) as RoomsResponse;
    const rooms = Array.isArray(data?.rooms)
      ? data.rooms.map((room) => ({
          id: room.id,
          userCount: room.userCount ?? room.clients ?? 0,
        }))
      : [];

    return NextResponse.json({ rooms });
  } catch (_error) {
    return NextResponse.json({ error: "Failed to load rooms" }, { status: 500 });
  }
}
