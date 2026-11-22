export const CONCLAVE_SFU_CLIENT_ID = "conclave";
const LEGACY_CONCLAVE_SFU_CLIENT_IDS = new Set(["default", "public"]);

const normalizeSfuClientId = (value: string | undefined): string | null => {
  const normalized = value?.trim();
  if (!normalized) return null;
  return /^[a-zA-Z0-9._:-]{1,64}$/.test(normalized) ? normalized : null;
};

export const canonicalizeSfuClientId = (
  value: string | null | undefined,
): string | null => {
  const normalized = normalizeSfuClientId(value ?? undefined);
  if (!normalized) return null;
  return LEGACY_CONCLAVE_SFU_CLIENT_IDS.has(normalized.toLowerCase())
    ? CONCLAVE_SFU_CLIENT_ID
    : normalized;
};

export const resolveBrowserSfuClientId = (): string =>
  canonicalizeSfuClientId(process.env.NEXT_PUBLIC_SFU_CLIENT_ID) ||
  CONCLAVE_SFU_CLIENT_ID;

export const resolveServerSfuClientId = (): string =>
  canonicalizeSfuClientId(process.env.SFU_CLIENT_ID) ||
  resolveBrowserSfuClientId();

/**
 * Client IDs a room code can be stored under for one tenant: the tenant a
 * link names, or the browser default for a bare link, which is the tenant
 * the meeting page joins. Never another tenant's.
 */
export const resolveSfuClientIdCandidates = (
  preferred?: string | null,
): string[] => {
  const tenant =
    canonicalizeSfuClientId(preferred) || resolveBrowserSfuClientId();
  return tenant === CONCLAVE_SFU_CLIENT_ID
    ? [CONCLAVE_SFU_CLIENT_ID, ...LEGACY_CONCLAVE_SFU_CLIENT_IDS]
    : [tenant];
};
