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
  const name = controllerName.trim();
  return name ? `${name} is sharing a browser` : "Shared browser";
}

function SharedBrowserPill({ label, isLive }: { label: string; isLive: boolean }) {
  return (
    <StageSourcePill icon={Globe} label={label} className="pointer-events-none">
      <span className="sr-only" role="status">
        {isLive ? " Live" : ""}
      </span>
    </StageSourcePill>
  );
}

function SharedBrowserFrame({
  src,
  label,
  onRetry,
}: {
  src: string;
  label: string;
  onRetry: () => void;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    if (status !== "loading") return;
    const timer = setTimeout(() => {
      setStatus((current) => (current === "loading" ? "failed" : current));
    }, SHARED_BROWSER_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const isReady = status === "ready";

  return (
    <div className="absolute inset-0" data-shared-browser-load-state={status}>
      <iframe
        src={src}
        onLoad={() => setStatus("ready")}
        inert={!isReady}
        className="absolute inset-0 h-full w-full border-0"
        style={{
          opacity: isReady ? 1 : 0,
          pointerEvents: isReady ? "auto" : "none",
        }}
        allow="clipboard-read; clipboard-write"
        title="Shared browser"
      />
      {status === "loading" ? (
        <StageNotice busy role="status" title="Loading shared browser" />
      ) : status === "failed" ? (
        <StageNotice
          icon={Globe}
          role="alert"
          title="Couldn’t load the shared browser"
          detail="Check your connection, then try again."
          action={{ label: "Retry", onClick: onRetry }}
        />
      ) : null}
      <SharedBrowserPill label={label} isLive={isReady} />
    </div>
  );
}

function SharedBrowserVideo({
  stream,
  src,
  label,
}: {
  stream: MediaStream;
  src: string;
  label: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.srcObject = stream;
    video.play().catch((err) => {
      if (errorName(err) !== "AbortError") {
        console.error("[Meets] Browser video play error:", err);
      }
    });

    return () => {
      if (video.srcObject === stream) {
        video.srcObject = null;
      }
    };
  }, [stream]);

  return (
    <div className="absolute inset-0" data-shared-browser-load-state="video">
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
            ref={videoRef}
            autoPlay
            playsInline
            muted
            onPlaying={() => setIsPlaying(true)}
            className="absolute inset-0 h-full w-full"
            style={{ objectFit: "fill", pointerEvents: "none" }}
          />
          <iframe
            key={src}
            src={`${src}${src.includes("?") ? "&" : "?"}${NOVNC_VIDEO_INPUT_PARAMS}`}
            className="absolute inset-0 h-full w-full border-0"
            style={{ opacity: 0, pointerEvents: "auto" }}
            allow="clipboard-read; clipboard-write"
            title="Shared browser input"
          />
        </div>
      </div>
      <SharedBrowserPill label={label} isLive={isPlaying} />
    </div>
  );
}

function SharedBrowserStage({
  noVncUrl,
  controllerName,
  isLocalController,
  provider = "chromium",
  browserVideoStream,
}: SharedBrowserStageProps) {
  const [attempt, setAttempt] = useState(0);
  const resolvedNoVncUrl = resolveNoVncUrl(noVncUrl);
  const label = formatSharedBrowserLabel(controllerName, isLocalController);

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-black"
      role="region"
      aria-label="Shared browser"
      data-shared-browser-stage
      data-browser-provider={provider}
    >
      {browserVideoStream ? (
        <SharedBrowserVideo
          stream={browserVideoStream}
          src={resolvedNoVncUrl}
          label={label}
        />
      ) : (
        <SharedBrowserFrame
          key={`${attempt}:${resolvedNoVncUrl}`}
          src={resolvedNoVncUrl}
          label={label}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      )}
    </div>
  );
}

export default memo(SharedBrowserStage);
