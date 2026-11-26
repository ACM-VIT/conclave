"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

export type ClipboardCopyStatus = "copied" | "failed";

const FEEDBACK_MS = 1800;

export function useClipboardCopy(text: string) {
  const [status, setStatus] = useState<ClipboardCopyStatus | null>(null);
  const [statusText, setStatusText] = useState(text);
  const latestRequestRef = useRef(0);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (statusText !== text) {
    setStatusText(text);
    setStatus(null);
  }

  useLayoutEffect(
    () => () => {
      latestRequestRef.current += 1;
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    },
    [text],
  );

  const copy = useCallback(async () => {
    const request = ++latestRequestRef.current;
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    setStatus(null);
    let result: ClipboardCopyStatus = "failed";
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        result = "copied";
      }
    } catch {
      result = "failed";
    }
    if (request !== latestRequestRef.current) return;
    setStatus(result);
    resetTimerRef.current = setTimeout(() => setStatus(null), FEEDBACK_MS);
  }, [text]);

  return { status, copy };
}
