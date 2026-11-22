export type UntrustedRecord = Readonly<Record<string, unknown>>;

const EMPTY_RECORD: UntrustedRecord = Object.freeze({});

export const asRecord = (value: unknown): UntrustedRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UntrustedRecord)
    : EMPTY_RECORD;

export const requestBody = (req: { body?: unknown }): UntrustedRecord =>
  asRecord(req.body);

export const asArray = (value: unknown): readonly unknown[] | null =>
  Array.isArray(value) ? (value as readonly unknown[]) : null;

export const readBoolean = (
  record: UntrustedRecord,
  key: string,
): boolean | undefined => {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
};

export const readString = (
  record: UntrustedRecord,
  key: string,
): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

export const readNumber = (
  record: UntrustedRecord,
  key: string,
): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

export const readCoercedNumber = (
  record: UntrustedRecord,
  key: string,
): number | undefined => {
  const value = record[key];
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

export const readCoercedBoolean = (
  record: UntrustedRecord,
  key: string,
): boolean | undefined => {
  const value = record[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
};
