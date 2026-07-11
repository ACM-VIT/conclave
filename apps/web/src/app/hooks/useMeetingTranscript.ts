"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Participant,
  TranscriptMinutesSnapshot,
  TranscriptMinutesStatus,
  TranscriptProviderKeyAvailability,
  TranscriptSegment,
  TranscriptServiceVersion,
  TranscriptSfuRelayStartRequest,
  TranscriptSfuRelayStartResponse,
  TranscriptSfuRelayStartToken,
  TranscriptSfuRelayStatusResponse,
  TranscriptSfuRelayStopResponse,
  TranscriptSessionState,
  TranscriptTokenResponse,
  TranscriptTransportMode,
} from "../lib/types";
import {
  DEFAULT_TRANSCRIPT_QA_MODEL,
  DEFAULT_TRANSCRIPT_TRANSCRIPTION_MODEL,
  getTranscriptTranscriptionProvider,
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
import {
  clearRecoveredTranscriptError,
  resolveSnapshotViewerConnectionId,
} from "../lib/transcript-connection";

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
  getTranscriptSfuRelayStatus?: () => Promise<TranscriptSfuRelayStatusResponse | null>;
  startTranscriptSfuRelay?: (
    request: TranscriptSfuRelayStartRequest,
  ) => Promise<TranscriptSfuRelayStartResponse | null>;
  stopTranscriptSfuRelay?: () => Promise<TranscriptSfuRelayStopResponse | null>;
}

interface StartTranscriptOptions {
  apiKey?: string;
  assistantApiKey?: string;
  transcriptModel?: string;
  qaModel?: string;
  transportMode?: TranscriptTransportMode;
}

type ServerEnvelope =
  | {
      type: "snapshot";
      viewerConnectionId?: string;
      globalOpenAiKeyAvailable?: boolean;
      globalProviderKeysAvailable?: TranscriptProviderKeyAvailability;
      serviceVersion?: TranscriptServiceVersion;
      session: TranscriptSessionState;
      segments?: TranscriptSegment[];
      partials?: TranscriptSegment[];
      minutes?: TranscriptMinutesSnapshot;
      minutesStatus?: TranscriptMinutesStatus;
    }
  | {
      type: "session.state";
      session: TranscriptSessionState;
      globalOpenAiKeyAvailable?: boolean;
      globalProviderKeysAvailable?: TranscriptProviderKeyAvailability;
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
      type: "minutes.status";
      status: TranscriptMinutesStatus;
      updatedAt?: number;
    }
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
      globalProviderKeysAvailable?: TranscriptProviderKeyAvailability;
      serviceVersion?: TranscriptServiceVersion;
    }
  | { type: "relay.pong"; id?: string }
  | ({ type: "sfu.relayStartToken" } & TranscriptSfuRelayStartToken)
  | { type: "error"; message?: string };

type TranscriptSessionWaiter = {
  predicate: (session: TranscriptSessionState) => boolean;
  resolve: (session: TranscriptSessionState | null) => void;
  timeoutId: number;
};

type SfuRelayStartTokenWaiter = {
  resolve: (token: TranscriptSfuRelayStartToken | null) => void;
  timeoutId: number;
};

type BufferedTranscriptClientMessage = {
  serialized: string;
  createdAt: number;
  bytes: number;
};

const buildIdleSession = (roomId: string): TranscriptSessionState => ({
  roomId,
  status: "idle",
  controller: null,
  transcriptModel: DEFAULT_TRANSCRIPT_TRANSCRIPTION_MODEL,
  qaModel: DEFAULT_TRANSCRIPT_QA_MODEL,
  transportMode: "browser",
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
const SFU_SESSION_READY_TIMEOUT_MS = 30_000;
const SFU_RELAY_TOKEN_TIMEOUT_MS = 5_000;
const SFU_RELAY_STOP_TIMEOUT_MS = 3_000;
const SFU_EXPLICIT_STOP_SUPPRESS_TAKEOVER_MS = 10_000;
const TRANSCRIPT_RECONNECT_MAX_DELAY_MS = 10_000;
const TRANSCRIPT_RECONNECT_MAX_BUFFER_AGE_MS = 2 * 60 * 1000;
const TRANSCRIPT_RECONNECT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const TRANSCRIPT_RECONNECT_MAX_BUFFER_MESSAGES = 2_000;
const TRANSCRIPT_HEARTBEAT_INTERVAL_MS = 20_000;
const TRANSCRIPT_HEARTBEAT_TIMEOUT_MS = 55_000;
const SFU_RELAY_START_RETRY_DELAYS_MS = [0, 300, 900] as const;

const isBufferableTranscriptAudioPayload = (payload: unknown): boolean => {
  if (!payload || typeof payload !== "object" || !("type" in payload)) {
    return false;
  }
  const type = (payload as { type?: unknown }).type;
  return (
    type === "audio.chunk" || type === "audio.commit" || type === "audio.clear"
  );
};

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

const withTimeout = async <T,>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> =>
  Promise.race([
    promise,
    new Promise<null>((resolve) =>
      window.setTimeout(() => resolve(null), timeoutMs),
    ),
  ]);

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
  getTranscriptSfuRelayStatus,
  startTranscriptSfuRelay,
  stopTranscriptSfuRelay,
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
  const [minutesStatus, setMinutesStatus] =
    useState<TranscriptMinutesStatus>("idle");
  const [qaMessages, setQaMessages] = useState<TranscriptQaMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isStreamingAudio, setIsStreamingAudio] = useState(false);
  const [tokenInfo, setTokenInfo] = useState<TranscriptTokenResponse | null>(
    null,
  );
  const [sfuRelayStatus, setSfuRelayStatus] =
    useState<TranscriptSfuRelayStatusResponse | null>(null);
  const [hasGlobalOpenAiKey, setHasGlobalOpenAiKey] = useState(false);
  const [globalProviderKeysAvailable, setGlobalProviderKeysAvailable] =
    useState<TranscriptProviderKeyAvailability>({});
  const [serviceVersion, setServiceVersion] =
    useState<TranscriptServiceVersion | null>(null);
  const [availableServiceVersion, setAvailableServiceVersion] =
    useState<TranscriptServiceVersion | null>(null);
  const [viewerConnectionId, setViewerConnectionId] = useState<string | null>(
    null,
  );
  const [automaticRelayStartToken, setAutomaticRelayStartToken] =
    useState<TranscriptSfuRelayStartToken | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const relayRef = useRef<TranscriptAudioRelay | null>(null);
  const connectPromiseRef = useRef<Promise<boolean> | null>(null);
  const subscribedRef = useRef(false);
  const connectRef = useRef<(() => Promise<boolean>) | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const bufferedAudioMessagesRef = useRef<BufferedTranscriptClientMessage[]>(
    [],
  );
  const bufferedAudioBytesRef = useRef(0);
  const lastControlPongAtRef = useRef(0);
  const sessionRef = useRef<TranscriptSessionState>(buildIdleSession(roomId));
  const sessionWaitersRef = useRef<Set<TranscriptSessionWaiter>>(new Set());
  const sfuRelayStartTokenRef = useRef<TranscriptSfuRelayStartToken | null>(
    null,
  );
  const sfuRelayStartTokenWaitersRef = useRef<
    Set<SfuRelayStartTokenWaiter>
  >(new Set());
  const serviceVersionRef = useRef<TranscriptServiceVersion | null>(null);
  const autoTakeoverAttemptRef = useRef<string | null>(null);
  const suppressAutoTakeoverUntilRef = useRef(0);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current === null) return;
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (!subscribedRef.current || reconnectTimerRef.current !== null) return;
    const attempt = reconnectAttemptRef.current;
    const delay = Math.min(
      TRANSCRIPT_RECONNECT_MAX_DELAY_MS,
      500 * 2 ** Math.min(attempt, 5),
    );
    reconnectAttemptRef.current += 1;
    setConnectionStatus("connecting");
    if (attempt >= 3) {
      setError("Reconnecting transcript automatically…");
    }
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      void connectRef.current?.().then((connected) => {
        if (!connected) scheduleReconnect();
      });
    }, delay);
  }, []);

  const clearBufferedAudioMessages = useCallback(() => {
    bufferedAudioMessagesRef.current = [];
    bufferedAudioBytesRef.current = 0;
  }, []);

  const pruneBufferedAudioMessages = useCallback(() => {
    const cutoff = Date.now() - TRANSCRIPT_RECONNECT_MAX_BUFFER_AGE_MS;
    while (
      bufferedAudioMessagesRef.current.length > 0 &&
      (bufferedAudioMessagesRef.current.length >
        TRANSCRIPT_RECONNECT_MAX_BUFFER_MESSAGES ||
        bufferedAudioBytesRef.current >
          TRANSCRIPT_RECONNECT_MAX_BUFFER_BYTES ||
        (bufferedAudioMessagesRef.current[0]?.createdAt ?? cutoff) < cutoff)
    ) {
      const removed = bufferedAudioMessagesRef.current.shift();
      if (!removed) break;
      bufferedAudioBytesRef.current -= removed.bytes;
    }
  }, []);

  const bufferAudioMessage = useCallback(
    (serialized: string) => {
      bufferedAudioMessagesRef.current.push({
        serialized,
        createdAt: Date.now(),
        bytes: serialized.length,
      });
      bufferedAudioBytesRef.current += serialized.length;
      pruneBufferedAudioMessages();
    },
    [pruneBufferedAudioMessages],
  );

  const flushBufferedAudioMessages = useCallback(
    (socket: WebSocket): boolean => {
      pruneBufferedAudioMessages();
      while (bufferedAudioMessagesRef.current.length > 0) {
        const message = bufferedAudioMessagesRef.current[0];
        if (!message) break;
        try {
          socket.send(message.serialized);
        } catch {
          try {
            socket.close();
          } catch {}
          return false;
        }
        bufferedAudioMessagesRef.current.shift();
        bufferedAudioBytesRef.current -= message.bytes;
      }
      return true;
    },
    [pruneBufferedAudioMessages],
  );

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
        ? "View-only participants can view transcript and minutes only."
        : "You do not have permission to control this transcript.",
    );
  }, [isViewOnly]);

  const send = useCallback(
    (payload: unknown): boolean => {
      let serialized: string;
      try {
        serialized = JSON.stringify(payload);
      } catch {
        return false;
      }
      const socket = socketRef.current;
      if (hasUsableOpenSocket(socket)) {
        try {
          socket!.send(serialized);
          return true;
        } catch {
          if (socketRef.current === socket) socketRef.current = null;
          try {
            socket?.close();
          } catch {}
          scheduleReconnect();
        }
      }
      if (
        subscribedRef.current &&
        isBufferableTranscriptAudioPayload(payload)
      ) {
        bufferAudioMessage(serialized);
        scheduleReconnect();
        return true;
      }
      return false;
    },
    [bufferAudioMessage, scheduleReconnect],
  );

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

  const applyProviderKeyAvailability = useCallback(
    (options: {
      globalOpenAiKeyAvailable?: boolean;
      globalProviderKeysAvailable?: TranscriptProviderKeyAvailability;
    }) => {
      const openai =
        options.globalProviderKeysAvailable?.openai ??
        options.globalOpenAiKeyAvailable === true;
      const next = {
        ...options.globalProviderKeysAvailable,
        openai,
      };
      setHasGlobalOpenAiKey(openai);
      setGlobalProviderKeysAvailable(next);
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

  const applySessionState = useCallback(
    (nextSession: TranscriptSessionState) => {
      sessionRef.current = nextSession;
      setSession(nextSession);
      if (
        nextSession.status === "idle" ||
        nextSession.status === "error" ||
        nextSession.status === "takeover_needed"
      ) {
        clearBufferedAudioMessages();
      }
      for (const waiter of Array.from(sessionWaitersRef.current)) {
        if (!waiter.predicate(nextSession)) continue;
        window.clearTimeout(waiter.timeoutId);
        sessionWaitersRef.current.delete(waiter);
        waiter.resolve(nextSession);
      }
    },
    [clearBufferedAudioMessages],
  );

  const clearSessionWaiters = useCallback(() => {
    for (const waiter of Array.from(sessionWaitersRef.current)) {
      window.clearTimeout(waiter.timeoutId);
      waiter.resolve(null);
    }
    sessionWaitersRef.current.clear();
  }, []);

  const waitForSessionState = useCallback(
    (
      predicate: (session: TranscriptSessionState) => boolean,
      timeoutMs: number,
    ): Promise<TranscriptSessionState | null> =>
      new Promise((resolve) => {
        const current = sessionRef.current;
        if (predicate(current)) {
          resolve(current);
          return;
        }

        const waiter: TranscriptSessionWaiter = {
          predicate,
          resolve,
          timeoutId: window.setTimeout(() => {
            sessionWaitersRef.current.delete(waiter);
            resolve(null);
          }, timeoutMs),
        };
        sessionWaitersRef.current.add(waiter);
      }),
    [],
  );

  const clearSfuRelayStartTokenWaiters = useCallback(() => {
    for (const waiter of Array.from(sfuRelayStartTokenWaitersRef.current)) {
      window.clearTimeout(waiter.timeoutId);
      waiter.resolve(null);
    }
    sfuRelayStartTokenWaitersRef.current.clear();
  }, []);

  const applySfuRelayStartToken = useCallback(
    (token: TranscriptSfuRelayStartToken) => {
      sfuRelayStartTokenRef.current = token;
      for (const waiter of Array.from(sfuRelayStartTokenWaitersRef.current)) {
        window.clearTimeout(waiter.timeoutId);
        sfuRelayStartTokenWaitersRef.current.delete(waiter);
        waiter.resolve(token);
      }
    },
    [],
  );

  const waitForSfuRelayStartToken = useCallback(
    (): Promise<TranscriptSfuRelayStartToken | null> =>
      new Promise((resolve) => {
        const current = sfuRelayStartTokenRef.current;
        if (current && current.expiresAt > Date.now()) {
          resolve(current);
          return;
        }

        const waiter: SfuRelayStartTokenWaiter = {
          resolve,
          timeoutId: window.setTimeout(() => {
            sfuRelayStartTokenWaitersRef.current.delete(waiter);
            resolve(null);
          }, SFU_RELAY_TOKEN_TIMEOUT_MS),
        };
        sfuRelayStartTokenWaitersRef.current.add(waiter);
      }),
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
          setViewerConnectionId((current) =>
            resolveSnapshotViewerConnectionId(current, message),
          );
          applyProviderKeyAvailability(message);
          applyServiceVersion(message.serviceVersion);
          applySessionState(message.session);
          setSegments(message.segments ?? []);
          setPartials(
            new Map((message.partials ?? []).map((segment) => [segment.itemId, segment])),
          );
          setMinutes(
            message.minutes ??
              createEmptyTranscriptMinutes(message.session.qaModel),
          );
          setMinutesStatus(message.minutesStatus ?? "idle");
          return;
        }
        case "session.state":
        case "handoff.requested":
          applyProviderKeyAvailability(message);
          applyServiceVersion(message.serviceVersion);
          applySessionState(message.session);
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
        case "minutes.status":
          setMinutesStatus(message.status);
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
        case "sfu.relayStartToken":
          const hadRelayTokenWaiter =
            sfuRelayStartTokenWaitersRef.current.size > 0;
          applySfuRelayStartToken({
            token: message.token,
            expiresAt: message.expiresAt,
            automatic: message.automatic,
          });
          if (message.automatic || !hadRelayTokenWaiter) {
            setAutomaticRelayStartToken({
              token: message.token,
              expiresAt: message.expiresAt,
              automatic: true,
            });
          }
          return;
        case "relay.pong":
          lastControlPongAtRef.current = Date.now();
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
    [
      applyProviderKeyAvailability,
      applyServiceVersion,
      applySessionState,
      applySfuRelayStartToken,
      upsertAssistantMessage,
    ],
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
        scheduleReconnect();
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
          try {
            socket.close();
          } catch {}
          scheduleReconnect();
          finish(false);
        }, 8000);
        socket.onopen = () => {
          if (!flushBufferedAudioMessages(socket)) {
            if (socketRef.current === socket) socketRef.current = null;
            scheduleReconnect();
            finish(false);
            return;
          }
          clearReconnectTimer();
          reconnectAttemptRef.current = 0;
          lastControlPongAtRef.current = Date.now();
          setConnectionStatus("connected");
          setError(null);
          finish(true);
        };
        socket.onerror = () => {
          if (socketRef.current === socket) {
            socketRef.current = null;
          }
          try {
            socket.close();
          } catch {}
          scheduleReconnect();
          finish(false);
        };
        socket.onclose = () => {
          if (socketRef.current === socket) {
            socketRef.current = null;
            scheduleReconnect();
          }
          finish(false);
        };
      });
      return connected;
    })();

    try {
      return await connectPromiseRef.current;
    } finally {
      connectPromiseRef.current = null;
    }
  }, [
    clearReconnectTimer,
    flushBufferedAudioMessages,
    getTranscriptToken,
    handleServerMessage,
    isJoined,
    scheduleReconnect,
  ]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    if (connectionStatus !== "connected" || !rawIsController) return;
    lastControlPongAtRef.current = Date.now();
    const heartbeat = window.setInterval(() => {
      const socket = socketRef.current;
      if (
        !hasUsableOpenSocket(socket) ||
        Date.now() - lastControlPongAtRef.current >
          TRANSCRIPT_HEARTBEAT_TIMEOUT_MS
      ) {
        if (socketRef.current === socket) socketRef.current = null;
        try {
          socket?.close();
        } catch {}
        scheduleReconnect();
        return;
      }
      send({
        type: "relay.ping",
        id: `control-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
    }, TRANSCRIPT_HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(heartbeat);
  }, [connectionStatus, rawIsController, scheduleReconnect, send]);

  const ensureSfuRelayAvailable = useCallback(async (): Promise<boolean> => {
    if (!getTranscriptSfuRelayStatus || !startTranscriptSfuRelay) {
      setError("This SFU does not support server-side transcript relay.");
      return false;
    }
    const status = await getTranscriptSfuRelayStatus();
    setSfuRelayStatus(status);
    if (!status?.available) {
      setError(status?.reason || "SFU transcript relay is not available.");
      return false;
    }
    return true;
  }, [getTranscriptSfuRelayStatus, startTranscriptSfuRelay]);

  const startSfuRelay = useCallback(async (
    providedToken?: TranscriptSfuRelayStartToken,
  ): Promise<boolean> => {
    if (!startTranscriptSfuRelay) {
      setError("This SFU does not support server-side transcript relay.");
      return false;
    }
    const relayStartToken =
      providedToken ?? (await waitForSfuRelayStartToken());
    if (!relayStartToken?.token || relayStartToken.expiresAt <= Date.now()) {
      setError("Transcript worker did not authorize the SFU relay.");
      return false;
    }
    let relayStart: TranscriptSfuRelayStartResponse | null = null;
    for (
      let attempt = 0;
      attempt < SFU_RELAY_START_RETRY_DELAYS_MS.length;
      attempt += 1
    ) {
      const delay = SFU_RELAY_START_RETRY_DELAYS_MS[attempt] ?? 0;
      if (delay > 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
      }
      relayStart = await startTranscriptSfuRelay({
        relayStartToken: relayStartToken.token,
      });
      if (relayStart?.success) break;
    }
    if (!relayStart?.success) {
      if (!providedToken?.automatic) {
        setSfuRelayStatus(
          relayStart
            ? {
                mode: "sfu",
                status: relayStart.status,
                available: false,
                reason: relayStart.reason,
                updatedAt: relayStart.updatedAt,
              }
            : null,
        );
        setError(relayStart?.reason || "Could not start SFU transcript relay.");
      }
      return false;
    }
    setSfuRelayStatus({
      mode: "sfu",
      status: relayStart.status,
      available: true,
      updatedAt: relayStart.updatedAt,
    });
    setError(clearRecoveredTranscriptError);
    return true;
  }, [startTranscriptSfuRelay, waitForSfuRelayStartToken]);

  useEffect(() => {
    if (
      !automaticRelayStartToken ||
      automaticRelayStartToken.expiresAt <= Date.now() ||
      session.status !== "live" ||
      session.transportMode !== "sfu" ||
      session.controller?.userId !== currentUserId ||
      !rawIsController
    ) {
      return;
    }
    const token = automaticRelayStartToken;
    setAutomaticRelayStartToken(null);
    void startSfuRelay(token);
  }, [
    automaticRelayStartToken,
    currentUserId,
    rawIsController,
    session.controller?.userId,
    session.status,
    session.transportMode,
    startSfuRelay,
  ]);

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

  const hasGlobalKeysForTranscriptModel = useCallback(
    (transcriptModel: string): boolean => {
      const provider = getTranscriptTranscriptionProvider(transcriptModel);
      return (
        globalProviderKeysAvailable.openai === true &&
        globalProviderKeysAvailable[provider] === true
      );
    },
    [globalProviderKeysAvailable],
  );

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
    const interval = window.setInterval(() => {
      void checkVersion();
    }, VERSION_POLL_INTERVAL_MS);
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
      suppressAutoTakeoverUntilRef.current = 0;
      const transportMode = options.transportMode ?? "browser";
      if (transportMode === "sfu" && !(await ensureSfuRelayAvailable())) {
        return false;
      }
      sfuRelayStartTokenRef.current = null;
      clearSfuRelayStartTokenWaiters();
      const sent = send({
        type: "session.start",
        apiKey: options.apiKey,
        assistantApiKey: options.assistantApiKey,
        transcriptModel:
          options.transcriptModel ?? DEFAULT_TRANSCRIPT_TRANSCRIPTION_MODEL,
        qaModel: options.qaModel ?? DEFAULT_TRANSCRIPT_QA_MODEL,
        transportMode,
      });
      if (!sent) return false;
      if (transportMode === "sfu") {
        const readySession = await waitForSessionState(
          (nextSession) =>
            nextSession.transportMode === "sfu" &&
            (nextSession.status === "live" ||
              nextSession.status === "error" ||
              nextSession.status === "takeover_needed"),
          SFU_SESSION_READY_TIMEOUT_MS,
        );
        if (readySession?.status !== "live") {
          setError(
            readySession?.error ||
              "Transcript is still reconnecting automatically.",
          );
          return false;
        }
        if (!(await startSfuRelay())) {
          suppressAutoTakeoverUntilRef.current = Date.now() + 30_000;
          send({
            type: "session.relayFailed",
            message: "SFU transcript audio relay could not reconnect.",
          });
          return false;
        }
      }
      return true;
    },
    [
      canStart,
      clearSfuRelayStartTokenWaiters,
      connect,
      ensureSfuRelayAvailable,
      send,
      setPermissionError,
      startSfuRelay,
      waitForSessionState,
    ],
  );

  const takeover = useCallback(
    async (options: StartTranscriptOptions): Promise<boolean> => {
      if (!canTakeover) {
        setPermissionError();
        return false;
      }
      const connected = await connect();
      if (!connected) return false;
      suppressAutoTakeoverUntilRef.current = 0;
      const transportMode = options.transportMode ?? session.transportMode;
      if (transportMode === "sfu" && !(await ensureSfuRelayAvailable())) {
        return false;
      }
      sfuRelayStartTokenRef.current = null;
      clearSfuRelayStartTokenWaiters();
      const sent = send({
        type: "session.takeover",
        apiKey: options.apiKey,
        assistantApiKey: options.assistantApiKey,
        transcriptModel:
          options.transcriptModel ?? session.transcriptModel,
        qaModel: options.qaModel ?? session.qaModel,
        transportMode,
      });
      if (!sent) return false;
      if (transportMode === "sfu") {
        const readySession = await waitForSessionState(
          (nextSession) =>
            nextSession.transportMode === "sfu" &&
            (nextSession.status === "live" ||
              nextSession.status === "error" ||
              nextSession.status === "takeover_needed"),
          SFU_SESSION_READY_TIMEOUT_MS,
        );
        if (readySession?.status !== "live") {
          setError(
            readySession?.error ||
              "Transcript is still reconnecting automatically.",
          );
          return false;
        }
        if (!(await startSfuRelay())) {
          suppressAutoTakeoverUntilRef.current = Date.now() + 30_000;
          send({
            type: "session.relayFailed",
            message: "SFU transcript audio relay could not reconnect.",
          });
          return false;
        }
      }
      return true;
    },
    [
      canTakeover,
      clearSfuRelayStartTokenWaiters,
      connect,
      ensureSfuRelayAvailable,
      send,
      session.qaModel,
      session.transcriptModel,
      session.transportMode,
      setPermissionError,
      startSfuRelay,
      waitForSessionState,
    ],
  );

  useEffect(() => {
    if (
      isViewOnly ||
      !hasGlobalKeysForTranscriptModel(session.transcriptModel) ||
      session.status !== "takeover_needed" ||
      session.controller?.userId !== currentUserId ||
      tokenInfo?.capabilities.takeover === false
    ) {
      return;
    }
    if (Date.now() < suppressAutoTakeoverUntilRef.current) {
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
    hasGlobalKeysForTranscriptModel,
    isViewOnly,
    serviceVersion?.id,
    session.controller?.connectionId,
    session.controller?.userId,
    session.status,
    session.transcriptModel,
    session.updatedAt,
    takeover,
    tokenInfo?.capabilities.takeover,
  ]);

  const stop = useCallback(async (): Promise<void> => {
    if (!canStop) {
      setPermissionError();
      return;
    }
    const transportMode = session.transportMode;
    suppressAutoTakeoverUntilRef.current =
      Date.now() + SFU_EXPLICIT_STOP_SUPPRESS_TAKEOVER_MS;
    send({ type: "session.stop" });
    if (transportMode === "sfu") {
      await withTimeout(
        stopTranscriptSfuRelay?.() ?? Promise.resolve(null),
        SFU_RELAY_STOP_TIMEOUT_MS,
      );
    }
  }, [
    canStop,
    send,
    session.transportMode,
    setPermissionError,
    stopTranscriptSfuRelay,
  ]);

  const pause = useCallback((): boolean => {
    if (!canStop) {
      setPermissionError();
      return false;
    }
    return send({ type: "session.pause" });
  }, [canStop, send, setPermissionError]);

  const resume = useCallback((): boolean => {
    if (!canStop) {
      setPermissionError();
      return false;
    }
    return send({ type: "session.resume" });
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
      clearReconnectTimer();
      reconnectAttemptRef.current = 0;
      clearBufferedAudioMessages();
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
      const idleSession = buildIdleSession(roomId);
      sessionRef.current = idleSession;
      clearSessionWaiters();
      sfuRelayStartTokenRef.current = null;
      clearSfuRelayStartTokenWaiters();
      setSession(idleSession);
      setSegments([]);
      setPartials(new Map());
      setMinutes(createEmptyTranscriptMinutes());
      setMinutesStatus("idle");
      setQaMessages([]);
      setTokenInfo(null);
      setHasGlobalOpenAiKey(false);
      setGlobalProviderKeysAvailable({});
      setServiceVersion(null);
      serviceVersionRef.current = null;
      setAvailableServiceVersion(null);
      setViewerConnectionId(null);
      setAutomaticRelayStartToken(null);
      setSfuRelayStatus(null);
      return;
    }

    subscribedRef.current = true;
    void connect();
  }, [
    clearSessionWaiters,
    clearSfuRelayStartTokenWaiters,
    clearBufferedAudioMessages,
    clearReconnectTimer,
    connect,
    isJoined,
    roomId,
  ]);

  useEffect(() => {
    if (!isJoined || isViewOnly || !getTranscriptSfuRelayStatus) return;
    let cancelled = false;
    void getTranscriptSfuRelayStatus().then((status) => {
      if (!cancelled) setSfuRelayStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, [getTranscriptSfuRelayStatus, isJoined, isViewOnly]);

  useEffect(() => {
    return () => {
      subscribedRef.current = false;
      clearReconnectTimer();
      clearBufferedAudioMessages();
      clearSessionWaiters();
      clearSfuRelayStartTokenWaiters();
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
  }, [
    clearReconnectTimer,
    clearBufferedAudioMessages,
    clearSessionWaiters,
    clearSfuRelayStartTokenWaiters,
  ]);

  useEffect(() => {
    const shouldStream =
      !isViewOnly &&
      session.transportMode !== "sfu" &&
      session.status === "live" &&
      session.controller?.userId === currentUserId &&
      session.controller.connectionId === viewerConnectionId;
    if (!shouldStream) {
      void relayRef.current?.stop();
      relayRef.current = null;
      setIsStreamingAudio(
        session.transportMode === "sfu" &&
          session.status === "live" &&
          session.controller?.userId === currentUserId &&
          sfuRelayStatus?.available === true,
      );
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
        onClear: (speaker) => {
          send({ type: "audio.clear", speaker });
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
    sfuRelayStatus?.available,
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
    minutesStatus,
    qaMessages,
    error,
    tokenInfo,
    sfuRelayStatus,
    hasGlobalOpenAiKey,
    globalProviderKeysAvailable,
    hasGlobalKeysForTranscriptModel,
    serviceVersion,
    availableServiceVersion,
    isServiceUpdateAvailable,
    isViewOnly,
    canStart,
    canTakeover,
    canStop,
    canPause: canStop,
    canAsk,
    canRefreshMinutes,
    isStreamingAudio,
    isController: !isViewOnly && rawIsController,
    isControllerUser: !isViewOnly && rawIsControllerUser,
    isLive: session.status === "live",
    isPaused: session.status === "paused",
    connect,
    reconnect,
    start,
    takeover,
    stop,
    pause,
    resume,
    ask,
    refreshMinutes,
    exportMarkdown,
    clearError: () => setError(null),
  };
}

export type MeetingTranscriptController = ReturnType<typeof useMeetingTranscript>;
