import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { getPageElements } from "../../core/doc/index";
import type { WhiteboardElement } from "../../core/model/types";

export const useWhiteboardElements = (doc: Y.Doc, pageId: string | null) => {
  const [elements, setElements] = useState<WhiteboardElement[]>([]);

  useEffect(() => {
    if (!pageId) {
      setElements([]);
      return;
    }
    const rebuild = () => {
      setElements(getPageElements(doc, pageId));
    };
    rebuild();
    doc.on("update", rebuild);
    return () => {
      doc.off("update", rebuild);
    };
  }, [doc, pageId]);

  return elements;
};
