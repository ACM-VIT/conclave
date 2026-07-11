import * as Y from "yjs";
import {
  createAppDoc,
  ensureAppArray,
  ensureAppMap,
  ensureAppText,
  getAppRoot,
} from "../../../../sdk/doc/createAppDoc";

const ROOT_KEY = "dev-playground";
const COUNTER_KEY = "counter";
const NOTES_KEY = "notes";
const ITEMS_KEY = "items";
const META_KEY = "meta";

type MetaMap = Y.Map<unknown>;
type ItemsArray = Y.Array<string>;

const getRoot = (doc: Y.Doc): Y.Map<unknown> => getAppRoot(doc, ROOT_KEY);

const getMetaMap = (doc: Y.Doc): MetaMap => {
  return ensureAppMap(getRoot(doc), META_KEY);
};

const readMetaMap = (doc: Y.Doc): MetaMap | null => {
  const value = getRoot(doc).get(META_KEY);
  return value instanceof Y.Map ? (value as MetaMap) : null;
};

const touchMeta = (doc: Y.Doc, userId?: string) => {
  const meta = getMetaMap(doc);
  const now = Date.now();
  if (typeof meta.get("createdAt") !== "number") {
    meta.set("createdAt", now);
  }
  meta.set("updatedAt", now);
  if (userId) {
    meta.set("updatedBy", userId);
  }
};

// Keep a joining client's document empty until the server sync arrives. Yjs
// map defaults written before that sync can win conflict resolution and reset
// the room for everyone. Read helpers return UI defaults without mutating;
// the first real edit creates the shared structures.
export const createDevPlaygroundDoc = (): Y.Doc => createAppDoc(ROOT_KEY);

export const getCounter = (doc: Y.Doc): number => {
  const value = getRoot(doc).get(COUNTER_KEY);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

export const setCounter = (doc: Y.Doc, next: number, userId?: string) => {
  const normalized = Number.isFinite(next) ? Math.round(next) : 0;
  getRoot(doc).set(COUNTER_KEY, normalized);
  touchMeta(doc, userId);
};

export const incrementCounter = (doc: Y.Doc, by = 1, userId?: string) => {
  setCounter(doc, getCounter(doc) + by, userId);
};

export const getNotes = (doc: Y.Doc): string => {
  const value = getRoot(doc).get(NOTES_KEY);
  return value instanceof Y.Text ? value.toString() : "";
};

export const setNotes = (doc: Y.Doc, value: string, userId?: string) => {
  const text = ensureAppText(getRoot(doc), NOTES_KEY);
  text.delete(0, text.length);
  text.insert(0, value);
  touchMeta(doc, userId);
};

export const getItems = (doc: Y.Doc): string[] => {
  const value = getRoot(doc).get(ITEMS_KEY);
  if (!(value instanceof Y.Array)) return [];
  return (value as ItemsArray)
    .toArray()
    .filter((item): item is string => typeof item === "string");
};

export const addItem = (doc: Y.Doc, rawValue: string, userId?: string) => {
  const value = rawValue.trim();
  if (!value) return;
  (ensureAppArray(getRoot(doc), ITEMS_KEY) as ItemsArray).push([value]);
  touchMeta(doc, userId);
};

export const removeItemAt = (doc: Y.Doc, index: number, userId?: string) => {
  const value = getRoot(doc).get(ITEMS_KEY);
  if (!(value instanceof Y.Array)) return;
  const items = value as ItemsArray;
  if (index < 0 || index >= items.length) return;
  items.delete(index, 1);
  touchMeta(doc, userId);
};

export const clearItems = (doc: Y.Doc, userId?: string) => {
  const value = getRoot(doc).get(ITEMS_KEY);
  if (!(value instanceof Y.Array)) return;
  const items = value as ItemsArray;
  if (items.length === 0) return;
  items.delete(0, items.length);
  touchMeta(doc, userId);
};

export const getMeta = (doc: Y.Doc): { createdAt: number | null; updatedAt: number | null } => {
  const meta = readMetaMap(doc);
  if (!meta) {
    return { createdAt: null, updatedAt: null };
  }
  const createdAt = meta.get("createdAt");
  const updatedAt = meta.get("updatedAt");
  return {
    createdAt: typeof createdAt === "number" ? createdAt : null,
    updatedAt: typeof updatedAt === "number" ? updatedAt : null,
  };
};
