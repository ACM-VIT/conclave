import * as Y from "yjs";

export const createAppDoc = (rootKey: string): Y.Doc => {
  const doc = new Y.Doc();
  doc.getMap<unknown>(rootKey);
  return doc;
};

export const getAppRoot = (doc: Y.Doc, rootKey: string): Y.Map<unknown> => {
  return doc.getMap<unknown>(rootKey);
};

export const ensureAppMap = (
  root: Y.Map<unknown>,
  key: string
): Y.Map<unknown> => {
  const existing = root.get(key);
  if (existing instanceof Y.Map) {
    return existing as Y.Map<unknown>;
  }
  const map = new Y.Map<unknown>();
  root.set(key, map);
  return map;
};

export const ensureAppArray = (
  root: Y.Map<unknown>,
  key: string
): Y.Array<unknown> => {
  const existing = root.get(key);
  if (existing instanceof Y.Array) {
    return existing as Y.Array<unknown>;
  }
  const array = new Y.Array<unknown>();
  root.set(key, array);
  return array;
};

export const ensureAppText = (
  root: Y.Map<unknown>,
  key: string
): Y.Text => {
  const existing = root.get(key);
  if (existing instanceof Y.Text) {
    return existing;
  }
  const text = new Y.Text();
  root.set(key, text);
  return text;
};
