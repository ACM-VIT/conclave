import { createHmac, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import {
  buildGuestUserKey,
  isGuestId,
  isGuestSessionId,
  isReservedGuestSessionId,
  type GuestSession,
} from "./guest-identity";

const PASS_AUDIENCE = "conclave-guest-pass";
const GRANT_AUDIENCE = "conclave-guest-grant";
const PASS_TTL_SECONDS = 30 * 24 * 60 * 60;
const GRANT_TTL_SECONDS = 24 * 60 * 60;

const GUEST_SESSION_EXPIRED =
  "Your guest session has expired. Reload the page to join again.";

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
// to other participants.
const proofOf = (sfuSecret: string, guestId: string): string =>
  createHmac("sha256", signingKey(sfuSecret))
    .update(`proof:${guestId}`)
    .digest("base64url");

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

/**
 * The guest identity for a page render: the one in the pass cookie, or a new
 * one with a grant the first join call turns into that cookie.
 */
export const resolveGuestSession = (
  sfuSecret: string,
  passCookieValue: string | undefined,
): GuestSession => {
  const guestId = verify(sfuSecret, passCookieValue, PASS_AUDIENCE);
  if (guestId) return { id: guestId };
  const fresh = mintGuestId();
  return {
    id: fresh,
    grant: sign(sfuSecret, fresh, GRANT_AUDIENCE, GRANT_TTL_SECONDS),
  };
};

export type GuestJoinIdentity =
  | {
      ok: true;
      userKey: string;
      /** Signed into the join token; the SFU binds the identity to it. */
      guestProof?: string;
      setCookie?: string;
      /** Set for a client that takes its guest identity from the server. */
      issued?: { guestId: string; guestGrant?: string };
    }
  | { ok: false; status: 400 | 409; error: string };

/**
 * Decides who an unauthenticated join is.
 *
 * A client that sends `guestId` (even empty) gets an identity built from a
 * pass this server issued, proven by the pass cookie or a grant.
 *
 * A client that does not is one that still derives `guest-<sessionId>`
 * itself: a tab opened before guest passes shipped, or an older native build.
 * It keeps that identity. Once it holds a pass cookie it proves the pass on
 * every call, so the SFU can bind that identity too. A client with no cookie
 * jar never does, and joins exactly as before.
 */
export const resolveGuestJoinIdentity = (input: {
  sfuSecret: string;
  sessionId: string;
  request: Request;
  guestId: unknown;
  guestGrant: unknown;
}): GuestJoinIdentity => {
  const { sfuSecret, sessionId } = input;
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
  if (!isGuestSessionId(sessionId)) {
    return { ok: false, status: 400, error: "Invalid session ID" };
  }

  const expected = typeof input.guestId === "string" ? input.guestId.trim() : "";
  const fromGrant = verify(sfuSecret, input.guestGrant, GRANT_AUDIENCE);

  let guestId: string;
  if (!expected) {
    guestId = fromCookie ?? fromGrant ?? mintGuestId();
  } else if (expected === fromCookie || expected === fromGrant) {
    guestId = expected;
  } else {
    return { ok: false, status: 409, error: GUEST_SESSION_EXPIRED };
  }

  const provenByCookie = guestId === fromCookie;
  return {
    ok: true,
    userKey: buildGuestUserKey(guestId, sessionId),
    guestProof: proofOf(sfuSecret, guestId),
    // Refresh this pass, or plant it when the browser has none. A valid pass
    // for another identity belongs to another tab and stays.
    ...(usesCookie && (provenByCookie || !fromCookie)
      ? { setCookie: passCookie(sfuSecret, guestId) }
      : {}),
    issued: {
      guestId,
      // Until the cookie comes back on a request, the caller keeps its
      // identity by sending the grant.
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
