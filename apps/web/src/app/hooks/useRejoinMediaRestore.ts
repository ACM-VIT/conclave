import { useEffect, useEffectEvent, useRef } from "react";
import type { RejoinMedia } from "../lib/rejoin-intent";

export function useRejoinMediaRestore(
  initialMedia: RejoinMedia | null | undefined,
  apply: (media: RejoinMedia, signal: AbortSignal) => Promise<void>,
): () => void {
  const controller = useRef<AbortController | null>(null);
  const started = useRef(false);
  const restore = useEffectEvent(apply);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!initialMedia || started.current) return;
    let disposed = false;
    // StrictMode replays setup before the browser should open a device.
    queueMicrotask(() => {
      if (disposed) return;
      started.current = true;
      controller.current ??= new AbortController();
      void restore(initialMedia, controller.current.signal).catch(() => {});
    });
    return () => {
      disposed = true;
    };
  }, [initialMedia]);
  return () => {
    controller.current ??= new AbortController();
    controller.current.abort();
  };
}
