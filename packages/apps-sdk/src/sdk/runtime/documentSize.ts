import * as Y from "yjs";

const REMEASURE_AFTER_MS = 500;

type SavedCopy = { doc: Y.Doc; measured: number; measuredAt: number; grownSince: number };

const copies = new WeakMap<Y.Doc, SavedCopy>();

const measure = (doc: Y.Doc): number => Y.encodeStateAsUpdate(doc).length;

const savedCopyOf = (doc: Y.Doc): SavedCopy => {
  const known = copies.get(doc);
  if (known) return known;
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  const saved: SavedCopy = { doc: copy, measured: measure(copy), measuredAt: Date.now(), grownSince: 0 };
  doc.on("update", (update: Uint8Array) => {
    Y.applyUpdate(copy, update);
    saved.grownSince += update.length;
  });
  copies.set(doc, saved);
  return saved;
};

export const savedSizeStaysUnder = (doc: Y.Doc, limit: number): boolean => {
  const saved = savedCopyOf(doc);
  if (saved.measured + saved.grownSince <= limit) return true;
  if (Date.now() - saved.measuredAt < REMEASURE_AFTER_MS) return false;
  saved.measured = measure(saved.doc);
  saved.measuredAt = Date.now();
  saved.grownSince = 0;
  return saved.measured <= limit;
};
