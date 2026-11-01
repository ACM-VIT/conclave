"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  ChevronUp,
  Hand,
  Maximize2,
  Minimize2,
  MessageCircleQuestion,
  PhoneOff,
  Users,
  X,
} from "lucide-react";
import { color, font } from "@conclave/ui-tokens";
import type { WebinarQaEntry } from "../lib/types";

const ICON_STROKE = 1.75;
const CHROME_IDLE_HIDE_MS = 3_500;
const MAX_QUESTION_LENGTH = 500;

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

/**
 * Overlay chrome for the attendee webinar viewer: title + LIVE + elapsed on
 * top, speaker chip and viewer actions on the bottom. Fades out when the
 * pointer goes idle, like a video player.
 */
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

  // Keep the chrome up while nothing is playing, so the room never looks dead.
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

const statusChip = (
  entry: WebinarQaEntry,
): { label: string; toneClass: string } | null => {
  switch (entry.status) {
    case "answering":
      return {
        label: "Being answered",
        toneClass: "border-[#F95F4A]/50 bg-[#F95F4A]/12 text-[#F95F4A]",
      };
    case "answered":
      return {
        label: "Answered",
        toneClass: "border-white/[0.14] bg-white/[0.06] text-[#fafafa]/75",
      };
    case "pending":
      return {
        label: "Waiting",
        toneClass: "border-white/[0.12] bg-transparent text-[#fafafa]/50",
      };
    case "dismissed":
      return null;
  }
};

/** Attendee-facing Q&A dock: ask questions, upvote, read answers. */
export function WebinarQaPanel({
  entries,
  qaEnabled,
  currentUserId,
  onClose,
  onSubmit,
  onUpvote,
}: {
  entries: WebinarQaEntry[];
  qaEnabled: boolean;
  currentUserId?: string | null;
  onClose: () => void;
  onSubmit?: (question: string) => Promise<{ ok: boolean; error?: string }>;
  onUpvote?: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const previousCountRef = useRef(0);

  useEffect(() => {
    composerRef.current?.focus();
  }, []);

  const orderedEntries = useMemo(() => {
    const rank = (entry: WebinarQaEntry): number =>
      entry.status === "answering" ? 0 : 1;
    return [...entries]
      .filter((entry) => entry.status !== "dismissed")
      .sort((a, b) => rank(a) - rank(b) || a.askedAt - b.askedAt);
  }, [entries]);

  useEffect(() => {
    if (orderedEntries.length > previousCountRef.current) {
      const list = listRef.current;
      if (list) list.scrollTop = list.scrollHeight;
    }
    previousCountRef.current = orderedEntries.length;
  }, [orderedEntries.length]);

  const handleSubmit = useCallback(async () => {
    const question = draft.trim();
    if (!question || !onSubmit || isSending) return;
    setIsSending(true);
    setSubmitError(null);
    const result = await onSubmit(question);
    setIsSending(false);
    if (!result.ok) {
      setSubmitError(result.error ?? "Could not send your question.");
      return;
    }
    setDraft("");
  }, [draft, isSending, onSubmit]);

  return (
    <aside
      data-testid="webinar-qa-panel"
      aria-label="Webinar Q&A"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      className="safe-area-pt safe-area-pb fixed bottom-0 right-0 top-0 z-40 flex w-full flex-col overflow-hidden border-l sm:w-[380px]"
      style={{
        backgroundColor: color.surface,
        borderColor: color.border,
        color: color.text,
        fontFamily: font.sans,
      }}
    >
      <header
        className="flex items-center justify-between border-b px-4 py-3.5"
        style={{ borderColor: color.border }}
      >
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold">Q&A</h2>
          <p className="mt-0.5 text-[11.5px]" style={{ color: color.textFaint }}>
            Only hosts see your question until they answer it.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close Q&A"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#a1a1aa] transition-colors duration-150 hover:bg-[#232327] hover:text-[#fafafa]"
        >
          <X size={18} strokeWidth={ICON_STROKE} />
        </button>
      </header>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
        {orderedEntries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <MessageCircleQuestion
              size={22}
              strokeWidth={ICON_STROKE}
              className="text-[#fafafa]/30"
            />
            <p className="text-[13px] text-[#fafafa]/55">
              {qaEnabled
                ? "No questions yet. Ask the first one."
                : "The host turned Q&A off for this webinar."}
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {orderedEntries.map((entry) => {
              const chip = statusChip(entry);
              const isOwn = Boolean(
                currentUserId && entry.userId === currentUserId,
              );
              return (
                <li
                  key={entry.id}
                  className={`rounded-xl border px-3 py-2.5 ${entry.status === "answering" ? "border-[#F95F4A]/45" : "border-white/[0.1]"}`}
                  style={{ backgroundColor: color.bgAlt }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[11.5px] font-medium text-[#fafafa]/60">
                      {isOwn ? "You" : entry.displayName}
                    </span>
                    {chip ? (
                      <span
                        className={`shrink-0 rounded-full border px-2 py-0.5 text-[9.5px] font-medium uppercase tracking-[0.08em] ${chip.toneClass}`}
                      >
                        {chip.label}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1.5 text-[13.5px] leading-snug text-[#fafafa]">
                    {entry.question}
                  </p>
                  {entry.answerText ? (
                    <p className="mt-2 rounded-lg border border-white/[0.08] bg-black/30 px-2.5 py-2 text-[12.5px] leading-snug text-[#fafafa]/80">
                      <span className="font-medium text-[#fafafa]">
                        {entry.answeredByName || "Host"}:
                      </span>{" "}
                      {entry.answerText}
                    </p>
                  ) : null}
                  <div className="mt-2 flex items-center justify-between">
                    <button
                      type="button"
                      onClick={onUpvote ? () => onUpvote(entry.id) : undefined}
                      disabled={!onUpvote}
                      aria-pressed={Boolean(entry.hasUpvoted)}
                      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors duration-150 ${
                        entry.hasUpvoted
                          ? "border-[#F95F4A]/55 bg-[#F95F4A]/12 text-[#F95F4A]"
                          : "border-white/[0.12] text-[#fafafa]/65 hover:bg-white/[0.06]"
                      } ${onUpvote ? "" : "opacity-50"}`}
                    >
                      <ChevronUp size={13} strokeWidth={ICON_STROKE} />
                      <span className="tabular-nums">{entry.upvotes}</span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {qaEnabled && onSubmit ? (
        <div className="border-t px-4 py-3.5" style={{ borderColor: color.border }}>
          {submitError ? (
            <p className="mb-2 text-[11.5px] text-[#F95F4A]">{submitError}</p>
          ) : null}
          <div className="flex items-end gap-2">
            <textarea
              ref={composerRef}
              value={draft}
              onChange={(event) =>
                setDraft(event.target.value.slice(0, MAX_QUESTION_LENGTH))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSubmit();
                }
              }}
              rows={2}
              placeholder="Ask the host a question"
              data-testid="webinar-qa-input"
              className="min-h-[44px] flex-1 resize-none rounded-xl border border-white/[0.12] bg-transparent px-3 py-2.5 text-[13.5px] text-[#fafafa] outline-none placeholder:text-[#fafafa]/35 focus:border-[#F95F4A]/50"
            />
            <button
              type="button"
              data-testid="webinar-qa-send"
              onClick={() => void handleSubmit()}
              disabled={!draft.trim() || isSending}
              className="inline-flex h-[44px] items-center justify-center rounded-xl bg-[#F95F4A] px-4 text-[13px] font-medium text-white transition-[filter] duration-150 enabled:hover:brightness-105 disabled:opacity-40"
            >
              Ask
            </button>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

/** Modal shown to an attendee the host invited on stage. */
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

/** Full-stage placeholder while no panelist is live yet. */
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
