"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuthorityAvailable } from "@conclave/apps-sdk";
import { qaContract, useQa } from "@conclave/apps-sdk/qa/web";
import type { WebinarQaEntry, WebinarQaModerateRequest } from "../lib/types";
import {
  useHeldThroughReconnect,
  waitForView,
  type ReconnectHold,
} from "./useHeldThroughReconnect";

type Result = { ok: boolean; error?: string };

const NO_ENTRIES: WebinarQaEntry[] = [];

type LegacyQa = {
  /**
   * The list the old events gave this connection, or null while they have
   * given it none. The socket drops it when its connection ends, and empties
   * it when webinar mode ends.
   */
  entries: WebinarQaEntry[] | null;
  fromThisConnection: boolean;
  /** Drops `entries`: the old events rest once the app's view is in. */
  forget: () => void;
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
 * Each source's list lasts only as long as what supplied it. The app's view
 * goes when its subscription ends. The old events' list goes when its
 * connection ends, and when the app's view arrives, because the server stops
 * sending the old events to that connection then: it resumes them with a
 * whole list once the subscription ends.
 *
 * What is shown never goes back, and is only what the viewer may see now.
 * While a connection or a subscription is coming back, no source has a list
 * yet, and the list last shown stays until one does, which is newer. It
 * never falls back to an older source's list. When Q&A is no longer the
 * viewer's, nothing is kept: the server withdrawing the view clears it at
 * once, and so does a regular meeting whose server does not offer the app.
 * A replacement of the view in parts shows nothing until it is in: never the
 * view before it, which the client dropped because the new one may hold less.
 */
export function useMeetingQa({
  legacy,
  isWebinar,
  hold,
  currentUserId,
}: {
  legacy: LegacyQa;
  isWebinar: boolean;
  hold: ReconnectHold;
  currentUserId?: string | null;
}) {
  const liveOffer = useAuthorityAvailable(qaContract);
  const awaitingServer = hold.holdingThroughReconnect;
  const offered = useHeldThroughReconnect(liveOffer, awaitingServer);
  const qa = useQa();
  const fromApp = offered && qa.isReady;
  const awaitingNewView = offered && qa.isReplacing;
  const meetingViewComing = !isWebinar && (awaitingServer || (offered && qa.isConnecting));
  const liveApp = useMemo(
    () => ({
      fromApp,
      askNeedsIdentity: qa.askNeedsIdentity,
      canAsk: qa.canAsk,
      canUpvote: qa.canUpvote,
      canModerate: qa.canModerate,
    }),
    [fromApp, qa.askNeedsIdentity, qa.canAsk, qa.canUpvote, qa.canModerate],
  );
  const app = useHeldThroughReconnect(liveApp, meetingViewComing);

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

  // The server rests the old events once this connection holds the app's
  // view, so the list they left no longer follows the room.
  const { forget } = legacy;
  const forgetLegacy = fromApp && legacy.entries !== null;
  useEffect(() => {
    if (forgetLegacy) forget();
  }, [forgetLegacy, forget]);

  // The list a source has now, or null while a connection or subscription
  // is coming back and none has one yet.
  const live: WebinarQaEntry[] | null = !hold.connectionLive
    ? NO_ENTRIES
    : fromApp
      ? appEntries
      : awaitingNewView
        ? NO_ENTRIES
        : qa.isRevoked
          ? // Withdrawn: only a list the old events sent since can show.
            (isWebinar ? legacy.entries : null) ?? NO_ENTRIES
          : isWebinar
            ? legacy.entries
            : qa.isConnecting || awaitingServer
              ? null
              : NO_ENTRIES;
  const [shown, setShown] = useState<WebinarQaEntry[]>(NO_ENTRIES);
  if (live !== null && live !== shown) setShown(live);
  const entries = live ?? shown;
  const [legacyConnection, setLegacyConnection] = useState(() => ({
    fromThisConnection: legacy.fromThisConnection,
    token: {},
  }));
  if (legacyConnection.fromThisConnection !== legacy.fromThisConnection) {
    setLegacyConnection({ fromThisConnection: legacy.fromThisConnection, token: {} });
  }
  const connection: unknown = fromApp ? qa.connection : legacyConnection.token;

  const { ask, toggleUpvote, moderate } = qa;
  const appModerate = useCallback(
    (request: WebinarQaModerateRequest) => moderate(request),
    [moderate],
  );

  const isAvailable = offered && hold.connectionLive && !isWebinar;
  const waiting =
    hold.holdingThroughReconnect || live === null || (app.fromApp && !fromApp);
  const oldEventsWaiting = live === null || !legacy.fromThisConnection;
  if (!hold.connectionLive) {
    return {
      offered,
      isAvailable,
      fromApp: false as const,
      waiting: false,
      entries,
      connection,
      askNeedsIdentity: false,
      onSubmit: undefined,
      onUpvote: undefined,
      onModerate: undefined,
    };
  }
  if (app.fromApp) {
    return {
      offered,
      isAvailable,
      fromApp: true as const,
      waiting,
      entries,
      connection,
      askNeedsIdentity: app.askNeedsIdentity,
      onSubmit: app.canAsk ? (waiting ? waitForView : ask) : undefined,
      onUpvote: app.canUpvote ? (waiting ? waitForView : toggleUpvote) : undefined,
      onModerate: app.canModerate ? (waiting ? waitForView : appModerate) : undefined,
    };
  }
  if ((offered && !isWebinar) || awaitingNewView) {
    // A view of the app is on its way, and nothing to act through until then.
    return {
      offered,
      isAvailable,
      fromApp: false as const,
      waiting,
      entries,
      connection,
      askNeedsIdentity: false,
      onSubmit: undefined,
      onUpvote: undefined,
      onModerate: undefined,
    };
  }
  return {
    offered,
    isAvailable,
    fromApp: false as const,
    waiting: oldEventsWaiting,
    entries,
    connection,
    askNeedsIdentity: false,
    onSubmit: legacy.submit && (oldEventsWaiting ? waitForView : legacy.submit),
    onUpvote: legacy.upvote && (oldEventsWaiting ? waitForView : legacy.upvote),
    onModerate: legacy.moderate && (oldEventsWaiting ? waitForView : legacy.moderate),
  };
}
