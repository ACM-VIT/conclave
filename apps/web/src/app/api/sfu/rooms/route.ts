import { NextResponse } from "next/server";
import {
  requireSfuAdminUser,
  resolveSfuClientId,
  resolveSfuSecret,
  resolveSfuUrl,
} from "@/lib/sfu-admin-auth";


type RoomsResponse = {
  rooms?: Array<{
    id: string;
    clients?: number;
    userCount?: number;
    counts?: { participants?: number };
  }>;
};

export async function GET(request: Request) {
  const authResult = await requireSfuAdminUser(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status },
    );
  }

  const sfuUrl = resolveSfuUrl();
  const secret = resolveSfuSecret();
  const clientId = resolveSfuClientId(request);

  try {
    const targetUrl = new URL("/admin/rooms", sfuUrl);
    if (clientId) {
      targetUrl.searchParams.set("clientId", clientId);
    }

    const response = await fetch(targetUrl.toString(), {
      headers: {
        "x-sfu-secret": secret,
        ...(clientId ? { "x-sfu-client": clientId } : {}),
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "Failed to load rooms" },
        { status: response.status },
      );
    }

    const data = (await response.json()) as RoomsResponse;
    const rooms = Array.isArray(data?.rooms)
      ? data.rooms.map((room) => ({
          id: room.id,
          userCount:
            room.userCount ?? room.clients ?? room.counts?.participants ?? 0,
        }))
      : [];

    return NextResponse.json(
      { rooms },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (_error) {
    return NextResponse.json({ error: "Failed to load rooms" }, { status: 500 });
  }
}
