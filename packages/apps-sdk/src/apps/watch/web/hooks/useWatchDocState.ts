import { useEffect, useState } from "react";
import type * as Y from "yjs";
import { getQueue, getVideoId, getVideoTitle } from "../../core/doc/index";
import type { QueueItem } from "../../core/model/types";

type WatchDocState = {
  videoId: string | null;
  videoTitle: string | null;
  queue: QueueItem[];
};

export function useWatchDocState(doc: Y.Doc): WatchDocState {
  const [state, setState] = useState<WatchDocState>(() => ({
    videoId: getVideoId(doc),
    videoTitle: getVideoTitle(doc),
    queue: getQueue(doc),
  }));

  useEffect(() => {
    const sync = () => {
      setState({
        videoId: getVideoId(doc),
        videoTitle: getVideoTitle(doc),
        queue: getQueue(doc),
      });
    };
    sync();
    doc.on("update", sync);
    return () => {
      doc.off("update", sync);
    };
  }, [doc]);

  return state;
}
