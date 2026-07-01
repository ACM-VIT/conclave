"use client";

import { useEffect } from "react";

type WakeLockSentinelLike = EventTarget & {
  released: boolean;
  release: () => Promise<void>;
};

type WakeLockNavigator = Navigator & {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinelLike>;
  };
};

interface UseScreenWakeLockOptions {
  enabled: boolean;
}

const isVisible = (): boolean =>
  typeof document === "undefined" || document.visibilityState === "visible";

export function useScreenWakeLock({ enabled }: UseScreenWakeLockOptions) {
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined" || typeof navigator === "undefined") {
      return;
    }

    const wakeLock = (navigator as WakeLockNavigator).wakeLock;
    if (!wakeLock?.request) return;

    let cancelled = false;
    let requesting = false;
    let sentinel: WakeLockSentinelLike | null = null;
    let retryTimeout: number | null = null;

    const clearRetry = () => {
      if (retryTimeout === null) return;
      window.clearTimeout(retryTimeout);
      retryTimeout = null;
    };

    const removeReleaseListener = () => {
      sentinel?.removeEventListener("release", handleRelease);
    };

    const canRequest = () => !cancelled && enabled && isVisible();

    const release = async () => {
      clearRetry();
      const current = sentinel;
      sentinel = null;
      if (!current) return;
      current.removeEventListener("release", handleRelease);
      if (current.released) return;
      try {
        await current.release();
      } catch (error) {
        console.debug("[Meets] Screen wake lock release failed:", error);
      }
    };

    const request = async () => {
      clearRetry();
      if (!canRequest() || requesting) return;
      if (sentinel && !sentinel.released) return;

      requesting = true;
      try {
        const nextSentinel = await wakeLock.request("screen");
        if (!canRequest()) {
          try {
            await nextSentinel.release();
          } catch {}
          return;
        }
        removeReleaseListener();
        sentinel = nextSentinel;
        sentinel.addEventListener("release", handleRelease);
      } catch (error) {
        // Browsers can reject while hidden, battery-saving, or permission-limited.
        // Visibility/page-show handlers below retry when requesting becomes legal.
        console.debug("[Meets] Screen wake lock request failed:", error);
      } finally {
        requesting = false;
      }
    };

    const scheduleRequest = (delayMs = 0) => {
      if (!canRequest() || retryTimeout !== null) return;
      retryTimeout = window.setTimeout(() => {
        retryTimeout = null;
        void request();
      }, delayMs);
    };

    function handleRelease() {
      removeReleaseListener();
      sentinel = null;
      scheduleRequest(250);
    }

    const handleVisibilityChange = () => {
      if (isVisible()) {
        scheduleRequest();
      } else {
        clearRetry();
      }
    };

    const handlePageShow = () => {
      scheduleRequest();
    };

    scheduleRequest();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("focus", handlePageShow);

    return () => {
      cancelled = true;
      clearRetry();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("focus", handlePageShow);
      void release();
    };
  }, [enabled]);
}
