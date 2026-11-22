"use client";

import { useCallback, useMemo } from "react";
import { useAuthorityAvailable } from "@conclave/apps-sdk";
import { qaContract, useQa } from "@conclave/apps-sdk/qa/web";
import type { WebinarQaEntry, WebinarQaModerateRequest } from "../lib/types";

type Result = { ok: boolean; error?: string };

type LegacyQa = {
  entries: WebinarQaEntry[];
  submit?: (question: string) => Promise<Result>;
  upvote?: (id: string) => void;
  moderate?: (request: WebinarQaModerateRequest) => Promise<Result>;
};

/**
 * The room's Q&A from whichever source this server has.
 *
 * A server that runs the Q&A app offers it in its capabilities, and the list
 * and every action then go through the app. An older server does not, and
 * webinar Q&A keeps running on the `webinar:qa:*` events it always used.
 * Nothing is inferred from those events: without the capability, Q&A in a
 * regular meeting is simply not offered.
 */
export function useMeetingQa({
  legacy,
  currentUserId,
}: {
  legacy: LegacyQa;
  currentUserId?: string | null;
}) {
  const fromApp = useAuthorityAvailable(qaContract);
  const qa = useQa();

  const appEntries = useMemo<WebinarQaEntry[]>(
    () =>
      qa.questions.map((question) => ({
        id: question.id,
        // The panels mark a question as the viewer's by this id.
        userId: question.mine ? (currentUserId ?? "") : "",
        displayName: question.askerName,
        question: question.text,
        status: question.status,
        askedAt: question.askedAt,
        updatedAt: question.updatedAt,
        upvotes: question.upvotes,
        hasUpvoted: question.hasUpvoted,
        ...(question.answerText ? { answerText: question.answerText } : {}),
        ...(question.answeredByName
          ? { answeredByName: question.answeredByName }
          : {}),
      })),
    [qa.questions, currentUserId],
  );

  const { ask, setUpvoted, moderate, questions } = qa;
  const appUpvote = useCallback(
    (id: string) => {
      const current = questions.find((question) => question.id === id);
      void setUpvoted(id, !current?.hasUpvoted);
    },
    [questions, setUpvoted],
  );
  const appModerate = useCallback(
    (request: WebinarQaModerateRequest) => moderate(request),
    [moderate],
  );

  if (!fromApp) {
    return {
      fromApp: false as const,
      entries: legacy.entries,
      askNeedsIdentity: false,
      onSubmit: legacy.submit,
      onUpvote: legacy.upvote,
      onModerate: legacy.moderate,
    };
  }
  return {
    fromApp: true as const,
    entries: appEntries,
    askNeedsIdentity: qa.askNeedsIdentity,
    onSubmit: qa.canAsk ? ask : undefined,
    onUpvote: qa.canUpvote ? appUpvote : undefined,
    onModerate: qa.canModerate ? appModerate : undefined,
  };
}
