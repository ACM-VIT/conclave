import { z } from "zod";

/**
 * What a join token says about a guest. The web join route signs these
 * claims and the SFU reads them, both through the schemas in this file, so
 * the two cannot drift apart.
 *
 * Unknown claims are dropped by a parse, never passed through.
 */

const identifier = (maxLength: number) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .regex(/^[^\u0000-\u001f\u007f]+$/);

/**
 * The public key of a guest seat that the join route issued from a guest
 * pass: one pass, in one room, in one tab. A client can never name one.
 */
export const GUEST_SEAT_KEY_PREFIX = "guest-gp_";
export const guestSeatKeySchema = z
  .string()
  .max(320)
  .regex(/^guest-gp_[^\u0000-\u001f\u007f\s#@]+$/)
  .brand<"GuestSeatKey">();
export type GuestSeatKey = z.infer<typeof guestSeatKeySchema>;

/** A keyed hash of a guest pass. No participant ever sees it. */
export const guestProofSchema = identifier(128).brand<"GuestProof">();
export type GuestProof = z.infer<typeof guestProofSchema>;

/**
 * A seat the same browser would hold in this room and tab under another of
 * its passes, with that pass's proof.
 */
const otherGuestSeatSchema = z.object({
  userKey: guestSeatKeySchema,
  guestProof: guestProofSchema,
});
export type OtherGuestSeat = z.infer<typeof otherGuestSeatSchema>;
export const MAX_OTHER_GUEST_SEATS = 3;

/** A guest token issued from a pass. It is good for `guestRoom` only. */
export const roomScopedClaimsSchema = z.object({
  userId: guestSeatKeySchema,
  guestProof: guestProofSchema,
  guestRoom: identifier(256),
  clientId: identifier(256),
  sessionId: identifier(128),
  guestWas: z.array(otherGuestSeatSchema).max(MAX_OTHER_GUEST_SEATS).optional(),
});
export type RoomScopedClaims = z.infer<typeof roomScopedClaimsSchema>;

/**
 * A guest token for a client that names its own `guest-<sessionId>`: a tab
 * from before guest passes, or an older native build. It names no room, so
 * it can never carry `guestRoom`.
 */
export const selfNamedGuestClaimsSchema = z.object({
  userId: z.string().max(320).regex(/^guest-/),
  guestProof: guestProofSchema.optional(),
  guestRoom: z.never().optional(),
});
export type SelfNamedGuestClaims = z.infer<typeof selfNamedGuestClaimsSchema>;

const guestJoinClaimsSchema = z.union([
  roomScopedClaimsSchema.transform((claims) => ({
    scope: "room" as const,
    ...claims,
  })),
  selfNamedGuestClaimsSchema.transform(({ userId, guestProof }) => ({
    scope: "none" as const,
    userId,
    guestProof,
  })),
]);
export type GuestJoinClaims = z.infer<typeof guestJoinClaimsSchema>;

/** The guest claims of a verified join token, or null when they are malformed. */
export const parseGuestJoinClaims = (claims: unknown): GuestJoinClaims | null =>
  guestJoinClaimsSchema.safeParse(claims).data ?? null;

/** The room-scoped claims of a verified join token, or null for any other token. */
export const parseRoomScopedClaims = (claims: unknown): RoomScopedClaims | null =>
  roomScopedClaimsSchema.safeParse(claims).data ?? null;

/**
 * The claims the join route signs for a guest it issued a seat key. Going
 * through the schema here means the route cannot sign what a reader of the
 * token would refuse.
 */
export const issueRoomScopedClaims = (claims: {
  userId: string;
  guestProof: string;
  guestRoom: string;
  clientId: string;
  sessionId: string;
  guestWas?: Array<{ userKey: string; guestProof: string }>;
}): RoomScopedClaims => roomScopedClaimsSchema.parse(claims);

/** The same for a guest that names its own `guest-<sessionId>`. */
export const issueSelfNamedGuestClaims = (claims: {
  userId: string;
  guestProof?: string;
}): SelfNamedGuestClaims => selfNamedGuestClaimsSchema.parse(claims);

/** The part of any join token that says who it is for. */
const joinTokenSubjectSchema = z.object({
  email: z.string().optional(),
  userId: z.string().optional(),
});

/**
 * The user key a join token names, read the way the SFU reads it: the
 * account's email when there is one, else the user id.
 */
export const readJoinTokenSubject = (claims: unknown): string | null => {
  const subject = joinTokenSubjectSchema.safeParse(claims).data;
  return subject?.email?.trim().toLowerCase() || subject?.userId?.trim() || null;
};
