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

export type WheelEntry = {
  id: string;
  label: string;
};

/**
 * A spin is a single LWW register holding everything every client needs to
 * replay the exact same animation: the entry snapshot it ran over, the
 * predetermined winner, and the timing curve parameters. Entries edited
 * mid-spin never affect an animation in flight.
 */
export type WheelSpin = {
  spinId: string;
  entries: WheelEntry[];
  winnerIndex: number;
  /** Spinner's wall clock at launch; clients clamp local skew. */
  startedAt: number;
  durationMs: number;
  /** Whole extra rotations before settling. */
  turns: number;
  /** 0..1 resting position within the winning segment. */
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

const isEntry = (value: unknown): value is WheelEntry => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { id?: unknown; label?: unknown };
  return typeof record.id === "string" && typeof record.label === "string";
};

export const createEntryId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const normalizeLabel = (rawLabel: string): string =>
  rawLabel.replace(/\s+/g, " ").trim().slice(0, MAX_ENTRY_LABEL_LENGTH);

// Keep a joining client's document empty until the server sync arrives. Yjs
// map defaults written before that sync can win conflict resolution and reset
// the room for everyone. Read helpers return UI defaults without mutating;
// the first real edit creates the shared structures.
export const createWheelDoc = (): Y.Doc => createAppDoc(ROOT_KEY);

export const getEntries = (doc: Y.Doc): WheelEntry[] => {
  const entries = readEntriesArray(doc);
  if (!entries) return [];
  // Concurrent edits can merge into duplicate ids (reorder replays) or push
  // past the cap (parallel adds); normalize at read time so every consumer
  // sees one bounded list.
  const seen = new Set<string>();
  const result: WheelEntry[] = [];
  for (const entry of entries.toArray()) {
    if (!isEntry(entry) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
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

/**
 * Replace the list with a reordered copy (shuffle/sort). Concurrent adds from
 * other clients survive: the delete only covers items this client saw.
 */
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
    record.entries.every(isEntry) &&
    typeof record.winnerIndex === "number" &&
    Number.isInteger(record.winnerIndex) &&
    record.winnerIndex >= 0 &&
    record.winnerIndex < record.entries.length &&
    typeof record.startedAt === "number" &&
    typeof record.durationMs === "number" &&
    record.durationMs > 0 &&
    typeof record.turns === "number" &&
    typeof record.jitter === "number" &&
    typeof record.spunById === "string" &&
    typeof record.spunByName === "string"
  );
};

export const getSpin = (doc: Y.Doc): WheelSpin | null => {
  const value = getRoot(doc).get(SPIN_KEY);
  return isSpin(value) ? value : null;
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
  const results = (value as Y.Array<WheelResult>).toArray().filter(isResult);
  // Two tabs of the spinner can both record the same settle; keep the first.
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.spinId)) return false;
    seen.add(result.spinId);
    return true;
  });
};

/**
 * Record a finished spin (newest first). Only the spinning client calls this
 * at settle time so results never appear before the wheel stops anywhere.
 */
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
