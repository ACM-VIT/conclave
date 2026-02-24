import * as Y from "yjs";
import type { WhiteboardElement } from "../model/types";

const ROOT_KEY = "whiteboard";
const PAGES_KEY = "pages";
const PAGE_ORDER_KEY = "pageOrder";
const META_KEY = "meta";
const DEFAULT_PAGE_ID = "page-1";
const DEFAULT_PAGE_NAME = "Page 1";
const MIN_PAGE_COUNT = 1;

type PageMap = Y.Map<unknown>;
type PagesMap = Y.Map<PageMap>;
type MetaMap = Y.Map<unknown>;

const ensurePagesMap = (root: Y.Map<unknown>): PagesMap => {
  const existing = root.get(PAGES_KEY);
  if (existing instanceof Y.Map) {
    return existing as PagesMap;
  }
  const pages = new Y.Map<PageMap>();
  root.set(PAGES_KEY, pages);
  return pages;
};

const ensurePageOrder = (root: Y.Map<unknown>): Y.Array<string> => {
  const existing = root.get(PAGE_ORDER_KEY);
  if (existing instanceof Y.Array) {
    return existing as Y.Array<string>;
  }
  const order = new Y.Array<string>();
  root.set(PAGE_ORDER_KEY, order);
  return order;
};

const ensureMetaMap = (root: Y.Map<unknown>): MetaMap => {
  const existing = root.get(META_KEY);
  if (existing instanceof Y.Map) {
    return existing as MetaMap;
  }
  const meta = new Y.Map<unknown>();
  root.set(META_KEY, meta);
  return meta;
};

const normalizePageOrder = (doc: Y.Doc): string[] => {
  const pages = getPagesMap(doc);
  const order = getPageOrder(doc);
  const rawOrder = order.toArray();
  const seen = new Set<string>();
  const indexesToDelete: number[] = [];
  const normalizedOrder: string[] = [];

  for (let index = 0; index < rawOrder.length; index += 1) {
    const pageId = rawOrder[index];
    if (!pages.has(pageId) || seen.has(pageId)) {
      indexesToDelete.push(index);
      continue;
    }
    seen.add(pageId);
    normalizedOrder.push(pageId);
  }

  for (let index = indexesToDelete.length - 1; index >= 0; index -= 1) {
    order.delete(indexesToDelete[index], 1);
  }

  pages.forEach((_page, pageId) => {
    if (seen.has(pageId)) return;
    order.push([pageId]);
    seen.add(pageId);
    normalizedOrder.push(pageId);
  });

  return normalizedOrder;
};

const ensureRoot = (doc: Y.Doc): Y.Map<unknown> => {
  const root = doc.getMap<unknown>(ROOT_KEY);
  ensurePagesMap(root);
  ensurePageOrder(root);
  ensureMetaMap(root);
  return root;
};

const ensurePageElements = (page: PageMap): Y.Array<WhiteboardElement> => {
  const existing = page.get("elements");
  if (existing instanceof Y.Array) {
    return existing as Y.Array<WhiteboardElement>;
  }
  const elements = new Y.Array<WhiteboardElement>();
  page.set("elements", elements);
  return elements;
};

export const createWhiteboardDoc = (): Y.Doc => {
  const doc = new Y.Doc();
  ensureDefaultPage(doc);
  return doc;
};

export const ensureDefaultPage = (doc: Y.Doc) => {
  doc.transact(() => {
    ensureRoot(doc);
    const pages = getPagesMap(doc);
    if (!pages.has(DEFAULT_PAGE_ID)) {
      addPage(doc, { id: DEFAULT_PAGE_ID, name: DEFAULT_PAGE_NAME });
    }

    const orderedPages = normalizePageOrder(doc);
    const active = getActivePageId(doc);
    if (!active || !pages.has(active)) {
      setActivePageId(doc, orderedPages[0] ?? DEFAULT_PAGE_ID);
    }
  });
};

export const getPagesMap = (doc: Y.Doc): PagesMap => {
  const root = ensureRoot(doc);
  return ensurePagesMap(root);
};

export const getPageOrder = (doc: Y.Doc): Y.Array<string> => {
  const root = ensureRoot(doc);
  return ensurePageOrder(root);
};

export const getMetaMap = (doc: Y.Doc): MetaMap => {
  const root = ensureRoot(doc);
  return ensureMetaMap(root);
};

export const getActivePageId = (doc: Y.Doc): string | null => {
  const meta = getMetaMap(doc);
  const value = meta.get("activePageId");
  return typeof value === "string" ? value : null;
};

export const setActivePageId = (doc: Y.Doc, pageId: string) => {
  const pages = getPagesMap(doc);
  const meta = getMetaMap(doc);
  if (!pages.has(pageId)) {
    const firstPage = normalizePageOrder(doc)[0];
    if (!firstPage) return;
    if (meta.get("activePageId") === firstPage) return;
    meta.set("activePageId", firstPage);
    return;
  }

  if (meta.get("activePageId") === pageId) {
    return;
  }
  meta.set("activePageId", pageId);
};

export const getPage = (doc: Y.Doc, pageId: string): PageMap | null => {
  const pages = getPagesMap(doc);
  const page = pages.get(pageId);
  if (!(page instanceof Y.Map)) return null;
  return page as PageMap;
};

export const getPageElementsArray = (
  doc: Y.Doc,
  pageId: string
): Y.Array<WhiteboardElement> | null => {
  const page = getPage(doc, pageId);
  if (!page) {
    return null;
  }
  return ensurePageElements(page);
};

export const getPageElements = (doc: Y.Doc, pageId: string): WhiteboardElement[] => {
  const elements = getPageElementsArray(doc, pageId);
  return elements ? elements.toArray() : [];
};

export const addPage = (doc: Y.Doc, page: { id: string; name: string }) => {
  const pages = getPagesMap(doc);
  if (pages.has(page.id)) return;
  const pageMap = new Y.Map<unknown>();
  pageMap.set("id", page.id);
  pageMap.set("name", page.name);
  pageMap.set("elements", new Y.Array<WhiteboardElement>());
  pages.set(page.id, pageMap);
  const order = getPageOrder(doc);
  if (!order.toArray().includes(page.id)) {
    order.push([page.id]);
  }
};

export const removePage = (doc: Y.Doc, pageId: string) => {
  const pages = getPagesMap(doc);
  if (!pages.has(pageId)) return;

  const order = getPageOrder(doc);
  if (order.length <= MIN_PAGE_COUNT) {
    return;
  }

  pages.delete(pageId);
  const orderedPages = order.toArray();
  for (let index = orderedPages.length - 1; index >= 0; index -= 1) {
    if (orderedPages[index] === pageId) {
      order.delete(index, 1);
    }
  }

  const active = getActivePageId(doc);
  if (active === pageId) {
    const next = normalizePageOrder(doc)[0] ?? null;
    if (next) {
      setActivePageId(doc, next);
    }
  }
  ensureDefaultPage(doc);
};

export const updatePageName = (doc: Y.Doc, pageId: string, name: string) => {
  const page = getPage(doc, pageId);
  if (!page) return;
  page.set("name", name);
};

export const addElement = (doc: Y.Doc, pageId: string, element: WhiteboardElement) => {
  const elements = getPageElementsArray(doc, pageId);
  if (!elements) return;
  elements.push([element]);
};

export const updateElement = (doc: Y.Doc, pageId: string, element: WhiteboardElement) => {
  const elements = getPageElementsArray(doc, pageId);
  if (!elements) return;
  const list = elements.toArray();
  const index = list.findIndex((item) => item.id === element.id);
  if (index === -1) {
    elements.push([element]);
    return;
  }
  elements.delete(index, 1);
  elements.insert(index, [element]);
};

export const removeElement = (doc: Y.Doc, pageId: string, elementId: string) => {
  const elements = getPageElementsArray(doc, pageId);
  if (!elements) return;
  const list = elements.toArray();
  const index = list.findIndex((item) => item.id === elementId);
  if (index === -1) return;
  elements.delete(index, 1);
};

export const createId = () => {
  const hasRandomUUID =
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function";
  const random = hasRandomUUID
    ? globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `wb_${Date.now().toString(36)}_${random}`;
};
