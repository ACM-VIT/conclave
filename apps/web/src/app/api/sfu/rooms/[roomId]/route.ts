import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { guestPassProofsOf } from "@/lib/guest-pass";
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
  } | null;
  viewerIsMember?: unknown;
};

const readError = readResponseError;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const headers = { "Cache-Control": "no-store" };

const toNonNegativeInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
};

// The identity the SFU knows this visitor by, built the way /api/sfu/join
// builds it: the signed-in account, else the tab's guest session.
const GUEST_VIEWER_KEY = "guest-viewer";

type Viewer = { key: string; guestProofs: string[] };

const resolveViewer = async (request: Request, sfuSecret: string): Promise<Viewer | null> => {
  const session = await auth.api
    .getSession({ headers: request.headers })
    .catch(() => null);
  const email = session?.user?.email?.trim().toLowerCase();
  const userId = session?.user?.id?.trim();
  if (email || userId) return { key: email || userId || "", guestProofs: [] };
  const guestProofs = guestPassProofsOf(sfuSecret, request);
  const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim();
  if (sessionId && SESSION_ID_PATTERN.test(sessionId)) {
    return { key: `guest-${sessionId}`, guestProofs };
  }
  return guestProofs.length > 0 ? { key: GUEST_VIEWER_KEY, guestProofs } : null;
};

// Only people in the room, its hosts, people let in and invitees see the
// headcount. Everyone else gets the same 403 whether or not the room exists,
// so codes cannot be probed for live meetings.
export async function GET(request: Request, context: RouteContext) {
  const { roomId } = await context.params;
  const normalizedRoomId = roomId?.trim();
  if (!normalizedRoomId) {
    return NextResponse.json({ error: "Missing room ID" }, { status: 400 });
  }

  const secret = resolveSfuSecret();
  const viewer = await resolveViewer(request, secret);
  const notAvailable = () =>
    NextResponse.json(
      { error: "Room status is not available" },
      { status: 403, headers },
    );
  if (!viewer) return notAvailable();

  const clientId = resolveSfuClientId(request);
  const results = await Promise.allSettled(resolveSfuUrls().map(async (sfuUrl) => {
    const targetUrl = new URL(`/rooms/${encodeURIComponent(normalizedRoomId)}`, sfuUrl);
    if (clientId) targetUrl.searchParams.set("clientId", clientId);
    targetUrl.searchParams.set("viewerKey", viewer.key);
    for (const proof of viewer.guestProofs) targetUrl.searchParams.append("viewerProof", proof);
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
    // An SFU that does not vouch for the viewer (including one too old to
    // know how) reveals nothing.
    if (data.viewerIsMember !== true) return null;
    const room = data.room;
    return {
      room: room
        ? {
            id: typeof room.id === "string" && room.id.trim() ? room.id.trim() : normalizedRoomId,
            userCount: toNonNegativeInteger(room.userCount),
          }
        : null,
    };
  }));
  const vouched = results.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : [],
  );
  if (vouched.length === 0) {
    if (results.some((result) => result.status === "rejected")) {
      return NextResponse.json({ error: "Room status is temporarily unavailable" }, {
        status: 503,
        headers: { ...headers, "Retry-After": "2" },
      });
    }
    return notAvailable();
  }
  const room = vouched
    .flatMap((entry) => (entry.room ? [entry.room] : []))
    .sort((left, right) => right.userCount - left.userCount)[0] ?? null;
  if (!room && results.some((result) => result.status === "rejected")) {
    return NextResponse.json({ error: "Room status is temporarily unavailable" }, {
      status: 503,
      headers: { ...headers, "Retry-After": "2" },
    });
  }
  return NextResponse.json({ room }, { headers });
}
