"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronUp, MessageCircleQuestion, X } from "lucide-react";
import { color, font } from "@conclave/ui-tokens";
import type {
  WebinarQaEntry,
  WebinarQaModerateRequest,
  WebinarQaStatus,
} from "../../lib/types";
import PanelNoticeSlot from "../PanelNoticeSlot";

const ICON_STROKE = 1.75;
const MAX_QUESTION_LENGTH = 500;

type QaModerateAction = WebinarQaModerateRequest["action"];

/** What a host can do to a question in each state. */
const MODERATION_ACTIONS: Record<
  WebinarQaStatus,
  { action: QaModerateAction; label: string; primary?: boolean }[]
> = {
  pending: [
    { action: "answering", label: "Answer live", primary: true },
    { action: "answered", label: "Mark answered" },
    { action: "dismissed", label: "Hide" },
  ],
  answering: [
    { action: "answered", label: "Done" },
    { action: "dismissed", label: "Hide" },
  ],
  answered: [
    { action: "reopen", label: "Reopen" },
    { action: "dismissed", label: "Hide" },
  ],
  dismissed: [{ action: "reopen", label: "Unhide" }],
};

const actionButtonBase =
  "inline-flex items-center justify-center rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40";
const neutralActionClass =
  actionButtonBase +
  " border border-white/10 bg-white/[0.04] text-[#a1a1aa] hover:bg-white/[0.07] hover:text-[#fafafa]";
const primaryActionClass =
  actionButtonBase +
  " border border-[#F95F4A]/35 bg-[#F95F4A]/10 text-[#F95F4A] hover:bg-[#F95F4A]/15";

/** Host moderation buttons for one question, shared by every Q&A surface. */
export function QaModerationActions({
  status,
  disabled,
  onAction,
}: {
  status: WebinarQaStatus;
  disabled?: boolean;
  onAction: (action: QaModerateAction) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {MODERATION_ACTIONS[status].map(({ action, label, primary }) => (
        <button
          key={action}
          type="button"
          disabled={disabled}
          onClick={() => onAction(action)}
          className={primary ? primaryActionClass : neutralActionClass}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const statusChip = (
  entry: WebinarQaEntry,
  audience: QaAudience,
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
      return audience === "webinar"
        ? {
            label: "Waiting",
            toneClass: "border-white/[0.12] bg-transparent text-[#fafafa]/50",
          }
        : null;
    case "dismissed":
      return {
        label: "Hidden",
        toneClass: "border-white/[0.12] bg-transparent text-[#fafafa]/50",
      };
  }
};

/**
 * Webinar attendees ask the hosts privately; in a regular meeting every
 * question is public until a host hides it.
 */
export type QaAudience = "webinar" | "meeting";

const COPY: Record<QaAudience, { subtitle: string; placeholder: string; off: string }> = {
  webinar: {
    subtitle: "Only hosts see your question until they answer it.",
    placeholder: "Ask the host a question",
    off: "The host turned Q&A off for this webinar.",
  },
  meeting: {
    subtitle: "Everyone in the meeting can see questions.",
    placeholder: "Ask a question",
    off: "Q&A is off.",
  },
};

export function QaPanel({
  audience,
  entries,
  qaEnabled,
  currentUserId,
  askNeedsIdentity = false,
  onClose,
  onSubmit,
  onUpvote,
  onModerate,
}: {
  audience: QaAudience;
  entries: WebinarQaEntry[];
  qaEnabled: boolean;
  currentUserId?: string | null;
  /** Asking is closed to this viewer only because they are not signed in. */
  askNeedsIdentity?: boolean;
  onClose: () => void;
  onSubmit?: (question: string) => Promise<{ ok: boolean; error?: string }>;
  /** May answer with why the upvote did not go through. */
  onUpvote?: (
    id: string,
  ) => void | Promise<{ ok: boolean; error?: string }>;
  /** Hosts only: moderation right inside the list. */
  onModerate?: (
    request: WebinarQaModerateRequest,
  ) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busyEntryId, setBusyEntryId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const previousCountRef = useRef(0);
  const copy = COPY[audience];

  useEffect(() => {
    composerRef.current?.focus();
  }, []);

  const orderedEntries = useMemo(() => {
    const rank = (entry: WebinarQaEntry): number =>
      entry.status === "answering" ? 0 : entry.status === "dismissed" ? 2 : 1;
    // A hidden question is a host's alone to see, its asker's no more than
    // anyone's. The server sends it to nobody else.
    return [...entries]
      .filter((entry) => onModerate || entry.status !== "dismissed")
      .sort((a, b) => rank(a) - rank(b) || a.askedAt - b.askedAt);
  }, [entries, onModerate]);

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

  const moderate = async (id: string, action: QaModerateAction) => {
    if (!onModerate) return;
    setBusyEntryId(id);
    setListError(null);
    const result = await onModerate({ id, action });
    setBusyEntryId(null);
    if (!result.ok) setListError(result.error ?? "That did not go through.");
  };

  const upvote = async (id: string) => {
    if (!onUpvote) return;
    setListError(null);
    const result = await onUpvote(id);
    if (result && !result.ok) {
      setListError(result.error ?? "That did not go through.");
    }
  };

  return (
    <aside
      data-testid="qa-panel"
      aria-label="Q&A"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      className="safe-area-pt safe-area-pb fixed bottom-0 right-0 top-0 z-40 flex w-full flex-col overflow-hidden border-l animate-panel-in sm:w-[360px]"
      style={{
        backgroundColor: color.surface,
        borderColor: color.border,
        color: color.text,
        fontFamily: font.sans,
      }}
    >
      <header
        className="flex items-center justify-between border-b px-4 py-3"
        style={{ borderColor: color.border }}
      >
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold">Q&A</h2>
          <p className="mt-0.5 text-[11.5px]" style={{ color: color.textFaint }}>
            {copy.subtitle}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close Q&A"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#a1a1aa] transition-colors duration-150 hover:bg-white/[0.06] hover:text-[#fafafa]"
        >
          <X size={18} strokeWidth={ICON_STROKE} />
        </button>
      </header>
      <PanelNoticeSlot />

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
        {orderedEntries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <MessageCircleQuestion
              size={22}
              strokeWidth={ICON_STROKE}
              className="text-[#fafafa]/30"
            />
            <p className="text-[13px] text-[#fafafa]/55">
              {qaEnabled ? "No questions yet. Ask the first one." : copy.off}
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {orderedEntries.map((entry) => {
              const chip = statusChip(entry, audience);
              const isOwn = Boolean(
                currentUserId && entry.userId === currentUserId,
              );
              const isHidden = entry.status === "dismissed";
              return (
                <li
                  key={entry.id}
                  data-testid="qa-entry"
                  data-qa-status={entry.status}
                  className={`rounded-xl border px-3 py-2.5 ${entry.status === "answering" ? "border-[#F95F4A]/45" : "border-white/[0.1]"} ${isHidden ? "opacity-60" : ""}`}
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
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      data-testid="qa-upvote"
                      onClick={onUpvote ? () => void upvote(entry.id) : undefined}
                      disabled={!onUpvote || isHidden}
                      aria-pressed={Boolean(entry.hasUpvoted)}
                      aria-label={`Upvote, ${entry.upvotes} so far`}
                      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors duration-150 ${
                        entry.hasUpvoted
                          ? "border-[#F95F4A]/55 bg-[#F95F4A]/12 text-[#F95F4A]"
                          : "border-white/[0.12] text-[#fafafa]/65 hover:bg-white/[0.06]"
                      } ${onUpvote && !isHidden ? "" : "opacity-50"}`}
                    >
                      <ChevronUp size={13} strokeWidth={ICON_STROKE} />
                      <span className="tabular-nums">{entry.upvotes}</span>
                    </button>
                    {onModerate ? (
                      <QaModerationActions
                        status={entry.status}
                        disabled={busyEntryId === entry.id}
                        onAction={(action) => void moderate(entry.id, action)}
                      />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {listError ? (
          <p
            data-testid="qa-list-error"
            className="mt-2 text-[11.5px] text-[#F95F4A]"
          >
            {listError}
          </p>
        ) : null}
      </div>

      {askNeedsIdentity ? (
        <p
          data-testid="qa-sign-in"
          className="border-t px-4 py-3.5 text-[12.5px] text-[#fafafa]/60"
          style={{ borderColor: color.border }}
        >
          Sign in to ask a question.
        </p>
      ) : qaEnabled && onSubmit ? (
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
              placeholder={copy.placeholder}
              data-testid="qa-input"
              className="min-h-[44px] flex-1 resize-none rounded-xl border border-white/[0.12] bg-transparent px-3 py-2.5 text-[13.5px] text-[#fafafa] outline-none placeholder:text-[#fafafa]/35 focus:border-[#F95F4A]/50"
            />
            <button
              type="button"
              data-testid="qa-send"
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
