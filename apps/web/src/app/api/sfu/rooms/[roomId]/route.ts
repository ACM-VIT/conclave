import { NextResponse } from "next/server";
import {
  resolveSfuClientId,
  resolveSfuSecret,
  resolveSfuUrl,
} from "@/lib/sfu-admin-auth";


type RouteContext = {
  params: Promise<{
    roomId?: string;
  }>;
};

type RoomOccupancyResponse = {
  room?: {
    id?: unknown;
    userCount?: unknown;
  };
};

const readError = async (response: Response): Promise<string> => {
  const payload = await response.json().catch(() => null);
  if (payload && typeof payload === "object" && "error" in payload) {
    return String((payload as { error?: string }).error || "Request failed");
  }
  return response.statusText || "Request failed";
};

const toNonNegativeInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
};

export async function GET(request: Request, context: RouteContext) {
  const { roomId } = await context.params;
  const normalizedRoomId = roomId?.trim();
  if (!normalizedRoomId) {
    return NextResponse.json({ error: "Missing room ID" }, { status: 400 });
  }

  const clientId = resolveSfuClientId(request);
  const targetUrl = new URL(
    `/rooms/${encodeURIComponent(normalizedRoomId)}`,
    resolveSfuUrl(),
  );
  if (clientId) {
    targetUrl.searchParams.set("clientId", clientId);
  }

  try {
    const response = await fetch(targetUrl.toString(), {
      headers: {
        "x-sfu-secret": resolveSfuSecret(),
        "accept": "application/json",
        ...(clientId ? { "x-sfu-client": clientId } : {}),
      },
      cache: "no-store",
    });

    if (response.status === 404) {
      return NextResponse.json(
        { room: null },
        {
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    }

    if (!response.ok) {
      return NextResponse.json(
        { error: await readError(response) },
        { status: response.status },
      );
    }

    const data = (await response.json()) as RoomOccupancyResponse;
    const room = data.room;
    if (!room) {
      return NextResponse.json(
        { room: null },
        {
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    }

    const responseRoomId =
      typeof room?.id === "string" && room.id.trim()
        ? room.id.trim()
        : normalizedRoomId;

    return NextResponse.json(
      {
        room: {
          id: responseRoomId,
          userCount: toNonNegativeInteger(room?.userCount),
        },
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (_error) {
    return NextResponse.json({ error: "Failed to load room" }, { status: 500 });
  }
}
