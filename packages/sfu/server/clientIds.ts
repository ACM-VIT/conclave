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

export const clientIdFamily = (clientId: string): string[] => {
  const canonical = canonicalizeClientId(clientId);
  return canonical === CONCLAVE_CLIENT_ID
    ? [CONCLAVE_CLIENT_ID, ...LEGACY_CONCLAVE_CLIENT_IDS]
    : [canonical];
};

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

export const servedClientId = (storedUnder: string): string => {
  const deployment = resolveDefaultClientId();
  return canMigrateClientNamespace(storedUnder, deployment) ? deployment : storedUnder;
};

export const clientsServedAs = (clientId: string): string[] => {
  const served = canonicalizeClientId(clientId);
  return clientIdCandidates(served).filter((candidate) => servedClientId(candidate) === served);
};

export const clientNamespaceIncludes = (
  viewClientId: string,
  storedClientId: string,
): boolean =>
  storedClientId === viewClientId ||
  canMigrateClientNamespace(storedClientId, viewClientId);

export const clientNamespacesIn = (viewClientId: string): string[] =>
  clientIdCandidates(viewClientId).filter((stored) => clientNamespaceIncludes(viewClientId, stored));
