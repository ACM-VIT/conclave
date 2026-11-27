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

export const resolveSfuClientIdCandidates = (
  preferred?: string | null,
): string[] => {
  const seen = new Set<string>();
  const candidates = [
    canonicalizeSfuClientId(preferred),
    resolveServerSfuClientId(),
    CONCLAVE_SFU_CLIENT_ID,
    "default",
    "public",
  ];
  return candidates.filter((candidate): candidate is string => {
    if (!candidate || seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
};
