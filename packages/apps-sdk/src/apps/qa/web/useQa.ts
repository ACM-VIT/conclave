import { useCallback, useMemo } from "react";
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

/** The room's questions as this viewer may see them, and what they may do. */
export function useQa() {
  const { state, act } = useAuthority(qaContract);

  const view = state.kind === "ready" ? state.view : null;
  const questions = useMemo<QaItem[]>(() => {
    if (!view) return [];
    const items = new Map<string, QaItem>();
    for (const question of view.questions.values()) {
      items.set(question.id, {
        ...question,
        upvotes: view.votes.get(question.id)?.upvotes ?? 0,
        mine: view.myQuestions.has(question.id),
        hasUpvoted: view.myUpvotes.has(question.id),
      });
    }
    // The viewer's own questions that their list leaves out: still waiting
    // in a webinar, or hidden by a host.
    for (const [id, own] of view.myQuestions) {
      if (!own.hidden || items.has(id)) continue;
      items.set(id, {
        ...own.hidden.question,
        upvotes: own.hidden.upvotes,
        mine: true,
        hasUpvoted: view.myUpvotes.has(id),
      });
    }
    return [...items.values()].sort((a, b) => a.askedAt - b.askedAt);
  }, [view]);

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
    moderate,
  };
}

export type QaApp = ReturnType<typeof useQa>;
