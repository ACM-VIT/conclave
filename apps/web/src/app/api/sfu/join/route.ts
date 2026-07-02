import jwt from "jsonwebtoken";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { resolveHostGrant } from "@conclave/meeting-core";
import { auth } from "@/lib/auth";
import { isSfuAllowlistedUser } from "@/lib/sfu-admin-auth";
import { resolveServerSfuClientId } from "@/lib/sfu-client-id";
import { lookupScheduledWebinarByRoomId } from "@/lib/sfu-user-auth";
import {
  normalizeRoutedSfuUrl,
  normalizeSfuUrl,
  resolveSfuUrl,
  resolveSfuUrls,
} from "@/lib/sfu-url";


let loggedSecretFingerprint = false;
const logSecretFingerprint = (secret: string): void => {
  if (loggedSecretFingerprint) return;
  loggedSecretFingerprint = true;
  if (process.env.SFU_DEBUG_SECRET === "0") return;
  const fp = createHash("sha256").update(secret).digest("hex").slice(0, 12);
  const source = process.env.SFU_SECRET
    ? "process.env (loaded by Next.js)"
    : "fallback literal";
  console.info(
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
const CLOUDFLARE_TURN_REQUEST_TIMEOUT_MS = 1500;
const SFU_ROUTING_REQUEST_TIMEOUT_MS = 1000;
const SFU_STATUS_REQUEST_TIMEOUT_MS = 1000;

type RoomRoutingResponse = {
  local?: boolean;
  owner?: {
    instanceId?: string;
    instanceUrl?: string;
  } | null;
};

type SfuStatusResponse = {
  instanceId?: string;
  draining?: boolean;
  rooms?: number;
};

type AvailableSfu = {
  index: number;
  url: string;
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
let sfuStatusWarningLogged = false;

const fetchWithTimeout = async (
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

const pickStableSfuUrl = (
  available: AvailableSfu[],
  routingKey: string,
): string | null => {
  if (available.length === 0) return null;
  if (available.length === 1) return available[0]?.url ?? null;

  const ordered = [...available].sort((a, b) => a.index - b.index);
  const digest = createHash("sha256").update(routingKey).digest();
  const index = digest.readUInt32BE(0) % ordered.length;
  return ordered[index]?.url ?? null;
};

const resolveRoomOwnerSfuUrl = async (options: {
  candidateSfuUrls: string[];
  secret: string;
  clientId: string;
  roomId: string;
}): Promise<string | null> => {
  const lookups = await Promise.allSettled(
    options.candidateSfuUrls.map(async (candidateSfuUrl) => {
      const routingUrl =
        `${candidateSfuUrl}/routing/rooms/` +
        `${encodeURIComponent(options.clientId)}/` +
        encodeURIComponent(options.roomId);
      const response = await fetchWithTimeout(
        routingUrl,
        {
          method: "GET",
          headers: {
            "x-sfu-secret": options.secret,
            accept: "application/json",
          },
          cache: "no-store",
        },
        SFU_ROUTING_REQUEST_TIMEOUT_MS,
      );
      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as RoomRoutingResponse;
      const ownerUrl = normalizeRoutedSfuUrl(data.owner?.instanceUrl);
      if (ownerUrl) {
        return ownerUrl;
      }
      if (data.owner && data.local) {
        return candidateSfuUrl;
      }
      return null;
    }),
  );

  let sawFailure = false;
  for (const lookup of lookups) {
    if (lookup.status === "rejected") {
      sawFailure = true;
      continue;
    }
    if (lookup.value) {
      return lookup.value;
    }
  }

  if (sawFailure && !roomRoutingWarningLogged) {
    console.warn(
      "[SFU Join] Some room routing lookups failed; continuing with available SFUs.",
    );
    roomRoutingWarningLogged = true;
  }

  return null;
};

const resolveNonDrainingSfuUrl = async (options: {
  candidateSfuUrls: string[];
  secret: string;
  routingKey: string;
}): Promise<string | null> => {
  const statuses = await Promise.allSettled(
    options.candidateSfuUrls.map(async (candidateSfuUrl, index) => {
      const response = await fetchWithTimeout(
        `${candidateSfuUrl}/status`,
        {
          method: "GET",
          headers: {
            "x-sfu-secret": options.secret,
            accept: "application/json",
          },
          cache: "no-store",
        },
        SFU_STATUS_REQUEST_TIMEOUT_MS,
      );
      if (!response.ok) {
        return null;
      }

      const status = (await response.json()) as SfuStatusResponse;
      if (status.draining) {
        return null;
      }

      return { index, url: candidateSfuUrl } satisfies AvailableSfu;
    }),
  );

  let sawFailure = false;
  const available = statuses.flatMap((status) => {
    if (status.status === "rejected") {
      sawFailure = true;
      return [];
    }
    return status.value ? [status.value] : [];
  });

  if (available.length === 0) {
    if (
      (sawFailure || options.candidateSfuUrls.length > 1) &&
      !sfuStatusWarningLogged
    ) {
      console.warn(
        "[SFU Join] No non-draining SFU status response was available; falling back to the first configured SFU.",
      );
      sfuStatusWarningLogged = true;
    }
    return null;
  }

  // Before any SFU owns a room, concurrent first joins for the same link must
  // still land on the same instance. Otherwise a degraded/missing registry can
  // split one meeting code into parallel rooms.
  return pickStableSfuUrl(available, options.routingKey);
};

const resolveRoutedSfuUrl = async (options: {
  candidateSfuUrls: string[];
  secret: string;
  clientId: string;
  roomId: string;
}): Promise<string> => {
  const candidateSfuUrls = options.candidateSfuUrls
    .map((url) => normalizeSfuUrl(url))
    .filter(Boolean);
  const fallbackSfuUrl = candidateSfuUrls[0] ?? normalizeSfuUrl(resolveSfuUrl());

  const ownerSfuUrl = await resolveRoomOwnerSfuUrl({
    candidateSfuUrls,
    secret: options.secret,
    clientId: options.clientId,
    roomId: options.roomId,
  });
  if (ownerSfuUrl) {
    return ownerSfuUrl;
  }

  const availableSfuUrl = await resolveNonDrainingSfuUrl({
    candidateSfuUrls,
    secret: options.secret,
    routingKey: `${options.clientId}:${options.roomId}`,
  });
  return availableSfuUrl ?? fallbackSfuUrl;
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
  const headerClientId = request.headers.get("x-sfu-client")?.trim() || "";
  const bodyClientId = body?.clientId?.trim() || "";
  return headerClientId || bodyClientId || resolveServerSfuClientId();
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

  const iceServersPromise = resolveIceServers();
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
  const canGhostJoin = !isWebinarAttendeeJoin && requestedGhost && isSuperAdmin;
  if (requestedGhost && !canGhostJoin) {
    return NextResponse.json(
      { error: "Ghost mode is not available for this session" },
      { status: 403 },
    );
  }
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
    candidateSfuUrls: resolveSfuUrls(),
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
      canGhostJoin,
      clientId,
      sessionId,
      joinMode,
    },
    secret,
    { expiresIn: "12h" },
  );

  const iceServers = await iceServersPromise;

  return NextResponse.json({
    token,
    sfuUrl: routedSfuUrl,
    ...(iceServers.length > 0 ? { iceServers } : {}),
  });
}
