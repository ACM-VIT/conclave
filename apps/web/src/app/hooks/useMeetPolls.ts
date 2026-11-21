"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { emitWithAckTimeout } from "../lib/socket-ack";
import { buildPollCsv, pollCsvFilename, upsertPoll } from "../lib/polls";
import type {
  PollChangedNotification,
  PollChoiceMode,
  PollExportResponse,
  PollSnapshot,
  PollView,
} from "../lib/types";

const ACK_TIMEOUT_MS = 8_000;
const NO_RESPONSE = "The server did not respond. Try again.";

export type PollActionResult = { ok: true } | { ok: false; error: string };

type PollsState = {
  /** False until this server answers poll:getState; older SFUs never do. */
  supported: boolean;
  polls: PollView[];
};

const EMPTY: PollsState = { supported: false, polls: [] };

const downloadCsv = (filename: string, csv: string) => {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

export function useMeetPolls({
  socket,
  isInMeeting,
  isConnected,
  onPollStarted,
}: {
  socket: Socket | null;
  /** In a meeting that can run polls; leaving clears every poll. */
  isInMeeting: boolean;
  /** The socket is joined to the room; every (re)join resyncs. */
  isConnected: boolean;
  /** A poll this client had not seen yet just opened. */
  onPollStarted?: (poll: PollView) => void;
}) {
  const [state, setState] = useState<PollsState>(EMPTY);
  const onPollStartedRef = useRef(onPollStarted);
  useEffect(() => {
    onPollStartedRef.current = onPollStarted;
  }, [onPollStarted]);
  const knownIdsRef = useRef<Set<string> | null>(null);
  const syncedRoomIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (isInMeeting) return;
    setState(EMPTY);
    knownIdsRef.current = null;
    syncedRoomIdRef.current = null;
  }, [isInMeeting]);

  useEffect(() => {
    if (!socket || !isInMeeting || !isConnected) return;
    let cancelled = false;

    const handleChanged = (notification: PollChangedNotification) => {
      const syncedRoomId = syncedRoomIdRef.current;
      if (syncedRoomId !== null && syncedRoomId !== notification.roomId) return;
      const { poll } = notification;
      const known = knownIdsRef.current;
      if (known && !known.has(poll.id)) {
        known.add(poll.id);
        if (poll.status === "open") onPollStartedRef.current?.(poll);
      }
      setState((previous) => ({
        ...previous,
        polls: upsertPoll(previous.polls, poll),
      }));
    };

    socket.on("poll:changed", handleChanged);
    emitWithAckTimeout(
      socket,
      ACK_TIMEOUT_MS,
      () => {},
      "poll:getState",
      (response: PollSnapshot | { error: string }) => {
        if (cancelled || "error" in response) return;
        syncedRoomIdRef.current = response.roomId;
        knownIdsRef.current = new Set(response.polls.map((poll) => poll.id));
        setState({ supported: true, polls: response.polls });
      },
    );

    return () => {
      cancelled = true;
      socket.off("poll:changed", handleChanged);
    };
  }, [socket, isInMeeting, isConnected]);

  const request = useCallback(
    <T extends object>(
      event: string,
      payload: unknown,
      onSuccess?: (response: T) => void,
    ): Promise<PollActionResult> => {
      if (!socket) return Promise.resolve({ ok: false, error: "Not connected" });
      return new Promise((resolve) => {
        emitWithAckTimeout(
          socket,
          ACK_TIMEOUT_MS,
          () => resolve({ ok: false, error: NO_RESPONSE }),
          event,
          payload,
          (response: T & { error?: string; poll?: PollView }) => {
            if (response.poll) {
              const poll = response.poll;
              setState((previous) => ({
                ...previous,
                polls: upsertPoll(previous.polls, poll),
              }));
            }
            if (response.error) {
              resolve({ ok: false, error: response.error });
              return;
            }
            onSuccess?.(response);
            resolve({ ok: true });
          },
        );
      });
    },
    [socket],
  );

  const createPoll = useCallback(
    (draft: { question: string; options: string[]; choiceMode: PollChoiceMode }) =>
      request("poll:create", draft),
    [request],
  );

  const vote = useCallback(
    (pollId: string, optionIds: string[]) =>
      request("poll:vote", { pollId, optionIds }),
    [request],
  );

  const endPoll = useCallback(
    (pollId: string) => request("poll:end", { pollId }),
    [request],
  );

  const shareResults = useCallback(
    (pollId: string, shared: boolean) =>
      request("poll:share", { pollId, shared }),
    [request],
  );

  const exportCsv = useCallback(
    (pollId: string) =>
      request<PollExportResponse>("poll:export", { pollId }, (response) => {
        downloadCsv(pollCsvFilename(response.poll), buildPollCsv(response));
      }),
    [request],
  );

  return {
    isSupported: state.supported,
    polls: state.polls,
    createPoll,
    vote,
    endPoll,
    shareResults,
    exportCsv,
  };
}

export type MeetPolls = ReturnType<typeof useMeetPolls>;
