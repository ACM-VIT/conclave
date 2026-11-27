import * as Y from "yjs";
import {
  createAppDoc,
  ensureAppArray,
  ensureAppMap,
  getAppRoot,
} from "../../../../sdk/doc/createAppDoc";
import { WHEEL_LIMITS, WHEEL_RECEIPT_LIMITS, isValidIdentifier, withoutLoneSurrogates } from "../../../../native-embed/protocol";
import { cutText } from "../../../../sdk/text";
import { hasVisibleText } from "../labels";

const ROOT_KEY = "wheel";
const ENTRIES_ROOT = "wheel.entries";
const ORDER_KEY = "order";
const SPIN_KEY = "spin";
const HISTORY_KEY = "history";
const SETTINGS_KEY = "settings";
const REMOVE_WINNER_KEY = "removeWinnerOnDone";
const ADD_RECEIPTS_ROOT = "wheel.addReceipts";

export const MAX_WHEEL_ENTRIES = WHEEL_LIMITS.entries;
export const MAX_ENTRY_LABEL_LENGTH = WHEEL_LIMITS.label;
const MAX_HISTORY_LENGTH = WHEEL_LIMITS.results;
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

const getRoot = (doc: Y.Doc): Y.Map<unknown> => getAppRoot(doc, ROOT_KEY);

const entriesOf = (doc: Y.Doc): Y.Array<unknown> => doc.getArray(ENTRIES_ROOT);

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

const readable = <T>(
  records: readonly unknown[],
  read: (record: unknown) => T | null,
  keyOf: (record: T) => string
): Accepted<T> => {
  const seen = new Set<string>();
  const kept: T[] = [];
  const indexes: number[] = [];
  records.forEach((record, index) => {
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

const readNames = (records: readonly unknown[]): Accepted<WheelEntry> =>
  readable(records, readEntry, (entry) => entry.id);

const prunedNames = (entries: Y.Array<unknown>): WheelEntry[] => {
  const names = readNames(entries.toArray());
  pruneTo(entries, names.indexes);
  return names.kept;
};

export const createEntryId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const createWheelDoc = (): Y.Doc => createAppDoc(ROOT_KEY);

export type WheelNames = { shown: WheelEntry[]; waiting: WheelEntry[] };

export const getWheelNames = (doc: Y.Doc): WheelNames => {
  const members = readNames(entriesOf(doc).toArray()).kept;
  const remaining = new Map(members.map((entry) => [entry.id, entry]));
  const order = getRoot(doc).get(ORDER_KEY);
  const names: WheelEntry[] = [];
  if (Array.isArray(order)) {
    for (const id of order) {
      if (typeof id !== "string") continue;
      const entry = remaining.get(id);
      if (!entry) continue;
      names.push(entry);
      remaining.delete(id);
    }
  }
  names.push(...remaining.values());
  return { shown: names.slice(0, MAX_WHEEL_ENTRIES), waiting: names.slice(MAX_WHEEL_ENTRIES) };
};

export const getEntries = (doc: Y.Doc): WheelEntry[] => getWheelNames(doc).shown;

const pushLabels = (doc: Y.Doc, labels: readonly string[]): number => {
  if (labels.length === 0) return 0;
  const entries = entriesOf(doc);
  const room = MAX_WHEEL_ENTRIES - prunedNames(entries).length;
  if (room <= 0) return 0;
  const batch = labels.slice(0, room).map((label) => ({ id: createEntryId(), label }));
  entries.push(batch);
  return batch.length;
};

export const addEntries = (doc: Y.Doc, rawLabels: string[]): number => {
  const labels = rawLabels.map(normalizeLabel).filter((label) => label.length > 0);
  return labels.length === 0 ? 0 : doc.transact(() => pushLabels(doc, labels));
};

type AddReceipt = { at: number; floor: number; tokens: readonly string[] };

const RECEIPT_FIXED_BYTES = 32;

const isStamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const readReceipt = (value: unknown): AddReceipt | null => {
  if (!isRecord(value) || !isStamp(value.at) || !isStamp(value.floor)) return null;
  const tokens: unknown = value.tokens;
  if (!Array.isArray(tokens) || tokens.length === 0 || tokens.length > MAX_WHEEL_ENTRIES) return null;
  const list: unknown[] = tokens;
  return list.every(isValidIdentifier) ? { at: value.at, floor: value.floor, tokens: list } : null;
};

const receiptBytes = (receipt: AddReceipt): number =>
  receipt.tokens.reduce((bytes, token) => bytes + token.length + 2, RECEIPT_FIXED_BYTES);

type ReceiptLedger = { tokens: Set<string>; floor: number; indexes: number[] };

const readLedger = (records: readonly unknown[]): ReceiptLedger => {
  const tokens = new Set<string>();
  const indexes: number[] = [];
  let floor = 0;
  let bytes = 0;
  let held = true;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const receipt = readReceipt(records[index]);
    if (receipt === null) continue;
    floor = Math.max(floor, receipt.floor);
    bytes += receiptBytes(receipt);
    held &&= indexes.length < WHEEL_RECEIPT_LIMITS.count && bytes <= WHEEL_RECEIPT_LIMITS.bytes;
    if (!held) {
      floor = Math.max(floor, receipt.at);
      continue;
    }
    indexes.push(index);
    for (const token of receipt.tokens) tokens.add(token);
  }
  return { tokens, floor, indexes };
};

export type AddRecord = { added: ReadonlySet<string>; reachesBack: boolean };

export const readAddRecord = (doc: Y.Doc, sentAt: number): AddRecord => {
  const ledger = readLedger(doc.getArray<unknown>(ADD_RECEIPTS_ROOT).toArray());
  const complete = !doc.store.pendingStructs && !doc.store.pendingDs;
  return { added: ledger.tokens, reachesBack: complete && sentAt > ledger.floor };
};

export type TokenedLabel = { token: string; label: string };

export const addEntriesOnce = (doc: Y.Doc, lines: readonly TokenedLabel[], sentAt: number): string[] =>
  doc.transact(() => {
    const receipts = doc.getArray<unknown>(ADD_RECEIPTS_ROOT);
    const records = receipts.toArray();
    const taken = readLedger(records).tokens;
    const fresh = lines
      .map((line) => ({ token: line.token, label: normalizeLabel(line.label) }))
      .filter((line) => {
        if (line.label.length === 0 || !isValidIdentifier(line.token) || taken.has(line.token)) return false;
        taken.add(line.token);
        return true;
      });
    const count = pushLabels(doc, fresh.map((line) => line.label));
    if (count === 0) return [];
    const tokens = fresh.slice(0, count).map((line) => line.token);
    const ledger = readLedger([...records, { at: sentAt, floor: 0, tokens }]);
    receipts.push([{ at: sentAt, floor: ledger.floor, tokens }]);
    pruneTo(receipts, ledger.indexes);
    return tokens;
  });

export const addEntry = (doc: Y.Doc, rawLabel: string): boolean =>
  addEntries(doc, [rawLabel]) === 1;

export const removeEntryById = (doc: Y.Doc, entryId: string): void => {
  const entries = entriesOf(doc);
  doc.transact(() => {
    const index = prunedNames(entries).findIndex((entry) => entry.id === entryId);
    if (index < 0) return;
    entries.delete(index, 1);
  });
};

export const clearEntries = (doc: Y.Doc): void => {
  const entries = entriesOf(doc);
  if (entries.length > 0) entries.delete(0, entries.length);
};

export const reorderEntries = (doc: Y.Doc, next: WheelEntry[]): void => {
  const shown = new Set(getEntries(doc).map(({ id }) => id));
  const order = next.flatMap(({ id }) => shown.delete(id) ? [id] : []);
  getRoot(doc).set(ORDER_KEY, order);
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

const readSpinEntries = (spin: WheelSpin): WheelSpin => {
  const read = (spin.entries as unknown[]).map(readEntry);
  const taken = new Set<string>();
  const ownsId = read.map((entry) => {
    if (entry === null || taken.has(entry.id)) return false;
    taken.add(entry.id);
    return true;
  });
  const entries = read.map((entry, index): WheelEntry => {
    if (entry !== null && ownsId[index]) return entry;
    let id = `slot-${index}`;
    for (let suffix = 1; taken.has(id); suffix += 1) id = `slot-${index}.${suffix}`;
    taken.add(id);
    return { id, label: entry?.label ?? "" };
  });
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
  doc.transact(() => {
    getRoot(doc).set(SPIN_KEY, spin);
  });
};

export const clearSpin = (doc: Y.Doc): void => {
  doc.transact(() => {
    const root = getRoot(doc);
    if (root.get(SPIN_KEY) != null) root.set(SPIN_KEY, null);
  });
};

const readResult = (value: unknown): WheelResult | null => {
  if (!isRecord(value) || !isValidIdentifier(value.spinId)) return null;
  if (typeof value.at !== "number" || typeof value.byName !== "string") return null;
  const label = readLabel(value.label);
  if (label === "") return null;
  const result = value as WheelResult;
  return label === result.label ? result : { ...result, label };
};

const acceptResults = (records: readonly unknown[]): Accepted<WheelResult> => {
  const results = readable(records, readResult, (result) => result.spinId);
  return { kept: results.kept.slice(0, MAX_HISTORY_LENGTH), indexes: results.indexes.slice(0, MAX_HISTORY_LENGTH) };
};

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
  doc.transact(() => {
    const value = getRoot(doc).get(HISTORY_KEY);
    if (!(value instanceof Y.Array) || value.length === 0) return;
    value.delete(0, value.length);
  });
};

export const getRemoveWinnerOnDone = (doc: Y.Doc): boolean => {
  const settings = getRoot(doc).get(SETTINGS_KEY);
  if (!(settings instanceof Y.Map)) return false;
  return settings.get(REMOVE_WINNER_KEY) === true;
};

export const setRemoveWinnerOnDone = (doc: Y.Doc, value: boolean): void => {
  doc.transact(() => {
    ensureAppMap(getRoot(doc), SETTINGS_KEY).set(REMOVE_WINNER_KEY, value);
  });
};
