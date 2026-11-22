/** Live values and deletion stamps for one kind of record, by key. */
export type StampedRecords<T> = {
  values: Map<string, T>;
  deletedAt: Map<string, number>;
};

const newestOf = <T>(
  records: StampedRecords<T>,
  key: string,
  stampOf: (value: T) => number,
): { stamp: number; value: T | null } | null => {
  const value = records.values.get(key);
  const deletedAt = records.deletedAt.get(key);
  const valueStamp = value === undefined ? null : stampOf(value);
  if (deletedAt !== undefined && (valueStamp === null || deletedAt > valueStamp)) {
    return { stamp: deletedAt, value: null };
  }
  return valueStamp === null || value === undefined ? null : { stamp: valueStamp, value };
};

/**
 * Merges stored records into local ones: per key, the newest stamp wins across
 * values and deletions together, and ties keep the local side. A key missing on
 * one side is never a vote, so a local delete is not undone by an older read
 * and a record another SFU added is never dropped. Returns how many keys changed.
 */
export const mergeNewestStamp = <T>(
  local: StampedRecords<T>,
  stored: StampedRecords<T>,
  stampOf: (value: T) => number,
  apply: { set: (key: string, value: T) => void; remove: (key: string, deletedAt: number) => void },
): number => {
  let changed = 0;
  for (const key of new Set([...stored.values.keys(), ...stored.deletedAt.keys()])) {
    const theirs = newestOf(stored, key, stampOf);
    if (!theirs) continue;
    const ours = newestOf(local, key, stampOf);
    if (ours && ours.stamp >= theirs.stamp) continue;
    if (theirs.value === null) {
      apply.remove(key, theirs.stamp);
    } else {
      apply.set(key, theirs.value);
    }
    changed += 1;
  }
  return changed;
};
