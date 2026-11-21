/**
 * The guest identity a page render hands to the browser. `id` is public: it
 * is part of the user id every participant sees. `grant` is a short-lived
 * credential for the same id, present only until the pass cookie is known to
 * work.
 */
export type GuestSession = {
  id: string;
  grant?: string;
};

export const GUEST_GRANT_TTL_SECONDS = 24 * 60 * 60;

/**
 * Whether a page that has held `guest` for `heldMs` should take the guest of
 * a new render before it joins. Only a grant goes stale: a guest with a pass
 * cookie proves itself for as long as the cookie lasts. Half the grant's life
 * leaves room for a browser clock that runs behind the server's.
 */
export const isGuestGrantStale = (
  guest: GuestSession | undefined,
  heldMs: number,
): boolean =>
  Boolean(guest?.grant) && heldMs > (GUEST_GRANT_TTL_SECONDS * 1000) / 2;

const GUEST_ID_PREFIX = "gp_";
const GUEST_ID_PATTERN = /^gp_[A-Za-z0-9_-]{22}$/;
const GUEST_SESSION_ID_PATTERN = /^[^\u0000-\u001f\u007f#@]{1,128}$/;

export const isGuestId = (value: unknown): value is string =>
  typeof value === "string" && GUEST_ID_PATTERN.test(value);

export const isGuestSessionId = (value: string): boolean =>
  GUEST_SESSION_ID_PATTERN.test(value);

/**
 * The user key of one tab of a guest pass. The join route builds it from the
 * pass it verified and the client from the id it was handed, so both sides
 * must agree on this shape.
 */
export const buildGuestUserKey = (guestId: string, sessionId: string): string =>
  `guest-${guestId}.${sessionId}`;

/**
 * Clients that predate guest passes are `guest-<sessionId>`. That key must
 * stay out of the pass namespace, and it must never equal the email that
 * keys a signed-in account.
 */
export const isReservedGuestSessionId = (sessionId: string): boolean =>
  sessionId.startsWith(GUEST_ID_PREFIX) || sessionId.includes("@");
