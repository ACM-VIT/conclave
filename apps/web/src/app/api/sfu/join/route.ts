import jwt from "jsonwebtoken";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type JoinRequestBody = {
  roomId?: string;
  sessionId?: string;
  joinMode?: "meeting" | "webinar_attendee";
  user?: {
    id?: string | null;
    email?: string | null;
    name?: string | null;
  };
  isHost?: boolean;
  isAdmin?: boolean;
  allowRoomCreation?: boolean;
  clientId?: string;
};

const resolveSfuUrl = () =>
  process.env.SFU_URL || process.env.NEXT_PUBLIC_SFU_URL || "http://localhost:3031";

const resolveClientId = (request: Request, body?: JoinRequestBody) => {
  const envClientId =
    process.env.SFU_CLIENT_ID || process.env.NEXT_PUBLIC_SFU_CLIENT_ID;
  if (envClientId?.trim()) {
    return envClientId.trim();
  }

  const headerClientId = request.headers.get("x-sfu-client")?.trim() || "";
  const bodyClientId = body?.clientId?.trim() || "";
  return headerClientId || bodyClientId || "default";
};

export async function POST(request: Request) {
  let body: JoinRequestBody;
  try {
    body = (await request.json()) as JoinRequestBody;
  } catch (_error) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const roomId = body?.roomId?.trim();
  const sessionId = body?.sessionId?.trim();

  if (!roomId) {
    return NextResponse.json({ error: "Missing room ID" }, { status: 400 });
  }

  if (!sessionId) {
    return NextResponse.json({ error: "Missing session ID" }, { status: 400 });
  }

  const clientId = resolveClientId(request, body);
  const joinMode =
    body?.joinMode === "webinar_attendee" ? "webinar_attendee" : "meeting";
  const email = body?.user?.email?.trim() || undefined;
  const name = body?.user?.name?.trim() || undefined;
  const providedId = body?.user?.id?.trim() || undefined;
  const baseUserId = email || providedId || `guest-${sessionId}`;
  const isWebinarAttendeeJoin = joinMode === "webinar_attendee";
  const isHost = isWebinarAttendeeJoin
    ? false
    : Boolean(body?.isHost ?? body?.isAdmin);
  const allowRoomCreation = isWebinarAttendeeJoin
    ? false
    : Boolean(body?.allowRoomCreation);

  const token = jwt.sign(
    {
      userId: baseUserId,
      email,
      name,
      isHost,
      isAdmin: isHost,
      allowRoomCreation,
      clientId,
      sessionId,
      joinMode,
    },
    process.env.SFU_SECRET || "development-secret",
    { expiresIn: "1h" }
  );

  return NextResponse.json({ token, sfuUrl: resolveSfuUrl() });
}
