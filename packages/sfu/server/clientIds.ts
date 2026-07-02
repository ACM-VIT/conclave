export const CONCLAVE_CLIENT_ID = "conclave";

const LEGACY_CONCLAVE_CLIENT_IDS = new Set(["default", "public"]);

export const canonicalizeClientId = (clientId: string): string => {
  const normalized = clientId.trim();
  return LEGACY_CONCLAVE_CLIENT_IDS.has(normalized.toLowerCase())
    ? CONCLAVE_CLIENT_ID
    : normalized;
};

export const resolveDefaultClientId = (): string =>
  canonicalizeClientId(
    process.env.SFU_CLIENT_ID?.trim() ||
      process.env.NEXT_PUBLIC_SFU_CLIENT_ID?.trim() ||
      CONCLAVE_CLIENT_ID,
  );

export const clientIdCandidates = (primary: string): string[] => {
  const seen = new Set<string>();
  return [
    canonicalizeClientId(primary),
    resolveDefaultClientId(),
    CONCLAVE_CLIENT_ID,
    "default",
    "public",
  ].filter((clientId) => {
    if (!clientId || seen.has(clientId)) return false;
    seen.add(clientId);
    return true;
  });
};
