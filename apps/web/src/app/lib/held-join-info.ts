/**
 * The join route's last answer for the meeting, kept so a reconnect can go
 * straight back to the SFU when the web app is slow or down.
 */
export type HeldJoinInfo<T extends { token: string }> = {
  joinInfo: T;
  roomId: string;
  /** What the token was issued for. A different grant needs a new token. */
  grant: string;
};

const TOKEN_EXPIRY_MARGIN_MS = 5 * 60_000;

const readTokenExpiryMs = (token: string): number | null => {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
    );
    const expirySeconds =
      claims && typeof claims === "object" && "exp" in claims
        ? claims.exp
        : null;
    return typeof expirySeconds === "number" && Number.isFinite(expirySeconds)
      ? expirySeconds * 1000
      : null;
  } catch {
    return null;
  }
};

/** The held answer, when it is for this join and its token is not near expiry. */
export const getReusableJoinInfo = <T extends { token: string }>(
  held: HeldJoinInfo<T> | null,
  wanted: { roomId: string; grant: string; now: number },
): T | null => {
  if (!held || held.roomId !== wanted.roomId || held.grant !== wanted.grant) {
    return null;
  }
  const expiresAt = readTokenExpiryMs(held.joinInfo.token);
  return expiresAt !== null && expiresAt - wanted.now > TOKEN_EXPIRY_MARGIN_MS
    ? held.joinInfo
    : null;
};

export type JoinInfoPlan<T> =
  /** Go to the SFU with the held answer; do not call the join route. */
  | { source: "held"; joinInfo: T }
  /** Ask the join route, and use the held answer if it cannot be reached. */
  | { source: "fresh"; fallback: T | null };

/**
 * A reconnect tries the held answer first, because it needs nothing from the
 * web app. If that attempt fails, later attempts ask the join route again so
 * a moved room or a rejected token is picked up, and fall back to the held
 * answer only while the route is unreachable.
 */
export const planJoinInfo = <T extends { token: string }>({
  held,
  roomId,
  grant,
  now,
  isFirstReconnectAttempt,
}: {
  held: HeldJoinInfo<T> | null;
  roomId: string;
  grant: string;
  now: number;
  isFirstReconnectAttempt: boolean;
}): JoinInfoPlan<T> => {
  const reusable = getReusableJoinInfo(held, { roomId, grant, now });
  return reusable && isFirstReconnectAttempt
    ? { source: "held", joinInfo: reusable }
    : { source: "fresh", fallback: reusable };
};
