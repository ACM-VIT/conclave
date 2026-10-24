import { NextResponse } from "next/server";
import {
  resolveSfuClientId,
  resolveSfuSecret,
} from "@/lib/sfu-admin-auth";
import { resolveSfuUrls } from "@/lib/sfu-url";
import { readResponseError } from "@/app/lib/utils";

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

const readError = readResponseError;

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
  const secret = resolveSfuSecret();
  const results = await Promise.allSettled(resolveSfuUrls().map(async (sfuUrl) => {
    const targetUrl = new URL(`/rooms/${encodeURIComponent(normalizedRoomId)}`, sfuUrl);
    if (clientId) targetUrl.searchParams.set("clientId", clientId);
    const response = await fetch(targetUrl.toString(), {
      headers: {
        "x-sfu-secret": secret,
        "accept": "application/json",
        ...(clientId ? { "x-sfu-client": clientId } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(2000)]),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(await readError(response));
    const data = (await response.json()) as RoomOccupancyResponse;
    const room = data.room;
    if (!room) return null;
    return {
      id: typeof room.id === "string" && room.id.trim() ? room.id.trim() : normalizedRoomId,
      userCount: toNonNegativeInteger(room.userCount),
    };
  }));
  const rooms = results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
  const room = rooms.sort((left, right) => right.userCount - left.userCount)[0] ?? null;
  const headers = { "Cache-Control": "no-store" };
  if (!room && results.some((result) => result.status === "rejected")) {
    return NextResponse.json({ error: "Room status is temporarily unavailable" }, {
      status: 503,
      headers: { ...headers, "Retry-After": "2" },
    });
  }
  return NextResponse.json({ room }, { headers });
}
