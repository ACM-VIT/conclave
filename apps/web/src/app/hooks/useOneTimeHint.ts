"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_PREFIX = "conclave:hint:";

interface UseOneTimeHintOptions {
  enabled?: boolean;
  delay?: number;
}

interface OneTimeHint {
  visible: boolean;
  dismiss: () => void;
}

export function useOneTimeHint(
  id: string,
  { enabled = true, delay = 0 }: UseOneTimeHintOptions = {},
): OneTimeHint {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setVisible(false);
      return;
    }
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(STORAGE_PREFIX + id) === "1";
    } catch {
    }
    if (dismissed) return;
    const timer = window.setTimeout(() => setVisible(true), delay);
    return () => window.clearTimeout(timer);
  }, [id, enabled, delay]);

  const dismiss = useCallback(() => {
    setVisible(false);
    try {
      window.localStorage.setItem(STORAGE_PREFIX + id, "1");
    } catch {
    }
  }, [id]);

  return { visible, dismiss };
}
