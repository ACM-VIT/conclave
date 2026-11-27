import { useEffect, useState } from "react";
import type * as Y from "yjs";
import {
  getHistory,
  getRemoveWinnerOnDone,
  getSpin,
  getWheelNames,
  type WheelEntry,
  type WheelResult,
  type WheelSpin,
} from "../../core/doc/index";

export type WheelDocSnapshot = {
  entries: WheelEntry[];
  waitingCount: number;
  spin: WheelSpin | null;
  history: WheelResult[];
  removeWinnerOnDone: boolean;
};

const readSnapshot = (doc: Y.Doc): WheelDocSnapshot => {
  const names = getWheelNames(doc);
  return {
    entries: names.shown,
    waitingCount: names.waiting.length,
    spin: getSpin(doc),
    history: getHistory(doc),
    removeWinnerOnDone: getRemoveWinnerOnDone(doc),
  };
};

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
