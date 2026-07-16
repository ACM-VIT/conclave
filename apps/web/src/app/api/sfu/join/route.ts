import jwt from "jsonwebtoken";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { resolveHostGrant } from "@conclave/meeting-core";
import { auth } from "@/lib/auth";
import {
  canonicalizeSfuClientId,
  resolveServerSfuClientId,
} from "@/lib/sfu-client-id";
import { lookupScheduledWebinarByRoomId } from "@/lib/sfu-user-auth";
import {
  normalizeSfuUrl,
  resolveSfuUrls,
} from "@/lib/sfu-url";
import {
  resolveConfiguredOwnerSfuUrl,
  resolveRoomPlacementCapability,
  resolveReservedSfuUrl,
  selectPreOwnerSfu,
  type PreOwnerSfuSelection,
  type SfuPlacementResponse,
  type SfuRoomAssignment,
  type SfuRoutingCandidate,
} from "@/lib/sfu-routing-policy";


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
  ghost?: boolean;
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
const SFU_PLACEMENT_REQUEST_TIMEOUT_MS = 1500;

type RoomRoutingResponse = {
  registryMode?: "local" | "redis";
  local?: boolean;
  owner?: {
    instanceId?: string;
    instanceUrl?: string;
  } | null;
  placement?: SfuRoomAssignment | null;
};

type SfuStatusResponse = {
  instanceId?: string;
  region?: string | null;
  draining?: boolean;
  rooms?: number;
  capabilities?: {
    roomPlacement?: number;
  };
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
let legacyPlacementWarningLogged = false;

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
      const assignment = data.owner ?? data.placement;
      if (
        data.placement &&
        options.candidateSfuUrls.length > 1 &&
        data.registryMode !== "redis"
      ) {
        return null;
      }
      const ownerUrl = resolveConfiguredOwnerSfuUrl(
        assignment?.instanceUrl,
        options.candidateSfuUrls,
      );
      if (ownerUrl) {
        return ownerUrl;
      }
      if (assignment && data.local) {
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
}): Promise<PreOwnerSfuSelection> => {
  const statuses = await Promise.allSettled(
    options.candidateSfuUrls.map(async (candidateSfuUrl, index) => {
      const startedAt = Date.now();
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
        return {
          index,
          url: candidateSfuUrl,
          availability: "unknown",
          latencyMs: Date.now() - startedAt,
        } satisfies SfuRoutingCandidate;
      }

      const status = (await response.json()) as SfuStatusResponse | null;

      return {
        index,
        url: candidateSfuUrl,
        availability:
          status && typeof status === "object"
            ? status.draining === true
              ? "draining"
              : "healthy"
            : "unknown",
        ...(typeof status?.instanceId === "string" && status.instanceId.trim()
          ? { instanceId: status.instanceId.trim() }
          : {}),
        ...(typeof status?.region === "string" && status.region.trim()
          ? { region: status.region.trim() }
          : {}),
        roomPlacementCapability: resolveRoomPlacementCapability(status),
        latencyMs: Date.now() - startedAt,
      } satisfies SfuRoutingCandidate;
    }),
  );

  const candidates = statuses.map((status, index) => {
    if (status.status === "rejected") {
      return {
        index,
        url: options.candidateSfuUrls[index] ?? "",
        availability: "unknown",
        roomPlacementCapability: "unknown",
      } satisfies SfuRoutingCandidate;
    }
    return status.value;
  });

  const selection = selectPreOwnerSfu(candidates, options.routingKey);
  // Stable hashing inside the near-latency band avoids needless placement
  // churn. The shared reservation below is still the concurrency authority.
  return selection;
};

type RoutedSfuResolution =
  | { ok: true; url: string }
  | {
      ok: false;
      reason:
        | "all-draining"
        | "placement-unsupported"
        | "placement-unavailable"
        | "unsafe-local-registry";
    };

const reserveRoomPlacement = async (options: {
  candidate: SfuRoutingCandidate;
  candidateSfuUrls: string[];
  secret: string;
  clientId: string;
  roomId: string;
}): Promise<RoutedSfuResolution> => {
  const placementUrl =
    `${options.candidate.url}/routing/placements/` +
    `${encodeURIComponent(options.clientId)}/` +
    encodeURIComponent(options.roomId);

  let response: Response;
  try {
    response = await fetchWithTimeout(
      placementUrl,
      {
        method: "POST",
        headers: {
          "x-sfu-secret": options.secret,
          accept: "application/json",
        },
        cache: "no-store",
      },
      SFU_PLACEMENT_REQUEST_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, reason: "placement-unavailable" };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason:
        response.status === 409
          ? "all-draining"
          : response.status === 404 ||
              response.status === 405 ||
              response.status === 501
            ? "placement-unsupported"
          : "placement-unavailable",
    };
  }

  let payload: SfuPlacementResponse;
  try {
    payload = (await response.json()) as SfuPlacementResponse;
  } catch {
    return { ok: false, reason: "placement-unavailable" };
  }

  const reserved = resolveReservedSfuUrl({
    response: payload,
    selectedCandidate: options.candidate,
    candidateSfuUrls: options.candidateSfuUrls,
  });
  if (!reserved.ok) {
    return {
      ok: false,
      reason:
        reserved.reason === "unsafe-local-registry"
          ? "unsafe-local-registry"
          : "placement-unavailable",
    };
  }
  return { ok: true, url: reserved.url };
};

const resolveRoutedSfuUrl = async (options: {
  candidateSfuUrls: string[];
  secret: string;
  clientId: string;
  roomId: string;
}): Promise<RoutedSfuResolution> => {
  const candidateSfuUrls = options.candidateSfuUrls
    .map((url) => normalizeSfuUrl(url))
    .filter(Boolean);
  // Ownership lookup and edge-to-SFU health/latency probes are independent.
  // Running them together removes a full regional RTT from first-join startup.
  const [ownerSfuUrl, selection] = await Promise.all([
    resolveRoomOwnerSfuUrl({
      candidateSfuUrls,
      secret: options.secret,
      clientId: options.clientId,
      roomId: options.roomId,
    }),
    resolveNonDrainingSfuUrl({
      candidateSfuUrls,
      secret: options.secret,
      routingKey: `${options.clientId}:${options.roomId}`,
    }),
  ]);
  if (ownerSfuUrl) {
    return { ok: true, url: ownerSfuUrl };
  }
  if (selection.kind === "selected") {
    if (selection.availability === "unknown" && !sfuStatusWarningLogged) {
      console.warn(
        "[SFU Join] No healthy SFU status response was available; using a deterministic unknown SFU and excluding explicitly draining instances.",
      );
      sfuStatusWarningLogged = true;
    }
    if (selection.candidate.roomPlacementCapability === "legacy") {
      if (!legacyPlacementWarningLogged) {
        console.warn(
          "[SFU Join] Selected SFU predates atomic room placement; using the stable deterministic route during the rolling upgrade.",
        );
        legacyPlacementWarningLogged = true;
      }
      return { ok: true, url: selection.candidate.url };
    }

    let everyAttemptWasDraining = true;
    // A timed-out reservation may still have committed in Redis. Trying the
    // next healthy candidate is safe: its atomic response returns that first
    // winner instead of creating a second placement.
    const reservationCandidates = [
      selection.candidate,
      ...selection.alternatives,
    ];
    for (let index = 0; index < reservationCandidates.length; index += 1) {
      const candidate = reservationCandidates[index];
      if (!candidate) continue;
      const reservation = await reserveRoomPlacement({
        candidate,
        candidateSfuUrls,
        secret: options.secret,
        clientId: options.clientId,
        roomId: options.roomId,
      });
      if (reservation.ok) {
        return reservation;
      }
      if (reservation.reason === "unsafe-local-registry") {
        return reservation;
      }
      if (index === 0 && reservation.reason === "placement-unsupported") {
        if (!legacyPlacementWarningLogged) {
          console.warn(
            "[SFU Join] Selected SFU does not expose atomic room placement; using the stable deterministic route during the rolling upgrade.",
          );
          legacyPlacementWarningLogged = true;
        }
        return { ok: true, url: selection.candidate.url };
      }
      if (reservation.reason !== "all-draining") {
        everyAttemptWasDraining = false;
      }
    }
    return {
      ok: false,
      reason: everyAttemptWasDraining
        ? "all-draining"
        : "placement-unavailable",
    };
  }
  if (selection.kind === "all-draining") {
    if (!sfuStatusWarningLogged) {
      console.warn(
        "[SFU Join] Every configured SFU is draining; refusing to route a new room.",
      );
      sfuStatusWarningLogged = true;
    }
    return { ok: false, reason: "all-draining" };
  }
  return { ok: false, reason: "placement-unavailable" };
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
  const headerClientId = canonicalizeSfuClientId(
    request.headers.get("x-sfu-client"),
  );
  const bodyClientId = canonicalizeSfuClientId(body?.clientId);
  return headerClientId || bodyClientId || resolveServerSfuClientId();
};

export async function POST(request: Request) {
  let body: JoinRequestBody;
  try {
    body = (await request.json()) as JoinRequestBody;
  } catch (_error) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body?.isGhost === true || body?.ghost === true) {
    return NextResponse.json(
      { error: "Ghost mode is not supported." },
      { status: 410 },
    );
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
  const routedSfu = await resolveRoutedSfuUrl({
    candidateSfuUrls: resolveSfuUrls(),
    secret,
    clientId,
    roomId,
  });
  if (!routedSfu.ok) {
    const allDraining = routedSfu.reason === "all-draining";
    const unsafeLocalRegistry =
      routedSfu.reason === "unsafe-local-registry";
    return NextResponse.json(
      {
        error: allDraining
          ? "Meeting servers are draining. Try again shortly."
          : unsafeLocalRegistry
            ? "Meeting placement requires the shared room registry. Try again shortly."
            : "Meeting placement is temporarily unavailable. Try again shortly.",
      },
      {
        status: 503,
        headers: { "Retry-After": allDraining ? "5" : "2" },
      },
    );
  }
  const routedSfuUrl = routedSfu.url;
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
      roomId,
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
