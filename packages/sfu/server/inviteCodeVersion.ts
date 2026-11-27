import { randomBytes } from "node:crypto";

export const newInviteCodeVersion = (inviteCodeHash: string | null): string =>
  inviteCodeHash ? randomBytes(12).toString("base64url") : "";
