"use client";

import { useEffect, useRef, useState } from "react";
import {
  prewarmVideoEffectsAssets,
  useVideoEffects,
} from "../hooks/useVideoEffects";
import {
  DEFAULT_VIDEO_EFFECTS,
  type BackgroundEffectId,
  type VideoEffectsState,
} from "../lib/video-effects";

function DiagnosticVideo({
  stream,
  label,
}: {
  stream: MediaStream | null;
  label: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!stream) {
      video.srcObject = null;
      return;
    }
    video.srcObject = stream;
    video.play().catch(() => {});
    return () => {
      if (video.srcObject === stream) {
        video.srcObject = null;
      }
    };
  }, [stream]);

  return (
    <div className="min-w-0">
      <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-[#fafafa]/50">
        {label}
      </div>
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="aspect-video w-full rounded-md bg-black object-cover"
      />
    </div>
  );
}

export default function DevVideoEffectsDiagnostic() {
  const [enabled, setEnabled] = useState(false);
  const [effects, setEffects] = useState<VideoEffectsState>({
    ...DEFAULT_VIDEO_EFFECTS,
    background: "blur-strong",
    studioLighting: true,
  });
  const [sourceStream, setSourceStream] = useState<MediaStream | null>(null);
  const processedVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const {
    effectiveStream,
    processedTrackReady,
    status,
    error,
    debugStats,
  } = useVideoEffects({
    sourceStream,
    effects,
    processedVideoTrackRef,
  });

  useEffect(() => {
    if (!enabled) return;
    void prewarmVideoEffectsAssets({
      segmentation: true,
      face: true,
      backgrounds: ["office", "beach"],
      reason: "dev-effects-diagnostic",
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled || typeof document === "undefined") {
      setSourceStream(null);
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx || typeof canvas.captureStream !== "function") {
      setSourceStream(null);
      return;
    }

    const stream = canvas.captureStream(30);
    const [captureTrack] = stream.getVideoTracks() as Array<
      MediaStreamTrack & { requestFrame?: () => void }
    >;
    const draw = () => {
      const time = performance.now() / 1000;
      const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      gradient.addColorStop(0, "#1f2937");
      gradient.addColorStop(0.55, "#0f766e");
      gradient.addColorStop(1, "#f59e0b");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = "rgba(255,255,255,0.18)";
      for (let i = 0; i < 7; i += 1) {
        const x = ((time * 42 + i * 112) % (canvas.width + 120)) - 60;
        ctx.fillRect(x, 34 + i * 38, 72, 16);
      }

      const centerX = canvas.width * 0.5 + Math.sin(time * 1.2) * 18;
      const centerY = canvas.height * 0.48 + Math.cos(time * 1.5) * 8;
      const headTilt = Math.sin(time * 0.9) * 0.14;
      ctx.fillStyle = "#1f2937";
      ctx.beginPath();
      ctx.ellipse(centerX, centerY + 150, 104, 128, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.translate(centerX, centerY + 38);
      ctx.rotate(headTilt);
      ctx.fillStyle = "#f2c7a5";
      ctx.beginPath();
      ctx.ellipse(0, 0, 66, 84, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#111827";
      ctx.beginPath();
      ctx.ellipse(0, -54, 76, 48, 0, Math.PI, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#111827";
      ctx.beginPath();
      ctx.arc(-24, -10, 5, 0, Math.PI * 2);
      ctx.arc(24, -10, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#7c2d12";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(0, 18, 22, 0.12 * Math.PI, 0.88 * Math.PI);
      ctx.stroke();
      ctx.restore();
      captureTrack?.requestFrame?.();
    };
    draw();
    const frameTimer = window.setInterval(draw, 1000 / 30);
    setSourceStream(stream);

    return () => {
      window.clearInterval(frameTimer);
      stream.getTracks().forEach((track) => track.stop());
      setSourceStream((current) => (current === stream ? null : current));
    };
  }, [enabled]);

  const diagnosticButtonClass =
    "rounded-md border border-[#fafafa]/15 px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-[#fafafa]/78 transition hover:border-[#fafafa]/35 hover:text-[#fafafa]";
  const setDiagnosticBackground = (background: BackgroundEffectId) => {
    setEffects((current) => ({
      ...current,
      background,
      filter: "none",
      style: "none",
    }));
  };
  const diagnosticStats = debugStats
    ? JSON.stringify({
        needsSegmentation: debugStats.needsSegmentation,
        needsFace: debugStats.needsFace,
        cooperativeSegmentationDispatches:
          debugStats.cooperativeSegmentationDispatches,
        cooperativeFaceDispatches: debugStats.cooperativeFaceDispatches,
        latestSegmentationMaskAgeMs: debugStats.latestSegmentationMaskAgeMs,
        latestFaceLandmarksAgeMs: debugStats.latestFaceLandmarksAgeMs,
        faceLandmarkCount: debugStats.faceLandmarkCount,
        nextModelDispatchKind: debugStats.nextModelDispatchKind,
        renderedFrames: debugStats.renderedFrames,
        taskSegmentationRuns: debugStats.taskSegmentationRuns,
        taskFaceRuns: debugStats.taskFaceRuns,
        legacyFaceRuns: debugStats.legacyFaceRuns,
        outputTrackPublished: debugStats.outputTrackPublished,
        blackOutputFrameCount: debugStats.blackOutputFrameCount,
        failures: debugStats.failures,
      })
    : undefined;

  return (
    <div
      data-testid="video-effects-diagnostic"
      data-video-effects-stats={diagnosticStats}
      data-video-effects-status={status}
      data-video-effects-ready={processedTrackReady ? "true" : "false"}
      className="mt-3 border-t border-[#fafafa]/10 pt-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-[#fafafa]/56">
            Effects diagnostic
          </div>
          <div className="mt-1 text-[11px] text-[#fafafa]/78">
            {enabled
              ? `${status}${processedTrackReady ? " · ready" : ""}`
              : "Stopped"}
          </div>
        </div>
        <button
          type="button"
          data-testid="video-effects-diagnostic-toggle"
          onClick={() => setEnabled((current) => !current)}
          className={diagnosticButtonClass}
        >
          {enabled ? "Stop" : "Start"}
        </button>
      </div>

      {enabled ? (
        <>
          <div className="mt-2 grid grid-cols-5 gap-1.5">
            <button
              type="button"
              data-testid="video-effects-diagnostic-blur"
              onClick={() => setDiagnosticBackground("blur-strong")}
              className={diagnosticButtonClass}
            >
              Blur
            </button>
            <button
              type="button"
              data-testid="video-effects-diagnostic-office"
              onClick={() => setDiagnosticBackground("office")}
              className={diagnosticButtonClass}
            >
              Office
            </button>
            <button
              type="button"
              data-testid="video-effects-diagnostic-beach"
              onClick={() => setDiagnosticBackground("beach")}
              className={diagnosticButtonClass}
            >
              Beach
            </button>
            <button
              type="button"
              data-testid="video-effects-diagnostic-sparkles"
              onClick={() =>
                setEffects((current) => ({
                  ...current,
                  background: "none",
                  filter: "sparkles",
                  style: "glow",
                }))
              }
              className={diagnosticButtonClass}
            >
              Face
            </button>
            <button
              type="button"
              data-testid="video-effects-diagnostic-combo"
              onClick={() =>
                setEffects((current) => ({
                  ...current,
                  background: "office",
                  filter: "sparkles",
                  style: "glow",
                }))
              }
              className={diagnosticButtonClass}
            >
              Combo
            </button>
          </div>
          {error ? (
            <div className="mt-2 rounded-md bg-red-950/70 px-2 py-1.5 text-[10px] text-red-100">
              {error}
            </div>
          ) : null}
          <div className="mt-2 grid grid-cols-2 gap-2">
            <DiagnosticVideo stream={sourceStream} label="Raw" />
            <DiagnosticVideo stream={effectiveStream} label="Processed" />
          </div>
        </>
      ) : null}
    </div>
  );
}
