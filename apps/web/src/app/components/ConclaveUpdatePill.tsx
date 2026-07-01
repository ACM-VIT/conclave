"use client";

import { RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ConclaveSiteVersion,
  formatConclaveSiteVersionLabel,
  isConclaveSiteVersionResponse,
  resolveAvailableConclaveVersion,
} from "../lib/site-version";

const VERSION_POLL_INTERVAL_MS = 30_000;

const getVersionDismissalKey = (version: ConclaveSiteVersion): string =>
  [version.id, version.tag ?? "", version.timestamp ?? ""].join(":");

export function ConclaveUpdatePill({
  currentVersion,
}: {
  currentVersion: ConclaveSiteVersion;
}) {
  const currentVersionRef = useRef(currentVersion);
  const fallbackBaselineRef = useRef<ConclaveSiteVersion | null>(null);
  const [availableVersion, setAvailableVersion] =
    useState<ConclaveSiteVersion | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [dismissedVersionKey, setDismissedVersionKey] = useState<string | null>(
    null,
  );
  const availableVersionKey = availableVersion
    ? getVersionDismissalKey(availableVersion)
    : null;
  const isDismissed =
    availableVersionKey !== null && dismissedVersionKey === availableVersionKey;

  useEffect(() => {
    currentVersionRef.current = currentVersion;
  }, [currentVersion]);

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

      const available = resolveAvailableConclaveVersion(
        currentVersionRef.current,
        payload,
      );
      if (available) {
        setAvailableVersion(available);
        return;
      }

      const fallbackVersion = payload.clientVersion ?? payload.serviceVersion;
      if (fallbackVersion.id === "local") return;
      if (!fallbackBaselineRef.current) {
        fallbackBaselineRef.current = fallbackVersion;
        return;
      }

      const fallbackAvailable = resolveAvailableConclaveVersion(
        fallbackBaselineRef.current,
        payload,
      );
      if (fallbackAvailable) {
        setAvailableVersion(fallbackAvailable);
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

  const handleDismiss = useCallback(() => {
    if (availableVersionKey) {
      setDismissedVersionKey(availableVersionKey);
    }
  }, [availableVersionKey]);

  if (!availableVersion || isDismissed) return null;

  const versionLabel = formatConclaveSiteVersionLabel(availableVersion);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed top-[calc(env(safe-area-inset-top,0px)+0.75rem)] left-1/2 z-[160] w-[min(calc(100vw-1.5rem),28rem)] -translate-x-1/2"
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
          className="group inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.06] px-2.5 text-[11px] font-semibold text-[#fafafa] transition-colors hover:bg-white/[0.12] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F95F4A] disabled:cursor-wait disabled:opacity-70"
        >
          <RefreshCw
            aria-hidden="true"
            className={`h-3.5 w-3.5 transition-transform duration-500 ease-out group-hover:rotate-180 ${isRefreshing ? "animate-spin" : ""}`}
          />
          <span>{isRefreshing ? "Refreshing" : "Refresh"}</span>
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#fafafa]/70 transition-colors hover:bg-white/[0.12] hover:text-[#fafafa] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F95F4A]"
        >
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export default ConclaveUpdatePill;
