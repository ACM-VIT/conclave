"use client";

import { useMemo } from "react";
import { useAuthorityAvailable, useAuthorityRuntime } from "@conclave/apps-sdk";
import { pollsContract, usePolls, type PollCard } from "@conclave/apps-sdk/polls/web";
import { useHeldThroughReconnect, waitForView } from "./useHeldThroughReconnect";

export function useMeetingPolls({
  isJoined,
  isWebinarAttendee,
  onPollStarted,
}: {
  isJoined: boolean;
  isWebinarAttendee: boolean;
  onPollStarted?: (poll: PollCard) => void;
}) {
  const polls = usePolls({ onPollStarted });
  const runtime = useAuthorityRuntime();
  const liveOffer = useAuthorityAvailable(pollsContract);
  const awaitingServer = isJoined && runtime === "unknown";
  const offered = useHeldThroughReconnect(liveOffer, awaitingServer);
  const viewComing = awaitingServer || (offered && polls.isConnecting);
  const shownPolls = useHeldThroughReconnect(polls.polls, viewComing && !polls.isReplacing);
  const liveGrants = useMemo(
    () => ({
      canManage: polls.canManage,
      canVote: polls.canVote,
      voteNeedsIdentity: polls.voteNeedsIdentity,
    }),
    [polls.canManage, polls.canVote, polls.voteNeedsIdentity],
  );
  const grants = useHeldThroughReconnect(liveGrants, viewComing);
  return {
    ...polls,
    ...grants,
    polls: shownPolls,
    offered,
    waiting: viewComing,
    createPoll: viewComing ? waitForView : polls.createPoll,
    vote: viewComing ? waitForView : polls.vote,
    endPoll: viewComing ? waitForView : polls.endPoll,
    shareResults: viewComing ? waitForView : polls.shareResults,
    exportCsv: viewComing ? waitForView : polls.exportCsv,
    isAvailable: offered && isJoined && !isWebinarAttendee,
  };
}
