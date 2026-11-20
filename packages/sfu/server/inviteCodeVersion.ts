import { randomBytes } from "node:crypto";

// A random tag drawn each time an invite code is set, so a host can tell
// whether the code it saved is still current without the tag revealing or
// matching anything about the code itself.
export const newInviteCodeVersion = (inviteCodeHash: string | null): string =>
  inviteCodeHash ? randomBytes(12).toString("base64url") : "";
