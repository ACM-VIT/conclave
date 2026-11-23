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

const CONCLAVE_CLIENT_IDS = [
  CONCLAVE_SFU_CLIENT_ID,
  ...LEGACY_CONCLAVE_SFU_CLIENT_IDS,
];

export const resolveSfuClientIdCandidates = (
  preferred?: string | null,
): string[] => {
  const named = canonicalizeSfuClientId(preferred);
  if (named) return named === CONCLAVE_SFU_CLIENT_ID ? CONCLAVE_CLIENT_IDS : [named];
  return Array.from(new Set([resolveServerSfuClientId(), ...CONCLAVE_CLIENT_IDS]));
};

export const findScheduledMeetingForLink = async <
  Meeting extends { clientId?: string },
>(
  linkedClientId: string | null | undefined,
  lookup: (clientId: string) => Promise<Meeting | null>,
): Promise<{ clientId: string; meeting: Meeting } | null> => {
  const named = canonicalizeSfuClientId(linkedClientId);
  for (const candidate of resolveSfuClientIdCandidates(linkedClientId)) {
    const meeting = await lookup(candidate);
    if (!meeting) continue;
    const booked = meeting.clientId?.trim();
    if (named && (!booked || canonicalizeSfuClientId(booked) !== named)) continue;
    return { clientId: booked || candidate, meeting };
  }
  return null;
};
