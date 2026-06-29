import jwt from "jsonwebtoken";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { resolveHostGrant } from "@conclave/meeting-core";
import { auth } from "@/lib/auth";
import { isSfuAllowlistedUser } from "@/lib/sfu-admin-auth";
import { lookupScheduledWebinarByRoomId } from "@/lib/sfu-user-auth";
import {
  normalizeRoutedSfuUrl,
  normalizeSfuUrl,
  resolveSfuUrl,
} from "@/lib/sfu-url";

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
  isGhost?: boolean;
  allowRoomCreation?: boolean;
  clientId?: string;
};

type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

type CloudflareTurnCredentialsResponse = {
  iceServers?: IceServer[];
};

const DEFAULT_PUBLIC_STUN_URLS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:stun2.l.google.com:19302",
];
const CLOUDFLARE_TURN_CREDENTIALS_URL =
  "https://rtc.live.cloudflare.com/v1/turn/keys";
const CLOUDFLARE_TURN_DEFAULT_TTL_SECONDS = 86400;
const CLOUDFLARE_TURN_MAX_TTL_SECONDS = 86400;
const CLOUDFLARE_TURN_REQUEST_TIMEOUT_MS = 5000;

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

const resolveStunIceServers = (): IceServer[] => {
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

  if (stunUrls.length === 0) return [];

  return [
    {
      urls: stunUrls.length === 1 ? stunUrls[0] : stunUrls,
    },
  ];
};

const normalizeIceServerUrls = (urls: IceServer["urls"] | undefined): string[] => {
  if (!urls) return [];
  return (Array.isArray(urls) ? urls : [urls])
    .map((url) => url.trim())
    .filter(Boolean)
    .filter((url) => !/^turns?:turn\.cloudflare\.com:53[/?]/i.test(url))
    .filter((url) => !/^stun:stun\.cloudflare\.com:53$/i.test(url));
};

const normalizeIceServers = (iceServers: IceServer[] | undefined): IceServer[] => {
  const normalized: IceServer[] = [];

  for (const iceServer of iceServers ?? []) {
    const urls = normalizeIceServerUrls(iceServer.urls);
    if (urls.length === 0) continue;

    normalized.push({
      urls: urls.length === 1 ? urls[0] : urls,
      ...(iceServer.username ? { username: iceServer.username } : {}),
      ...(iceServer.credential ? { credential: iceServer.credential } : {}),
    });
  }

  return normalized;
};

const resolveCloudflareTurnTtl = (): number => {
  const configured = Number(
    firstNonEmpty(
      process.env.CLOUDFLARE_TURN_TTL_SECONDS,
      process.env.CF_TURN_TTL_SECONDS,
    ),
  );
  if (
    Number.isInteger(configured) &&
    configured > 0 &&
    configured <= CLOUDFLARE_TURN_MAX_TTL_SECONDS
  ) {
    return configured;
  }
  return CLOUDFLARE_TURN_DEFAULT_TTL_SECONDS;
};

const resolveCloudflareTurnIceServers = async (): Promise<IceServer[]> => {
  const turnTokenId = firstNonEmpty(
    process.env.CLOUDFLARE_TURN_TOKEN_ID,
    process.env.CLOUDFLARE_TURN_KEY_ID,
    process.env.CF_TURN_TOKEN_ID,
    process.env.CF_TURN_KEY_ID,
  );
  const turnApiToken = firstNonEmpty(
    process.env.CLOUDFLARE_TURN_API_TOKEN,
    process.env.CLOUDFLARE_TURN_KEY_API_TOKEN,
    process.env.CF_TURN_API_TOKEN,
    process.env.CF_TURN_KEY_API_TOKEN,
  );

  if (!turnTokenId && !turnApiToken) return [];
  if (!turnTokenId || !turnApiToken) {
    if (!turnCredentialWarningLogged) {
      console.warn(
        "[SFU Join] Cloudflare TURN configuration is incomplete; using STUN-only ICE servers.",
      );
      turnCredentialWarningLogged = true;
    }
    return [];
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CLOUDFLARE_TURN_REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(
      `${CLOUDFLARE_TURN_CREDENTIALS_URL}/${encodeURIComponent(turnTokenId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${turnApiToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ ttl: resolveCloudflareTurnTtl() }),
        cache: "no-store",
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      throw new Error(`Cloudflare TURN credential request failed with ${response.status}`);
    }

    const payload = (await response.json()) as CloudflareTurnCredentialsResponse;
    return normalizeIceServers(payload.iceServers);
  } catch (error) {
    console.warn(
      "[SFU Join] Cloudflare TURN credentials unavailable; using STUN-only ICE servers.",
      error,
    );
    return [];
  } finally {
    clearTimeout(timeout);
  }
};

const resolveIceServers = async (): Promise<IceServer[]> => {
  const cloudflareTurnIceServers = await resolveCloudflareTurnIceServers();
  if (cloudflareTurnIceServers.length > 0) {
    return cloudflareTurnIceServers;
  }

  return resolveStunIceServers();
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
  const requestedGhost = Boolean(body?.isGhost);
  const isSuperAdmin =
    Boolean(sessionUser?.id) &&
    isSfuAllowlistedUser({
      id: sessionUser!.id,
      email: sessionUser!.email,
    });
  const isForcedHost =
    !isWebinarAttendeeJoin &&
    (Boolean(
      normalizedSessionEmail && alwaysHostEmails.has(normalizedSessionEmail),
    ) ||
      (isSuperAdmin && requestedGhost));
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
  const { isHost, allowRoomCreation } = resolveHostGrant({
    isWebinarAttendeeJoin,
    isForcedHost,
    scheduledRoomHostMatch,
    isScheduledHostRoom,
    requestedHost,
    // `/abc123` public room links intentionally create the room on first join.
    // This still does not mint host/admin for an existing room; the SFU only
    // promotes the requester through its server-authoritative createdRoom path.
    bodyAllowRoomCreation: Boolean(body?.allowRoomCreation),
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

  const iceServers = await resolveIceServers();

  return NextResponse.json({
    token,
    sfuUrl: routedSfuUrl,
    ...(iceServers.length > 0 ? { iceServers } : {}),
  });
}
