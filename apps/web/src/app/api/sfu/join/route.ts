import jwt from "jsonwebtoken";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { resolveHostGrant } from "@conclave/meeting-core";
import { auth } from "@/lib/auth";
import { lookupScheduledWebinarByRoomId } from "@/lib/sfu-user-auth";

export const runtime = "nodejs";

let loggedSecretFingerprint = false;
const logSecretFingerprint = (secret: string): void => {
  if (loggedSecretFingerprint) return;
  loggedSecretFingerprint = true;
  if (process.env.SFU_DEBUG_SECRET === "0") return;
  const fp = createHash("sha256").update(secret).digest("hex").slice(0, 12);
  const source = process.env.SFU_SECRET
    ? "process.env (loaded by Next.js)"
    : "fallback literal";
  console.log(
    `[SFU join] signing JWTs with secret source: ${source}; fingerprint: ${fp}`,
  );
};

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

type RoomRoutingResponse = {
  owner?: {
    instanceUrl?: string;
  } | null;
};

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

const normalizeUserId = (
  value: string | null | undefined,
): string | undefined => {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 128) return undefined;
  return /^[a-zA-Z0-9._:@-]+$/.test(normalized) ? normalized : undefined;
};

const isSyntheticGuestEmail = (value: string | undefined): boolean =>
  Boolean(value && /^guest-[^@]+@guest\.(?:conclave|com)$/i.test(value));

const isSyntheticGuestUserId = (value: string | undefined): boolean =>
  Boolean(value && value.startsWith("guest-"));

const parseEmailList = (value: string | undefined): Set<string> =>
  new Set(
    (value ?? "")
      .split(",")
      .map((entry) => normalizeEmail(entry))
      .filter((entry): entry is string => Boolean(entry)),
  );

const isScheduledRoomId = (value: string): boolean =>
  /^sched-[a-f0-9]{8}$/i.test(value);

const normalizeSfuUrl = (value: string): string => value.replace(/\/+$/, "");

const normalizeRoutedSfuUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return normalizeSfuUrl(url.toString());
  } catch {
    return null;
  }
};

let roomRoutingWarningLogged = false;
const resolveRoutedSfuUrl = async (options: {
  baseSfuUrl: string;
  secret: string;
  clientId: string;
  roomId: string;
}): Promise<string> => {
  const baseSfuUrl = normalizeSfuUrl(options.baseSfuUrl);
  try {
    const routingUrl =
      `${baseSfuUrl}/routing/rooms/` +
      `${encodeURIComponent(options.clientId)}/` +
      encodeURIComponent(options.roomId);
    const response = await fetch(
      routingUrl,
      {
        method: "GET",
        headers: {
          "x-sfu-secret": options.secret,
          accept: "application/json",
        },
        cache: "no-store",
      },
    );
    if (!response.ok) {
      return baseSfuUrl;
    }

    const data = (await response.json()) as RoomRoutingResponse;
    return normalizeRoutedSfuUrl(data.owner?.instanceUrl) ?? baseSfuUrl;
  } catch (error) {
    if (!roomRoutingWarningLogged) {
      console.warn(
        "[SFU Join] Room routing lookup failed; using default SFU URL.",
        error,
      );
      roomRoutingWarningLogged = true;
    }
    return baseSfuUrl;
  }
};

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
  const rawBodyEmail = normalizeEmail(body?.user?.email);
  const rawBodyUserId = normalizeUserId(body?.user?.id);
  const bodyEmail = isSyntheticGuestEmail(rawBodyEmail)
    ? undefined
    : rawBodyEmail;
  const bodyUserId = isSyntheticGuestUserId(rawBodyUserId)
    ? undefined
    : rawBodyUserId;
  // Browser sessions are authoritative when present. Native clients do not have
  // the better-auth cookie, so preserve their supplied non-guest stable identity
  // for the SFU's user-keyed reconnect, allow/block-list, and host-tracking
  // paths. Synthetic web/mobile guests must stay session-scoped because the
  // clients render their local participant as guest-${sessionId}.
  const email = sessionEmail || bodyEmail;
  const name =
    sessionUser?.name?.trim() || body?.user?.name?.trim() || undefined;
  const normalizedSessionEmail = normalizeEmail(sessionEmail);
  const providedId = sessionUser?.id?.trim() || bodyUserId || undefined;
  const baseUserId = email || providedId || `guest-${sessionId}`;
  const isWebinarAttendeeJoin = joinMode === "webinar_attendee";
  const isScheduledHostRoom = isScheduledRoomId(roomId);
  const isForcedHost =
    !isWebinarAttendeeJoin &&
    Boolean(
      normalizedSessionEmail && alwaysHostEmails.has(normalizedSessionEmail),
    );
  const requestedHost = Boolean(body?.isHost ?? body?.isAdmin);

  // For scheduled webinar rooms, only the actual host or a registered co-host
  // may claim host status. We resolve this by looking the scheduled webinar
  // up by roomId on the SFU and matching the session email.
  let scheduledRoomHostMatch = false;
  if (isScheduledHostRoom && !isWebinarAttendeeJoin && normalizedSessionEmail) {
    const scheduled = await lookupScheduledWebinarByRoomId(clientId, roomId);
    if (scheduled) {
      if (
        scheduled.hostEmail === normalizedSessionEmail ||
        scheduled.coHostEmails.includes(normalizedSessionEmail)
      ) {
        scheduledRoomHostMatch = true;
      }
    }
  }

  // Host/admin is NEVER minted from a bare client claim. The decision (and its
  // security invariant + regression tests) lives in resolveHostGrant: a host
  // *intent* only grants room-creation, so the creator becomes host via the
  // SFU's server-authoritative createdRoom path — never seizing an existing room.
  const canHonorBodyRoomCreation =
    Boolean(sessionUser?.id) || clientId !== "public" || requestedHost;
  const { isHost, allowRoomCreation } = resolveHostGrant({
    isWebinarAttendeeJoin,
    isForcedHost,
    scheduledRoomHostMatch,
    isScheduledHostRoom,
    requestedHost,
    bodyAllowRoomCreation:
      canHonorBodyRoomCreation && Boolean(body?.allowRoomCreation),
  });

  const secret = process.env.SFU_SECRET || "development-secret";
  const routedSfuUrl = await resolveRoutedSfuUrl({
    baseSfuUrl: resolveSfuUrl(),
    secret,
    clientId,
    roomId,
  });
  logSecretFingerprint(secret);
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
    secret,
    { expiresIn: "12h" },
  );

  const iceServers = resolveIceServers();

  return NextResponse.json({
    token,
    sfuUrl: routedSfuUrl,
    ...(iceServers.length > 0 ? { iceServers } : {}),
  });
}
