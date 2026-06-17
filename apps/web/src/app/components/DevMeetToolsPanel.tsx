"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import {
  prewarmVideoEffectsAssets,
  useVideoEffects,
} from "../hooks/useVideoEffects";
import type { JoinMode } from "../lib/types";
import { generateSessionId } from "../lib/utils";
import {
  DEFAULT_VIDEO_EFFECTS,
  type BackgroundEffectId,
  type VideoEffectsState,
} from "../lib/video-effects";

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const parseNumberInput = (
  value: string,
  fallback: number,
  min: number,
  max: number,
) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return clampNumber(parsed, min, max);
};

const clientId = process.env.NEXT_PUBLIC_SFU_CLIENT_ID || "public";

const readError = async (response: Response) => {
  const data = await response.json().catch(() => null);
  if (data && typeof data === "object" && "error" in data) {
    return String((data as { error?: string }).error || "Request failed");
  }
  return response.statusText || "Request failed";
};

interface DevMeetToolsPanelProps {
  roomId: string;
  onPresentationStreamChange?: (stream: MediaStream | null) => void;
  onCameraStreamChange?: (stream: MediaStream | null) => void;
}

type SpawnMethod = "inline" | "popup" | "headless";
type InlineBot = {
  id: string;
  name: string;
  url: string;
};
type DevHeadlessBotSnapshot = {
  id: string;
  participantId: string | null;
  name: string | null;
  connected: boolean;
  raised: boolean;
};

declare global {
  interface Window {
    __conclaveGetDevHeadlessBots?: () => DevHeadlessBotSnapshot[];
    __conclaveSetDevHeadlessBotHandRaised?: (
      botIdOrIndex: string | number,
      raised: boolean,
    ) => Promise<{
      success: boolean;
      id?: string;
      participantId?: string | null;
      error?: string;
    }>;
  }
}

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

function VideoEffectsDiagnostic() {
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
          <div className="mt-2 grid grid-cols-6 gap-1.5">
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
              data-testid="video-effects-diagnostic-gradient"
              onClick={() => setDiagnosticBackground("gradient")}
              className={diagnosticButtonClass}
            >
              Gradient
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

function SyntheticPresentationDiagnostic({
  onPresentationStreamChange,
}: {
  onPresentationStreamChange?: (stream: MediaStream | null) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState("Stopped");

  useEffect(() => {
    if (!enabled || typeof document === "undefined") {
      onPresentationStreamChange?.(null);
      setStatus("Stopped");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx || typeof canvas.captureStream !== "function") {
      onPresentationStreamChange?.(null);
      setStatus("Canvas capture unavailable");
      return;
    }

    const stream = canvas.captureStream(30);
    const [track] = stream.getVideoTracks() as Array<
      MediaStreamTrack & { requestFrame?: () => void }
    >;
    if (track && "contentHint" in track) {
      track.contentHint = "detail";
    }

    const draw = () => {
      const t = performance.now() / 1000;
      ctx.fillStyle = "#0f172a";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const header = ctx.createLinearGradient(0, 0, canvas.width, 0);
      header.addColorStop(0, "#1d4ed8");
      header.addColorStop(0.5, "#14b8a6");
      header.addColorStop(1, "#f97316");
      ctx.fillStyle = header;
      ctx.fillRect(0, 0, canvas.width, 84);

      ctx.fillStyle = "#e5e7eb";
      ctx.font = "600 34px system-ui, sans-serif";
      ctx.fillText("Conclave screen share fixture", 48, 54);
      ctx.font = "500 20px system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.82)";
      ctx.fillText("Auto / tiled / spotlight / sidebar regression source", 760, 54);

      ctx.fillStyle = "#111827";
      ctx.fillRect(48, 128, 760, 500);
      ctx.fillStyle = "#1f2937";
      ctx.fillRect(80, 170, 696, 56);
      ctx.fillRect(80, 254, 696, 56);
      ctx.fillRect(80, 338, 696, 56);
      ctx.fillRect(80, 422, 696, 56);
      ctx.fillRect(80, 506, 696, 56);

      for (let i = 0; i < 5; i += 1) {
        const x = 110 + ((Math.sin(t * 1.4 + i) + 1) / 2) * 530;
        ctx.fillStyle = ["#38bdf8", "#22c55e", "#f59e0b", "#f43f5e", "#a78bfa"][i];
        ctx.fillRect(110, 188 + i * 84, x - 110, 20);
      }

      ctx.fillStyle = "#0b1120";
      ctx.fillRect(856, 128, 376, 500);
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 2;
      ctx.strokeRect(856, 128, 376, 500);
      ctx.fillStyle = "#e5e7eb";
      ctx.font = "600 26px system-ui, sans-serif";
      ctx.fillText("Stage content", 896, 180);
      ctx.font = "500 18px system-ui, sans-serif";
      ctx.fillStyle = "rgba(229,231,235,0.72)";
      ctx.fillText(`Frame ${Math.floor(t * 30)}`, 896, 222);
      ctx.fillText("Presentation track: live", 896, 258);
      ctx.fillText("contentHint: detail", 896, 294);

      ctx.save();
      ctx.translate(1044, 444);
      ctx.rotate(Math.sin(t) * 0.05);
      ctx.fillStyle = "#14b8a6";
      ctx.beginPath();
      ctx.roundRect(-92, -92, 184, 184, 28);
      ctx.fill();
      ctx.fillStyle = "#0f172a";
      ctx.font = "700 64px system-ui, sans-serif";
      ctx.fillText("16:9", -70, 20);
      ctx.restore();

      track?.requestFrame?.();
    };

    draw();
    const timer = window.setInterval(draw, 1000 / 30);
    onPresentationStreamChange?.(stream);
    setStatus("Synthetic presentation live");

    return () => {
      window.clearInterval(timer);
      stream.getTracks().forEach((streamTrack) => streamTrack.stop());
      onPresentationStreamChange?.(null);
      setStatus("Stopped");
    };
  }, [enabled, onPresentationStreamChange]);

  return (
    <div
      data-testid="presentation-diagnostic"
      data-presentation-diagnostic-enabled={enabled ? "true" : "false"}
      className="mt-3 border-t border-[#fafafa]/10 pt-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-[#fafafa]/56">
            Presentation fixture
          </div>
          <div className="mt-1 text-[11px] text-[#fafafa]/78">{status}</div>
        </div>
        <button
          type="button"
          data-testid="presentation-diagnostic-toggle"
          onClick={() => setEnabled((current) => !current)}
          disabled={!onPresentationStreamChange}
          className="rounded-md border border-[#fafafa]/15 px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-[#fafafa]/78 transition hover:border-[#fafafa]/35 hover:text-[#fafafa] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {enabled ? "Stop" : "Start"}
        </button>
      </div>
    </div>
  );
}

function SyntheticCameraDiagnostic({
  onCameraStreamChange,
}: {
  onCameraStreamChange?: (stream: MediaStream | null) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState("Stopped");

  useEffect(() => {
    if (!enabled || typeof document === "undefined") {
      onCameraStreamChange?.(null);
      setStatus("Stopped");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx || typeof canvas.captureStream !== "function") {
      onCameraStreamChange?.(null);
      setStatus("Canvas capture unavailable");
      return;
    }

    const stream = canvas.captureStream(30);
    const [track] = stream.getVideoTracks() as Array<
      MediaStreamTrack & { requestFrame?: () => void }
    >;
    if (track && "contentHint" in track) {
      track.contentHint = "motion";
    }

    const draw = () => {
      const time = performance.now() / 1000;
      const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      gradient.addColorStop(0, "#172554");
      gradient.addColorStop(0.52, "#155e75");
      gradient.addColorStop(1, "#7c2d12");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = "rgba(255,255,255,0.14)";
      for (let i = 0; i < 8; i += 1) {
        ctx.fillRect(42 + i * 78, 38 + Math.sin(time + i) * 10, 42, 250);
      }

      const centerX = canvas.width * 0.5 + Math.sin(time * 1.1) * 24;
      const centerY = canvas.height * 0.48 + Math.cos(time * 1.6) * 9;
      ctx.fillStyle = "#0f172a";
      ctx.beginPath();
      ctx.ellipse(centerX, centerY + 128, 108, 104, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#f3c8a8";
      ctx.beginPath();
      ctx.ellipse(centerX, centerY, 64, 78, Math.sin(time) * 0.08, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#111827";
      ctx.beginPath();
      ctx.ellipse(centerX, centerY - 50, 74, 46, 0, Math.PI, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#111827";
      ctx.beginPath();
      ctx.arc(centerX - 23, centerY - 8, 5, 0, Math.PI * 2);
      ctx.arc(centerX + 23, centerY - 8, 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "#7c2d12";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(centerX, centerY + 18, 22, 0.12 * Math.PI, 0.88 * Math.PI);
      ctx.stroke();

      ctx.fillStyle = "rgba(15,23,42,0.68)";
      ctx.fillRect(24, 24, 246, 40);
      ctx.fillStyle = "#e5e7eb";
      ctx.font = "600 18px system-ui, sans-serif";
      ctx.fillText("Synthetic active speaker", 42, 50);

      track?.requestFrame?.();
    };

    draw();
    const timer = window.setInterval(draw, 1000 / 30);
    onCameraStreamChange?.(stream);
    setStatus("Synthetic camera live");

    return () => {
      window.clearInterval(timer);
      stream.getTracks().forEach((streamTrack) => streamTrack.stop());
      onCameraStreamChange?.(null);
      setStatus("Stopped");
    };
  }, [enabled, onCameraStreamChange]);

  return (
    <div
      data-testid="camera-diagnostic"
      data-camera-diagnostic-enabled={enabled ? "true" : "false"}
      className="mt-3 border-t border-[#fafafa]/10 pt-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-[#fafafa]/56">
            Camera fixture
          </div>
          <div className="mt-1 text-[11px] text-[#fafafa]/78">{status}</div>
        </div>
        <button
          type="button"
          data-testid="camera-diagnostic-toggle"
          onClick={() => setEnabled((current) => !current)}
          disabled={!onCameraStreamChange}
          className="rounded-md border border-[#fafafa]/15 px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-[#fafafa]/78 transition hover:border-[#fafafa]/35 hover:text-[#fafafa] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {enabled ? "Stop" : "Start"}
        </button>
      </div>
    </div>
  );
}

export default function DevMeetToolsPanel({
  roomId,
  onPresentationStreamChange,
  onCameraStreamChange,
}: DevMeetToolsPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [spawnCount, setSpawnCount] = useState(3);
  const [namePrefix, setNamePrefix] = useState("Dev");
  const [nextIndex, setNextIndex] = useState(1);
  const [joinMode, setJoinMode] = useState<JoinMode>("meeting");
  const [autoJoin, setAutoJoin] = useState(true);
  const [hideJoinUI, setHideJoinUI] = useState(true);
  const [spawnDelayMs, setSpawnDelayMs] = useState(150);
  const [autoCloseSeconds, setAutoCloseSeconds] = useState(0);
  const [asAdmin, setAsAdmin] = useState(false);
  const [openWindowsCount, setOpenWindowsCount] = useState(0);
  const [spawnMethod, setSpawnMethod] = useState<SpawnMethod>("headless");
  const [inlineBots, setInlineBots] = useState<InlineBot[]>([]);
  const [headlessCount, setHeadlessCount] = useState(0);
  const openWindowsRef = useRef<Window[]>([]);
  const headlessSocketsRef = useRef<Map<string, Socket>>(new Map());
  const headlessLabelsRef = useRef<Map<string, string>>(new Map());
  const headlessParticipantIdsRef = useRef<Map<string, string>>(new Map());
  const headlessRaisedRef = useRef<Map<string, boolean>>(new Map());
  const headlessTimersRef = useRef<Map<string, number>>(new Map());
  const scheduledTimersRef = useRef<Set<number>>(new Set());

  const canSpawn = roomId.trim().length > 0;

  const scheduleDevTimeout = useCallback(
    (callback: () => void, delayMs: number) => {
      const timer = window.setTimeout(() => {
        scheduledTimersRef.current.delete(timer);
        callback();
      }, delayMs);
      scheduledTimersRef.current.add(timer);
      return timer;
    },
    [],
  );

  const clearScheduledTimers = useCallback(() => {
    scheduledTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    scheduledTimersRef.current.clear();
  }, []);

  const buildSpawnUrl = useCallback(
    (displayName: string, sessionId?: string) => {
      const shouldHideJoinUI = hideJoinUI && autoJoin;
      const safeRoomId = encodeURIComponent(roomId.trim());
      const url = new URL(`/${safeRoomId}`, window.location.origin);
      if (autoJoin) url.searchParams.set("autojoin", "1");
      if (shouldHideJoinUI) url.searchParams.set("hide", "1");
      if (asAdmin) url.searchParams.set("admin", "1");
      if (joinMode === "webinar_attendee") {
        url.searchParams.set("mode", "webinar_attendee");
      }
      if (sessionId) {
        url.searchParams.set("session", sessionId);
      }
      if (displayName.trim()) {
        url.searchParams.set("name", displayName.trim());
      }
      return url.toString();
    },
    [roomId, autoJoin, hideJoinUI, asAdmin, joinMode],
  );

  const removeInlineBot = useCallback((id: string) => {
    setInlineBots((prev) => prev.filter((bot) => bot.id !== id));
  }, []);

  const removeHeadlessBot = useCallback(
    (id: string, disconnect = true) => {
      const socket = headlessSocketsRef.current.get(id);
      if (socket) {
        socket.removeAllListeners();
        if (disconnect && socket.connected) {
          socket.disconnect();
        }
      }
      headlessSocketsRef.current.delete(id);
      headlessLabelsRef.current.delete(id);
      headlessParticipantIdsRef.current.delete(id);
      headlessRaisedRef.current.delete(id);
      const timer = headlessTimersRef.current.get(id);
      if (timer) {
        window.clearTimeout(timer);
        scheduledTimersRef.current.delete(timer);
        headlessTimersRef.current.delete(id);
      }
      setHeadlessCount(headlessSocketsRef.current.size);
    },
    [],
  );

  const registerHeadlessBot = useCallback(
    (
      id: string,
      label: string,
      fallbackParticipantId: string,
      socket: Socket,
      autoCloseMs: number,
    ) => {
      headlessSocketsRef.current.set(id, socket);
      headlessLabelsRef.current.set(id, label);
      headlessParticipantIdsRef.current.set(id, fallbackParticipantId);
      headlessRaisedRef.current.set(id, false);
      setHeadlessCount(headlessSocketsRef.current.size);
      socket.on("disconnect", () => removeHeadlessBot(id, false));
      if (autoCloseMs > 0) {
        const timer = scheduleDevTimeout(() => {
          headlessTimersRef.current.delete(id);
          removeHeadlessBot(id);
        }, autoCloseMs);
        headlessTimersRef.current.set(id, timer);
      }
    },
    [removeHeadlessBot, scheduleDevTimeout],
  );

  const createHeadlessBot = useCallback(
    async (label: string, sessionId: string, autoCloseMs: number) => {
      const targetRoomId = roomId.trim();
      if (!targetRoomId) return;
      const botId = `devbot-${sessionId}`;
      const response = await fetch("/api/sfu/join", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-sfu-client": clientId,
        },
        body: JSON.stringify({
          roomId: targetRoomId,
          sessionId,
          user: {
            id: botId,
            name: label,
          },
          isHost: asAdmin,
          allowRoomCreation: false,
          clientId,
          joinMode,
        }),
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const data = (await response.json()) as {
        token: string;
        sfuUrl: string;
      };
      const { io } = await import("socket.io-client");
      const socket = io(data.sfuUrl, {
        transports: ["websocket", "polling"],
        timeout: 10000,
        reconnection: false,
        forceNew: true,
        auth: { token: data.token },
      });

      const fallbackParticipantId = `guest-${sessionId}#${sessionId}`;
      registerHeadlessBot(botId, label, fallbackParticipantId, socket, autoCloseMs);

      socket.on("connect", () => {
        socket.emit(
          "joinRoom",
          {
            roomId: targetRoomId,
            sessionId,
          },
          (joinResponse: { error?: string }) => {
            if (joinResponse?.error) {
              console.warn("[DevBots] Join error:", joinResponse.error);
              removeHeadlessBot(botId);
            }
          },
        );
      });

      socket.on(
        "handRaised",
        ({ userId, raised }: { userId: string; raised: boolean }) => {
          if (userId === headlessParticipantIdsRef.current.get(botId)) {
            headlessRaisedRef.current.set(botId, Boolean(raised));
          }
        },
      );

      socket.on(
        "displayNameSnapshot",
        ({
          users,
        }: {
          users?: Array<{ userId: string; displayName: string }>;
        }) => {
          const match = users?.find((user) => user.displayName === label);
          if (match?.userId) {
            headlessParticipantIdsRef.current.set(botId, match.userId);
          }
        },
      );

      socket.on("connect_error", (err) => {
        console.warn("[DevBots] Socket error:", err);
        removeHeadlessBot(botId);
      });
    },
    [asAdmin, joinMode, registerHeadlessBot, removeHeadlessBot, roomId],
  );

  const registerWindow = useCallback(
    (handle: Window | null, autoCloseMs: number) => {
      if (!handle) return;
      openWindowsRef.current.push(handle);
      setOpenWindowsCount((prev) => prev + 1);
      if (autoCloseMs > 0) {
        scheduleDevTimeout(() => {
          try {
            if (!handle.closed) {
              handle.close();
            }
          } catch {}
          openWindowsRef.current = openWindowsRef.current.filter(
            (windowHandle) => windowHandle !== handle,
          );
          setOpenWindowsCount(openWindowsRef.current.length);
        }, autoCloseMs);
      }
    },
    [scheduleDevTimeout],
  );

  const spawnParticipants = useCallback(() => {
    if (!canSpawn || typeof window === "undefined") return;
    const count = clampNumber(spawnCount, 1, 50);
    const delay = clampNumber(spawnDelayMs, 0, 5000);
    const autoCloseMs = clampNumber(autoCloseSeconds, 0, 3600) * 1000;
    const baseIndex = Math.max(1, nextIndex);
    const width = 380;
    const height = 700;
    const gap = 18;
    const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
    const baseLeft = window.screenX + 40;
    const baseTop = window.screenY + 60;

    if (spawnMethod === "inline") {
      const newBots: InlineBot[] = [];
      for (let i = 0; i < count; i += 1) {
        const label = `${namePrefix || "Dev"} ${baseIndex + i}`.trim();
        const sessionId = generateSessionId();
        const url = buildSpawnUrl(label, sessionId);
        const id = `inline-${sessionId}`;
        newBots.push({ id, name: label, url });
        if (autoCloseMs > 0) {
          scheduleDevTimeout(() => removeInlineBot(id), autoCloseMs);
        }
      }
      setInlineBots((prev) => [...prev, ...newBots]);
      setNextIndex(baseIndex + count);
      return;
    }

    if (spawnMethod === "headless") {
      for (let i = 0; i < count; i += 1) {
        const label = `${namePrefix || "Dev"} ${baseIndex + i}`.trim();
        const sessionId = generateSessionId();
        const startBot = () => {
          void createHeadlessBot(label, sessionId, autoCloseMs).catch((err) =>
            console.warn("[DevBots] Failed to spawn bot:", err),
          );
        };
        if (delay > 0) {
          scheduleDevTimeout(startBot, i * delay);
        } else {
          startBot();
        }
      }
      setNextIndex(baseIndex + count);
      return;
    }

    const popupEntries: Array<{ handle: Window | null; url: string }> = [];
    for (let i = 0; i < count; i += 1) {
      const left = baseLeft + (i % columns) * (width + gap);
      const top = baseTop + Math.floor(i / columns) * (height + gap);
      const features = `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
      const handle = window.open(
        "about:blank",
        `conclave-dev-${Date.now()}-${i}`,
        features,
      );
      const label = `${namePrefix || "Dev"} ${baseIndex + i}`.trim();
      const sessionId = generateSessionId();
      const url = buildSpawnUrl(label, sessionId);
      popupEntries.push({ handle, url });
    }

    popupEntries.forEach(({ handle, url }, i) => {
      const assignLocation = () => {
        try {
          if (handle && !handle.closed) {
            handle.location.href = url;
          }
        } catch {}
      };
      if (delay > 0) {
        scheduleDevTimeout(assignLocation, i * delay);
      } else {
        assignLocation();
      }
      registerWindow(handle, autoCloseMs);
    });

    setNextIndex(baseIndex + count);
  }, [
    canSpawn,
    spawnCount,
    spawnDelayMs,
    autoCloseSeconds,
    nextIndex,
    namePrefix,
    buildSpawnUrl,
    registerWindow,
    spawnMethod,
    removeInlineBot,
    createHeadlessBot,
    scheduleDevTimeout,
  ]);

  const closeAllWindows = useCallback(() => {
    openWindowsRef.current.forEach((handle) => {
      try {
        if (!handle.closed) {
          handle.close();
        }
      } catch {
      }
    });
    openWindowsRef.current = [];
    setOpenWindowsCount(0);
  }, []);

  const clearAllBots = useCallback(() => {
    clearScheduledTimers();
    closeAllWindows();
    setInlineBots([]);
    const headlessIds = Array.from(headlessSocketsRef.current.keys());
    headlessIds.forEach((id) => removeHeadlessBot(id));
  }, [clearScheduledTimers, closeAllWindows, removeHeadlessBot]);

  useEffect(() => {
    window.__conclaveGetDevHeadlessBots = () =>
      Array.from(headlessSocketsRef.current.entries()).map(([id, socket]) => ({
        id,
        participantId: headlessParticipantIdsRef.current.get(id) ?? null,
        name: headlessLabelsRef.current.get(id) ?? null,
        connected: socket.connected,
        raised: headlessRaisedRef.current.get(id) ?? false,
      }));

    window.__conclaveSetDevHeadlessBotHandRaised = (botIdOrIndex, raised) =>
      new Promise((resolve) => {
        const entries = Array.from(headlessSocketsRef.current.entries());
        const entry =
          typeof botIdOrIndex === "number"
            ? entries.at(botIdOrIndex)
            : entries.find(([id]) => id === botIdOrIndex);
        if (!entry) {
          resolve({ success: false, error: "Headless bot not found" });
          return;
        }

        const [id, socket] = entry;
        const participantId = headlessParticipantIdsRef.current.get(id) ?? null;
        if (!socket.connected) {
          resolve({
            success: false,
            id,
            participantId,
            error: "Headless bot disconnected",
          });
          return;
        }

        let settled = false;
        const timeout = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({ success: false, id, participantId, error: "Timed out" });
        }, 3000);

        socket.emit(
          "setHandRaised",
          { raised },
          (response: { success: boolean } | { error: string }) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout);
            if ("error" in response) {
              resolve({ success: false, id, participantId, error: response.error });
              return;
            }
            headlessRaisedRef.current.set(id, raised);
            resolve({ success: true, id, participantId });
          },
        );
      });

    return () => {
      delete window.__conclaveGetDevHeadlessBots;
      delete window.__conclaveSetDevHeadlessBotHandRaised;
    };
  }, []);

  useEffect(
    () => () => {
      clearScheduledTimers();
      closeAllWindows();
      const headlessIds = Array.from(headlessSocketsRef.current.keys());
      headlessIds.forEach((id) => removeHeadlessBot(id));
    },
    [clearScheduledTimers, closeAllWindows, removeHeadlessBot],
  );

  const panelClass =
    "w-[320px] rounded-xl border border-[#fafafa]/15 bg-[#131316]/95 p-3 text-[11px] text-[#fafafa]/80 shadow-2xl backdrop-blur";
  const inputClass =
    "w-full rounded-md border border-[#fafafa]/10 bg-black/40 px-2.5 py-1.5 text-[11px] text-[#fafafa] outline-none focus:border-[#fafafa]/30";
  const labelClass =
    "text-[10px] uppercase tracking-[0.22em] text-[#fafafa]/56";
  const buttonClass =
    "rounded-md border border-[#fafafa]/15 px-2.5 py-1.5 text-[11px] uppercase tracking-[0.16em] text-[#fafafa]/80 transition hover:border-[#fafafa]/30 hover:text-[#fafafa]";

  const spawnSummary = useMemo(() => {
    if (!canSpawn) return "Set a room ID first.";
    return `Ready to spawn in ${roomId}.`;
  }, [canSpawn, roomId]);

  return (
    <div className="absolute bottom-24 left-4 z-[120] flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="rounded-full border border-[#fafafa]/20 bg-black/60 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[#fafafa]/80 hover:border-[#fafafa]/40"
      >
        Dev Tools
      </button>
      {isOpen && (
        <div className={panelClass}>
          <div className="flex items-center justify-between">
            <div>
              <div className={labelClass}>Dev panel</div>
              <p className="mt-1 text-[11px] text-[#fafafa]/82">
                {spawnSummary}
              </p>
            </div>
            <div className="text-[10px] text-[#fafafa]/75">
              Inline: {inlineBots.length} · Headless: {headlessCount} ·
              Windows: {openWindowsCount}
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <div>
              <div className={labelClass}>Count</div>
              <input
                data-testid="dev-spawn-count"
                type="number"
                min={1}
                max={50}
                value={spawnCount}
                onChange={(event) =>
                  setSpawnCount(
                    parseNumberInput(event.target.value, spawnCount, 1, 50),
                  )
                }
                className={inputClass}
              />
            </div>
            <div>
              <div className={labelClass}>Start #</div>
              <input
                type="number"
                min={1}
                max={9999}
                value={nextIndex}
                onChange={(event) =>
                  setNextIndex(
                    parseNumberInput(event.target.value, nextIndex, 1, 9999),
                  )
                }
                className={inputClass}
              />
            </div>
            <div className="col-span-2">
              <div className={labelClass}>Name prefix</div>
              <input
                value={namePrefix}
                onChange={(event) => setNamePrefix(event.target.value)}
                className={inputClass}
                placeholder="Dev"
              />
            </div>
            <div>
              <div className={labelClass}>Spawn method</div>
              <select
                value={spawnMethod}
                onChange={(event) =>
                  setSpawnMethod(event.target.value as SpawnMethod)
                }
                className={inputClass}
              >
                <option value="inline">Inline (hidden)</option>
                <option value="headless">Headless (socket-only)</option>
                <option value="popup">Popups</option>
              </select>
            </div>
            <div>
              <div className={labelClass}>Join mode</div>
              <select
                value={joinMode}
                onChange={(event) =>
                  setJoinMode(event.target.value as JoinMode)
                }
                className={inputClass}
              >
                <option value="meeting">Meeting</option>
                <option value="webinar_attendee">Webinar attendee</option>
              </select>
            </div>
            <div>
              <div className={labelClass}>Delay (ms)</div>
              <input
                data-testid="dev-spawn-delay"
                type="number"
                min={0}
                max={5000}
                value={spawnDelayMs}
                onChange={(event) =>
                  setSpawnDelayMs(
                    parseNumberInput(event.target.value, spawnDelayMs, 0, 5000),
                  )
                }
                className={inputClass}
              />
            </div>
            <div>
              <div className={labelClass}>Auto-close (s)</div>
              <input
                type="number"
                min={0}
                max={3600}
                value={autoCloseSeconds}
                onChange={(event) =>
                  setAutoCloseSeconds(
                    parseNumberInput(
                      event.target.value,
                      autoCloseSeconds,
                      0,
                      3600,
                    ),
                  )
                }
                className={inputClass}
              />
            </div>
            <div>
              <div className={labelClass}>Flags</div>
              <div className="mt-1 flex flex-col gap-1.5 text-[11px] text-[#fafafa]/80">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={autoJoin}
                    onChange={(event) => setAutoJoin(event.target.checked)}
                  />
                  Auto-join
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={hideJoinUI}
                    onChange={(event) => setHideJoinUI(event.target.checked)}
                  />
                  Hide join UI
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={asAdmin}
                    onChange={(event) => setAsAdmin(event.target.checked)}
                  />
                  Admin
                </label>
              </div>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={spawnParticipants}
              disabled={!canSpawn}
              className={`${buttonClass} ${!canSpawn ? "opacity-40" : ""}`}
            >
              Spawn
            </button>
            <button
              type="button"
              onClick={clearAllBots}
              className={buttonClass}
            >
              Clear all
            </button>
          </div>

          <SyntheticPresentationDiagnostic
            onPresentationStreamChange={onPresentationStreamChange}
          />
          <SyntheticCameraDiagnostic
            onCameraStreamChange={onCameraStreamChange}
          />
          <VideoEffectsDiagnostic />
        </div>
      )}
      {inlineBots.length > 0 && (
        <div className="pointer-events-none fixed left-0 top-0 h-0 w-0 overflow-hidden">
          {inlineBots.map((bot) => (
            <iframe
              key={bot.id}
              src={bot.url}
              title={`Dev bot ${bot.name}`}
              className="h-px w-px opacity-0"
            />
          ))}
        </div>
      )}
    </div>
  );
}
