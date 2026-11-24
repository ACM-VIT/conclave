import { createHmac, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import {
  issueRoomScopedClaims,
  issueSelfNamedGuestClaims,
  MAX_OTHER_GUEST_SEATS,
  type RoomScopedClaims,
  type SelfNamedGuestClaims,
} from "@conclave/meeting-core/guest-join-claims";

const PASS_AUDIENCE = "conclave-guest-pass";
const GRANT_AUDIENCE = "conclave-guest-grant";
const PASS_TTL_SECONDS = 30 * 24 * 60 * 60;
const GRANT_TTL_SECONDS = 24 * 60 * 60;
// A token has room for every pass this reads (see MAX_OTHER_GUEST_SEATS).
const MAX_BROWSER_PASSES = MAX_OTHER_GUEST_SEATS + 1;
// Signatures checked per request, whatever a client puts in its cookies.
const MAX_PASS_COOKIES_CHECKED = 64;

const GUEST_ID_PREFIX = "gp_";
const GUEST_SESSION_ID_PATTERN = /^[^\u0000-\u001f\u007f#@]{1,128}$/;

const guestPassIdSchema = z
  .string()
  .regex(/^gp_[A-Za-z0-9_-]{22}$/)
  .brand<"GuestPassId">();
type GuestPassId = z.infer<typeof guestPassIdSchema>;

/** What a pass cookie and a grant carry once their signature checks out. */
const passClaimsSchema = z.object({ gid: guestPassIdSchema });

/**
 * The guest side of a join request. A client that sends `guestId` takes its
 * identity from this server. `guestGrant` stands in for a pass cookie the
 * client could not send, and a malformed one counts as none.
 * `guestJoinedAs` lists the passes the tab has joined under. It proves
 * nothing. It only says which of the browser's own passes matter to this
 * tab, should the browser hold more than a token can name.
 */
const guestJoinRequestSchema = z
  .object({
    guestId: z.unknown(),
    guestGrant: z.string().optional().catch(undefined),
    guestJoinedAs: z.array(guestPassIdSchema).max(8).catch([]).default([]),
  })
  .transform(({ guestId, guestGrant, guestJoinedAs }) => ({
    takesIdentityFromServer: guestId !== undefined,
    guestGrant,
    joinedAs: guestJoinedAs,
  }));

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

const keyedHash = (sfuSecret: string, input: string): Buffer =>
  createHmac("sha256", signingKey(sfuSecret)).update(input).digest();

/**
 * Every pass has a cookie of its own, and all of them start with this.
 *
 * The __Host- prefix stops a sibling subdomain from planting a pass. The
 * scope is per secret: stacks on localhost share one cookie jar across
 * ports, and a shared name would let each read the other's cookies as its
 * own.
 */
export const guestPassCookiePrefix = (sfuSecret: string): string => {
  const scope = keyedHash(sfuSecret, "cookie-name").toString("hex").slice(0, 8);
  return `${usesSecureCookie() ? "__Host-" : ""}conclave-guest-${scope}-`;
};

// One cookie per pass. Two responses that each give a new browser a pass
// then leave it holding both, where one shared name would let the later
// response erase the earlier pass, and with it the only thing that ties the
// browser to the seats it took under that pass.
const passCookieName = (sfuSecret: string, guestId: GuestPassId): string =>
  guestPassCookiePrefix(sfuSecret) +
  keyedHash(sfuSecret, `cookie-slot:${guestId}`).toString("hex").slice(0, 8);

const sign = (
  sfuSecret: string,
  guestId: GuestPassId,
  audience: string,
  ttlSeconds: number,
): string =>
  jwt.sign({ gid: guestId }, signingKey(sfuSecret), {
    algorithm: "HS256",
    audience,
    expiresIn: ttlSeconds,
  });

const readPass = (
  sfuSecret: string,
  token: string | undefined,
  audience: string,
): GuestPassId | null => {
  if (!token) return null;
  try {
    return passClaimsSchema.parse(
      jwt.verify(token, signingKey(sfuSecret), {
        algorithms: ["HS256"],
        audience,
      }),
    ).gid;
  } catch {
    return null;
  }
};

const mintGuestId = (): GuestPassId =>
  guestPassIdSchema.parse(`gp_${randomBytes(16).toString("base64url")}`);

// What the SFU knows a guest by. Derived from the pass, never shown to other
// participants. It is the same in every room and tab, which is how the SFU
// tells that two seats belong to one guest.
const proofOf = (sfuSecret: string, guestId: GuestPassId): string =>
  keyedHash(sfuSecret, `proof:${guestId}`).toString("base64url");

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
const seatKeyOf = (
  sfuSecret: string,
  guestId: GuestPassId,
  seat: GuestSeat,
): string => {
  const digest = keyedHash(
    sfuSecret,
    JSON.stringify(["seat", guestId, seat.clientId, seat.roomId, seat.sessionId]),
  ).toString("base64url");
  return `guest-${GUEST_ID_PREFIX}${digest.slice(0, 22)}`;
};

/**
 * The passes the browser holds. The first is the lowest id, and it is the
 * pass the browser goes by: that choice depends on nothing but the passes
 * themselves, so every tab and every request makes it the same way,
 * whatever order the passes arrived in. Every pass the browser sends is
 * returned, up to what a token can name.
 *
 * A cookie value may arrive in double quotes (RFC 6265). The Android app's
 * cookie jar sends a cookie that was set with Max-Age back that way.
 */
const readBrowserPasses = (
  sfuSecret: string,
  cookieHeader: string | null,
  joinedAs: readonly GuestPassId[] = [],
): GuestPassId[] => {
  const prefix = guestPassCookiePrefix(sfuSecret);
  const passes = new Set<GuestPassId>();
  let checked = 0;
  for (const part of cookieHeader?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator <= 0 || !part.slice(0, separator).trim().startsWith(prefix)) {
      continue;
    }
    if ((checked += 1) > MAX_PASS_COOKIES_CHECKED) break;
    const pass = readPass(
      sfuSecret,
      part
        .slice(separator + 1)
        .trim()
        .replace(/^"(.*)"$/, "$1"),
      PASS_AUDIENCE,
    );
    if (pass) passes.add(pass);
  }
  const [lowest, ...others] = [...passes].sort();
  if (others.length < MAX_BROWSER_PASSES) {
    return lowest === undefined ? [] : [lowest, ...others];
  }
  // More passes than a token can name. None is dropped without a trace, and
  // the ones this tab joined under go first: its rights are under those.
  console.warn(
    `[Guest pass] A browser sent ${passes.size} passes. A join token names ${MAX_BROWSER_PASSES}.`,
  );
  return [
    lowest,
    ...others.filter((pass) => joinedAs.includes(pass)),
    ...others.filter((pass) => !joinedAs.includes(pass)),
  ].slice(0, MAX_BROWSER_PASSES);
};

const passCookie = (sfuSecret: string, guestId: GuestPassId): string =>
  [
    `${passCookieName(sfuSecret, guestId)}=${sign(sfuSecret, guestId, PASS_AUDIENCE, PASS_TTL_SECONDS)}`,
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
 * The `Set-Cookie` value that gives a browser a guest pass, when the request
 * shows it has none. A page asks for this as soon as it loads
 * (`/api/guest-pass`), so a tab carries its pass before it makes any join
 * call and the tabs of a browser share one.
 */
export const guestPassCookieForNewBrowser = (
  sfuSecret: string,
  request: Request,
): string | undefined => {
  if (isCrossSiteRequest(request)) return undefined;
  const held = readBrowserPasses(sfuSecret, request.headers.get("cookie"));
  return held.length > 0 ? undefined : passCookie(sfuSecret, mintGuestId());
};

export type GuestJoinIdentity =
  | {
      ok: true;
      userKey: string;
      /** The guest claims to sign into the join token, as the SFU parses them. */
      claims: RoomScopedClaims | SelfNamedGuestClaims;
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
 * server issued: the lowest pass among the browser's cookies, else the one a
 * grant proves, else a new one.
 *
 * A browser can hold more than one pass, when several of its first requests
 * were each answered before any cookie had arrived. A tab may then have
 * joined under a pass that is not the one the browser goes by. The token
 * therefore also names the seat this tab would hold under every other pass
 * in the browser's cookies (`guestWas`), and the SFU treats all of them as
 * one guest. Only the pass cookies vouch for that. They are HttpOnly, so
 * holding a copy of a join token is not enough to be taken for its guest
 * under another pass.
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
  /** The body of the join request. */
  body: unknown;
}): GuestJoinIdentity => {
  const { sfuSecret, seat } = input;
  const { sessionId } = seat;
  const caller = guestJoinRequestSchema.safeParse(input.body).data ?? {
    takesIdentityFromServer: false,
    guestGrant: undefined,
    joinedAs: [],
  };
  const usesCookie = !isCrossSiteRequest(input.request);
  const held = usesCookie
    ? readBrowserPasses(
        sfuSecret,
        input.request.headers.get("cookie"),
        caller.joinedAs,
      )
    : [];
  const fromCookie = held.at(0);

  if (!caller.takesIdentityFromServer) {
    if (isReservedGuestSessionId(sessionId)) {
      return { ok: false, status: 400, error: "Invalid session ID" };
    }
    const { claims } = issueSelfNamedGuestClaims({
      userId: `guest-${sessionId}`,
      ...(fromCookie ? { guestProof: proofOf(sfuSecret, fromCookie) } : {}),
    });
    if (!claims) {
      return { ok: false, status: 400, error: "Invalid session ID" };
    }
    return {
      ok: true,
      userKey: claims.userId,
      claims,
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
    readPass(sfuSecret, caller.guestGrant, GRANT_AUDIENCE) ??
    mintGuestId();
  const otherSeats = held
    .filter((pass) => pass !== guestId)
    .map((pass) => ({
      userKey: seatKeyOf(sfuSecret, pass, seat),
      guestProof: proofOf(sfuSecret, pass),
    }));
  const { claims, invalid } = issueRoomScopedClaims({
    userId: seatKeyOf(sfuSecret, guestId, seat),
    guestProof: proofOf(sfuSecret, guestId),
    guestRoom: seat.roomId,
    clientId: seat.clientId,
    sessionId,
    ...(otherSeats.length > 0 ? { guestWas: otherSeats } : {}),
  });
  if (!claims) {
    // A value the caller sent cannot go into a join token.
    return {
      ok: false,
      status: 400,
      error: invalid === "guestRoom" ? "Invalid room ID" : "Invalid session ID",
    };
  }
  return {
    ok: true,
    userKey: claims.userId,
    claims,
    // Refresh the pass the browser goes by, or plant this one when the
    // browser has none.
    ...(usesCookie ? { setCookie: passCookie(sfuSecret, guestId) } : {}),
    issued: {
      guestId,
      // Until the cookie comes back on a request, the caller keeps its
      // pass by sending the grant.
      ...(guestId === fromCookie
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
