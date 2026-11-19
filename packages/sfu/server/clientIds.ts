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

/**
 * Whether stored data may move from `fromClientId` to `toClientId`.
 *
 * Lookups fall back to the deployment's legacy client ids and move what they
 * find into the requested namespace. The requested id comes from the request
 * (a query parameter or the x-sfu-client header), so moving data on any
 * request let anyone pull a scheduled meeting or webinar out of its tenant
 * with `?clientId=<anything>`, where its attendees and host could no longer
 * find it. Data only ever moves into the deployment's default client, and
 * only from one of its legacy aliases.
 */
export const canMigrateClientNamespace = (
  fromClientId: string,
  toClientId: string,
): boolean => {
  const target = canonicalizeClientId(toClientId);
  if (target !== resolveDefaultClientId()) return false;
  const source = fromClientId.trim();
  if (!source || source === target) return false;
  return clientIdCandidates(target).includes(source) ||
    LEGACY_CONCLAVE_CLIENT_IDS.has(source.toLowerCase());
};
