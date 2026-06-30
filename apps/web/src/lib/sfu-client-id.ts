export const CONCLAVE_SFU_CLIENT_ID = "conclave";

const normalizeSfuClientId = (value: string | undefined): string | null => {
  const normalized = value?.trim();
  if (!normalized) return null;
  return /^[a-zA-Z0-9._:-]{1,64}$/.test(normalized) ? normalized : null;
};

export const resolveBrowserSfuClientId = (): string =>
  normalizeSfuClientId(process.env.NEXT_PUBLIC_SFU_CLIENT_ID) ||
  CONCLAVE_SFU_CLIENT_ID;

export const resolveServerSfuClientId = (): string =>
  normalizeSfuClientId(process.env.SFU_CLIENT_ID) ||
  resolveBrowserSfuClientId();

export const resolveSfuClientIdCandidates = (
  preferred?: string | null,
): string[] => {
  const seen = new Set<string>();
  const candidates = [
    normalizeSfuClientId(preferred ?? undefined),
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
