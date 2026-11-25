import * as Y from "yjs";
import {
  createAppDoc,
  ensureAppArray,
  ensureAppMap,
  getAppRoot,
} from "../../../../sdk/doc/createAppDoc";
import { WHEEL_LIMITS, isValidIdentifier, withoutLoneSurrogates } from "../../../../native-embed/protocol";
import { cutText } from "../../../../sdk/text";
import { hasVisibleText } from "../labels";

const ROOT_KEY = "wheel";
const ENTRIES_KEY = "entries";
const SPIN_KEY = "spin";
const HISTORY_KEY = "history";
const SETTINGS_KEY = "settings";
const REMOVE_WINNER_KEY = "removeWinnerOnDone";
const RETIRED_ROOT = "wheel.retired";
const RETIRED_KEEP_MS = 24 * 60 * 60 * 1000;
const MAX_ADD_INDEX = 4_096;

export const MAX_WHEEL_ENTRIES = WHEEL_LIMITS.entries;
export const MAX_ENTRY_LABEL_LENGTH = WHEEL_LIMITS.label;
const MAX_HISTORY_LENGTH = WHEEL_LIMITS.results;
const MIN_SPIN_DURATION_MS = 250;
const MAX_SPIN_DURATION_MS = 30_000;
const MAX_SPIN_TURNS = 20;

export type WheelEntry = {
  id: string;
  label: string;
  addedBy?: string;
  slot?: number;
};

export type AddOrigin = { key: string; slots: number[] };

export type WheelSpin = {
  spinId: string;
  entries: WheelEntry[];
  winnerIndex: number;
  startedAt: number;
  durationMs: number;
  turns: number;
  jitter: number;
  spunById: string;
  spunByName: string;
};

export type WheelResult = {
  spinId: string;
  label: string;
  at: number;
  byName: string;
};

type EntriesArray = Y.Array<WheelEntry>;

const getRoot = (doc: Y.Doc): Y.Map<unknown> => getAppRoot(doc, ROOT_KEY);

const readEntriesArray = (doc: Y.Doc): EntriesArray | null => {
  const value = getRoot(doc).get(ENTRIES_KEY);
  return value instanceof Y.Array ? (value as EntriesArray) : null;
};

const CONTROL_CHARACTERS = /\p{Cc}/gu;

export const normalizeLabel = (rawLabel: string): string => {
  const label = cutText(
    withoutLoneSurrogates(rawLabel).replace(/\s+/g, " ").replace(CONTROL_CHARACTERS, "").trim(),
    MAX_ENTRY_LABEL_LENGTH
  );
  return hasVisibleText(label) ? label : "";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const readLabel = (value: unknown): string =>
  typeof value === "string" && value.length <= MAX_ENTRY_LABEL_LENGTH ? normalizeLabel(value) : "";

const readEntry = (value: unknown): WheelEntry | null => {
  if (!isRecord(value) || !isValidIdentifier(value.id)) return null;
  const label = readLabel(value.label);
  if (label === "") return null;
  const entry = value as WheelEntry;
  return label === entry.label ? entry : { ...entry, label };
};

type Accepted<T> = { kept: T[]; indexes: number[] };

const accept = <T>(
  records: readonly unknown[],
  limit: number,
  read: (record: unknown) => T | null,
  keyOf: (record: T) => string
): Accepted<T> => {
  const seen = new Set<string>();
  const kept: T[] = [];
  const indexes: number[] = [];
  records.forEach((record, index) => {
    if (kept.length >= limit) return;
    const value = read(record);
    if (value === null || seen.has(keyOf(value))) return;
    seen.add(keyOf(value));
    kept.push(value);
    indexes.push(index);
  });
  return { kept, indexes };
};

const pruneTo = (array: Y.Array<unknown>, indexes: number[]): void => {
  const keep = new Set(indexes);
  for (let index = array.length - 1; index >= 0; index -= 1) {
    if (!keep.has(index)) array.delete(index, 1);
  }
};

const acceptEntries = (records: readonly unknown[]): Accepted<WheelEntry> =>
  accept(records, MAX_WHEEL_ENTRIES, readEntry, (entry) => entry.id);

const originOf = (value: unknown): { key: string; slot: number } | null => {
  if (!isRecord(value) || typeof value.addedBy !== "string" || value.addedBy === "") return null;
  const slot = value.slot;
  if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot >= MAX_ADD_INDEX) return null;
  return { key: value.addedBy, slot };
};

const retire = (doc: Y.Doc | null, removed: readonly unknown[]): void => {
  if (!doc) return;
  const origins = removed.map(originOf).filter((origin) => origin !== null);
  if (origins.length === 0) return;
  const retired = doc.getMap<unknown>(RETIRED_ROOT);
  const now = Date.now();
  for (const origin of origins) retired.set(`${origin.key}#${origin.slot}`, now);
  const stale = [...retired.entries()].filter(([, at]) => typeof at !== "number" || at < now - RETIRED_KEEP_MS);
  for (const [key] of stale) retired.delete(key);
};

const prunedEntries = (entries: EntriesArray): WheelEntry[] => {
  const records = entries.toArray();
  const accepted = acceptEntries(records);
  const kept = new Set(accepted.indexes);
  retire(entries.doc, records.filter((_, index) => !kept.has(index)));
  pruneTo(entries as Y.Array<unknown>, accepted.indexes);
  return accepted.kept;
};

export const createEntryId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const createWheelDoc = (): Y.Doc => createAppDoc(ROOT_KEY);

export const getEntries = (doc: Y.Doc): WheelEntry[] => {
  const entries = readEntriesArray(doc);
  return entries ? acceptEntries(entries.toArray()).kept : [];
};

export const addEntries = (doc: Y.Doc, rawLabels: string[], origin?: AddOrigin): number => {
  const labels = rawLabels
    .map((raw, index) => ({ label: normalizeLabel(raw), slot: origin?.slots[index] }))
    .filter((item) => item.label.length > 0);
  if (labels.length === 0) return 0;

  let added = 0;
  doc.transact(() => {
    const entries = ensureAppArray(getRoot(doc), ENTRIES_KEY) as EntriesArray;
    const room = MAX_WHEEL_ENTRIES - prunedEntries(entries).length;
    if (room <= 0) return;
    const batch = labels
      .slice(0, room)
      .map(({ label, slot }): WheelEntry =>
        origin && slot !== undefined ? { id: createEntryId(), label, addedBy: origin.key, slot } : { id: createEntryId(), label }
      );
    entries.push(batch);
    added = batch.length;
  });
  return added;
};

export type AddOutcome = { ok: boolean; error?: string; added: number[] };

export const getAddOutcome = (doc: Y.Doc, key: string): AddOutcome | null => {
  const slots = new Set<number>();
  for (const record of readEntriesArray(doc)?.toArray() ?? []) {
    const origin = originOf(record);
    if (origin && origin.key === key) slots.add(origin.slot);
  }
  const prefix = `${key}#`;
  const oldest = Date.now() - RETIRED_KEEP_MS;
  for (const [retiredKey, at] of doc.getMap<unknown>(RETIRED_ROOT).entries()) {
    if (!retiredKey.startsWith(prefix) || typeof at !== "number" || at < oldest) continue;
    const slot = Number(retiredKey.slice(prefix.length));
    if (Number.isInteger(slot) && slot >= 0 && slot < MAX_ADD_INDEX) slots.add(slot);
  }
  return slots.size > 0 ? { ok: true, added: [...slots].sort((a, b) => a - b) } : null;
};

export const addEntry = (doc: Y.Doc, rawLabel: string): boolean =>
  addEntries(doc, [rawLabel]) === 1;

export const removeEntryById = (doc: Y.Doc, entryId: string): void => {
  const entries = readEntriesArray(doc);
  if (!entries) return;
  doc.transact(() => {
    const index = prunedEntries(entries).findIndex((entry) => entry.id === entryId);
    if (index < 0) return;
    retire(doc, [entries.get(index)]);
    entries.delete(index, 1);
  });
};

export const clearEntries = (doc: Y.Doc): void => {
  const entries = readEntriesArray(doc);
  if (!entries || entries.length === 0) return;
  doc.transact(() => {
    retire(doc, entries.toArray());
    entries.delete(0, entries.length);
  });
};

export const replaceEntries = (doc: Y.Doc, next: WheelEntry[]): void => {
  doc.transact(() => {
    const entries = ensureAppArray(getRoot(doc), ENTRIES_KEY) as EntriesArray;
    const kept = acceptEntries(next).kept;
    const keptIds = new Set(kept.map((entry) => entry.id));
    retire(doc, entries.toArray().filter((record) => !(isRecord(record) && keptIds.has(record.id))));
    entries.delete(0, entries.length);
    entries.push(kept);
  });
};

const isSpin = (value: unknown): value is WheelSpin => {
  if (!isRecord(value)) return false;
  const record = value;
  return (
    typeof record.spinId === "string" &&
    Array.isArray(record.entries) &&
    record.entries.length > 0 &&
    record.entries.length <= MAX_WHEEL_ENTRIES &&
    typeof record.winnerIndex === "number" &&
    Number.isInteger(record.winnerIndex) &&
    record.winnerIndex >= 0 &&
    record.winnerIndex < record.entries.length &&
    typeof record.startedAt === "number" &&
    Number.isFinite(record.startedAt) &&
    typeof record.durationMs === "number" &&
    Number.isFinite(record.durationMs) &&
    record.durationMs >= MIN_SPIN_DURATION_MS &&
    record.durationMs <= MAX_SPIN_DURATION_MS &&
    typeof record.turns === "number" &&
    Number.isInteger(record.turns) &&
    record.turns >= 1 &&
    record.turns <= MAX_SPIN_TURNS &&
    typeof record.jitter === "number" &&
    Number.isFinite(record.jitter) &&
    record.jitter >= 0 &&
    record.jitter <= 1 &&
    typeof record.spunById === "string" &&
    typeof record.spunByName === "string"
  );
};

const readSpins = new WeakMap<WheelSpin, WheelSpin>();

const readSlot = (raw: unknown, index: number): WheelEntry =>
  readEntry(raw) ?? { id: `slot-${index}`, label: "" };

const readSpinEntries = (spin: WheelSpin): WheelSpin => {
  const entries = (spin.entries as unknown[]).map(readSlot);
  return entries.every((entry, index) => entry === spin.entries[index]) ? spin : { ...spin, entries };
};

export const slotLabel = (spin: WheelSpin, index: number): string =>
  spin.entries[index]?.label || String(index + 1);

const readSpin = (spin: WheelSpin): WheelSpin => {
  const cached = readSpins.get(spin);
  if (cached) return cached;
  const read = readSpinEntries(spin);
  readSpins.set(spin, read);
  return read;
};

export const getSpin = (doc: Y.Doc): WheelSpin | null => {
  const value = getRoot(doc).get(SPIN_KEY);
  return isSpin(value) ? readSpin(value) : null;
};

export const startSpin = (doc: Y.Doc, spin: WheelSpin): void => {
  getRoot(doc).set(SPIN_KEY, spin);
};

export const clearSpin = (doc: Y.Doc): void => {
  const root = getRoot(doc);
  if (root.get(SPIN_KEY) != null) root.set(SPIN_KEY, null);
};

const readResult = (value: unknown): WheelResult | null => {
  if (!isRecord(value) || !isValidIdentifier(value.spinId)) return null;
  if (typeof value.at !== "number" || typeof value.byName !== "string") return null;
  const label = readLabel(value.label);
  if (label === "") return null;
  const result = value as WheelResult;
  return label === result.label ? result : { ...result, label };
};

const acceptResults = (records: readonly unknown[]): Accepted<WheelResult> =>
  accept(records, MAX_HISTORY_LENGTH, readResult, (result) => result.spinId);

export const getHistory = (doc: Y.Doc): WheelResult[] => {
  const value = getRoot(doc).get(HISTORY_KEY);
  return value instanceof Y.Array ? acceptResults(value.toArray()).kept : [];
};

export const recordResult = (doc: Y.Doc, result: WheelResult): void => {
  doc.transact(() => {
    const history = ensureAppArray(
      getRoot(doc),
      HISTORY_KEY
    ) as Y.Array<WheelResult>;
    const accepted = acceptResults(history.toArray());
    pruneTo(history as Y.Array<unknown>, accepted.indexes);
    const read = readResult({ ...result, label: normalizeLabel(result.label) });
    if (read === null || accepted.kept.some((item) => item.spinId === read.spinId)) return;
    history.insert(0, [read]);
    if (history.length > MAX_HISTORY_LENGTH) {
      history.delete(MAX_HISTORY_LENGTH, history.length - MAX_HISTORY_LENGTH);
    }
  });
};

export const clearHistory = (doc: Y.Doc): void => {
  const value = getRoot(doc).get(HISTORY_KEY);
  if (!(value instanceof Y.Array) || value.length === 0) return;
  value.delete(0, value.length);
};

export const getRemoveWinnerOnDone = (doc: Y.Doc): boolean => {
  const settings = getRoot(doc).get(SETTINGS_KEY);
  if (!(settings instanceof Y.Map)) return false;
  return settings.get(REMOVE_WINNER_KEY) === true;
};

export const setRemoveWinnerOnDone = (doc: Y.Doc, value: boolean): void => {
  ensureAppMap(getRoot(doc), SETTINGS_KEY).set(REMOVE_WINNER_KEY, value);
};
