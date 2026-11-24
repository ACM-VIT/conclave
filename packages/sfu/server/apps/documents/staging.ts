export const MAX_CHANGE_PARTS = 64;
export const MAX_CHANGE_ID_LENGTH = 64;
export const STAGED_CHANGE_IDLE_MS = 5_000;
export const DEFAULT_STAGING_BYTES = 64 * 1024 * 1024;

export type ChangePart = { id: string; index: number; count: number };

export type StagingBudget = {
  take: (bytes: number) => boolean;
  give: (bytes: number) => void;
  used: () => number;
};

export const createStagingBudget = (limitBytes: number = DEFAULT_STAGING_BYTES): StagingBudget => {
  let used = 0;
  return {
    take: (bytes) => {
      if (used + bytes > limitBytes) return false;
      used += bytes;
      return true;
    },
    give: (bytes) => {
      used = Math.max(0, used - bytes);
    },
    used: () => used,
  };
};

const isCount = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

export const readChangePart = (value: unknown): ChangePart | null | "invalid" => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return "invalid";
  const { id, index, count } = value as Record<string, unknown>;
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_CHANGE_ID_LENGTH) return "invalid";
  if (!isCount(count, 2, MAX_CHANGE_PARTS) || !isCount(index, 0, count - 1)) return "invalid";
  return { id, index, count };
};
