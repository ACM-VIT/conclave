import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { getPageElements } from "../../core/doc/index";
import type { WhiteboardElement } from "../../core/model/types";

export const useWhiteboardElements = (doc: Y.Doc, pageId: string | null) => {
  const [elements, setElements] = useState<WhiteboardElement[]>([]);
  const frameRef = useRef<number | null>(null);
  const pendingElementsRef = useRef<WhiteboardElement[] | null>(null);

  useEffect(() => {
    if (!pageId) {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      pendingElementsRef.current = null;
      setElements([]);
      return;
    }

    const flush = () => {
      frameRef.current = null;
      const next = pendingElementsRef.current;
      pendingElementsRef.current = null;
      if (!next) return;
      setElements(next);
    };

    const scheduleRebuild = () => {
      pendingElementsRef.current = getPageElements(doc, pageId);
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(flush);
    };

    scheduleRebuild();
    doc.on("update", scheduleRebuild);

    return () => {
      doc.off("update", scheduleRebuild);
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      pendingElementsRef.current = null;
    };
  }, [doc, pageId]);

  return elements;
};
