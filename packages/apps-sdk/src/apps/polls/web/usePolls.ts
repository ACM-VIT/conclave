import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAuthority } from "../../../sdk/authority/react";
import type { AuthorityFailure } from "../../../sdk/authority/index";
import {
  buildPollCsv,
  pollCsvFilename,
  pollResultRows,
  pollsContract,
  type PollBallot,
  type PollCard,
  type PollChoiceMode,
  type PollResultRow,
} from "../core/index";

export type PollActionResult = { ok: true } | { ok: false; error: string };

export type PollItem = PollCard & {
  /** The viewer's own ballot. Empty until they vote. */
  myVote: string[];
  /**
   * Result bars, present exactly when the server let this viewer see
   * results. Show them when they are there, with no condition of your own.
   */
  results: PollResultRow[] | null;
  voterCount: number | null;
};

const REASONS: Record<string, string> = {
  "invalid-question": "Add a question",
  "invalid-options": "Add 2 to 10 different options",
  "too-many-polls": "This meeting has reached its poll limit",
  "not-found": "This poll is no longer available",
  ended: "This poll has ended",
  "already-voted": "You already voted",
  "invalid-choice": "Pick an option to vote",
  "export-changed": "This poll's votes changed during the download. Try again.",
};

const FAILURES: Partial<Record<AuthorityFailure["code"], string>> = {
  forbidden: "Only hosts can do that",
  "identity-required": "Sign in to vote",
  "invalid-input": "Pick an option to vote",
  "rate-limited": "You are voting too quickly",
  busy: "A lot is happening. Try again in a moment.",
  "unknown-outcome": "The server did not respond. Try again.",
};

const describe = (failure: AuthorityFailure): string =>
  (failure.code === "rejected"
    ? REASONS[failure.reason ?? ""]
    : FAILURES[failure.code]) ?? "That did not go through.";

/** How long to wait before asking again for a page the server refused as busy. */
const EXPORT_WAIT_MS = 1_000;
/** Waits in a row before an export gives up. */
const EXPORT_MAX_WAITS = 10;
const EXPORT_MAX_RESTARTS = 3;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const downloadCsv = (filename: string, csv: string): void => {
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

/**
 * The room's polls as this viewer may see them, and what they may do.
 * `onPollStarted` fires for a poll that opened after this viewer's first
 * look, so a host surface can point at it.
 */
export function usePolls(options?: {
  onPollStarted?: (poll: PollCard) => void;
}) {
  const { state, act, query } = useAuthority(pollsContract);
  const onPollStarted = options?.onPollStarted;
  const onPollStartedRef = useRef(onPollStarted);
  useEffect(() => {
    onPollStartedRef.current = onPollStarted;
  }, [onPollStarted]);

  const view = state.kind === "ready" ? state.view : null;
  const polls = useMemo<PollItem[]>(() => {
    if (!view) return [];
    return [...view.polls.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((poll) => {
        const results = view.results.get(poll.id);
        return {
          ...poll,
          myVote: view.myVotes.get(poll.id)?.optionIds ?? [],
          results: results ? pollResultRows(poll, results) : null,
          voterCount: results ? results.voterCount : null,
        };
      });
  }, [view]);

  const knownIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!view) {
      knownIdsRef.current = null;
      return;
    }
    const known = knownIdsRef.current;
    if (!known) {
      knownIdsRef.current = new Set(view.polls.keys());
      return;
    }
    for (const poll of view.polls.values()) {
      if (known.has(poll.id)) continue;
      known.add(poll.id);
      if (poll.status === "open") onPollStartedRef.current?.(poll);
    }
  }, [view]);

  const createPoll = useCallback(
    async (draft: {
      question: string;
      options: string[];
      choiceMode: PollChoiceMode;
    }): Promise<PollActionResult> => {
      const result = await act("create", draft);
      return result.ok ? { ok: true } : { ok: false, error: describe(result) };
    },
    [act],
  );
  const vote = useCallback(
    async (pollId: string, optionIds: string[]): Promise<PollActionResult> => {
      const result = await act("vote", { pollId, optionIds });
      return result.ok ? { ok: true } : { ok: false, error: describe(result) };
    },
    [act],
  );
  const endPoll = useCallback(
    async (pollId: string): Promise<PollActionResult> => {
      const result = await act("end", { pollId });
      return result.ok ? { ok: true } : { ok: false, error: describe(result) };
    },
    [act],
  );
  const shareResults = useCallback(
    async (pollId: string, shared: boolean): Promise<PollActionResult> => {
      const result = await act("share", { pollId, shared });
      return result.ok ? { ok: true } : { ok: false, error: describe(result) };
    },
    [act],
  );
  /**
   * Downloads every ballot of a poll. A poll can hold more ballots than one
   * answer carries, so they are read a page at a time and joined here. A
   * page the server is too busy to give is asked for again after a wait.
   */
  const exportCsv = useCallback(
    async (pollId: string): Promise<PollActionResult> => {
      const ballots: PollBallot[] = [];
      let offset = 0;
      let rewrites: number | undefined;
      let waits = 0;
      let restarts = 0;
      for (;;) {
        const result = await query("exportBallots", { pollId, offset, rewrites });
        if (!result.ok) {
          if (result.code === "rejected" && result.reason === "export-changed" && restarts < EXPORT_MAX_RESTARTS) {
            restarts += 1;
            ballots.length = 0;
            offset = 0;
            rewrites = undefined;
            continue;
          }
          const busy = result.code === "rate-limited" || result.code === "busy";
          if (!busy || waits >= EXPORT_MAX_WAITS) {
            return { ok: false, error: describe(result) };
          }
          waits += 1;
          await pause(result.retryAfterMs ?? EXPORT_WAIT_MS);
          continue;
        }
        waits = 0;
        rewrites = result.value.rewrites;
        ballots.push(...result.value.ballots);
        if (result.value.nextOffset === null) {
          const { poll } = result.value;
          downloadCsv(pollCsvFilename(poll), buildPollCsv({ poll, ballots }));
          return { ok: true };
        }
        offset = result.value.nextOffset;
      }
    },
    [query],
  );

  const ready = state.kind === "ready" ? state : null;
  return {
    isReady: ready !== null,
    isConnecting: state.kind === "connecting",
    isReplacing: state.kind === "connecting" && state.replacing === true,
    polls,
    /** Hosts: may start, end, share and export. */
    canManage: ready?.actions.has("create") ?? false,
    canVote: ready?.actions.has("vote") ?? false,
    /** Voting is closed to this viewer only for want of a verified identity. */
    voteNeedsIdentity: ready?.needsIdentity.has("vote") ?? false,
    createPoll,
    vote,
    endPoll,
    shareResults,
    exportCsv,
  };
}

export type PollsApp = ReturnType<typeof usePolls>;
