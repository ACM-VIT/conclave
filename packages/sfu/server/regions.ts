const MAX_SFU_REGION_LENGTH = 64;
const SFU_REGION_PATTERN =
  /^[a-z0-9](?:[a-z0-9._:-]{0,62}[a-z0-9])?$/;

export const normalizeSfuRegion = (
  value: unknown,
): string | null => {
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_SFU_REGION_LENGTH ||
    !SFU_REGION_PATTERN.test(normalized)
  ) {
    return null;
  }

  return normalized;
};

export const resolveConfiguredSfuRegion = (
  value: unknown,
): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim().length === 0) return null;

  const region = normalizeSfuRegion(value);
  if (!region) {
    throw new Error(
      "SFU_REGION must be a 1-64 character identifier using letters, numbers, '.', '_', ':', or '-' and must start and end with a letter or number.",
    );
  }
  return region;
};
