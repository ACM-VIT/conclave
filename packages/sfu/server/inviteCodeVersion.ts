import { createHmac } from "node:crypto";
import { config } from "../config/config.js";

// A non-reversible tag that changes whenever the invite code changes, so a
// host can tell whether the code it saved is still the current one.
export const inviteCodeVersion = (inviteCodeHash: string | null): string =>
  inviteCodeHash
    ? createHmac("sha256", config.sfuSecret)
        .update(`invite-code-version:${inviteCodeHash}`)
        .digest("base64url")
        .slice(0, 16)
    : "";
