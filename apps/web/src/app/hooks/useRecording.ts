"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type {
  RecordingPublicState,
  RecordingSessionMetadata,
} from "@/lib/recordings";

export type StartRecordingOptions = {
  audioBitrateKbps?: number;
  videoBitrateKbps?: number;
  preferredVideoCodec?: "h264" | "vp8";
  composite?: boolean;
};

export type UseRecordingReturn = {
  state: RecordingPublicState;
  isWorking: boolean;
  error: string | null;
  startRecording: (options?: StartRecordingOptions) => Promise<boolean>;
  stopRecording: () => Promise<RecordingSessionMetadata | null>;
  pauseRecording: () => Promise<boolean>;
  resumeRecording: () => Promise<boolean>;
  refreshState: () => Promise<RecordingPublicState | null>;
  clearError: () => void;
};

const idleState: RecordingPublicState = {
  active: false,
  paused: false,
  sessionId: null,
  startedAt: null,
  startedBy: null,
  trackCount: 0,
};

export function useRecording(
  socketRef: React.MutableRefObject<Socket | null> | null,
  isHost: boolean,
): UseRecordingReturn {
  const [state, setState] = useState<RecordingPublicState>(idleState);
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const updateState = useCallback((next: RecordingPublicState) => {
    setState({
      active: Boolean(next?.active),
      paused: Boolean(next?.paused),
      sessionId: next?.sessionId ?? null,
      startedAt: next?.startedAt ?? null,
      startedBy: next?.startedBy ?? null,
      trackCount: next?.trackCount ?? 0,
    });
  }, []);

  const refreshState = useCallback(async (): Promise<RecordingPublicState | null> => {
    const socket = socketRef?.current;
    if (!socket) return null;
    return await new Promise<RecordingPublicState | null>((resolve) => {
      socket.emit(
        "recording:getState",
        undefined,
        (response: RecordingPublicState | { error: string }) => {
          if (!response || "error" in response) {
            resolve(null);
            return;
          }
          updateState(response);
          resolve(response);
        },
      );
    });
  }, [socketRef, updateState]);

  useEffect(() => {
    const socket = socketRef?.current;
    if (!socket) return;

    const handler = (payload: RecordingPublicState & { roomId?: string }) => {
      updateState(payload);
    };
    socket.on("recordingStateChanged", handler);
    void refreshState();
    return () => {
      socket.off("recordingStateChanged", handler);
    };
  }, [socketRef, refreshState, updateState]);

  const startRecording = useCallback<UseRecordingReturn["startRecording"]>(
    async (options) => {
      const socket = socketRef?.current;
      if (!socket) return false;
      if (!isHost) {
        setError("Only hosts can start recording.");
        return false;
      }
      setIsWorking(true);
      setError(null);
      try {
        const result = await new Promise<
          | { success: true; state: RecordingPublicState }
          | { error: string }
        >((resolve) => {
          socket.emit(
            "recording:start",
            options ?? {},
            (
              response:
                | { success: true; state: RecordingPublicState }
                | { error: string },
            ) => resolve(response),
          );
        });
        if ("error" in result) {
          setError(result.error);
          return false;
        }
        updateState(result.state);
        return true;
      } finally {
        setIsWorking(false);
      }
    },
    [socketRef, isHost, updateState],
  );

  const stopRecording = useCallback<UseRecordingReturn["stopRecording"]>(
    async () => {
      const socket = socketRef?.current;
      if (!socket) return null;
      setIsWorking(true);
      setError(null);
      try {
        const result = await new Promise<
          | { success: true; metadata: RecordingSessionMetadata }
          | { error: string }
        >((resolve) => {
          socket.emit(
            "recording:stop",
            undefined,
            (
              response:
                | { success: true; metadata: RecordingSessionMetadata }
                | { error: string },
            ) => resolve(response),
          );
        });
        if ("error" in result) {
          setError(result.error);
          return null;
        }
        setState(idleState);
        return result.metadata;
      } finally {
        setIsWorking(false);
      }
    },
    [socketRef],
  );

  const pauseRecording = useCallback<UseRecordingReturn["pauseRecording"]>(
    async () => {
      const socket = socketRef?.current;
      if (!socket) return false;
      setIsWorking(true);
      try {
        const result = await new Promise<
          | { success: true; state: RecordingPublicState }
          | { error: string }
        >((resolve) => {
          socket.emit(
            "recording:pause",
            undefined,
            (
              response:
                | { success: true; state: RecordingPublicState }
                | { error: string },
            ) => resolve(response),
          );
        });
        if ("error" in result) {
          setError(result.error);
          return false;
        }
        updateState(result.state);
        return true;
      } finally {
        setIsWorking(false);
      }
    },
    [socketRef, updateState],
  );

  const resumeRecording = useCallback<UseRecordingReturn["resumeRecording"]>(
    async () => {
      const socket = socketRef?.current;
      if (!socket) return false;
      setIsWorking(true);
      try {
        const result = await new Promise<
          | { success: true; state: RecordingPublicState }
          | { error: string }
        >((resolve) => {
          socket.emit(
            "recording:resume",
            undefined,
            (
              response:
                | { success: true; state: RecordingPublicState }
                | { error: string },
            ) => resolve(response),
          );
        });
        if ("error" in result) {
          setError(result.error);
          return false;
        }
        updateState(result.state);
        return true;
      } finally {
        setIsWorking(false);
      }
    },
    [socketRef, updateState],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    state,
    isWorking,
    error,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    refreshState,
    clearError,
  };
}
