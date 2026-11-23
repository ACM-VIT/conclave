import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { RejoinMedia } from "../lib/call-outcome";

/**
 * Applies the device choices a rejoin carries, once, and reports while those
 * devices are still opening, so Join waits and hands the restored devices to
 * the call instead of joining with them off.
 */
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
