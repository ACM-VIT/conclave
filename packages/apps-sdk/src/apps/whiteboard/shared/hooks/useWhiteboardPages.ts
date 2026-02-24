import { useCallback, useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import {
  addPage,
  createId,
  ensureDefaultPage,
  getActivePageId,
  getPageOrder,
  getPagesMap,
  removePage,
  setActivePageId,
  updatePageName,
} from "../../core/doc/index";
import type { WhiteboardElement, WhiteboardPage } from "../../core/model/types";

export type WhiteboardPagesOptions = {
  readOnly?: boolean;
};

export const useWhiteboardPages = (doc: Y.Doc, options?: WhiteboardPagesOptions) => {
  const readOnly = options?.readOnly ?? false;
  const [pages, setPages] = useState<WhiteboardPage[]>([]);
  const [activePageId, setActivePage] = useState<string | null>(null);

  const rebuild = useCallback(() => {
    ensureDefaultPage(doc);
    const pagesMap = getPagesMap(doc);
    const order = getPageOrder(doc).toArray();
    const list: WhiteboardPage[] = order
      .map((pageId) => {
        const page = pagesMap.get(pageId);
        if (!(page instanceof Y.Map)) return null;
        const rawName = page.get("name");
        const rawElements = page.get("elements");
        return {
          id: pageId,
          name:
            typeof rawName === "string" && rawName.trim().length > 0
              ? rawName
              : "Untitled",
          elements:
            rawElements instanceof Y.Array
              ? (rawElements.toArray() as WhiteboardElement[])
              : [],
        };
      })
      .filter((page): page is WhiteboardPage => page !== null);
    setPages(list);
    setActivePage(getActivePageId(doc) ?? list[0]?.id ?? null);
  }, [doc]);

  useEffect(() => {
    rebuild();
    const handler = () => rebuild();
    doc.on("update", handler);
    return () => {
      doc.off("update", handler);
    };
  }, [doc, rebuild]);

  const createPage = useMemo(
    () => (name?: string) => {
      if (readOnly) return;
      const id = createId();
      ensureDefaultPage(doc);
      const index = getPagesMap(doc).size + 1;
      addPage(doc, { id, name: name ?? `Page ${index}` });
      setActivePageId(doc, id);
    },
    [doc, readOnly]
  );

  const renamePage = useMemo(
    () => (pageId: string, name: string) => {
      if (readOnly) return;
      updatePageName(doc, pageId, name);
    },
    [doc, readOnly]
  );

  const deletePage = useMemo(
    () => (pageId: string) => {
      if (readOnly) return;
      removePage(doc, pageId);
    },
    [doc, readOnly]
  );

  const setActive = useMemo(
    () => (pageId: string) => {
      setActivePageId(doc, pageId);
    },
    [doc]
  );

  return { pages, activePageId, createPage, renamePage, deletePage, setActive };
};
