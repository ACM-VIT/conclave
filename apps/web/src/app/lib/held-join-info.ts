/** Who a join answer was issued to, and as what. */
export type JoinGrant = {
  joinMode: string;
  userId: string;
  isHost: boolean;
};

type HoldableJoinInfo = {
  token: string;
  /** How long the answer's TURN credentials last, when it has any. */
  iceServersTtlSeconds?: number;
};

/**
 * The join route's last answer for the meeting, kept so a reconnect can go
 * straight back to the SFU when the web app is slow or down.
 */
export type HeldJoinInfo<T extends HoldableJoinInfo> = {
  joinInfo: T;
  roomId: string;
  grant: JoinGrant;
  /** When the token or the TURN credentials run out, whichever is first. */
  expiresAt: number | null;
};

const EXPIRY_MARGIN_MS = 5 * 60_000;

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

export const holdJoinInfo = <T extends HoldableJoinInfo>(
  joinInfo: T,
  {
    roomId,
    grant,
    receivedAt,
  }: { roomId: string; grant: JoinGrant; receivedAt: number },
): HeldJoinInfo<T> => {
  const tokenExpiresAt = readTokenExpiryMs(joinInfo.token);
  const turnTtlSeconds = joinInfo.iceServersTtlSeconds;
  const turnExpiresAt =
    typeof turnTtlSeconds === "number" && Number.isFinite(turnTtlSeconds)
      ? receivedAt + turnTtlSeconds * 1000
      : null;
  return {
    joinInfo,
    roomId,
    grant,
    expiresAt:
      tokenExpiresAt === null || turnExpiresAt === null
        ? tokenExpiresAt
        : Math.min(tokenExpiresAt, turnExpiresAt),
  };
};

// A participant token still works after a promotion, because the SFU makes a
// promoted user host again from the room. A host token is never reused for less.
const grantCovers = (held: JoinGrant, wanted: JoinGrant): boolean =>
  held.joinMode === wanted.joinMode &&
  held.userId === wanted.userId &&
  (!held.isHost || wanted.isHost);

/** The held answer, when it is for this join and is not near expiry. */
export const getReusableJoinInfo = <T extends HoldableJoinInfo>(
  held: HeldJoinInfo<T> | null,
  wanted: { roomId: string; grant: JoinGrant; now: number },
): T | null => {
  if (
    !held ||
    held.roomId !== wanted.roomId ||
    !grantCovers(held.grant, wanted.grant)
  ) {
    return null;
  }
  return held.expiresAt !== null &&
    held.expiresAt - wanted.now > EXPIRY_MARGIN_MS
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
export const planJoinInfo = <T extends HoldableJoinInfo>({
  held,
  roomId,
  grant,
  now,
  isFirstReconnectAttempt,
}: {
  held: HeldJoinInfo<T> | null;
  roomId: string;
  grant: JoinGrant;
  now: number;
  isFirstReconnectAttempt: boolean;
}): JoinInfoPlan<T> => {
  const reusable = getReusableJoinInfo(held, { roomId, grant, now });
  return reusable && isFirstReconnectAttempt
    ? { source: "held", joinInfo: reusable }
    : { source: "fresh", fallback: reusable };
};
