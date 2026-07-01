import { createHmac } from "crypto";
import { config as sfuConfig } from "../../config/config.js";

export const analyticsDistinctId = (stableIdentity: string): string =>
  `user_${createHmac("sha256", sfuConfig.sfuSecret)
    .update(stableIdentity)
    .digest("hex")
    .slice(0, 32)}`;
