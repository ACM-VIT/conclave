"use client";

import { useMemo } from "react";
import { useAuthorityAvailable } from "@conclave/apps-sdk";
import { pollsContract, usePolls, type PollCard } from "@conclave/apps-sdk/polls/web";
import {
  useHeldThroughReconnect,
  waitForView,
  type ReconnectHold,
} from "./useHeldThroughReconnect";

export function useMeetingPolls({
  hold,
  isWebinarAttendee,
  onPollStarted,
}: {
  hold: ReconnectHold;
  isWebinarAttendee: boolean;
  onPollStarted?: (poll: PollCard) => void;
}) {
  const polls = usePolls({ onPollStarted });
  const liveOffer = useAuthorityAvailable(pollsContract);
  const offered = useHeldThroughReconnect(liveOffer, hold.holdingThroughReconnect);
  const viewComing = hold.holdingThroughReconnect || (offered && polls.isConnecting);
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
    isAvailable: offered && hold.connectionLive && !isWebinarAttendee,
  };
}
