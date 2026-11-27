"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  Hand,
  Maximize2,
  Minimize2,
  MessageCircleQuestion,
  PhoneOff,
  Users,
} from "lucide-react";
import { color, font } from "@conclave/ui-tokens";

const ICON_STROKE = 1.75;
const CHROME_IDLE_HIDE_MS = 3_500;

const formatElapsed = (since: number, now: number): string => {
  const totalSeconds = Math.max(0, Math.floor((now - since) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
};

const formatViewerCount = (count: number): string =>
  count === 1 ? "1 watching" : `${count} watching`;

function WebinarViewerChrome({
  title,
  attendeeCount,
  hasLiveStage,
  speakerName,
  qaEnabled,
  isQaOpen,
  unseenQaCount,
  onToggleQa,
  isHandRaised,
  onToggleHand,
  stageContainerRef,
  onLeave,
}: {
  title?: string;
  attendeeCount: number;
  hasLiveStage: boolean;
  speakerName: string | null;
  qaEnabled: boolean;
  isQaOpen: boolean;
  unseenQaCount: number;
  onToggleQa?: () => void;
  isHandRaised: boolean;
  onToggleHand?: () => void;
  stageContainerRef: RefObject<HTMLDivElement | null>;
  onLeave: () => void;
}) {
  const [isIdle, setIsIdle] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [liveSince, setLiveSince] = useState<number | null>(null);
  const idleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (hasLiveStage) {
      setLiveSince((previous) => previous ?? Date.now());
    }
  }, [hasLiveStage]);

  useEffect(() => {
    const markActive = () => {
      setIsIdle(false);
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(
        () => setIsIdle(true),
        CHROME_IDLE_HIDE_MS,
      );
    };
    markActive();
    window.addEventListener("pointermove", markActive);
    window.addEventListener("pointerdown", markActive);
    window.addEventListener("keydown", markActive);
    return () => {
      window.removeEventListener("pointermove", markActive);
      window.removeEventListener("pointerdown", markActive);
      window.removeEventListener("keydown", markActive);
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!liveSince) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [liveSince]);

  useEffect(() => {
    const syncFullscreen = () =>
      setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () =>
      document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  const supportsFullscreen =
    typeof document !== "undefined" &&
    typeof document.documentElement.requestFullscreen === "function";

  const handleToggleFullscreen = useCallback(() => {
    const stage = stageContainerRef.current;
    if (!stage) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else if (stage.requestFullscreen) {
      void stage.requestFullscreen();
    }
  }, [stageContainerRef]);

  const hidden = isIdle && hasLiveStage && !isQaOpen;

  const overlayButtonClass =
    "pointer-events-auto inline-flex h-10 items-center justify-center gap-2 rounded-full border border-white/[0.14] bg-[#131316]/90 px-4 text-[12.5px] font-medium text-[#fafafa] transition-colors duration-150 hover:bg-[#232327]";

  return (
    <div
      data-testid="webinar-viewer-chrome"
      className={`pointer-events-none absolute inset-0 z-20 flex flex-col justify-between transition-opacity duration-300 ${hidden ? "opacity-0 [&_*]:pointer-events-none!" : "opacity-100"}`}
      style={{ fontFamily: font.sans }}
    >
      <div
        className="flex items-start justify-between gap-3 px-5 sm:px-7"
        style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 20px)" }}
      >
        <div className="pointer-events-auto min-w-0 rounded-2xl border border-white/[0.14] bg-[#131316]/90 px-4 py-2.5">
          <p className="truncate text-[14px] font-semibold text-[#fafafa]">
            {title || "Webinar"}
          </p>
          {hasLiveStage ? (
            <div className="mt-1 flex items-center gap-2.5 text-[11.5px] text-[#fafafa]/64">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[#F95F4A]" />
                Live
              </span>
              {liveSince ? (
                <span className="tabular-nums">
                  {formatElapsed(liveSince, now)}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="pointer-events-auto inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-white/[0.14] bg-[#131316]/90 px-3.5 text-[12px] text-[#fafafa]/85">
          <Users size={14} strokeWidth={ICON_STROKE} />
          <span data-testid="webinar-viewer-count" className="tabular-nums">
            {formatViewerCount(attendeeCount)}
          </span>
        </div>
      </div>

      <div
        className="flex items-end justify-between gap-3 px-5 sm:px-7"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 20px)" }}
      >
        <div className="min-w-0">
          {hasLiveStage && speakerName ? (
            <div className="pointer-events-auto inline-flex max-w-full items-center gap-2 rounded-full border border-white/[0.14] bg-[#131316]/90 px-3.5 py-2 text-[12.5px] text-[#fafafa]">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#F95F4A]" />
              <span className="truncate">{speakerName}</span>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onToggleHand ? (
            <button
              type="button"
              data-testid="webinar-raise-hand"
              onClick={onToggleHand}
              aria-pressed={isHandRaised}
              aria-label={isHandRaised ? "Lower hand" : "Raise hand"}
              title={
                isHandRaised
                  ? "Lower your hand"
                  : "Raise your hand to ask to speak"
              }
              className={`${overlayButtonClass} ${isHandRaised ? "border-[#F95F4A]/60 bg-[#F95F4A]/15 text-[#F95F4A]" : ""}`}
            >
              <Hand size={15} strokeWidth={ICON_STROKE} />
              <span className="hidden sm:inline">
                {isHandRaised ? "Hand raised" : "Raise hand"}
              </span>
            </button>
          ) : null}
          {qaEnabled && onToggleQa ? (
            <button
              type="button"
              data-testid="webinar-qa-toggle"
              onClick={onToggleQa}
              aria-pressed={isQaOpen}
              aria-label="Questions and answers"
              title="Ask the host a question"
              className={`${overlayButtonClass} relative ${isQaOpen ? "border-[#F95F4A]/60 text-[#F95F4A]" : ""}`}
            >
              <MessageCircleQuestion size={15} strokeWidth={ICON_STROKE} />
              <span className="hidden sm:inline">Q&A</span>
              {unseenQaCount > 0 && !isQaOpen ? (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#F95F4A] px-1 text-[9.5px] font-semibold text-white">
                  {unseenQaCount > 9 ? "9+" : unseenQaCount}
                </span>
              ) : null}
            </button>
          ) : null}
          {supportsFullscreen ? (
            <button
              type="button"
              onClick={handleToggleFullscreen}
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              className={`${overlayButtonClass} w-10 px-0`}
            >
              {isFullscreen ? (
                <Minimize2 size={15} strokeWidth={ICON_STROKE} />
              ) : (
                <Maximize2 size={15} strokeWidth={ICON_STROKE} />
              )}
            </button>
          ) : null}
          <button
            type="button"
            data-testid="webinar-leave"
            onClick={onLeave}
            aria-label="Leave webinar"
            title="Leave the webinar"
            className="pointer-events-auto inline-flex h-10 items-center justify-center gap-2 rounded-full bg-[#ea4335] px-4 text-[12.5px] font-medium text-white transition-[filter] duration-150 hover:brightness-110"
          >
            <PhoneOff size={15} strokeWidth={ICON_STROKE} />
            Leave
          </button>
        </div>
      </div>
    </div>
  );
}

export function WebinarStageInviteDialog({
  promotedByName,
  onAccept,
  onDismiss,
}: {
  promotedByName?: string;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Stage invitation"
      style={{ fontFamily: font.sans }}
    >
      <div
        className="w-full max-w-sm rounded-2xl border p-6 text-center"
        style={{ backgroundColor: color.surface, borderColor: color.border }}
      >
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-[#F95F4A]/50 bg-[#F95F4A]/12">
          <Hand size={18} strokeWidth={ICON_STROKE} className="text-[#F95F4A]" />
        </div>
        <h2 className="mt-4 text-[17px] font-semibold text-[#fafafa]">
          You&apos;re invited on stage
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-[#fafafa]/60">
          {promotedByName ? `${promotedByName} wants` : "The host wants"} to
          bring you into the conversation. You&apos;ll rejoin as a speaker and
          can turn on your mic and camera.
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            data-testid="webinar-invite-accept"
            onClick={onAccept}
            className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-[#F95F4A] text-[14px] font-medium text-white transition-[filter] duration-150 hover:brightness-105"
          >
            Join as a speaker
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex h-11 w-full items-center justify-center rounded-xl border border-white/[0.12] text-[14px] font-medium text-[#fafafa]/80 transition-colors duration-150 hover:bg-white/[0.06]"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

export function WebinarWaitingCard({
  attendeeCount,
}: {
  attendeeCount: number;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 text-center"
      style={{ fontFamily: font.sans }}
    >
      <h2
        className="text-[20px] leading-tight text-[#fafafa]"
        style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
      >
        The webinar will begin soon
      </h2>
      {attendeeCount > 1 ? (
        <p className="text-[13px] text-[#fafafa]/55">
          {attendeeCount} people are waiting with you
        </p>
      ) : null}
    </div>
  );
}

export default WebinarViewerChrome;
