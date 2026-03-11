import jwt from "jsonwebtoken";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

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

type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

const DEFAULT_PUBLIC_STUN_URLS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:stun2.l.google.com:19302",
];

const resolveSfuUrl = () =>
  process.env.SFU_URL || process.env.NEXT_PUBLIC_SFU_URL || "http://localhost:3031";

const splitUrls = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const firstNonEmpty = (...values: Array<string | undefined>): string | undefined => {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
};

const normalizeEmail = (
  value: string | null | undefined,
): string | undefined => {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
};

const parseEmailList = (value: string | undefined): Set<string> =>
  new Set(
    (value ?? "")
      .split(",")
      .map((entry) => normalizeEmail(entry))
      .filter((entry): entry is string => Boolean(entry)),
  );

const alwaysHostEmails = parseEmailList(
  firstNonEmpty(
    process.env.SFU_ALWAYS_HOST_EMAILS,
    process.env.SFU_ALWAYS_HOST_EMAIL,
    process.env.ALWAYS_HOST_EMAILS,
    process.env.ALWAYS_HOST_EMAIL,
  ),
);

let turnCredentialWarningLogged = false;
let turnMissingCredentialWarningLogged = false;

const resolveIceServers = (): IceServer[] => {
  const servers: IceServer[] = [];

  const configuredStunUrls = splitUrls(
    firstNonEmpty(
      process.env.STUN_URLS,
      process.env.STUN_URL,
      process.env.NEXT_PUBLIC_STUN_URLS,
      process.env.NEXT_PUBLIC_STUN_URL,
    ),
  );
  const stunUrls =
    configuredStunUrls.length > 0 ? configuredStunUrls : DEFAULT_PUBLIC_STUN_URLS;

  if (stunUrls.length > 0) {
    servers.push({
      urls: stunUrls.length === 1 ? stunUrls[0] : stunUrls,
    });
  }

  const turnUrls = splitUrls(
    firstNonEmpty(
      process.env.TURN_URLS,
      process.env.TURN_URL,
      process.env.NEXT_PUBLIC_TURN_URLS,
      process.env.NEXT_PUBLIC_TURN_URL,
    ),
  );

  if (turnUrls.length > 0) {
    const turnUsername = firstNonEmpty(
      process.env.TURN_USERNAME,
      process.env.NEXT_PUBLIC_TURN_USERNAME,
    );
    const turnCredential = firstNonEmpty(
      process.env.TURN_PASSWORD,
      process.env.TURN_CREDENTIAL,
      process.env.NEXT_PUBLIC_TURN_PASSWORD,
      process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
    );

    const turnServer: IceServer = {
      urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls,
    };

    if (turnUsername && turnCredential) {
      turnServer.username = turnUsername;
      turnServer.credential = turnCredential;
    } else if (turnUsername || turnCredential) {
      if (!turnCredentialWarningLogged) {
        console.warn(
          "[SFU Join] TURN credential configuration is incomplete; ignoring username/password.",
        );
        turnCredentialWarningLogged = true;
      }
    } else if (!turnMissingCredentialWarningLogged) {
      console.warn(
        "[SFU Join] TURN URLs configured without credentials. Relay candidates may fail if TURN auth is required.",
      );
      turnMissingCredentialWarningLogged = true;
    }

    servers.push(turnServer);
  }

  return servers;
};

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
  const session = await auth.api
    .getSession({
      headers: request.headers,
    })
    .catch(() => null);
  const sessionUser = session?.user;
  const sessionEmail = sessionUser?.email?.trim() || undefined;
  const email = sessionEmail || body?.user?.email?.trim() || undefined;
  const name =
    sessionUser?.name?.trim() || body?.user?.name?.trim() || undefined;
  const normalizedSessionEmail = normalizeEmail(sessionEmail);
  const providedId =
    sessionUser?.id?.trim() || body?.user?.id?.trim() || undefined;
  const baseUserId = email || providedId || `guest-${sessionId}`;
  const isWebinarAttendeeJoin = joinMode === "webinar_attendee";
  const isForcedHost =
    !isWebinarAttendeeJoin &&
    Boolean(
      normalizedSessionEmail && alwaysHostEmails.has(normalizedSessionEmail),
    );
  const isHost = isWebinarAttendeeJoin
    ? false
    : isForcedHost || Boolean(body?.isHost ?? body?.isAdmin);
  const allowRoomCreation = isWebinarAttendeeJoin
    ? false
    : Boolean(body?.allowRoomCreation);

  const token = jwt.sign(
    {
      userId: baseUserId,
      email,
      name,
      isForcedHost,
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

  const iceServers = resolveIceServers();

  return NextResponse.json({
    token,
    sfuUrl: resolveSfuUrl(),
    ...(iceServers.length > 0 ? { iceServers } : {}),
  });
}
