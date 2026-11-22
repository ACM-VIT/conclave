"use client";

import { Globe } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { errorName, resolveNoVncUrl } from "../lib/utils";
import StageNotice from "./StageNotice";
import StageSourcePill from "./StageSourcePill";

export const SHARED_BROWSER_LOAD_TIMEOUT_MS = 20000;

const NOVNC_VIDEO_INPUT_PARAMS = "autoconnect=true&resize=scale&quality=0&compression=9";

interface SharedBrowserStageProps {
  noVncUrl: string;
  controllerName: string;
  isLocalController: boolean;
  provider?: "chromium" | "kitesurf";
  browserVideoStream?: MediaStream | null;
}

export function formatSharedBrowserLabel(
  controllerName: string,
  isLocalController: boolean,
): string {
  if (isLocalController) return "You’re sharing a browser";
  return `${controllerName.trim() || "The host"} is sharing a browser`;
}

function SharedBrowserStage({
  noVncUrl,
  controllerName,
  isLocalController,
  provider = "chromium",
  browserVideoStream,
}: SharedBrowserStageProps) {
  const browserVideoRef = useRef<HTMLVideoElement>(null);
  const [attempt, setAttempt] = useState(0);
  const frameKey = `${attempt}:${noVncUrl}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [timedOutKey, setTimedOutKey] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(
      () => setTimedOutKey(frameKey),
      SHARED_BROWSER_LOAD_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [frameKey]);

  useEffect(() => {
    const video = browserVideoRef.current;
    if (!video) return;

    if (!browserVideoStream) {
      if (video.srcObject) {
        video.srcObject = null;
      }
      return;
    }

    video.srcObject = browserVideoStream;
    video.play().catch((err) => {
      if (errorName(err) !== "AbortError") {
        console.error("[Meets] Browser video play error:", err);
      }
    });

    return () => {
      if (video.srcObject === browserVideoStream) {
        video.srcObject = null;
      }
    };
  }, [browserVideoStream]);

  const resolvedNoVncUrl = resolveNoVncUrl(noVncUrl);
  const loadState =
    loadedKey === frameKey
      ? "ready"
      : timedOutKey === frameKey
        ? "failed"
        : "loading";
  const markLoaded = () => setLoadedKey(frameKey);
  const label = formatSharedBrowserLabel(controllerName, isLocalController);

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-black"
      role="region"
      aria-label="Shared browser"
      data-shared-browser-stage
      data-browser-provider={provider}
      data-shared-browser-load-state={browserVideoStream ? "video" : loadState}
    >
      {browserVideoStream ? (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{ containerType: "size" }}
        >
          <div
            className="relative"
            style={{
              width: "min(100cqw, calc(100cqh * 16 / 9))",
              aspectRatio: "16 / 9",
            }}
          >
            <video
              ref={browserVideoRef}
              autoPlay
              playsInline
              muted
              className="absolute inset-0 h-full w-full"
              style={{ objectFit: "fill", pointerEvents: "none" }}
            />
            <iframe
              key={frameKey}
              src={`${resolvedNoVncUrl}${resolvedNoVncUrl.includes("?") ? "&" : "?"}${NOVNC_VIDEO_INPUT_PARAMS}`}
              onLoad={markLoaded}
              className="absolute inset-0 h-full w-full border-0"
              style={{ opacity: 0, pointerEvents: "auto" }}
              allow="clipboard-read; clipboard-write"
              title="Shared browser input"
            />
          </div>
        </div>
      ) : (
        <>
          <iframe
            key={frameKey}
            src={resolvedNoVncUrl}
            onLoad={markLoaded}
            className="absolute inset-0 h-full w-full border-0"
            style={{
              opacity: loadState === "ready" ? 1 : 0,
              pointerEvents: loadState === "ready" ? "auto" : "none",
            }}
            allow="clipboard-read; clipboard-write"
            title="Shared browser"
          />
          {loadState === "loading" ? (
            <StageNotice busy role="status" title="Loading shared browser" />
          ) : loadState === "failed" ? (
            <StageNotice
              icon={Globe}
              role="alert"
              title="Couldn’t load the shared browser"
              detail="Check your connection, then try again."
              action={{
                label: "Retry",
                onClick: () => setAttempt((value) => value + 1),
              }}
            />
          ) : null}
        </>
      )}
      <StageSourcePill
        icon={Globe}
        label={label}
        className="pointer-events-none"
      />
    </div>
  );
}

export default memo(SharedBrowserStage);
