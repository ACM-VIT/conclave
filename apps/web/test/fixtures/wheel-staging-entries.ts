import * as Y from "yjs";
import { getAppRoot } from "../../../../packages/apps-sdk/src/sdk/doc/createAppDoc";

// The legacy deletion path from staging 634a07505.
const ROOT_KEY = "wheel";
const ENTRIES_KEY = "entries";
export const MAX_ENTRY_LABEL_LENGTH = 48;
export type WheelEntry = {
  id: string;
  label: string;
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
  return (
    typeof record.id === "string" &&
    typeof record.label === "string" &&
    record.label.trim().length > 0 &&
    record.label.length <= MAX_ENTRY_LABEL_LENGTH
  );
};
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
