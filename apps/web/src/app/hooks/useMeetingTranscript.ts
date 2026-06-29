"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Participant,
  TranscriptMinutesSnapshot,
  TranscriptSegment,
  TranscriptServiceVersion,
  TranscriptSessionState,
  TranscriptTokenResponse,
} from "../lib/types";
import {
  DEFAULT_TRANSCRIPT_QA_MODEL,
  DEFAULT_TRANSCRIPT_TRANSCRIPTION_MODEL,
} from "../lib/transcript-models";
import {
  createEmptyTranscriptMinutes,
  exportTranscriptMarkdown,
  mergeTranscriptDelta,
  mergeTranscriptFinal,
  orderTranscriptSegments,
} from "../lib/transcript-reducer";
import {
  TranscriptAudioRelay,
  type TranscriptRelaySource,
} from "../lib/transcript-audio";

export type TranscriptConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "error";

export interface TranscriptQaMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "done" | "error";
  createdAt: number;
  updatedAt: number;
  error?: string;
}

interface UseMeetingTranscriptOptions {
  roomId: string;
  isJoined: boolean;
  currentUserId: string;
  currentDisplayName: string;
  isMuted: boolean;
  localStream: MediaStream | null;
  participants: Map<string, Participant>;
  activeSpeakerId: string | null;
  isViewOnly?: boolean;
  resolveDisplayName: (userId: string) => string;
  getTranscriptToken: () => Promise<TranscriptTokenResponse | null>;
}

interface StartTranscriptOptions {
  apiKey?: string;
  transcriptModel?: string;
  qaModel?: string;
}

type ServerEnvelope =
  | {
      type: "snapshot";
      viewerConnectionId?: string;
      globalOpenAiKeyAvailable?: boolean;
      serviceVersion?: TranscriptServiceVersion;
      session: TranscriptSessionState;
      segments?: TranscriptSegment[];
      partials?: TranscriptSegment[];
      minutes?: TranscriptMinutesSnapshot;
    }
  | {
      type: "session.state";
      session: TranscriptSessionState;
      globalOpenAiKeyAvailable?: boolean;
      serviceVersion?: TranscriptServiceVersion;
    }
  | {
      type: "segment.delta";
      delta: Parameters<typeof mergeTranscriptDelta>[1];
    }
  | { type: "segment.final"; segment: TranscriptSegment }
  | { type: "partials.reset" }
  | { type: "minutes.updated"; minutes: TranscriptMinutesSnapshot }
  | {
      type: "qa.delta";
      id: string;
      question: string;
      answer?: string;
      delta?: string;
      status?: "streaming";
    }
  | {
      type: "qa.final";
      id: string;
      question: string;
      answer?: string;
      status: "done" | "error";
      error?: string;
    }
  | {
      type: "handoff.requested";
      session: TranscriptSessionState;
      globalOpenAiKeyAvailable?: boolean;
      serviceVersion?: TranscriptServiceVersion;
    }
  | { type: "error"; message?: string };

const buildIdleSession = (roomId: string): TranscriptSessionState => ({
  roomId,
  status: "idle",
  controller: null,
  transcriptModel: DEFAULT_TRANSCRIPT_TRANSCRIPTION_MODEL,
  qaModel: DEFAULT_TRANSCRIPT_QA_MODEL,
  keySource: null,
  startedAt: null,
  updatedAt: Date.now(),
  error: null,
});

const toWorkerWebSocketUrl = (token: TranscriptTokenResponse): string => {
  const base = token.workerUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/rooms/${encodeURIComponent(token.roomId)}/ws`);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  }
  url.searchParams.set("token", token.token);
  return url.toString();
};

// Matches ConclaveUpdatePill's cadence so both update prompts behave alike.
const VERSION_POLL_INTERVAL_MS = 30_000;

const toWorkerVersionUrl = (workerUrl: string): string => {
  const base = workerUrl.replace(/\/+$/, "");
  return new URL("/version", `${base}/`).toString();
};

const isTranscriptServiceVersion = (
  value: unknown,
): value is TranscriptServiceVersion =>
  Boolean(
    value &&
      typeof value === "object" &&
      "id" in value &&
      typeof (value as { id?: unknown }).id === "string",
  );

const isLiveAudioStream = (stream: MediaStream | null | undefined): boolean =>
  Boolean(
    stream
      ?.getAudioTracks()
      .some((track) => track.enabled && track.readyState === "live"),
  );

const hasUsableOpenSocket = (socket: WebSocket | null): boolean =>
  Boolean(socket && socket.readyState === WebSocket.OPEN);

export function useMeetingTranscript({
  roomId,
  isJoined,
  currentUserId,
  currentDisplayName,
  isMuted,
  localStream,
  participants,
  activeSpeakerId,
  isViewOnly = false,
  resolveDisplayName,
  getTranscriptToken,
}: UseMeetingTranscriptOptions) {
  const [connectionStatus, setConnectionStatus] =
    useState<TranscriptConnectionStatus>("idle");
  const [session, setSession] = useState<TranscriptSessionState>(() =>
    buildIdleSession(roomId),
  );
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [partials, setPartials] = useState<Map<string, TranscriptSegment>>(
    () => new Map(),
  );
  const [minutes, setMinutes] = useState<TranscriptMinutesSnapshot>(() =>
    createEmptyTranscriptMinutes(),
  );
  const [qaMessages, setQaMessages] = useState<TranscriptQaMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isStreamingAudio, setIsStreamingAudio] = useState(false);
  const [tokenInfo, setTokenInfo] = useState<TranscriptTokenResponse | null>(
    null,
  );
  const [hasGlobalOpenAiKey, setHasGlobalOpenAiKey] = useState(false);
  const [serviceVersion, setServiceVersion] =
    useState<TranscriptServiceVersion | null>(null);
  const [availableServiceVersion, setAvailableServiceVersion] =
    useState<TranscriptServiceVersion | null>(null);
  const [viewerConnectionId, setViewerConnectionId] = useState<string | null>(
    null,
  );
  const socketRef = useRef<WebSocket | null>(null);
  const relayRef = useRef<TranscriptAudioRelay | null>(null);
  const connectPromiseRef = useRef<Promise<boolean> | null>(null);
  const subscribedRef = useRef(false);
  const connectRef = useRef<(() => Promise<boolean>) | null>(null);
  const serviceVersionRef = useRef<TranscriptServiceVersion | null>(null);
  const autoTakeoverAttemptRef = useRef<string | null>(null);

  const transcriptSources = useMemo<TranscriptRelaySource[]>(() => {
    const sources: TranscriptRelaySource[] = [];
    if (isViewOnly) return sources;
    const activeRemoteParticipant =
      activeSpeakerId && activeSpeakerId !== currentUserId
        ? participants.get(activeSpeakerId)
        : null;
    const activeRemoteHasAudio = Boolean(
      activeRemoteParticipant &&
        ((!activeRemoteParticipant.isMuted &&
          isLiveAudioStream(activeRemoteParticipant.audioStream)) ||
          isLiveAudioStream(activeRemoteParticipant.screenShareAudioStream)),
    );
    if (!activeRemoteHasAudio && !isMuted && isLiveAudioStream(localStream)) {
      sources.push({
        id: `local:${localStream!.id}`,
        stream: localStream!,
        speaker: {
          userId: currentUserId,
          displayName: currentDisplayName,
          source: "local",
        },
      });
    }
    for (const participant of participants.values()) {
      if (!participant.isMuted && isLiveAudioStream(participant.audioStream)) {
        sources.push({
          id: `remote:${participant.userId}:${participant.audioStream!.id}`,
          stream: participant.audioStream!,
          speaker: {
            userId: participant.userId,
            displayName: resolveDisplayName(participant.userId),
            source: "remote",
          },
        });
      }
      if (isLiveAudioStream(participant.screenShareAudioStream)) {
        sources.push({
          id: `screen:${participant.userId}:${participant.screenShareAudioStream!.id}`,
          stream: participant.screenShareAudioStream!,
          speaker: {
            userId: participant.userId,
            displayName: resolveDisplayName(participant.userId),
            source: "screen",
          },
        });
      }
    }
    return sources;
  }, [
    activeSpeakerId,
    currentDisplayName,
    currentUserId,
    isMuted,
    isViewOnly,
    localStream,
    participants,
    resolveDisplayName,
  ]);

  const canStart = !isViewOnly && (tokenInfo?.capabilities.start ?? true);
  const canTakeover =
    !isViewOnly && (tokenInfo?.capabilities.takeover ?? true);
  const canAsk = !isViewOnly && (tokenInfo?.capabilities.ask ?? true);
  const canRefreshMinutes = canAsk;
  const rawIsController =
    Boolean(viewerConnectionId) &&
    session.controller?.connectionId === viewerConnectionId;
  const rawIsControllerUser = session.controller?.userId === currentUserId;
  const canStop =
    !isViewOnly &&
    (rawIsControllerUser || tokenInfo?.capabilities.stop === true);

  const setPermissionError = useCallback(() => {
    setError(
      isViewOnly
        ? "Ghost mode can view transcript and minutes only."
        : "You do not have permission to control this transcript.",
    );
  }, [isViewOnly]);

  const send = useCallback((payload: unknown): boolean => {
    const socket = socketRef.current;
    if (!hasUsableOpenSocket(socket)) return false;
    socket!.send(JSON.stringify(payload));
    return true;
  }, []);

  const applyServiceVersion = useCallback(
    (version: TranscriptServiceVersion | undefined): void => {
      if (!version?.id) return;
      serviceVersionRef.current = version;
      setServiceVersion(version);
      setAvailableServiceVersion((available) =>
        available?.id === version.id ? null : available,
      );
    },
    [],
  );

  const upsertAssistantMessage = useCallback(
    (payload: {
      id: string;
      question: string;
      answer?: string;
      status: "streaming" | "done" | "error";
      error?: string;
    }) => {
      setQaMessages((prev) => {
        const now = Date.now();
        const assistantId = `${payload.id}:assistant`;
        const hasQuestion = prev.some((message) => message.id === payload.id);
        const seeded = hasQuestion
          ? prev
          : [
              ...prev,
              {
                id: payload.id,
                role: "user" as const,
                content: payload.question,
                status: "done" as const,
                createdAt: now,
                updatedAt: now,
              },
            ];
        const existingIndex = seeded.findIndex(
          (message) => message.id === assistantId,
        );
        const nextMessage: TranscriptQaMessage = {
          id: assistantId,
          role: "assistant",
          content: payload.answer ?? "",
          status: payload.status,
          createdAt:
            existingIndex >= 0 ? seeded[existingIndex].createdAt : now,
          updatedAt: now,
          ...(payload.error ? { error: payload.error } : {}),
        };
        if (existingIndex >= 0) {
          const next = [...seeded];
          next[existingIndex] = nextMessage;
          return next;
        }
        return [...seeded, nextMessage];
      });
    },
    [],
  );

  const handleServerMessage = useCallback(
    (raw: string) => {
      let message: ServerEnvelope;
      try {
        message = JSON.parse(raw) as ServerEnvelope;
      } catch {
        return;
      }

      switch (message.type) {
        case "snapshot": {
          setViewerConnectionId(message.viewerConnectionId ?? null);
          setHasGlobalOpenAiKey(message.globalOpenAiKeyAvailable === true);
          applyServiceVersion(message.serviceVersion);
          setSession(message.session);
          setSegments(message.segments ?? []);
          setPartials(
            new Map((message.partials ?? []).map((segment) => [segment.itemId, segment])),
          );
          setMinutes(
            message.minutes ??
              createEmptyTranscriptMinutes(message.session.qaModel),
          );
          return;
        }
        case "session.state":
        case "handoff.requested":
          setHasGlobalOpenAiKey(message.globalOpenAiKeyAvailable === true);
          applyServiceVersion(message.serviceVersion);
          setSession(message.session);
          return;
        case "segment.delta":
          setPartials((prev) => mergeTranscriptDelta(prev, message.delta));
          return;
        case "segment.final":
          setPartials((prev) => {
            const next = new Map(prev);
            next.delete(message.segment.itemId);
            return next;
          });
          setSegments((prev) => mergeTranscriptFinal(prev, message.segment));
          return;
        case "partials.reset":
          setPartials(new Map());
          return;
        case "minutes.updated":
          setMinutes(message.minutes);
          return;
        case "qa.delta":
          upsertAssistantMessage({
            id: message.id,
            question: message.question,
            answer: message.answer ?? "",
            status: "streaming",
          });
          return;
        case "qa.final":
          upsertAssistantMessage({
            id: message.id,
            question: message.question,
            answer: message.answer ?? "",
            status: message.status,
            error: message.error,
          });
          return;
        case "error":
          setError(message.message || "Transcript service error.");
          return;
        default: {
          const _exhaustive: never = message;
          void _exhaustive;
          return;
        }
      }
    },
    [applyServiceVersion, upsertAssistantMessage],
  );

  const connect = useCallback(async (): Promise<boolean> => {
    if (!isJoined) {
      setError("Join the meeting before starting transcript.");
      return false;
    }
    if (hasUsableOpenSocket(socketRef.current)) return true;
    if (connectPromiseRef.current) return connectPromiseRef.current;

    connectPromiseRef.current = (async () => {
      setConnectionStatus("connecting");
      setError(null);
      const token = await getTranscriptToken();
      if (!token) {
        setConnectionStatus("error");
        setError("Could not authorize transcript for this room.");
        return false;
      }

      setTokenInfo(token);
      const socket = new WebSocket(toWorkerWebSocketUrl(token));
      socketRef.current = socket;
      socket.onmessage = (event) => handleServerMessage(String(event.data));
      const connected = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          resolve(ok);
        };
        const timeout = window.setTimeout(() => {
          if (socketRef.current === socket) {
            socketRef.current = null;
          }
          setViewerConnectionId(null);
          try {
            socket.close();
          } catch {}
          setConnectionStatus("error");
          setError("Transcript worker connection timed out.");
          finish(false);
        }, 8000);
        socket.onopen = () => {
          setConnectionStatus("connected");
          finish(true);
        };
        socket.onerror = () => {
          if (socketRef.current === socket) {
            socketRef.current = null;
          }
          setViewerConnectionId(null);
          setConnectionStatus("error");
          setError("Transcript worker connection failed.");
          finish(false);
        };
      });
      socket.onclose = () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
          setViewerConnectionId(null);
          setConnectionStatus((prev) =>
            prev === "error" ? "error" : "idle",
          );
          if (subscribedRef.current) {
            window.setTimeout(() => {
              if (subscribedRef.current) {
                void connectRef.current?.();
              }
            }, 2000);
          }
        }
      };
      return connected;
    })();

    try {
      return await connectPromiseRef.current;
    } finally {
      connectPromiseRef.current = null;
    }
  }, [getTranscriptToken, handleServerMessage, isJoined]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const reconnect = useCallback(async (): Promise<boolean> => {
    const relay = relayRef.current;
    relayRef.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    connectPromiseRef.current = null;
    setViewerConnectionId(null);
    setIsStreamingAudio(false);
    setAvailableServiceVersion(null);
    if (relay) await relay.stop();
    try {
      socket?.close();
    } catch {}
    return connect();
  }, [connect]);

  useEffect(() => {
    if (
      !isJoined ||
      connectionStatus !== "connected" ||
      !tokenInfo?.workerUrl
    ) {
      return;
    }

    let cancelled = false;
    const checkVersion = async () => {
      try {
        const response = await fetch(toWorkerVersionUrl(tokenInfo.workerUrl), {
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          serviceVersion?: unknown;
        };
        if (!isTranscriptServiceVersion(payload.serviceVersion)) return;
        const current = serviceVersionRef.current;
        if (
          !cancelled &&
          current?.id &&
          payload.serviceVersion.id !== current.id
        ) {
          setAvailableServiceVersion(payload.serviceVersion);
        }
      } catch {
        // A version probe should never interrupt the live transcript.
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void checkVersion();
    };

    void checkVersion();
    const interval = window.setInterval(checkVersion, VERSION_POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [connectionStatus, isJoined, tokenInfo?.workerUrl]);

  const start = useCallback(
    async (options: StartTranscriptOptions): Promise<boolean> => {
      if (!canStart) {
        setPermissionError();
        return false;
      }
      const connected = await connect();
      if (!connected) return false;
      return send({
        type: "session.start",
        apiKey: options.apiKey,
        transcriptModel:
          options.transcriptModel ?? DEFAULT_TRANSCRIPT_TRANSCRIPTION_MODEL,
        qaModel: options.qaModel ?? DEFAULT_TRANSCRIPT_QA_MODEL,
      });
    },
    [canStart, connect, send, setPermissionError],
  );

  const takeover = useCallback(
    async (options: StartTranscriptOptions): Promise<boolean> => {
      if (!canTakeover) {
        setPermissionError();
        return false;
      }
      const connected = await connect();
      if (!connected) return false;
      return send({
        type: "session.takeover",
        apiKey: options.apiKey,
        transcriptModel:
          options.transcriptModel ?? session.transcriptModel,
        qaModel: options.qaModel ?? session.qaModel,
      });
    },
    [
      canTakeover,
      connect,
      send,
      session.qaModel,
      session.transcriptModel,
      setPermissionError,
    ],
  );

  useEffect(() => {
    if (
      isViewOnly ||
      !hasGlobalOpenAiKey ||
      session.status !== "takeover_needed" ||
      session.controller?.userId !== currentUserId ||
      tokenInfo?.capabilities.takeover === false
    ) {
      return;
    }

    const attemptKey = [
      session.controller.connectionId,
      session.updatedAt,
      serviceVersion?.id ?? "unknown",
    ].join(":");
    if (autoTakeoverAttemptRef.current === attemptKey) return;
    autoTakeoverAttemptRef.current = attemptKey;
    void takeover({});
  }, [
    currentUserId,
    hasGlobalOpenAiKey,
    isViewOnly,
    serviceVersion?.id,
    session.controller?.connectionId,
    session.controller?.userId,
    session.status,
    session.updatedAt,
    takeover,
    tokenInfo?.capabilities.takeover,
  ]);

  const stop = useCallback(() => {
    if (!canStop) {
      setPermissionError();
      return;
    }
    send({ type: "session.stop" });
  }, [canStop, send, setPermissionError]);

  const ask = useCallback(
    async (question: string): Promise<boolean> => {
      const trimmed = question.trim();
      if (!trimmed) return false;
      if (!canAsk) {
        setPermissionError();
        return false;
      }
      const connected = await connect();
      if (!connected) return false;
      const id = `qa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now();
      setQaMessages((prev) => [
        ...prev,
        {
          id,
          role: "user",
          content: trimmed,
          status: "done",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: `${id}:assistant`,
          role: "assistant",
          content: "",
          status: "streaming",
          createdAt: now,
          updatedAt: now,
        },
      ]);
      return send({ type: "qa.ask", id, question: trimmed });
    },
    [canAsk, connect, send, setPermissionError],
  );

  const refreshMinutes = useCallback(async (): Promise<boolean> => {
    if (!canRefreshMinutes) {
      setPermissionError();
      return false;
    }
    const connected = await connect();
    if (!connected) return false;
    return send({ type: "minutes.refresh" });
  }, [canRefreshMinutes, connect, send, setPermissionError]);

  const partialSegments = useMemo(
    () => orderTranscriptSegments(Array.from(partials.values())),
    [partials],
  );
  const allSegments = useMemo(
    () => orderTranscriptSegments([...segments, ...partialSegments]),
    [partialSegments, segments],
  );

  const exportMarkdown = useCallback(
    () => exportTranscriptMarkdown({ roomId, segments: allSegments, minutes }),
    [allSegments, minutes, roomId],
  );

  useEffect(() => {
    if (!isJoined) {
      subscribedRef.current = false;
      const relay = relayRef.current;
      relayRef.current = null;
      const socket = socketRef.current;
      socketRef.current = null;
      if (relay) {
        void relay.stop().finally(() => {
          try {
            socket?.close();
          } catch {}
        });
      } else {
        try {
          socket?.close();
        } catch {}
      }
      setConnectionStatus("idle");
      setSession(buildIdleSession(roomId));
      setSegments([]);
      setPartials(new Map());
      setMinutes(createEmptyTranscriptMinutes());
      setQaMessages([]);
      setTokenInfo(null);
      setHasGlobalOpenAiKey(false);
      setServiceVersion(null);
      serviceVersionRef.current = null;
      setAvailableServiceVersion(null);
      setViewerConnectionId(null);
      return;
    }

    subscribedRef.current = true;
    void connect();
  }, [connect, isJoined, roomId]);

  useEffect(() => {
    return () => {
      const relay = relayRef.current;
      const socket = socketRef.current;
      relayRef.current = null;
      socketRef.current = null;
      if (relay) {
        void relay.stop().finally(() => {
          try {
            socket?.close();
          } catch {}
        });
      } else {
        try {
          socket?.close();
        } catch {}
      }
    };
  }, []);

  useEffect(() => {
    const shouldStream =
      !isViewOnly &&
      session.status === "live" &&
      session.controller?.userId === currentUserId &&
      session.controller.connectionId === viewerConnectionId &&
      hasUsableOpenSocket(socketRef.current);
    if (!shouldStream) {
      void relayRef.current?.stop();
      relayRef.current = null;
      setIsStreamingAudio(false);
      return;
    }

    if (!relayRef.current) {
      relayRef.current = new TranscriptAudioRelay({
        onAudioChunk: (audio, speaker) => {
          send({ type: "audio.chunk", audio, speaker });
        },
        onCommit: (speaker) => {
          send({ type: "audio.commit", speaker });
        },
      });
    }
    relayRef.current
      .start(transcriptSources)
      .then(() => setIsStreamingAudio(true))
      .catch((startError: unknown) => {
        setIsStreamingAudio(false);
        setError(
          startError instanceof Error
            ? startError.message
            : "Could not start transcript audio.",
        );
      });
  }, [
    currentUserId,
    isViewOnly,
    send,
    session,
    transcriptSources,
    viewerConnectionId,
  ]);

  const isServiceUpdateAvailable =
    availableServiceVersion !== null &&
    availableServiceVersion.id !== serviceVersion?.id;

  return {
    connectionStatus,
    session,
    segments,
    partialSegments,
    allSegments,
    minutes,
    qaMessages,
    error,
    tokenInfo,
    hasGlobalOpenAiKey,
    serviceVersion,
    availableServiceVersion,
    isServiceUpdateAvailable,
    isViewOnly,
    canStart,
    canTakeover,
    canStop,
    canAsk,
    canRefreshMinutes,
    isStreamingAudio,
    isController: !isViewOnly && rawIsController,
    isControllerUser: !isViewOnly && rawIsControllerUser,
    isLive: session.status === "live",
    connect,
    reconnect,
    start,
    takeover,
    stop,
    ask,
    refreshMinutes,
    exportMarkdown,
    clearError: () => setError(null),
  };
}

export type MeetingTranscriptController = ReturnType<typeof useMeetingTranscript>;
