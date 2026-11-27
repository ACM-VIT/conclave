import { createHash } from "node:crypto";

const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : inner,
  );

export const hashLegacyValue = (value: unknown): string =>
  createHash("sha256").update(stableJson(value)).digest("base64url");
