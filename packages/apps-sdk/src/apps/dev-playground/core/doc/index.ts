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

const touchMeta = (doc: Y.Doc, userId?: string) => {
  const meta = getMetaMap(doc);
  meta.set("updatedAt", Date.now());
  if (userId) {
    meta.set("updatedBy", userId);
  }
};

export const createDevPlaygroundDoc = (): Y.Doc => {
  return createAppDoc(ROOT_KEY, (root) => {
    if (typeof root.get(COUNTER_KEY) !== "number") {
      root.set(COUNTER_KEY, 0);
    }
    ensureAppText(root, NOTES_KEY);
    ensureAppArray(root, ITEMS_KEY);
    const meta = ensureAppMap(root, META_KEY);
    if (typeof meta.get("createdAt") !== "number") {
      const now = Date.now();
      meta.set("createdAt", now);
      meta.set("updatedAt", now);
    }
  });
};

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

export const getNotesText = (doc: Y.Doc): Y.Text => {
  const root = getRoot(doc);
  return ensureAppText(root, NOTES_KEY);
};

export const getNotes = (doc: Y.Doc): string => {
  return getNotesText(doc).toString();
};

export const setNotes = (doc: Y.Doc, value: string, userId?: string) => {
  const text = getNotesText(doc);
  text.delete(0, text.length);
  text.insert(0, value);
  touchMeta(doc, userId);
};

export const getItemsArray = (doc: Y.Doc): ItemsArray => {
  return ensureAppArray(getRoot(doc), ITEMS_KEY) as ItemsArray;
};

export const getItems = (doc: Y.Doc): string[] => {
  return getItemsArray(doc)
    .toArray()
    .filter((item): item is string => typeof item === "string");
};

export const addItem = (doc: Y.Doc, rawValue: string, userId?: string) => {
  const value = rawValue.trim();
  if (!value) return;
  getItemsArray(doc).push([value]);
  touchMeta(doc, userId);
};

export const removeItemAt = (doc: Y.Doc, index: number, userId?: string) => {
  const items = getItemsArray(doc);
  if (index < 0 || index >= items.length) return;
  items.delete(index, 1);
  touchMeta(doc, userId);
};

export const clearItems = (doc: Y.Doc, userId?: string) => {
  const items = getItemsArray(doc);
  if (items.length === 0) return;
  items.delete(0, items.length);
  touchMeta(doc, userId);
};

export const getMeta = (doc: Y.Doc): { createdAt: number | null; updatedAt: number | null } => {
  const meta = getMetaMap(doc);
  const createdAt = meta.get("createdAt");
  const updatedAt = meta.get("updatedAt");
  return {
    createdAt: typeof createdAt === "number" ? createdAt : null,
    updatedAt: typeof updatedAt === "number" ? updatedAt : null,
  };
};
