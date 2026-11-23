import { createHmac, randomBytes } from "node:crypto";
import type { Subject } from "@conclave/apps-sdk/authority/server";
import type { Client } from "../../../config/classes/Client.js";
import type { Room } from "../../../config/classes/Room.js";
import { isGuestUserKey } from "../../identity.js";
import { getSocketAuthUser } from "../../socket/auth.js";

export type ResolvedIdentity = {
  subject: Subject;
  /** Whether the server can vouch that this subject is one stable person. */
  verified: boolean;
};

/**
 * The proof of the server-issued guest pass behind a guest `userKey`, when
 * the room has bound one. Two tabs of one guest carry the same pass, so the
 * proof is the guest's stable identity where the `userKey` is not.
 */
export type GuestPassProofSource = (
  room: Room,
  userKey: string,
) => string | undefined;

export const guestPassProofOf: GuestPassProofSource = (room, userKey) =>
  room.guestIdentityOf(userKey);

/**
 * Whether the join token says this seat is a signed-in account. The web join
 * route signs an `email` claim only from an authenticated session, so its
 * presence is the server's own word. A guest key always starts with
 * `guest-`, but so can an account's email, so the prefix alone would turn
 * `guest-services@example.com` into an unverified guest.
 */
export type AccountSource = (client: Client) => boolean;

export const hasSignedInAccount: AccountSource = (client) => {
  const email = getSocketAuthUser(client.socket)?.email;
  return typeof email === "string" && email.trim().length > 0;
};

type Cached = {
  userKey: string;
  account: boolean;
  proof: string | undefined;
  identity: ResolvedIdentity;
};

/**
 * The one place a connection becomes a subject. Apps never see a user key,
 * an email or a socket: only an opaque id that is the same for one person
 * across tabs and reconnects in this room and means nothing outside it.
 *
 * A signed-in person's subject comes from their account. A guest's comes
 * from their verified pass. A guest with no verified pass gets a subject
 * that lasts only for their session and is marked unverified, so the host
 * can refuse them anything that rests on one-per-person.
 */
export class IdentityAdapter {
  private readonly salt = randomBytes(32);
  private readonly cache = new WeakMap<Client, Cached>();

  constructor(
    private readonly guestProofOf: GuestPassProofSource = guestPassProofOf,
    private readonly isAccount: AccountSource = hasSignedInAccount,
  ) {}

  resolve(room: Room, client: Client): ResolvedIdentity | null {
    const userKey = room.userKeysById.get(client.id);
    if (!userKey) return null;
    const account = !isGuestUserKey(userKey) || this.isAccount(client);
    const proof = account ? undefined : this.guestProofOf(room, userKey);
    const cached = this.cache.get(client);
    if (
      cached &&
      cached.userKey === userKey &&
      cached.account === account &&
      cached.proof === proof
    ) {
      return cached.identity;
    }
    const identity = this.derive(userKey, account, proof, client.id);
    this.cache.set(client, { userKey, account, proof, identity });
    return identity;
  }

  private derive(
    userKey: string,
    account: boolean,
    proof: string | undefined,
    seatId: string,
  ): ResolvedIdentity {
    if (account) {
      return { subject: this.subject("account", userKey), verified: true };
    }
    if (proof) {
      return { subject: this.subject("guest-pass", proof), verified: true };
    }
    return { subject: this.subject("session", seatId), verified: false };
  }

  private subject(kind: string, value: string): Subject {
    return createHmac("sha256", this.salt)
      .update(kind)
      .update("\u0000")
      .update(value)
      .digest("base64url")
      .slice(0, 22) as Subject;
  }
}
