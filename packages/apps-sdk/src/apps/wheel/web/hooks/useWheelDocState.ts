import { useEffect, useState } from "react";
import type * as Y from "yjs";
import {
  getEntries,
  getHistory,
  getRemoveWinnerOnDone,
  getSpin,
  type WheelEntry,
  type WheelResult,
  type WheelSpin,
} from "../../core/doc/index";

export type WheelDocSnapshot = {
  entries: WheelEntry[];
  spin: WheelSpin | null;
  history: WheelResult[];
  removeWinnerOnDone: boolean;
};

const readSnapshot = (doc: Y.Doc): WheelDocSnapshot => ({
  entries: getEntries(doc),
  spin: getSpin(doc),
  history: getHistory(doc),
  removeWinnerOnDone: getRemoveWinnerOnDone(doc),
});

export const useWheelDocState = (doc: Y.Doc): WheelDocSnapshot => {
  const [snapshot, setSnapshot] = useState<WheelDocSnapshot>(() =>
    readSnapshot(doc)
  );

  useEffect(() => {
    const handleUpdate = () => setSnapshot(readSnapshot(doc));
    handleUpdate();
    doc.on("update", handleUpdate);
    return () => {
      doc.off("update", handleUpdate);
    };
  }, [doc]);

  return snapshot;
};
