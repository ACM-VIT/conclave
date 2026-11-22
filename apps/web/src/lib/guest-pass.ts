import { createHmac, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";

const PASS_AUDIENCE = "conclave-guest-pass";
const GRANT_AUDIENCE = "conclave-guest-grant";
const PASS_TTL_SECONDS = 30 * 24 * 60 * 60;
const GRANT_TTL_SECONDS = 24 * 60 * 60;

const GUEST_ID_PREFIX = "gp_";
const GUEST_ID_PATTERN = /^gp_[A-Za-z0-9_-]{22}$/;
const GUEST_SESSION_ID_PATTERN = /^[^\u0000-\u001f\u007f#@]{1,128}$/;

const isGuestId = (value: unknown): value is string =>
  typeof value === "string" && GUEST_ID_PATTERN.test(value);

/**
 * Clients that predate guest passes are `guest-<sessionId>`. That key must
 * stay out of the namespace of issued seat keys, and it must never equal the
 * email that keys a signed-in account.
 */
const isReservedGuestSessionId = (sessionId: string): boolean =>
  sessionId.startsWith(GUEST_ID_PREFIX) || sessionId.includes("@");

// Same switch better-auth uses for its session cookie (see lib/auth.ts).
const usesSecureCookie = (): boolean => process.env.NODE_ENV === "production";

// A derived key, so a pass or grant can never verify as an SFU join token.
const signingKey = (sfuSecret: string): Buffer =>
  createHmac("sha256", sfuSecret).update("conclave-guest-pass-v1").digest();

/**
 * The __Host- prefix stops a sibling subdomain from planting its own pass.
 * The suffix is per secret: stacks on localhost share one cookie jar across
 * ports, and a shared name would let each replace the other's pass.
 */
export const guestPassCookieName = (sfuSecret: string): string => {
  const scope = createHmac("sha256", signingKey(sfuSecret))
    .update("cookie-name")
    .digest("hex")
    .slice(0, 8);
  return `${usesSecureCookie() ? "__Host-" : ""}conclave-guest-${scope}`;
};

const sign = (
  sfuSecret: string,
  guestId: string,
  audience: string,
  ttlSeconds: number,
): string =>
  jwt.sign({ gid: guestId }, signingKey(sfuSecret), {
    algorithm: "HS256",
    audience,
    expiresIn: ttlSeconds,
  });

const verify = (
  sfuSecret: string,
  token: unknown,
  audience: string,
): string | null => {
  if (typeof token !== "string" || !token) return null;
  try {
    const payload = jwt.verify(token, signingKey(sfuSecret), {
      algorithms: ["HS256"],
      audience,
    });
    const guestId: unknown = typeof payload === "object" ? payload.gid : null;
    return isGuestId(guestId) ? guestId : null;
  } catch {
    return null;
  }
};

const mintGuestId = (): string =>
  `gp_${randomBytes(16).toString("base64url")}`;

// What the SFU binds a guest identity to. Derived from the pass, never shown
// to other participants. It is the same in every room and tab, which is how
// the SFU tells that two seats belong to one guest.
const proofOf = (sfuSecret: string, guestId: string): string =>
  createHmac("sha256", signingKey(sfuSecret))
    .update(`proof:${guestId}`)
    .digest("base64url");

export type GuestSeat = {
  clientId: string;
  roomId: string;
  sessionId: string;
};

/**
 * The public user key of one guest seat: this pass, in this room, in this
 * tab. Every participant sees it, so it must not say which pass is behind
 * it. As a keyed hash, the keys one browser gets in two rooms or two tabs
 * cannot be linked, and nobody can produce a key without the pass.
 */
const seatKeyOf = (sfuSecret: string, guestId: string, seat: GuestSeat): string => {
  const digest = createHmac("sha256", signingKey(sfuSecret))
    .update(
      JSON.stringify(["seat", guestId, seat.clientId, seat.roomId, seat.sessionId]),
    )
    .digest("base64url");
  return `guest-${GUEST_ID_PREFIX}${digest.slice(0, 22)}`;
};

// A cookie value may arrive in double quotes (RFC 6265). The Android app's
// cookie jar sends a cookie that was set with Max-Age back that way.
const readCookie = (header: string | null, name: string): string | undefined => {
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      return part
        .slice(separator + 1)
        .trim()
        .replace(/^"(.*)"$/, "$1");
    }
  }
  return undefined;
};

const passCookie = (sfuSecret: string, guestId: string): string =>
  [
    `${guestPassCookieName(sfuSecret)}=${sign(sfuSecret, guestId, PASS_AUDIENCE, PASS_TTL_SECONDS)}`,
    "Path=/",
    `Max-Age=${PASS_TTL_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(usesSecureCookie() ? ["Secure"] : []),
  ].join("; ");

/**
 * The `Set-Cookie` value that gives a browser a guest pass, when the request
 * shows it has none. The page proxy calls this for every page load, so a tab
 * carries its pass before it makes any join call and all tabs of a browser
 * share one.
 */
export const guestPassCookieForNewBrowser = (
  sfuSecret: string,
  cookieHeader: string | null,
): string | undefined => {
  const current = readCookie(cookieHeader, guestPassCookieName(sfuSecret));
  if (verify(sfuSecret, current, PASS_AUDIENCE)) return undefined;
  return passCookie(sfuSecret, mintGuestId());
};

/**
 * The seat a tab held before, read from the join token of its previous join
 * for this room. It matters when the browser's pass has changed since: two
 * tabs can each be given a pass before either has a cookie, and the browser
 * keeps only one. The tab then joins under the pass in the cookie, and this
 * tells the SFU which seat it was, with that seat's proof, so what the seat
 * held moves to the new key.
 */
const formerSeatOf = (
  sfuSecret: string,
  previousToken: unknown,
  seat: GuestSeat,
  userKey: string,
): { userKey: string; guestProof: string } | undefined => {
  if (typeof previousToken !== "string" || !previousToken) return undefined;
  let claims: Record<string, unknown>;
  try {
    const payload = jwt.verify(previousToken, sfuSecret, {
      algorithms: ["HS256"],
    });
    if (typeof payload !== "object") return undefined;
    claims = payload;
  } catch {
    return undefined;
  }
  const { userId, guestProof } = claims;
  if (
    typeof userId !== "string" ||
    typeof guestProof !== "string" ||
    !userId.startsWith(`guest-${GUEST_ID_PREFIX}`) ||
    userId === userKey ||
    claims.guestRoom !== seat.roomId ||
    claims.clientId !== seat.clientId ||
    claims.sessionId !== seat.sessionId
  ) {
    return undefined;
  }
  return { userKey: userId, guestProof };
};

// The pass cookie is SameSite=Lax, so a form post from another site arrives
// without it. Answering that post with a new pass would replace the
// visitor's own, so such a request gets no cookie handling at all.
const isCrossSiteRequest = (request: Request): boolean => {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite !== "same-origin" && fetchSite !== "none";
  // Browsers too old to send Sec-Fetch-Site still send Origin on a POST.
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const url = new URL(request.url);
  const protocol =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    url.protocol.slice(0, -1);
  const host = request.headers.get("host") ?? url.host;
  return origin !== `${protocol}://${host}`;
};

export type GuestJoinIdentity =
  | {
      ok: true;
      userKey: string;
      /** Signed into the join token; the SFU binds the identity to it. */
      guestProof?: string;
      /** Signed into the join token; the SFU lets it join no other room. */
      guestRoom?: string;
      /** Signed into the join token; the seat this tab held under another pass. */
      guestWas?: { userKey: string; guestProof: string };
      setCookie?: string;
      /**
       * Set for a client that takes its guest identity from the server: the
       * pass it now goes by, and a grant for it until the cookie comes back.
       */
      issued?: { guestId: string; guestGrant?: string };
    }
  | { ok: false; status: 400; error: string };

/**
 * Decides who an unauthenticated join is.
 *
 * A client that sends `guestId` gets a seat key built from a pass this
 * server issued: the pass in the browser's cookie, else the one a grant
 * proves, else a new one. The cookie always wins, so every tab of a browser
 * converges on one pass. A tab that joined under another pass before the
 * cookie settled sends the token of that join (`guestSeatToken`), and keeps
 * what its seat held (see `formerSeatOf`).
 *
 * A client that does not send `guestId` is one that still derives
 * `guest-<sessionId>` itself: a tab opened before guest passes shipped, or an
 * older native build. It keeps that identity. Once it holds a pass cookie it
 * proves the pass on every call, so the SFU can bind that identity too. A
 * client with no cookie jar never does, and joins exactly as before.
 */
export const resolveGuestJoinIdentity = (input: {
  sfuSecret: string;
  seat: GuestSeat;
  request: Request;
  guestId: unknown;
  guestGrant: unknown;
  guestSeatToken?: unknown;
}): GuestJoinIdentity => {
  const { sfuSecret, seat } = input;
  const { sessionId } = seat;
  const usesCookie = !isCrossSiteRequest(input.request);
  const fromCookie = usesCookie
    ? verify(
        sfuSecret,
        readCookie(
          input.request.headers.get("cookie"),
          guestPassCookieName(sfuSecret),
        ),
        PASS_AUDIENCE,
      )
    : null;

  if (input.guestId === undefined) {
    if (isReservedGuestSessionId(sessionId)) {
      return { ok: false, status: 400, error: "Invalid session ID" };
    }
    return {
      ok: true,
      userKey: `guest-${sessionId}`,
      ...(fromCookie ? { guestProof: proofOf(sfuSecret, fromCookie) } : {}),
      ...(usesCookie
        ? { setCookie: passCookie(sfuSecret, fromCookie ?? mintGuestId()) }
        : {}),
    };
  }
  if (!GUEST_SESSION_ID_PATTERN.test(sessionId)) {
    return { ok: false, status: 400, error: "Invalid session ID" };
  }

  const guestId =
    fromCookie ??
    verify(sfuSecret, input.guestGrant, GRANT_AUDIENCE) ??
    mintGuestId();
  const provenByCookie = guestId === fromCookie;
  const userKey = seatKeyOf(sfuSecret, guestId, seat);
  const guestWas = formerSeatOf(sfuSecret, input.guestSeatToken, seat, userKey);
  return {
    ok: true,
    userKey,
    guestProof: proofOf(sfuSecret, guestId),
    guestRoom: seat.roomId,
    ...(guestWas ? { guestWas } : {}),
    // Refresh the pass in the cookie, or plant this one when the browser
    // has none.
    ...(usesCookie ? { setCookie: passCookie(sfuSecret, guestId) } : {}),
    issued: {
      guestId,
      // Until the cookie comes back on a request, the caller keeps its
      // pass by sending the grant.
      ...(provenByCookie
        ? {}
        : {
            guestGrant: sign(
              sfuSecret,
              guestId,
              GRANT_AUDIENCE,
              GRANT_TTL_SECONDS,
            ),
          }),
    },
  };
};
