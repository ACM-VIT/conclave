import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { RejoinMedia } from "../lib/rejoin-intent";

export function useRejoinMediaRestore(
  initialMedia: RejoinMedia | null | undefined,
  apply: (media: RejoinMedia) => Promise<unknown>,
): boolean {
  const [restoring, setRestoring] = useState(false);
  const applied = useRef(false);
  const restore = useEffectEvent((media: RejoinMedia) => {
    setRestoring(true);
    void apply(media)
      .catch(() => {})
      .finally(() => setRestoring(false));
  });
  useEffect(() => {
    if (!initialMedia || applied.current) return;
    applied.current = true;
    restore(initialMedia);
  }, [initialMedia]);
  return restoring;
}
