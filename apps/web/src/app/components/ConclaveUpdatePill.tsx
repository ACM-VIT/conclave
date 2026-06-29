"use client";

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ConclaveSiteVersion,
  formatConclaveSiteVersionLabel,
  isConclaveSiteVersionResponse,
  isSameConclaveSiteVersion,
} from "../lib/site-version";

const VERSION_POLL_INTERVAL_MS = 30_000;

const shouldIgnoreVersion = (version: ConclaveSiteVersion): boolean =>
  version.id === "local";

export function ConclaveUpdatePill() {
  // The first real version we observe becomes the baseline; any later
  // version that differs from it means a deploy happened mid-session.
  const baselineVersionRef = useRef<ConclaveSiteVersion | null>(null);
  const [availableVersion, setAvailableVersion] =
    useState<ConclaveSiteVersion | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const checkVersion = useCallback(async () => {
    try {
      const response = await fetch("/api/version", {
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
      });
      if (!response.ok) return;

      const payload: unknown = await response.json();
      if (!isConclaveSiteVersionResponse(payload)) return;

      const nextVersion = payload.serviceVersion;
      if (shouldIgnoreVersion(nextVersion)) return;

      if (!baselineVersionRef.current) {
        baselineVersionRef.current = nextVersion;
        return;
      }

      if (!isSameConclaveSiteVersion(baselineVersionRef.current, nextVersion)) {
        setAvailableVersion(nextVersion);
      }
    } catch {
      // A version check should never interrupt the active page.
    }
  }, []);

  useEffect(() => {
    void checkVersion();

    const intervalId = window.setInterval(
      () => void checkVersion(),
      VERSION_POLL_INTERVAL_MS,
    );
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void checkVersion();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [checkVersion]);

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    window.location.reload();
  }, []);

  if (!availableVersion) return null;

  const versionLabel = formatConclaveSiteVersionLabel(availableVersion);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom,0px)+6.25rem)] left-1/2 z-[80] w-[min(calc(100vw-1.5rem),28rem)] -translate-x-1/2 sm:bottom-[calc(env(safe-area-inset-bottom,0px)+5.75rem)]"
    >
      <div
        className="pointer-events-auto mx-auto flex w-fit max-w-full items-center gap-2 rounded-full border border-white/10 bg-[#0a0a0b]/90 px-3 py-2 text-[12px] font-medium text-[#fafafa] shadow-[0_8px_24px_rgba(0,0,0,0.35)] backdrop-blur-xl"
        style={{ fontFamily: "'PolySans Trial', sans-serif" }}
      >
        <span className="h-2 w-2 shrink-0 rounded-full bg-[#F95F4A]" />
        <span className="min-w-0 truncate">
          New Conclave version ready · {versionLabel}
        </span>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.06] px-2.5 text-[11px] font-semibold text-[#fafafa] transition-colors hover:bg-white/[0.12] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F95F4A] disabled:cursor-wait disabled:opacity-70"
        >
          <RefreshCw
            aria-hidden="true"
            className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`}
          />
          <span>{isRefreshing ? "Refreshing" : "Refresh"}</span>
        </button>
      </div>
    </div>
  );
}

export default ConclaveUpdatePill;
