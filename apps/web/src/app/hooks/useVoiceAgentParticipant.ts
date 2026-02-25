"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { Device as MediasoupDevice, Producer, Transport } from "mediasoup-client/types";
import type {
  ChatMessage,
  DtlsParameters,
  JoinRoomResponse,
  Participant,
  RtpParameters,
  TransportResponse,
} from "../lib/types";
import { OPUS_MAX_AVERAGE_BITRATE } from "../lib/constants";

type VoiceAgentStatus = "idle" | "starting" | "running" | "error";

type JoinInfo = {
  token?: string;
  sfuUrl?: string;
  iceServers?: RTCIceServer[];
  error?: string;
};

type RuntimeState = {
  openAiPc: RTCPeerConnection | null;
  openAiMicStream: MediaStream | null;
  openAiMixContext: AudioContext | null;
  openAiMixDestination: MediaStreamAudioDestinationNode | null;
  openAiMixSources: MediaStreamAudioSourceNode[];
  openAiDataChannel: RTCDataChannel | null;
  sfuSocket: Socket | null;
  producerTransport: Transport | null;
  producer: Producer | null;
};

type UseVoiceAgentParticipantOptions = {
  roomId: string;
  isJoined: boolean;
  isAdmin: boolean;
  isMuted: boolean;
  activeSpeakerId: string | null;
  localUserId: string;
  localStream: MediaStream | null;
  participants: Map<string, Participant>;
  recentMessages?: ChatMessage[];
  resolveDisplayName?: (userId: string) => string;
  instructions?: string;
  model?: string;
  voice?: string;
};

const DEFAULT_MODEL = "gpt-realtime-1.5";
const DEFAULT_VOICE = "marin";
const DEFAULT_INSTRUCTIONS =
  "You are a concise, helpful voice assistant in a live meeting. Keep responses short and practical.";
const AGENT_DISPLAY_NAME = "Voice Agent";
const SOCKET_CONNECT_TIMEOUT_MS = 8000;
const SFU_CLIENT_ID = process.env.NEXT_PUBLIC_SFU_CLIENT_ID || "public";
const TURN_URL_PATTERN = /^turns?:/i;
const ACTIVE_SPEAKER_HOLD_MS = 450;

const normalizeIceServerUrls = (
  urls: RTCIceServer["urls"] | undefined,
): string[] => {
  if (!urls) return [];
  return (Array.isArray(urls) ? urls : [urls])
    .map((value) => value.trim())
    .filter(Boolean);
};

const buildIceServerWithUrls = (
  iceServer: RTCIceServer,
  urls: string[],
): RTCIceServer => ({
  ...iceServer,
  urls: urls.length === 1 ? urls[0] : urls,
});

const splitIceServersByType = (
  iceServers: RTCIceServer[] | null | undefined,
): { stunIceServers: RTCIceServer[]; turnIceServers: RTCIceServer[] } => {
  const stunIceServers: RTCIceServer[] = [];
  const turnIceServers: RTCIceServer[] = [];

  for (const iceServer of iceServers ?? []) {
    const urls = normalizeIceServerUrls(iceServer.urls);
    if (urls.length === 0) continue;

    const turnUrls = urls.filter((url) => TURN_URL_PATTERN.test(url));
    const stunUrls = urls.filter((url) => !TURN_URL_PATTERN.test(url));

    if (stunUrls.length > 0) {
      stunIceServers.push(buildIceServerWithUrls(iceServer, stunUrls));
    }
    if (turnUrls.length > 0) {
      turnIceServers.push(buildIceServerWithUrls(iceServer, turnUrls));
    }
  }

  return { stunIceServers, turnIceServers };
};

type RealtimeClientSecretResponse = {
  value?: string;
  client_secret?: {
    value?: string;
  };
  error?: {
    message?: string;
  };
};

type RealtimeToolDefinition = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

type ToolCallPayload = {
  callId: string;
  name: string;
  argumentsText: string;
};

const REALTIME_TOOLS: RealtimeToolDefinition[] = [
  {
    type: "function",
    name: "get_meeting_state",
    description:
      "Get room-level context like participant count, mute state, and who is sharing.",
    parameters: {
      type: "object",
      properties: {
        includeParticipants: {
          type: "boolean",
          description: "Include a compact participant list in the response.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_participants",
    description:
      "List participants with speaking-relevant status (muted, camera, hand raise, screen share).",
    parameters: {
      type: "object",
      properties: {
        includeMuted: {
          type: "boolean",
          description: "Whether muted participants should be included.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_recent_chat",
    description: "Get recent chat messages for conversation context.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 30,
          description: "How many latest chat messages to return.",
        },
      },
      additionalProperties: false,
    },
  },
];

const parseToolArguments = (raw: string) => {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
};

const normalizeBoolean = (value: unknown, fallback: boolean) =>
  typeof value === "boolean" ? value : fallback;

const normalizeLimit = (value: unknown, fallback = 8) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(30, Math.floor(value)));
};

const extractToolCall = (event: unknown): ToolCallPayload | null => {
  if (!event || typeof event !== "object") return null;
  const data = event as Record<string, unknown>;
  const type = typeof data.type === "string" ? data.type : "";

  if (type === "response.output_item.done") {
    const item =
      data.item && typeof data.item === "object"
        ? (data.item as Record<string, unknown>)
        : null;
    if (!item || item.type !== "function_call") return null;
    const callId = typeof item.call_id === "string" ? item.call_id : "";
    const name = typeof item.name === "string" ? item.name : "";
    const argumentsText = typeof item.arguments === "string" ? item.arguments : "{}";
    if (!callId || !name) return null;
    return { callId, name, argumentsText };
  }

  if (type === "response.function_call_arguments.done") {
    const callId = typeof data.call_id === "string" ? data.call_id : "";
    const name = typeof data.name === "string" ? data.name : "";
    const argumentsText =
      typeof data.arguments === "string" ? data.arguments : "{}";
    if (!callId || !name) return null;
    return { callId, name, argumentsText };
  }

  return null;
};

type AudioContextCtor = new (
  contextOptions?: AudioContextOptions,
) => AudioContext;

const createRuntimeState = (): RuntimeState => ({
  openAiPc: null,
  openAiMicStream: null,
  openAiMixContext: null,
  openAiMixDestination: null,
  openAiMixSources: [],
  openAiDataChannel: null,
  sfuSocket: null,
  producerTransport: null,
  producer: null,
});

const disconnectMixSources = (runtime: RuntimeState) => {
  for (const source of runtime.openAiMixSources) {
    try {
      source.disconnect();
    } catch {}
  }
  runtime.openAiMixSources = [];
};

const closeRuntimeState = (runtime: RuntimeState) => {
  if (runtime.producer && !runtime.producer.closed) {
    try {
      runtime.producer.close();
    } catch {}
  }
  if (runtime.producerTransport && !runtime.producerTransport.closed) {
    try {
      runtime.producerTransport.close();
    } catch {}
  }
  if (runtime.sfuSocket) {
    try {
      runtime.sfuSocket.disconnect();
    } catch {}
  }
  if (runtime.openAiDataChannel) {
    try {
      runtime.openAiDataChannel.close();
    } catch {}
  }
  if (runtime.openAiPc) {
    try {
      runtime.openAiPc.close();
    } catch {}
  }
  disconnectMixSources(runtime);
  if (runtime.openAiMixContext) {
    try {
      void runtime.openAiMixContext.close();
    } catch {}
  }
  runtime.openAiMixContext = null;
  runtime.openAiMixDestination = null;
  if (runtime.openAiMicStream) {
    runtime.openAiMicStream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {}
    });
  }
};

const buildRandomId = (prefix: string): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const getAudioContextCtor = (): AudioContextCtor | null => {
  if (typeof window === "undefined") return null;
  const nativeCtor = window.AudioContext as AudioContextCtor | undefined;
  if (nativeCtor) return nativeCtor;
  const webkitCtor = (
    window as Window & {
      webkitAudioContext?: AudioContextCtor;
    }
  ).webkitAudioContext;
  return webkitCtor ?? null;
};

const hasLiveAudioTrack = (stream: MediaStream | null): boolean =>
  Boolean(
    stream?.getAudioTracks().some((track) => track.readyState !== "ended"),
  );

const isVoiceAgentUserId = (userId: string): boolean => {
  const normalized = userId.toLowerCase();
  return (
    normalized.includes("@agent.conclave") ||
    normalized.startsWith("voice-agent-")
  );
};

const createSocketConnection = async (
  sfuUrl: string,
  token: string,
): Promise<Socket> => {
  const { io } = await import("socket.io-client");
  const socket = io(sfuUrl, {
    transports: ["websocket", "polling"],
    timeout: SOCKET_CONNECT_TIMEOUT_MS,
    reconnection: false,
    auth: { token },
  });

  return new Promise<Socket>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      socket.disconnect();
      reject(new Error("Voice agent socket connect timeout."));
    }, SOCKET_CONNECT_TIMEOUT_MS);

    const onConnect = () => {
      window.clearTimeout(timeoutId);
      socket.off("connect_error", onConnectError);
      resolve(socket);
    };

    const onConnectError = (error: Error) => {
      window.clearTimeout(timeoutId);
      socket.off("connect", onConnect);
      reject(error);
    };

    socket.once("connect", onConnect);
    socket.once("connect_error", onConnectError);
  });
};

const joinRoomAsAgent = async (
  socket: Socket,
  roomId: string,
  sessionId: string,
): Promise<JoinRoomResponse> => {
  return new Promise<JoinRoomResponse>((resolve, reject) => {
    socket.emit(
      "joinRoom",
      {
        roomId,
        sessionId,
        displayName: AGENT_DISPLAY_NAME,
        ghost: false,
      },
      (response: JoinRoomResponse | { error: string }) => {
        if ("error" in response) {
          reject(new Error(response.error));
          return;
        }
        if (response.status === "waiting") {
          reject(new Error("Voice agent is waiting for room admission."));
          return;
        }
        resolve(response);
      },
    );
  });
};

const createProducerTransport = async (
  socket: Socket,
  device: MediasoupDevice,
  iceServers?: RTCIceServer[],
): Promise<Transport> => {
  const transportResponse = await new Promise<TransportResponse>((resolve, reject) => {
    socket.emit(
      "createProducerTransport",
      (response: TransportResponse | { error: string }) => {
        if ("error" in response) {
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      },
    );
  });

  const transport = device.createSendTransport({
    ...transportResponse,
    iceServers,
  });

  transport.on(
    "connect",
    (
      { dtlsParameters }: { dtlsParameters: DtlsParameters },
      callback: () => void,
      errback: (error: Error) => void,
    ) => {
      socket.emit(
        "connectProducerTransport",
        { transportId: transport.id, dtlsParameters },
        (response: { success: boolean } | { error: string }) => {
          if ("error" in response) {
            errback(new Error(response.error));
            return;
          }
          callback();
        },
      );
    },
  );

  transport.on(
    "produce",
    (
      {
        kind,
        rtpParameters,
        appData,
      }: {
        kind: "audio" | "video";
        rtpParameters: RtpParameters;
        appData: { type?: string; paused?: boolean };
      },
      callback: ({ id }: { id: string }) => void,
      errback: (error: Error) => void,
    ) => {
      socket.emit(
        "produce",
        { kind, rtpParameters, appData },
        (response: { producerId: string } | { error: string }) => {
          if ("error" in response) {
            errback(new Error(response.error));
            return;
          }
          callback({ id: response.producerId });
        },
      );
    },
  );

  return transport;
};

const waitForDataChannelOpen = (channel: RTCDataChannel) => {
  if (channel.readyState === "open") {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Realtime data channel open timeout."));
    }, 6000);

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("error", onError);
    };

    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error("Realtime data channel failed to open."));
    };

    channel.addEventListener("open", onOpen);
    channel.addEventListener("error", onError);
  });
};

export function useVoiceAgentParticipant({
  roomId,
  isJoined,
  isAdmin,
  isMuted,
  activeSpeakerId,
  localUserId,
  localStream,
  participants,
  recentMessages = [],
  resolveDisplayName,
  instructions = DEFAULT_INSTRUCTIONS,
  model = DEFAULT_MODEL,
  voice = DEFAULT_VOICE,
}: UseVoiceAgentParticipantOptions) {
  const runtimeRef = useRef<RuntimeState>(createRuntimeState());
  const pendingRemoteTrackRef = useRef<MediaStreamTrack | null>(null);
  const mountedRef = useRef(true);
  const roomIdRef = useRef(roomId);
  const isMutedRef = useRef(isMuted);
  const activeSpeakerIdRef = useRef(activeSpeakerId);
  const localUserIdRef = useRef(localUserId);
  const participantsRef = useRef(participants);
  const recentMessagesRef = useRef(recentMessages);
  const resolveDisplayNameRef = useRef(resolveDisplayName);
  const lastHeldSpeakerRef = useRef<{ id: string; ts: number } | null>(null);

  const [status, setStatus] = useState<VoiceAgentStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const setSafeStatus = useCallback((next: VoiceAgentStatus) => {
    if (!mountedRef.current) return;
    setStatus(next);
  }, []);

  const setSafeError = useCallback((next: string | null) => {
    if (!mountedRef.current) return;
    setError(next);
  }, []);

  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    activeSpeakerIdRef.current = activeSpeakerId;
  }, [activeSpeakerId]);

  useEffect(() => {
    localUserIdRef.current = localUserId;
  }, [localUserId]);

  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  useEffect(() => {
    recentMessagesRef.current = recentMessages;
  }, [recentMessages]);

  useEffect(() => {
    resolveDisplayNameRef.current = resolveDisplayName;
  }, [resolveDisplayName]);

  const stop = useCallback(() => {
    pendingRemoteTrackRef.current = null;
    lastHeldSpeakerRef.current = null;
    const runtime = runtimeRef.current;
    runtimeRef.current = createRuntimeState();
    closeRuntimeState(runtime);
    setSafeError(null);
    setSafeStatus("idle");
  }, [setSafeError, setSafeStatus]);

  const producePendingTrack = useCallback(async () => {
    const pendingTrack = pendingRemoteTrackRef.current;
    const runtime = runtimeRef.current;
    if (!pendingTrack || !runtime.producerTransport || runtime.producer) {
      return;
    }

    const producer = await runtime.producerTransport.produce({
      track: pendingTrack,
      codecOptions: {
        opusStereo: true,
        opusFec: true,
        opusDtx: true,
        opusMaxAverageBitrate: OPUS_MAX_AVERAGE_BITRATE,
      },
      appData: { type: "webcam", paused: false },
    });
    runtime.producer = producer;
  }, []);

  const rebuildOpenAiMix = useCallback(
    async (runtime: RuntimeState) => {
      const context = runtime.openAiMixContext;
      const destination = runtime.openAiMixDestination;
      if (!context || !destination) {
        return;
      }

      disconnectMixSources(runtime);
      const connectedStreamIds = new Set<string>();

      const connectStream = (stream: MediaStream | null) => {
        if (!stream || !hasLiveAudioTrack(stream)) {
          return;
        }
        if (connectedStreamIds.has(stream.id)) {
          return;
        }
        try {
          const source = context.createMediaStreamSource(stream);
          source.connect(destination);
          runtime.openAiMixSources.push(source);
          connectedStreamIds.add(stream.id);
        } catch {}
      };

      const now = Date.now();
      let speakerId = activeSpeakerId || null;
      if (speakerId) {
        lastHeldSpeakerRef.current = { id: speakerId, ts: now };
      } else if (
        lastHeldSpeakerRef.current &&
        now - lastHeldSpeakerRef.current.ts <= ACTIVE_SPEAKER_HOLD_MS
      ) {
        speakerId = lastHeldSpeakerRef.current.id;
      } else {
        lastHeldSpeakerRef.current = null;
      }

      if (!speakerId) {
        if (context.state === "suspended") {
          await context.resume().catch(() => undefined);
        }
        return;
      }

      if (speakerId === localUserId) {
        if (!isMuted) {
          connectStream(localStream);
        }
      } else {
        const speaker = participants.get(speakerId);
        if (speaker && !speaker.isMuted && !isVoiceAgentUserId(speaker.userId)) {
          connectStream(speaker.audioStream);
          connectStream(speaker.screenShareAudioStream);
        }
      }

      if (context.state === "suspended") {
        await context.resume().catch(() => undefined);
      }
    },
    [activeSpeakerId, isMuted, localStream, localUserId, participants],
  );

  const buildParticipantSnapshot = useCallback(
    (options?: { includeMuted?: boolean }) => {
      const includeMuted = normalizeBoolean(options?.includeMuted, true);
      const resolver = resolveDisplayNameRef.current;
      return Array.from(participantsRef.current.values())
        .filter((participant) => !isVoiceAgentUserId(participant.userId))
        .filter((participant) => (includeMuted ? true : !participant.isMuted))
        .map((participant) => ({
          userId: participant.userId,
          displayName: resolver?.(participant.userId) ?? participant.userId,
          muted: participant.isMuted,
          cameraOff: participant.isCameraOff,
          handRaised: participant.isHandRaised,
          hasScreenShare: Boolean(participant.screenShareStream),
        }));
    },
    [],
  );

  const runTool = useCallback(
    async (name: string, rawArgs: string) => {
      const args = parseToolArguments(rawArgs);
      switch (name) {
        case "get_meeting_state": {
          const includeParticipants = normalizeBoolean(
            args.includeParticipants,
            true,
          );
          const participantList = buildParticipantSnapshot({
            includeMuted: true,
          });
          return {
            roomId: roomIdRef.current,
            participantCount: participantList.length,
            localUserMuted: isMutedRef.current,
            screenShareCount: participantList.filter((item) => item.hasScreenShare)
              .length,
            participants: includeParticipants ? participantList : undefined,
          };
        }
        case "list_participants": {
          return {
            roomId: roomIdRef.current,
            participants: buildParticipantSnapshot({
              includeMuted: normalizeBoolean(args.includeMuted, true),
            }),
          };
        }
        case "get_recent_chat": {
          const limit = normalizeLimit(args.limit, 8);
          const messages = recentMessagesRef.current
            .slice(-limit)
            .map((message) => ({
              userId: message.userId,
              displayName: message.displayName,
              content: message.content,
              timestamp: message.timestamp,
            }));
          return {
            roomId: roomIdRef.current,
            count: messages.length,
            messages,
          };
        }
        default:
          return {
            error: `Unknown tool: ${name}`,
          };
      }
    },
    [buildParticipantSnapshot],
  );

  const handleRealtimeToolCall = useCallback(
    async (runtime: RuntimeState, payload: ToolCallPayload) => {
      const channel = runtime.openAiDataChannel;
      if (!channel || channel.readyState !== "open") {
        return;
      }
      const output = await runTool(payload.name, payload.argumentsText);
      channel.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: payload.callId,
            output: JSON.stringify(output),
          },
        }),
      );
      channel.send(
        JSON.stringify({
          type: "response.create",
        }),
      );
    },
    [runTool],
  );

  const buildSessionInstructions = useCallback(() => {
    const resolver = resolveDisplayNameRef.current;
    const participantList = Array.from(participantsRef.current.values())
      .filter((participant) => !isVoiceAgentUserId(participant.userId))
      .map((participant) => resolver?.(participant.userId) ?? participant.userId)
      .slice(0, 12);
    const recentChatPreview = recentMessagesRef.current
      .slice(-5)
      .map((message) => `${message.displayName}: ${message.content}`)
      .join(" | ");

    return [
      instructions,
      "",
      `Meeting room: ${roomIdRef.current}.`,
      `Local user muted: ${isMutedRef.current ? "yes" : "no"}.`,
      participantList.length > 0
        ? `Participants: ${participantList.join(", ")}.`
        : "Participants: unknown.",
      recentChatPreview
        ? `Recent chat: ${recentChatPreview}`
        : "Recent chat: none.",
      "Use available tools when you need up-to-date meeting details before answering.",
      "Keep responses concise and practical for a live meeting.",
      "Respond only when addressed or when there is a clear request in the current speech.",
    ].join("\n");
  }, [instructions]);

  const start = useCallback(async (providedApiKey?: string) => {
    if (!isAdmin) {
      setSafeError("Only admins can start the voice agent.");
      setSafeStatus("error");
      return;
    }
    if (!isJoined || !roomId.trim()) {
      setSafeError("Join a room before starting the voice agent.");
      setSafeStatus("error");
      return;
    }
    if (status === "starting" || status === "running") {
      return;
    }
    const apiKey = providedApiKey?.trim() || "";
    if (!apiKey) {
      setSafeError("Enter your OpenAI API key before starting the voice agent.");
      setSafeStatus("error");
      return;
    }

    setSafeError(null);
    setSafeStatus("starting");

    closeRuntimeState(runtimeRef.current);
    const runtime = createRuntimeState();
    runtimeRef.current = runtime;
    pendingRemoteTrackRef.current = null;

    try {
      const sessionInstructions = buildSessionInstructions();
      const AudioContextImpl = getAudioContextCtor();
      if (!AudioContextImpl) {
        throw new Error(
          "This browser does not support the audio APIs needed for the voice agent.",
        );
      }
      runtime.openAiMixContext = new AudioContextImpl({
        latencyHint: "interactive",
      });
      runtime.openAiMixDestination =
        runtime.openAiMixContext.createMediaStreamDestination();
      runtime.openAiMicStream = runtime.openAiMixDestination.stream;
      await rebuildOpenAiMix(runtime);

      const sessionPayload = {
        session: {
          type: "realtime" as const,
          model,
          instructions: sessionInstructions,
          audio: {
            input: {
              turn_detection: {
                type: "server_vad" as const,
              },
            },
            output: {
              voice,
            },
          },
          tools: REALTIME_TOOLS,
          tool_choice: "auto" as const,
        },
      };

      const clientSecretResponse = await fetch(
        "https://api.openai.com/v1/realtime/client_secrets",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(sessionPayload),
          credentials: "omit",
          referrerPolicy: "no-referrer",
        },
      );

      const clientSecretBody = (await clientSecretResponse.json().catch(() => null)) as
        | RealtimeClientSecretResponse
        | null;

      const clientSecret =
        clientSecretBody?.client_secret?.value?.trim() ||
        clientSecretBody?.value?.trim() ||
        "";
      if (!clientSecretResponse.ok || !clientSecret) {
        throw new Error(
          clientSecretBody?.error?.message ??
            "Failed to create voice agent session secret.",
        );
      }

      runtime.openAiPc = new RTCPeerConnection();
      runtime.openAiDataChannel = runtime.openAiPc.createDataChannel("oai-events");
      runtime.openAiDataChannel.onmessage = (event) => {
        if (runtimeRef.current !== runtime) return;
        if (typeof event.data !== "string") return;
        try {
          const parsed = JSON.parse(event.data) as unknown;
          const toolCall = extractToolCall(parsed);
          if (!toolCall) return;
          void handleRealtimeToolCall(runtime, toolCall).catch((toolError) => {
            const message =
              toolError instanceof Error
                ? toolError.message
                : "Voice agent tool execution failed.";
            setSafeError(message);
          });
        } catch {}
      };
      runtime.openAiPc.ontrack = (event) => {
        if (runtimeRef.current !== runtime) return;
        const audioTrack =
          event.streams?.[0]?.getAudioTracks?.()[0] ??
          (event.track.kind === "audio" ? event.track : null);
        if (!audioTrack) return;
        pendingRemoteTrackRef.current = audioTrack;
        void producePendingTrack().catch((produceError) => {
          if (!mountedRef.current) return;
          if (runtimeRef.current !== runtime) return;
          const message =
            produceError instanceof Error
              ? produceError.message
              : "Failed to publish voice agent audio to SFU.";
          setSafeError(message);
          setSafeStatus("error");
        });
      };

      const micTrack = runtime.openAiMicStream.getAudioTracks()[0];
      if (!micTrack) {
        throw new Error("No available meeting audio track for the voice agent input.");
      }
      runtime.openAiPc.addTrack(micTrack, runtime.openAiMicStream);

      const offer = await runtime.openAiPc.createOffer();
      await runtime.openAiPc.setLocalDescription(offer);

      const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp ?? "",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (!sdpResponse.ok) {
        const reason = await sdpResponse.text();
        throw new Error(
          `Realtime call failed (${sdpResponse.status}): ${reason || "Unknown error"}`,
        );
      }

      const answerSdp = await sdpResponse.text();
      await runtime.openAiPc.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      });

      if (runtime.openAiDataChannel) {
        await waitForDataChannelOpen(runtime.openAiDataChannel);
        runtime.openAiDataChannel.send(
          JSON.stringify({
            type: "session.update",
            session: {
              type: "realtime",
              model,
              instructions: sessionInstructions,
              audio: {
                input: {
                  turn_detection: {
                    type: "server_vad",
                  },
                },
                output: {
                  voice,
                },
              },
              tools: REALTIME_TOOLS,
              tool_choice: "auto",
            },
          }),
        );
      }

      const agentSessionId = buildRandomId("agent-session");
      const agentUserId = buildRandomId("voice-agent");

      const joinInfoResponse = await fetch("/api/sfu/join", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-sfu-client": SFU_CLIENT_ID,
        },
        credentials: "omit",
        body: JSON.stringify({
          roomId,
          sessionId: agentSessionId,
          joinMode: "meeting",
          isHost: false,
          isAdmin: false,
          allowRoomCreation: false,
          user: {
            id: agentUserId,
            email: `${agentUserId}@agent.conclave`,
            name: AGENT_DISPLAY_NAME,
          },
          clientId: SFU_CLIENT_ID,
        }),
      });
      const joinInfo = (await joinInfoResponse.json().catch(() => null)) as JoinInfo | null;
      const token = joinInfo?.token?.trim();
      const sfuUrl = joinInfo?.sfuUrl?.trim();
      if (!joinInfoResponse.ok || !token || !sfuUrl) {
        throw new Error(joinInfo?.error ?? "Failed to create SFU token for voice agent.");
      }

      runtime.sfuSocket = await createSocketConnection(sfuUrl, token);
      runtime.sfuSocket.on("disconnect", () => {
        if (!mountedRef.current) return;
        if (runtimeRef.current.sfuSocket !== runtime.sfuSocket) return;
        setSafeError("Voice agent disconnected from SFU.");
        setSafeStatus("error");
      });

      const joinRoomResponse = await joinRoomAsAgent(
        runtime.sfuSocket,
        roomId,
        agentSessionId,
      );

      const { Device } = await import("mediasoup-client");
      const device = new Device();
      await device.load({
        routerRtpCapabilities: joinRoomResponse.rtpCapabilities,
      });

      const { stunIceServers, turnIceServers } = splitIceServersByType(
        Array.isArray(joinInfo?.iceServers) ? joinInfo.iceServers : undefined,
      );
      const stunOnlyIceServers =
        stunIceServers.length > 0 ? stunIceServers : undefined;
      const turnFallbackIceServers =
        turnIceServers.length > 0
          ? [...(stunIceServers.length > 0 ? stunIceServers : []), ...turnIceServers]
          : undefined;

      try {
        runtime.producerTransport = await createProducerTransport(
          runtime.sfuSocket,
          device,
          stunOnlyIceServers,
        );
      } catch (stunTransportError) {
        if (!turnFallbackIceServers) {
          throw stunTransportError;
        }
        console.warn(
          "[Voice Agent] STUN-only transport failed. Retrying with TURN fallback.",
          stunTransportError,
        );
        runtime.producerTransport = await createProducerTransport(
          runtime.sfuSocket,
          device,
          turnFallbackIceServers,
        );
      }

      await producePendingTrack();
      if (runtimeRef.current !== runtime || !runtime.sfuSocket?.connected) {
        throw new Error("Voice agent disconnected while starting.");
      }
      setSafeStatus("running");
      setSafeError(null);
    } catch (startError) {
      const message =
        startError instanceof Error
          ? startError.message
          : "Failed to start voice agent.";
      pendingRemoteTrackRef.current = null;
      closeRuntimeState(runtime);
      runtimeRef.current = createRuntimeState();
      setSafeError(message);
      setSafeStatus("error");
    }
  }, [
    buildSessionInstructions,
    handleRealtimeToolCall,
    isAdmin,
    isJoined,
    model,
    producePendingTrack,
    rebuildOpenAiMix,
    roomId,
    setSafeError,
    setSafeStatus,
    status,
    voice,
  ]);

  const clearError = useCallback(() => {
    setSafeError(null);
    if (status === "error") {
      setSafeStatus("idle");
    }
  }, [setSafeError, setSafeStatus, status]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingRemoteTrackRef.current = null;
      lastHeldSpeakerRef.current = null;
      const runtime = runtimeRef.current;
      runtimeRef.current = createRuntimeState();
      closeRuntimeState(runtime);
    };
  }, []);

  useEffect(() => {
    if (status === "idle") return;
    if (!isJoined) {
      stop();
    }
  }, [isJoined, status, stop]);

  useEffect(() => {
    if (status !== "starting" && status !== "running") return;
    const runtime = runtimeRef.current;
    if (!runtime.openAiMixContext || !runtime.openAiMixDestination) return;
    void rebuildOpenAiMix(runtime).catch((mixError) => {
      const message =
        mixError instanceof Error
          ? mixError.message
          : "Failed to refresh voice agent audio input.";
      setSafeError(message);
      setSafeStatus("error");
    });
  }, [rebuildOpenAiMix, setSafeError, setSafeStatus, status]);

  return {
    status,
    isStarting: status === "starting",
    isRunning: status === "running",
    error,
    start,
    stop,
    clearError,
  };
}
