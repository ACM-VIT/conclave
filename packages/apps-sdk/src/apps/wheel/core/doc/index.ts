import * as Y from "yjs";
import {
  createAppDoc,
  ensureAppArray,
  ensureAppMap,
  getAppRoot,
} from "../../../../sdk/doc/createAppDoc";

const ROOT_KEY = "wheel";
const ENTRIES_KEY = "entries";
const SPIN_KEY = "spin";
const HISTORY_KEY = "history";
const SETTINGS_KEY = "settings";
const REMOVE_WINNER_KEY = "removeWinnerOnDone";

export const MAX_WHEEL_ENTRIES = 64;
export const MAX_ENTRY_LABEL_LENGTH = 48;
const MAX_HISTORY_LENGTH = 25;
const MIN_SPIN_DURATION_MS = 250;
const MAX_SPIN_DURATION_MS = 30_000;
const MAX_SPIN_TURNS = 20;

export type WheelEntry = {
  id: string;
  label: string;
};

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

const normalizeLabel = (rawLabel: string): string =>
  rawLabel.replace(/\s+/g, " ").trim().slice(0, MAX_ENTRY_LABEL_LENGTH);

const isEntry = (value: unknown): value is WheelEntry => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { id?: unknown; label?: unknown };
  return (
    typeof record.id === "string" &&
    typeof record.label === "string" &&
    record.label.trim().length > 0 &&
    record.label.length <= MAX_ENTRY_LABEL_LENGTH
  );
};

const readEntry = (entry: WheelEntry): WheelEntry => {
  const label = normalizeLabel(entry.label);
  return label === entry.label ? entry : { ...entry, label };
};

export const createEntryId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const createWheelDoc = (): Y.Doc => createAppDoc(ROOT_KEY);

export const getEntries = (doc: Y.Doc): WheelEntry[] => {
  const entries = readEntriesArray(doc);
  if (!entries) return [];
  const seen = new Set<string>();
  const result: WheelEntry[] = [];
  for (const entry of entries.toArray()) {
    if (!isEntry(entry) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(readEntry(entry));
    if (result.length >= MAX_WHEEL_ENTRIES) break;
  }
  return result;
};

export const addEntries = (doc: Y.Doc, rawLabels: string[]): number => {
  const labels = rawLabels
    .map(normalizeLabel)
    .filter((label) => label.length > 0);
  if (labels.length === 0) return 0;

  let added = 0;
  doc.transact(() => {
    const entries = ensureAppArray(getRoot(doc), ENTRIES_KEY) as EntriesArray;
    const room = MAX_WHEEL_ENTRIES - entries.length;
    if (room <= 0) return;
    const batch = labels
      .slice(0, room)
      .map((label) => ({ id: createEntryId(), label }));
    entries.push(batch);
    added = batch.length;
  });
  return added;
};

export const addEntry = (doc: Y.Doc, rawLabel: string): boolean =>
  addEntries(doc, [rawLabel]) === 1;

export const removeEntryById = (doc: Y.Doc, entryId: string): void => {
  const entries = readEntriesArray(doc);
  if (!entries) return;
  doc.transact(() => {
    const index = entries
      .toArray()
      .findIndex((entry) => isEntry(entry) && entry.id === entryId);
    if (index >= 0) entries.delete(index, 1);
  });
};

export const clearEntries = (doc: Y.Doc): void => {
  const entries = readEntriesArray(doc);
  if (!entries || entries.length === 0) return;
  entries.delete(0, entries.length);
};

export const replaceEntries = (doc: Y.Doc, next: WheelEntry[]): void => {
  doc.transact(() => {
    const entries = ensureAppArray(getRoot(doc), ENTRIES_KEY) as EntriesArray;
    entries.delete(0, entries.length);
    entries.push(next.filter(isEntry).slice(0, MAX_WHEEL_ENTRIES));
  });
};

const isSpin = (value: unknown): value is WheelSpin => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.spinId === "string" &&
    Array.isArray(record.entries) &&
    record.entries.length > 0 &&
    record.entries.length <= MAX_WHEEL_ENTRIES &&
    record.entries.every(isEntry) &&
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

const readSpin = (spin: WheelSpin): WheelSpin => {
  const cached = readSpins.get(spin);
  if (cached) return cached;
  const entries = spin.entries.map(readEntry);
  const read = entries.every((entry, index) => entry === spin.entries[index])
    ? spin
    : { ...spin, entries };
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

const isResult = (value: unknown): value is WheelResult => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.spinId === "string" &&
    typeof record.label === "string" &&
    typeof record.at === "number" &&
    typeof record.byName === "string"
  );
};

export const getHistory = (doc: Y.Doc): WheelResult[] => {
  const value = getRoot(doc).get(HISTORY_KEY);
  if (!(value instanceof Y.Array)) return [];
  const results = (value as Y.Array<WheelResult>)
    .toArray()
    .filter(isResult)
    .map((result) => {
      const label = normalizeLabel(result.label);
      return label === result.label ? result : { ...result, label };
    });
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.spinId)) return false;
    seen.add(result.spinId);
    return true;
  });
};

export const recordResult = (doc: Y.Doc, result: WheelResult): void => {
  doc.transact(() => {
    const history = ensureAppArray(
      getRoot(doc),
      HISTORY_KEY
    ) as Y.Array<WheelResult>;
    const existing = history
      .toArray()
      .some((item) => isResult(item) && item.spinId === result.spinId);
    if (existing) return;
    history.insert(0, [result]);
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
