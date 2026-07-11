import * as Y from "yjs";
import { createAppDoc } from "../../../../sdk/doc/createAppDoc";
import type { WhiteboardElement } from "../model/types";

const ROOT_KEY = "whiteboard";
const PAGES_KEY = "pages";
const PAGE_ORDER_KEY = "pageOrder";
const META_KEY = "meta";
export const DEFAULT_WHITEBOARD_PAGE_ID = "page-1";
export const DEFAULT_WHITEBOARD_PAGE_NAME = "Page 1";
const MIN_PAGE_COUNT = 1;

type PageMap = Y.Map<unknown>;
type PagesMap = Y.Map<PageMap>;
type MetaMap = Y.Map<unknown>;

const getRoot = (doc: Y.Doc): Y.Map<unknown> =>
  doc.getMap<unknown>(ROOT_KEY);

const ensurePagesMap = (doc: Y.Doc): PagesMap => {
  const root = getRoot(doc);
  const existing = root.get(PAGES_KEY);
  if (existing instanceof Y.Map) {
    return existing as PagesMap;
  }
  const pages = new Y.Map<PageMap>();
  root.set(PAGES_KEY, pages);
  return pages;
};

const ensurePageOrder = (doc: Y.Doc): Y.Array<string> => {
  const root = getRoot(doc);
  const existing = root.get(PAGE_ORDER_KEY);
  if (existing instanceof Y.Array) {
    return existing as Y.Array<string>;
  }
  const order = new Y.Array<string>();
  root.set(PAGE_ORDER_KEY, order);
  return order;
};

const ensureMetaMap = (doc: Y.Doc): MetaMap => {
  const root = getRoot(doc);
  const existing = root.get(META_KEY);
  if (existing instanceof Y.Map) {
    return existing as MetaMap;
  }
  const meta = new Y.Map<unknown>();
  root.set(META_KEY, meta);
  return meta;
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

const insertPage = (
  pages: PagesMap,
  order: Y.Array<string>,
  page: { id: string; name: string },
): PageMap => {
  const existing = pages.get(page.id);
  if (existing instanceof Y.Map) return existing;

  const pageMap = new Y.Map<unknown>();
  pageMap.set("id", page.id);
  pageMap.set("name", page.name);
  pageMap.set("elements", new Y.Array<WhiteboardElement>());
  pages.set(page.id, pageMap);
  if (!order.toArray().includes(page.id)) {
    order.push([page.id]);
  }
  return pageMap;
};

// Canonicalization is a write operation and is therefore only called from
// mutation helpers, never while a joining client is waiting for server sync.
const normalizePageOrder = (doc: Y.Doc): string[] => {
  const pages = ensurePagesMap(doc);
  const order = ensurePageOrder(doc);
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

// Keep joining documents empty. Read helpers expose a synthetic Page 1 to the
// UI; the first edit materializes it in the shared document.
export const createWhiteboardDoc = (): Y.Doc => createAppDoc(ROOT_KEY);

export const getWhiteboardRoot = (doc: Y.Doc): Y.Map<unknown> => getRoot(doc);

export const getPagesMap = (doc: Y.Doc): PagesMap | null => {
  const value = getRoot(doc).get(PAGES_KEY);
  return value instanceof Y.Map ? (value as PagesMap) : null;
};

export const getPageOrder = (doc: Y.Doc): Y.Array<string> | null => {
  const value = getRoot(doc).get(PAGE_ORDER_KEY);
  return value instanceof Y.Array ? (value as Y.Array<string>) : null;
};

export const getMetaMap = (doc: Y.Doc): MetaMap | null => {
  const value = getRoot(doc).get(META_KEY);
  return value instanceof Y.Map ? (value as MetaMap) : null;
};

/** Return valid page ids without repairing or otherwise changing the doc. */
export const getOrderedPageIds = (doc: Y.Doc): string[] => {
  const pages = getPagesMap(doc);
  if (!pages || pages.size === 0) return [DEFAULT_WHITEBOARD_PAGE_ID];

  const rawOrder = getPageOrder(doc)?.toArray() ?? [];
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const pageId of rawOrder) {
    if (!pages.has(pageId) || seen.has(pageId)) continue;
    seen.add(pageId);
    ordered.push(pageId);
  }
  pages.forEach((_page, pageId) => {
    if (seen.has(pageId)) return;
    seen.add(pageId);
    ordered.push(pageId);
  });
  return ordered.length > 0 ? ordered : [DEFAULT_WHITEBOARD_PAGE_ID];
};

export const getActivePageId = (doc: Y.Doc): string => {
  const pages = getPagesMap(doc);
  const value = getMetaMap(doc)?.get("activePageId");
  if (typeof value === "string" && pages?.has(value)) {
    return value;
  }
  return getOrderedPageIds(doc)[0] ?? DEFAULT_WHITEBOARD_PAGE_ID;
};

export const getPage = (doc: Y.Doc, pageId: string): PageMap | null => {
  const page = getPagesMap(doc)?.get(pageId);
  return page instanceof Y.Map ? page : null;
};

export const getPageElementsArray = (
  doc: Y.Doc,
  pageId: string,
): Y.Array<WhiteboardElement> | null => {
  const value = getPage(doc, pageId)?.get("elements");
  return value instanceof Y.Array
    ? (value as Y.Array<WhiteboardElement>)
    : null;
};

export const getPageElements = (
  doc: Y.Doc,
  pageId: string,
): WhiteboardElement[] => getPageElementsArray(doc, pageId)?.toArray() ?? [];

/** Explicitly materialize the synthetic first page before a real edit. */
export const ensureDefaultPage = (doc: Y.Doc): void => {
  doc.transact(() => {
    const pages = ensurePagesMap(doc);
    const order = ensurePageOrder(doc);
    const meta = ensureMetaMap(doc);
    insertPage(pages, order, {
      id: DEFAULT_WHITEBOARD_PAGE_ID,
      name: DEFAULT_WHITEBOARD_PAGE_NAME,
    });

    const orderedPages = normalizePageOrder(doc);
    const active = meta.get("activePageId");
    if (typeof active !== "string" || !pages.has(active)) {
      meta.set(
        "activePageId",
        orderedPages[0] ?? DEFAULT_WHITEBOARD_PAGE_ID,
      );
    }
  });
};

export const setActivePageId = (doc: Y.Doc, pageId: string): void => {
  if (
    pageId === DEFAULT_WHITEBOARD_PAGE_ID &&
    !getPagesMap(doc)?.has(pageId)
  ) {
    ensureDefaultPage(doc);
    return;
  }

  const pages = getPagesMap(doc);
  if (!pages || pages.size === 0) return;
  doc.transact(() => {
    const nextPageId = pages.has(pageId)
      ? pageId
      : normalizePageOrder(doc)[0];
    if (!nextPageId) return;
    const meta = ensureMetaMap(doc);
    if (meta.get("activePageId") !== nextPageId) {
      meta.set("activePageId", nextPageId);
    }
  });
};

export const addPage = (
  doc: Y.Doc,
  page: { id: string; name: string },
): void => {
  doc.transact(() => {
    insertPage(ensurePagesMap(doc), ensurePageOrder(doc), page);
  });
};

export const removePage = (doc: Y.Doc, pageId: string): void => {
  const pages = getPagesMap(doc);
  const order = getPageOrder(doc);
  if (!pages?.has(pageId) || !order || pages.size <= MIN_PAGE_COUNT) return;

  doc.transact(() => {
    pages.delete(pageId);
    const orderedPages = order.toArray();
    for (let index = orderedPages.length - 1; index >= 0; index -= 1) {
      if (orderedPages[index] === pageId) {
        order.delete(index, 1);
      }
    }

    const meta = getMetaMap(doc);
    if (meta?.get("activePageId") === pageId) {
      const next = normalizePageOrder(doc)[0];
      if (next) meta.set("activePageId", next);
    }
  });
};

export const updatePageName = (
  doc: Y.Doc,
  pageId: string,
  name: string,
): void => {
  if (
    pageId === DEFAULT_WHITEBOARD_PAGE_ID &&
    !getPagesMap(doc)?.has(pageId)
  ) {
    ensureDefaultPage(doc);
  }
  getPage(doc, pageId)?.set("name", name);
};

const getWritablePage = (doc: Y.Doc, pageId: string): PageMap | null => {
  let page = getPage(doc, pageId);
  if (!page && pageId === DEFAULT_WHITEBOARD_PAGE_ID) {
    ensureDefaultPage(doc);
    page = getPage(doc, pageId);
  }
  return page;
};

export const addElement = (
  doc: Y.Doc,
  pageId: string,
  element: WhiteboardElement,
): void => {
  const page = getWritablePage(doc, pageId);
  if (!page) return;
  ensurePageElements(page).push([element]);
};

export const updateElement = (
  doc: Y.Doc,
  pageId: string,
  element: WhiteboardElement,
): void => {
  const page = getWritablePage(doc, pageId);
  if (!page) return;
  const elements = ensurePageElements(page);
  const list = elements.toArray();
  const index = list.findIndex((item) => item.id === element.id);
  if (index === -1) {
    elements.push([element]);
    return;
  }
  elements.delete(index, 1);
  elements.insert(index, [element]);
};

export const removeElement = (
  doc: Y.Doc,
  pageId: string,
  elementId: string,
): void => {
  const elements = getPageElementsArray(doc, pageId);
  if (!elements) return;
  const index = elements.toArray().findIndex((item) => item.id === elementId);
  if (index === -1) return;
  elements.delete(index, 1);
};

export const createId = (): string => {
  const hasRandomUUID =
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function";
  const random = hasRandomUUID
    ? globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `wb_${Date.now().toString(36)}_${random}`;
};
