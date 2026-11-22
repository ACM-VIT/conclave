"use client";

import { useCallback, useMemo } from "react";
import { useAuthorityAvailable } from "@conclave/apps-sdk";
import { qaContract, useQa } from "@conclave/apps-sdk/qa/web";
import type { WebinarQaEntry, WebinarQaModerateRequest } from "../lib/types";

type Result = { ok: boolean; error?: string };

const NO_ENTRIES: WebinarQaEntry[] = [];

type LegacyQa = {
  entries: WebinarQaEntry[];
  submit?: (question: string) => Promise<Result>;
  upvote?: (id: string) => void | Promise<Result>;
  moderate?: (request: WebinarQaModerateRequest) => Promise<Result>;
};

/**
 * Whether the Apps entry for meeting Q&A should ask for attention: someone
 * else's question the viewer has not seen yet. Only while Apps lists that
 * entry. In a webinar the questions live in the Questions section instead,
 * and opening Apps could never mark them seen.
 */
export const hasUnseenMeetingQuestion = ({
  isAvailable,
  isOpen,
  entries,
  currentUserId,
  seenIds,
}: {
  isAvailable: boolean;
  isOpen: boolean;
  entries: readonly WebinarQaEntry[];
  currentUserId?: string | null;
  seenIds: ReadonlySet<string>;
}): boolean =>
  isAvailable &&
  !isOpen &&
  entries.some(
    (entry) =>
      entry.status !== "dismissed" &&
      entry.userId !== currentUserId &&
      !seenIds.has(entry.id),
  );

/**
 * The room's Q&A from whichever source this connection has right now.
 *
 * A server that runs the Q&A app offers it in its capabilities, and the list
 * and every action go through the app once the app's view has arrived. An
 * older server does not offer it, and webinar Q&A keeps running on the
 * `webinar:qa:*` events it always used.
 *
 * In between, a webinar stays on the old events: after the server has
 * offered the app and before its view is in, however long that takes. The
 * server feeds a connection the old events until that connection holds its
 * own view, so one of the two is always current and nothing is shown twice.
 * Nothing is inferred from the old events about a regular meeting, which
 * they do not carry: there Q&A is offered when the server offers the app.
 *
 * Once a subscription's view has arrived, the server stops sending the old
 * events to this connection, so the list they left is stale while that
 * subscription lasts. A replacement of its view in parts shows nothing until
 * it is in: never that stale list, and never the view before it, which the
 * client dropped because the new one may hold less. A new subscription, on a
 * new connection or the same one, starts on the old events again: the
 * server feeds them until the connection holds its own view, so they are
 * current for as long as that view does not come.
 */
export function useMeetingQa({
  legacy,
  isWebinar,
  currentUserId,
}: {
  legacy: LegacyQa;
  isWebinar: boolean;
  currentUserId?: string | null;
}) {
  const offered = useAuthorityAvailable(qaContract);
  const qa = useQa();
  const fromApp = offered && qa.isReady;
  const awaitingNewView = offered && qa.isReplacing;

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

  const { ask, toggleUpvote, moderate } = qa;
  const appModerate = useCallback(
    (request: WebinarQaModerateRequest) => moderate(request),
    [moderate],
  );

  if (fromApp) {
    return {
      offered,
      fromApp: true as const,
      entries: appEntries,
      askNeedsIdentity: qa.askNeedsIdentity,
      onSubmit: qa.canAsk ? ask : undefined,
      onUpvote: qa.canUpvote ? toggleUpvote : undefined,
      onModerate: qa.canModerate ? appModerate : undefined,
    };
  }
  if ((offered && !isWebinar) || awaitingNewView) {
    // A view of the app is on its way: nothing to show yet.
    return {
      offered,
      fromApp: false as const,
      entries: NO_ENTRIES,
      askNeedsIdentity: false,
      onSubmit: undefined,
      onUpvote: undefined,
      onModerate: undefined,
    };
  }
  return {
    offered,
    fromApp: false as const,
    entries: legacy.entries,
    askNeedsIdentity: false,
    onSubmit: legacy.submit,
    onUpvote: legacy.upvote,
    onModerate: legacy.moderate,
  };
}
