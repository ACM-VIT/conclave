"use client";

import { useMemo, useState } from "react";
import { Check, ChartBar, Download, Plus, X } from "lucide-react";
import { color } from "@conclave/ui-tokens";
import { SwitchRow } from "@conclave/ui-tokens/web";
import {
  POLL_MAX_OPTION_LENGTH,
  POLL_MAX_OPTIONS,
  POLL_MAX_QUESTION_LENGTH,
  POLL_MIN_OPTIONS,
  type PollActionResult,
  type PollChoiceMode,
  type PollItem,
  type PollResultRow,
} from "@conclave/apps-sdk/polls/web";
import PanelNoticeSlot from "../PanelNoticeSlot";

const STROKE = 1.75;

const inputClass =
  "w-full rounded-lg border border-white/[0.12] bg-transparent px-3 py-2 text-[13.5px] text-[#fafafa] outline-none placeholder:text-[#fafafa]/35 focus:border-[#F95F4A]/60";
const primaryButtonClass =
  "inline-flex h-9 items-center justify-center rounded-lg bg-[#F95F4A] px-4 text-[13px] font-medium text-white transition-[filter] duration-150 enabled:hover:brightness-105 disabled:opacity-40";
const quietButtonClass =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-white/[0.12] px-3 text-[12.5px] text-[#fafafa]/80 transition-colors duration-150 enabled:hover:bg-white/[0.06] disabled:opacity-40";

export type PollsPanelProps = {
  polls: PollItem[];
  isHost: boolean;
  /** Whether this viewer may vote at all. */
  canVote: boolean;
  /** Voting is closed to this viewer only because they are not signed in. */
  voteNeedsIdentity: boolean;
  onClose: () => void;
  onCreate: (draft: {
    question: string;
    options: string[];
    choiceMode: PollChoiceMode;
  }) => Promise<PollActionResult>;
  onVote: (pollId: string, optionIds: string[]) => Promise<PollActionResult>;
  onEnd: (pollId: string) => Promise<PollActionResult>;
  onShare: (pollId: string, shared: boolean) => Promise<PollActionResult>;
  onExport: (pollId: string) => Promise<PollActionResult>;
  waiting?: boolean;
};

export function PollsPanel({
  polls,
  isHost,
  canVote,
  voteNeedsIdentity,
  onClose,
  onCreate,
  onVote,
  onEnd,
  onShare,
  onExport,
  waiting = false,
}: PollsPanelProps) {
  const [isComposing, setIsComposing] = useState(false);
  const newestFirst = useMemo(
    () => [...polls].sort((a, b) => b.createdAt - a.createdAt),
    [polls],
  );

  return (
    <aside
      data-testid="polls-panel"
      aria-label="Polls"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      className="safe-area-pt safe-area-pb fixed right-0 top-0 bottom-0 z-40 flex w-full flex-col border-l border-white/10 bg-[#18181b] animate-panel-in sm:w-[360px]"
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
        <h2 className="text-[15px] font-semibold text-[#fafafa]">Polls</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close polls"
          title="Close polls"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[#a1a1aa] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
        >
          <X size={18} strokeWidth={STROKE} />
        </button>
      </div>
      <PanelNoticeSlot />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {isHost && !isComposing ? (
          <button
            type="button"
            data-testid="poll-start"
            onClick={() => setIsComposing(true)}
            className="mb-4 flex w-full items-center justify-center gap-2 rounded-xl border border-white/[0.12] py-2.5 text-[13.5px] font-medium text-[#fafafa] transition-colors duration-150 hover:bg-white/[0.05]"
          >
            <Plus size={16} strokeWidth={STROKE} />
            Start a poll
          </button>
        ) : null}

        {isHost && isComposing ? (
          <PollComposer
            waiting={waiting}
            onCancel={() => setIsComposing(false)}
            onLaunch={async (draft) => {
              const result = await onCreate(draft);
              if (result.ok) setIsComposing(false);
              return result;
            }}
          />
        ) : null}

        {newestFirst.length === 0 && !isComposing ? (
          <div className="flex flex-col items-center gap-2 px-6 pt-10 text-center">
            <ChartBar size={22} strokeWidth={STROKE} className="text-[#fafafa]/30" />
            <p className="text-balance text-[13px] leading-relaxed text-[#fafafa]/55">
              {isHost
                ? "Ask a question and see the answers come in live."
                : "No polls yet. When a host starts one, it shows up here."}
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {newestFirst.map((poll) => (
              <li key={poll.id}>
                <PollCard
                  poll={poll}
                  isHost={isHost}
                  mayVote={canVote}
                  voteNeedsIdentity={voteNeedsIdentity}
                  onVote={onVote}
                  onEnd={onEnd}
                  onShare={onShare}
                  onExport={onExport}
                  waiting={waiting}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function PollComposer({
  onLaunch,
  onCancel,
  waiting,
}: {
  onLaunch: (draft: {
    question: string;
    options: string[];
    choiceMode: PollChoiceMode;
  }) => Promise<PollActionResult>;
  onCancel: () => void;
  waiting: boolean;
}) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filledOptions = options.map((option) => option.trim()).filter(Boolean);
  const canLaunch =
    question.trim().length > 0 &&
    filledOptions.length >= POLL_MIN_OPTIONS &&
    !isLaunching &&
    !waiting;

  const launch = async () => {
    if (!canLaunch) return;
    setIsLaunching(true);
    setError(null);
    const result = await onLaunch({
      question: question.trim(),
      options: filledOptions,
      choiceMode: allowMultiple ? "multiple" : "single",
    });
    setIsLaunching(false);
    if (!result.ok) setError(result.error);
  };

  return (
    <form
      data-testid="poll-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void launch();
      }}
      className="mb-4 rounded-xl border border-white/[0.12] p-3"
      style={{ backgroundColor: color.bgAlt }}
    >
      <label className="block text-[12px] font-medium text-[#fafafa]/70" htmlFor="poll-question">
        Question
      </label>
      <input
        id="poll-question"
        data-testid="poll-question-input"
        autoFocus
        value={question}
        maxLength={POLL_MAX_QUESTION_LENGTH}
        onChange={(event) => setQuestion(event.target.value)}
        placeholder="Ask a question"
        className={`${inputClass} mt-1.5`}
      />

      <p className="mt-3 text-[12px] font-medium text-[#fafafa]/70">Options</p>
      <div className="mt-1.5 flex flex-col gap-2">
        {options.map((option, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <input
              data-testid="poll-option-input"
              aria-label={`Option ${index + 1}`}
              value={option}
              maxLength={POLL_MAX_OPTION_LENGTH}
              onChange={(event) =>
                setOptions((previous) =>
                  previous.map((value, at) => (at === index ? event.target.value : value)),
                )
              }
              placeholder={`Option ${index + 1}`}
              className={inputClass}
            />
            {options.length > POLL_MIN_OPTIONS ? (
              <button
                type="button"
                aria-label={`Remove option ${index + 1}`}
                onClick={() =>
                  setOptions((previous) => previous.filter((_, at) => at !== index))
                }
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#a1a1aa] hover:bg-white/[0.06] hover:text-[#fafafa]"
              >
                <X size={15} strokeWidth={STROKE} />
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {options.length < POLL_MAX_OPTIONS ? (
        <button
          type="button"
          data-testid="poll-add-option"
          onClick={() => setOptions((previous) => [...previous, ""])}
          className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[#F95F4A] hover:brightness-110"
        >
          <Plus size={14} strokeWidth={STROKE} />
          Add option
        </button>
      ) : null}

      <SwitchRow
        label="Allow multiple answers"
        checked={allowMultiple}
        onChange={setAllowMultiple}
        className="mt-2 -mx-3 w-[calc(100%+1.5rem)] text-[13px]"
      />

      {error ? <p className="mt-1 text-[12px] text-[#F95F4A]">{error}</p> : null}

      <div className="mt-2 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={quietButtonClass}>
          Cancel
        </button>
        <button
          type="submit"
          data-testid="poll-launch"
          disabled={!canLaunch}
          className={primaryButtonClass}
        >
          Launch
        </button>
      </div>
    </form>
  );
}

function PollCard({
  poll,
  isHost,
  mayVote,
  voteNeedsIdentity,
  onVote,
  onEnd,
  onShare,
  onExport,
  waiting,
}: {
  poll: PollItem;
  isHost: boolean;
  mayVote: boolean;
  voteNeedsIdentity: boolean;
  onVote: PollsPanelProps["onVote"];
  onEnd: PollsPanelProps["onEnd"];
  onShare: PollsPanelProps["onShare"];
  onExport: PollsPanelProps["onExport"];
  waiting: boolean;
}) {
  const [selection, setSelection] = useState<string[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isOpen = poll.status === "open";
  const voted = poll.myVote.length > 0;
  const canVote = isOpen && !voted && mayVote;
  // The server sends results exactly when this viewer may see them, so they
  // are shown whenever they are here, voted or not, open or ended.
  const results = poll.results;
  const showResults = results !== null;
  const myVote = new Set(poll.myVote);
  const isMultiple = poll.choiceMode === "multiple";

  const run = async (action: string, task: () => Promise<PollActionResult>) => {
    setBusyAction(action);
    setError(null);
    const result = await task();
    setBusyAction(null);
    if (!result.ok) setError(result.error);
  };

  const toggle = (optionId: string) =>
    setSelection((previous) =>
      isMultiple
        ? previous.includes(optionId)
          ? previous.filter((id) => id !== optionId)
          : [...previous, optionId]
        : [optionId],
    );

  const rowsById = new Map<string, PollResultRow>(
    (results ?? []).map((row) => [row.id, row]),
  );

  return (
    <article
      data-testid="poll-card"
      data-poll-status={poll.status}
      className={`rounded-xl border p-3 ${isOpen ? "border-white/[0.14]" : "border-white/[0.08]"}`}
      style={{ backgroundColor: color.bgAlt }}
    >
      <div className="flex items-center gap-2 text-[11.5px] text-[#fafafa]/55">
        {isOpen ? (
          <span className="inline-flex items-center gap-1.5 font-medium text-[#fafafa]/80">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#F95F4A]" />
            Live
          </span>
        ) : (
          <span className="font-medium">Ended</span>
        )}
        <span aria-hidden>·</span>
        <span className="truncate">{isMultiple ? "Pick any" : "Pick one"}</span>
      </div>

      <fieldset className="mt-1.5" disabled={!canVote || busyAction !== null}>
        <legend className="text-[14px] font-medium leading-snug text-[#fafafa]">
          {poll.question}
        </legend>
        <div className="mt-2.5 flex flex-col gap-1.5">
          {poll.options.map((option) => {
            const row = rowsById.get(option.id);
            const isMine = myVote.has(option.id);
            return (
              <label
                key={option.id}
                className={`block rounded-lg px-2 py-1.5 ${canVote ? "cursor-pointer hover:bg-white/[0.04]" : ""}`}
              >
                <span className="flex items-center gap-2.5">
                  {canVote ? (
                    <input
                      type={isMultiple ? "checkbox" : "radio"}
                      name={`poll-${poll.id}`}
                      checked={selection.includes(option.id)}
                      onChange={() => toggle(option.id)}
                      className="h-4 w-4 shrink-0 accent-[#F95F4A]"
                    />
                  ) : isMine ? (
                    <Check
                      size={15}
                      strokeWidth={2}
                      className="shrink-0 text-[#F95F4A]"
                      aria-label="Your answer"
                    />
                  ) : voted ? (
                    <span aria-hidden className="w-[15px] shrink-0" />
                  ) : null}
                  <span className="min-w-0 flex-1 text-[13.5px] leading-snug text-[#fafafa]">
                    {option.text}
                  </span>
                  {showResults && row ? (
                    <span className="shrink-0 text-[12px] tabular-nums text-[#fafafa]/60">
                      {row.votes} · {row.percent}%
                    </span>
                  ) : null}
                </span>
                {showResults && row ? (
                  <span
                    aria-hidden
                    data-testid="poll-result-bar"
                    className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-white/[0.07]"
                  >
                    <span
                      className="block h-full rounded-full transition-[width] duration-300 ease-out"
                      style={{
                        width: `${row.percent}%`,
                        backgroundColor: isMine ? color.accent : "rgba(250,250,250,0.32)",
                      }}
                    />
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>
      </fieldset>

      <PollFootnote
        poll={poll}
        isHost={isHost}
        voted={voted}
        showResults={showResults}
        needsIdentity={isOpen && !voted && voteNeedsIdentity}
      />

      {canVote ? (
        <button
          type="button"
          data-testid="poll-vote"
          disabled={selection.length === 0 || busyAction !== null || waiting}
          onClick={() => void run("vote", () => onVote(poll.id, selection))}
          className={`${primaryButtonClass} mt-3 w-full`}
        >
          Vote
        </button>
      ) : null}

      {isHost ? (
        <div className="mt-3 border-t border-white/[0.08] pt-2">
          <SwitchRow
            label="Show results to everyone"
            checked={poll.resultsShared}
            disabled={busyAction !== null || waiting}
            onChange={(shared) => void run("share", () => onShare(poll.id, shared))}
            className="-mx-3 w-[calc(100%+1.5rem)] text-[13px]"
          />
          <div className="mt-1 flex flex-wrap gap-2">
            {isOpen ? (
              <button
                type="button"
                data-testid="poll-end"
                disabled={busyAction !== null || waiting}
                onClick={() => void run("end", () => onEnd(poll.id))}
                className={quietButtonClass}
              >
                End poll
              </button>
            ) : null}
            <button
              type="button"
              data-testid="poll-export"
              disabled={busyAction !== null || waiting}
              onClick={() => void run("export", () => onExport(poll.id))}
              className={quietButtonClass}
            >
              <Download size={14} strokeWidth={STROKE} />
              Download CSV
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className="mt-2 text-[12px] text-[#F95F4A]">{error}</p> : null}
    </article>
  );
}

function PollFootnote({
  poll,
  isHost,
  voted,
  showResults,
  needsIdentity,
}: {
  poll: PollItem;
  isHost: boolean;
  voted: boolean;
  showResults: boolean;
  needsIdentity: boolean;
}) {
  const voterCount = poll.voterCount ?? 0;
  const votes = `${voterCount} ${voterCount === 1 ? "vote" : "votes"}`;
  let text: string | null = null;
  if (isHost) {
    text = poll.resultsShared ? `${votes} · Everyone can see results` : `${votes} · Only hosts see results`;
  } else if (needsIdentity) {
    text = "Sign in to vote.";
  } else if (showResults) {
    text = votes;
  } else if (voted) {
    text = "Vote submitted. The host can share results.";
  } else if (poll.status === "ended") {
    text = "This poll has ended.";
  }
  return text ? (
    <p data-testid="poll-footnote" className="mt-2 text-[12px] text-[#fafafa]/55">
      {text}
    </p>
  ) : null;
}
