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
 * - The viewer's own upvote on this question in the view changes after
 *   the request left, by that request landing or by another tab, even if
 *   it changes back. `sentOn` is how many times that row had changed when
 *   the request left. A change to their vote on another question leaves
 *   it standing.
 * - The view reaches the revision the request's answer named, a replayed
 *   answer included. The view then reflects the request and everything
 *   committed before the answer, even when nothing in it changed.
 *
 * A wish not sent yet, a change of mind waiting for the request before it,
 * stands until it is sent, or until its connection's request ends after a reconnect.
 */
type UpvoteWish = {
  value: boolean;
  session: unknown;
  sentOn?: { changes: number };
  revision?: number;
};

const NO_WISHES: ReadonlyMap<string, UpvoteWish> = new Map();

type Seen = { changes: ReadonlyMap<string, number>; revision: number };

/**
 * How many times each question's own upvote row has changed in the views
 * as they came: one that went and came back has changed twice.
 */
type UpvoteChanges = {
  seen: ReadonlyMap<string, unknown> | null;
  counts: ReadonlyMap<string, number>;
};

const withUpvoteChanges = (
  track: UpvoteChanges,
  now: ReadonlyMap<string, unknown> | null,
): UpvoteChanges => {
  const counts = new Map(track.counts);
  // A row the view did not change keeps its identity when another changes.
  for (const id of new Set([...(track.seen?.keys() ?? []), ...(now?.keys() ?? [])])) {
    if (track.seen?.get(id) !== now?.get(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return { seen: now, counts };
};

const wishedUpvote = (
  wishes: ReadonlyMap<string, UpvoteWish>,
  id: string,
  seen: Seen,
): boolean | undefined => {
  const wish = wishes.get(id);
  if (!wish) return undefined;
  const moved = wish.sentOn !== undefined && wish.sentOn.changes !== (seen.changes.get(id) ?? 0);
  const reached = wish.revision !== undefined && seen.revision >= wish.revision;
  return moved || reached ? undefined : wish.value;
};

/** The room's questions as this viewer may see them, and what they may do. */
export function useQa() {
  const { state, act } = useAuthority(qaContract);

  const view = state.kind === "ready" ? state.view : null;
  const revision = state.kind === "ready" ? state.revision : 0;
  const [wishes, setWishes] = useState(NO_WISHES);
  // A new connection is a new session, whose view and revisions start over.
  // A wish its answer settled was the old session's, and its revision says
  // nothing of the new one: the new view decides.
  const [wishesOf, setWishesOf] = useState(() => act);
  if (act !== wishesOf) {
    setWishesOf(() => act);
    const kept = new Map([...wishes].filter(([, wish]) => wish.revision === undefined));
    if (kept.size !== wishes.size) setWishes(kept.size === 0 ? NO_WISHES : kept);
  }
  // Counted from each view to the next, as React keeps what a render saw.
  const myUpvotes = view?.myUpvotes ?? null;
  const [upvoteChanges, setUpvoteChanges] = useState<UpvoteChanges>(() => ({
    seen: myUpvotes,
    counts: new Map(),
  }));
  let changes = upvoteChanges;
  if (myUpvotes !== upvoteChanges.seen) {
    changes = withUpvoteChanges(upvoteChanges, myUpvotes);
    setUpvoteChanges(changes);
  }
  const counts = changes.counts;
  const questions = useMemo<QaItem[]>(() => {
    if (!view) return [];
    const seen: Seen = { changes: counts, revision };
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
  }, [view, revision, wishes, counts]);

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
  const countsRef = useRef(counts);
  useEffect(() => {
    viewRef.current = view;
    revisionRef.current = revision;
    countsRef.current = counts;
  }, [view, revision, counts]);
  const wishesRef = useRef(wishes);
  useEffect(() => {
    wishesRef.current = wishes;
  }, [wishes]);
  // Which session's request is on its way for each question. A loop belongs
  // to the session it sends on: a new connection's clicks send on their own.
  const sendingRef = useRef(new Map<string, unknown>());
  const actRef = useRef(act);
  useEffect(() => {
    actRef.current = act;
  }, [act]);

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
      const seen: Seen = { changes: countsRef.current, revision: revisionRef.current };
      const shown =
        wishedUpvote(wishesRef.current, id, seen) ??
        current?.myUpvotes.has(id) ??
        false;
      wish({ value: !shown, session: act });
      if (sendingRef.current.get(id) === act) return { ok: true };

      sendingRef.current.set(id, act);
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
          const flag: UpvoteWish = {
            value,
            session: act,
            sentOn: { changes: countsRef.current.get(id) ?? 0 },
          };
          wish(flag);
          const result = await act("upvote", { id, value });
          // The connection changed while this was on its way. A wish made on
          // the new session is its own; one made here can no longer settle.
          if (actRef.current !== act) {
            if (wishesRef.current.get(id)?.session !== act) return { ok: true };
            wish(null);
            return result.ok
              ? { ok: true }
              : { ok: false, error: describe(result, "upvote") };
          }
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
          const changed = (countsRef.current.get(id) ?? 0) !== flag.sentOn?.changes;
          if (changed || reached) {
            onServer = now?.has(id) ?? value;
            continue;
          }
          wish(answered);
          return { ok: true };
        }
      } finally {
        if (sendingRef.current.get(id) === act) sendingRef.current.delete(id);
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
    /**
     * This subscription showed a view, and a replacement in parts dropped
     * it because the new one may hold rows this viewer can no longer see.
     */
    isReplacing: state.kind === "connecting" && state.replacing === true,
    /** A view is on its way: the connection is new or coming back. */
    isConnecting: state.kind === "connecting",
    /** The server withdrew this viewer's view: Q&A is no longer theirs. */
    isRevoked: state.kind === "revoked",
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
