import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuthority } from "../../../sdk/authority/react";
import type { AuthorityFailure } from "../../../sdk/authority/index";
import {
  qaContract,
  type QaModerateAction,
  type QuestionCard,
} from "../core/index";

export type QaActionResult = { ok: true } | { ok: false; error: string };

export type QaItem = QuestionCard & {
  upvotes: number;
  /** The viewer asked this. */
  mine: boolean;
  hasUpvoted: boolean;
};

const REASONS: Record<string, string> = {
  "too-short": "Ask a longer question",
  "too-many-open": "You already have questions waiting. Give the host a moment.",
  "not-found": "Question not found",
};

type Doing = "ask" | "upvote" | "moderate";

const FAILURES: Partial<
  Record<AuthorityFailure["code"], Partial<Record<Doing, string>>>
> = {
  forbidden: {
    ask: "Q&A is not available to you here",
    upvote: "Q&A is not available to you here",
    moderate: "Only hosts can do this",
  },
  "identity-required": {
    ask: "Sign in to ask a question",
    upvote: "Sign in to upvote",
  },
  "invalid-input": { ask: "Ask a longer question" },
  "rate-limited": {
    ask: "You are sending questions too quickly",
    upvote: "You are voting too quickly",
  },
  busy: {
    ask: "A lot is happening. Try again in a moment.",
    upvote: "A lot is happening. Try again in a moment.",
    moderate: "A lot is happening. Try again in a moment.",
  },
  "unknown-outcome": {
    ask: "The server did not respond. Try again.",
    upvote: "The server did not respond. Try again.",
    moderate: "The server did not respond. Try again.",
  },
};

const describe = (failure: AuthorityFailure, doing: Doing): string =>
  (failure.code === "rejected"
    ? REASONS[failure.reason ?? ""]
    : FAILURES[failure.code]?.[doing]) ?? "That did not go through.";

/**
 * What the viewer last asked for on one question, shown in place of the
 * view only until the view can answer for itself. The button's state is the
 * view's: a wish is an optimistic flag over it, and it stops standing when
 * either of these happens:
 *
 * - The viewer's own upvotes in the view change after the request left,
 *   by that request landing or by another tab. `sentOn` is those upvotes
 *   as the view held them when the request left.
 * - The view reaches the revision the request's answer named, a replayed
 *   answer included. The view then reflects the request and everything
 *   committed before the answer, even when nothing in it changed.
 *
 * A wish not sent yet, a change of mind waiting for the request before it,
 * stands until it is sent.
 */
type UpvoteWish = {
  value: boolean;
  sentOn?: ReadonlyMap<string, unknown> | null;
  revision?: number;
};

const NO_WISHES: ReadonlyMap<string, UpvoteWish> = new Map();

type Seen = { myUpvotes: ReadonlyMap<string, unknown> | null; revision: number };

const wishedUpvote = (
  wishes: ReadonlyMap<string, UpvoteWish>,
  id: string,
  seen: Seen,
): boolean | undefined => {
  const wish = wishes.get(id);
  if (!wish) return undefined;
  const moved = wish.sentOn !== undefined && wish.sentOn !== seen.myUpvotes;
  const reached = wish.revision !== undefined && seen.revision >= wish.revision;
  return moved || reached ? undefined : wish.value;
};

/** The room's questions as this viewer may see them, and what they may do. */
export function useQa() {
  const { state, act } = useAuthority(qaContract);

  const view = state.kind === "ready" ? state.view : null;
  const revision = state.kind === "ready" ? state.revision : 0;
  const [wishes, setWishes] = useState(NO_WISHES);
  const questions = useMemo<QaItem[]>(() => {
    if (!view) return [];
    const seen: Seen = { myUpvotes: view.myUpvotes, revision };
    const hasUpvoted = (id: string): boolean =>
      wishedUpvote(wishes, id, seen) ?? view.myUpvotes.has(id);
    const items = new Map<string, QaItem>();
    for (const question of view.questions.values()) {
      items.set(question.id, {
        ...question,
        upvotes: view.votes.get(question.id)?.upvotes ?? 0,
        mine: view.myQuestions.has(question.id),
        hasUpvoted: hasUpvoted(question.id),
      });
    }
    // The viewer's own questions that their list leaves out: the ones still
    // waiting for a host in a webinar.
    for (const [id, own] of view.myQuestions) {
      if (!own.hidden || items.has(id)) continue;
      items.set(id, {
        ...own.hidden.question,
        upvotes: own.hidden.upvotes,
        mine: true,
        hasUpvoted: hasUpvoted(id),
      });
    }
    return [...items.values()].sort((a, b) => a.askedAt - b.askedAt);
  }, [view, revision, wishes]);

  const ask = useCallback(
    async (text: string): Promise<QaActionResult> => {
      const result = await act("ask", { text });
      return result.ok
        ? { ok: true }
        : { ok: false, error: describe(result, "ask") };
    },
    [act],
  );
  const setUpvoted = useCallback(
    async (id: string, value: boolean): Promise<QaActionResult> => {
      const result = await act("upvote", { id, value });
      return result.ok
        ? { ok: true }
        : { ok: false, error: describe(result, "upvote") };
    },
    [act],
  );

  // The view and wishes as they are when an answer comes back, which is
  // later than the click that asked.
  const viewRef = useRef(view);
  const revisionRef = useRef(revision);
  useEffect(() => {
    viewRef.current = view;
    revisionRef.current = revision;
  }, [view, revision]);
  const wishesRef = useRef(wishes);
  const sendingRef = useRef(new Set<string>());

  /**
   * Flips the viewer's upvote on a question. Clicks are the viewer's intent
   * and the server's answer may be a moment behind them, so each click flips
   * what was last asked for, not what the view shows. One request per
   * question is out at a time, and it carries the wanted state: a change of
   * mind is sent after the answer, and a click that returns to what is
   * already on its way sends nothing.
   */
  const toggleUpvote = useCallback(
    async (id: string): Promise<QaActionResult> => {
      const wish = (next: UpvoteWish | null): void => {
        const wishes = new Map(wishesRef.current);
        if (next) wishes.set(id, next);
        else wishes.delete(id);
        wishesRef.current = wishes;
        setWishes(wishes);
      };
      const current = viewRef.current;
      const seen: Seen = {
        myUpvotes: current?.myUpvotes ?? null,
        revision: revisionRef.current,
      };
      const shown =
        wishedUpvote(wishesRef.current, id, seen) ??
        current?.myUpvotes.has(id) ??
        false;
      wish({ value: !shown });
      if (sendingRef.current.has(id)) return { ok: true };

      sendingRef.current.add(id);
      try {
        // With nothing on its way, what was shown is what the server holds:
        // its last answer, or its view where no answer is waiting for one.
        let onServer = shown;
        for (;;) {
          const value = wishesRef.current.get(id)?.value ?? onServer;
          if (value === onServer) {
            wish(null);
            return { ok: true };
          }
          const flag: UpvoteWish = { value, sentOn: viewRef.current?.myUpvotes ?? null };
          wish(flag);
          const result = await act("upvote", { id, value });
          if (!result.ok) {
            wish(null);
            return { ok: false, error: describe(result, "upvote") };
          }
          onServer = value;
          // The answer can be a retry's, replaying an outcome the view has
          // moved past since. The flag stands only until the view's own
          // upvotes change or the view reaches the answer's revision, and
          // either may already have happened.
          const answered: UpvoteWish = { ...flag, revision: result.revision };
          const wanted = wishesRef.current.get(id);
          if (!wanted) return { ok: true };
          if (wanted === flag) {
            wish(answered);
            return { ok: true };
          }
          if (wanted.value !== value) continue;
          // A click since asked for what was just sent. If the view moved
          // past the request first, or already reflects its answer, the click
          // was made against the view, and the view is what is on the server.
          const now = viewRef.current?.myUpvotes ?? null;
          const reached =
            result.revision !== undefined && revisionRef.current >= result.revision;
          if (now !== flag.sentOn || reached) {
            onServer = now?.has(id) ?? value;
            continue;
          }
          wish(answered);
          return { ok: true };
        }
      } finally {
        sendingRef.current.delete(id);
      }
    },
    [act],
  );

  const moderate = useCallback(
    async (request: {
      id: string;
      action: QaModerateAction;
      answerText?: string;
    }): Promise<QaActionResult> => {
      const result = await act("moderate", request);
      return result.ok
        ? { ok: true }
        : { ok: false, error: describe(result, "moderate") };
    },
    [act],
  );

  const ready = state.kind === "ready" ? state : null;
  return {
    isReady: ready !== null,
    questions,
    canAsk: ready?.actions.has("ask") ?? false,
    /** Asking is closed to this viewer only for want of a verified identity. */
    askNeedsIdentity: ready?.needsIdentity.has("ask") ?? false,
    canUpvote: ready?.actions.has("upvote") ?? false,
    canModerate: ready?.actions.has("moderate") ?? false,
    ask,
    setUpvoted,
    toggleUpvote,
    moderate,
  };
}

export type QaApp = ReturnType<typeof useQa>;
