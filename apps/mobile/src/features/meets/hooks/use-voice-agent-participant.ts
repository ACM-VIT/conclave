import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type {
  Device as MediasoupDevice,
  Producer,
  Transport,
} from "mediasoup-client/types";
import type {
  DtlsParameters,
  JoinRoomResponse,
  Participant,
  RtpParameters,
  TransportResponse,
} from "../types";
import { OPUS_MAX_AVERAGE_BITRATE } from "../constants";
import { ensureWebRTCGlobals } from "@/lib/webrtc";

type VoiceAgentStatus = "idle" | "starting" | "running" | "error";

type JoinInfo = {
  token?: string;
  sfuUrl?: string;
  iceServers?: RTCIceServer[];
  error?: string;
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

type AudioContextCtor = new (
  contextOptions?: AudioContextOptions
) => AudioContext;

type RuntimeState = {
  openAiPc: RTCPeerConnection | null;
  openAiDataChannel: RTCDataChannel | null;
  openAiMicStream: MediaStream | null;
  shouldStopMicTracks: boolean;
  openAiMixContext: AudioContext | null;
  openAiMixDestination: MediaStreamAudioDestinationNode | null;
  openAiMixSources: MediaStreamAudioSourceNode[];
  sfuSocket: Socket | null;
  producerTransport: Transport | null;
  producer: Producer | null;
};

type UseVoiceAgentParticipantOptions = {
  roomId: string;
  isJoined: boolean;
  isAdmin: boolean;
  isMuted: boolean;
  localStream: MediaStream | null;
  participants: Map<string, Participant>;
  instructions?: string;
  model?: string;
  voice?: string;
};

const DEFAULT_MODEL = "gpt-realtime";
const DEFAULT_VOICE = "marin";
const DEFAULT_INSTRUCTIONS =
  "You are a concise, helpful voice assistant in a live meeting. Keep responses short and practical.";
const AGENT_DISPLAY_NAME = "Voice Agent";
const SOCKET_CONNECT_TIMEOUT_MS = 8000;
const SFU_CLIENT_ID = process.env.EXPO_PUBLIC_SFU_CLIENT_ID || "public";
const SFU_BASE_URL =
  process.env.EXPO_PUBLIC_SFU_BASE_URL || process.env.EXPO_PUBLIC_API_URL || "";
const TURN_URL_PATTERN = /^turns?:/i;

const normalizeIceServerUrls = (
  urls: RTCIceServer["urls"] | undefined
): string[] => {
  if (!urls) return [];
  return (Array.isArray(urls) ? urls : [urls])
    .map((value) => value.trim())
    .filter(Boolean);
};

const buildIceServerWithUrls = (
  iceServer: RTCIceServer,
  urls: string[]
): RTCIceServer => ({
  ...iceServer,
  urls: urls.length === 1 ? urls[0] : urls,
});

const splitIceServersByType = (
  iceServers: RTCIceServer[] | null | undefined
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

const createRuntimeState = (): RuntimeState => ({
  openAiPc: null,
  openAiDataChannel: null,
  openAiMicStream: null,
  shouldStopMicTracks: false,
  openAiMixContext: null,
  openAiMixDestination: null,
  openAiMixSources: [],
  sfuSocket: null,
  producerTransport: null,
  producer: null,
});

const buildApiUrl = (path: string) => {
  if (!SFU_BASE_URL) return path;
  return `${SFU_BASE_URL.replace(/\/$/, "")}${path}`;
};

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
  if (runtime.shouldStopMicTracks && runtime.openAiMicStream) {
    runtime.openAiMicStream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {}
    });
  }
};

const getAudioContextCtor = (): AudioContextCtor | null => {
  const nativeCtor = globalThis.AudioContext as AudioContextCtor | undefined;
  if (nativeCtor) return nativeCtor;
  const webkitCtor = (
    globalThis as typeof globalThis & {
      webkitAudioContext?: AudioContextCtor;
    }
  ).webkitAudioContext;
  return webkitCtor ?? null;
};

const hasLiveAudioTrack = (stream: MediaStream | null): boolean =>
  Boolean(
    stream?.getAudioTracks().some((track) => track.readyState !== "ended"),
  );

const getPrimaryLiveAudioTrack = (
  stream: MediaStream | null
): MediaStreamTrack | null => {
  if (!stream) return null;
  const track = stream
    .getAudioTracks()
    .find((candidate) => candidate.readyState === "live");
  return track ?? null;
};

const isVoiceAgentUserId = (userId: string): boolean => {
  const normalized = userId.toLowerCase();
  return (
    normalized.includes("@agent.conclave") ||
    normalized.startsWith("voice-agent-")
  );
};

const buildRandomId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const createSocketConnection = async (
  sfuUrl: string,
  token: string
): Promise<Socket> => {
  const { io } = await import("socket.io-client");
  const socket = io(sfuUrl, {
    transports: ["websocket", "polling"],
    timeout: SOCKET_CONNECT_TIMEOUT_MS,
    reconnection: false,
    auth: { token },
  });

  return new Promise<Socket>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      socket.disconnect();
      reject(new Error("Voice agent socket connect timeout."));
    }, SOCKET_CONNECT_TIMEOUT_MS);

    const onConnect = () => {
      clearTimeout(timeoutId);
      socket.off("connect_error", onConnectError);
      resolve(socket);
    };

    const onConnectError = (error: Error) => {
      clearTimeout(timeoutId);
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
  sessionId: string
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
      }
    );
  });
};

const createProducerTransport = async (
  socket: Socket,
  device: MediasoupDevice,
  iceServers?: RTCIceServer[]
): Promise<Transport> => {
  const transportResponse = await new Promise<TransportResponse>(
    (resolve, reject) => {
      socket.emit(
        "createProducerTransport",
        (response: TransportResponse | { error: string }) => {
          if ("error" in response) {
            reject(new Error(response.error));
            return;
          }
          resolve(response);
        }
      );
    }
  );

  const transport = device.createSendTransport({
    ...transportResponse,
    iceServers,
  });

  transport.on(
    "connect",
    (
      { dtlsParameters }: { dtlsParameters: DtlsParameters },
      callback: () => void,
      errback: (error: Error) => void
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
        }
      );
    }
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
      errback: (error: Error) => void
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
        }
      );
    }
  );

  return transport;
};

export function useVoiceAgentParticipant({
  roomId,
  isJoined,
  isAdmin,
  isMuted,
  localStream,
  participants,
  instructions = DEFAULT_INSTRUCTIONS,
  model = DEFAULT_MODEL,
  voice = DEFAULT_VOICE,
}: UseVoiceAgentParticipantOptions) {
  const runtimeRef = useRef<RuntimeState>(createRuntimeState());
  const pendingRemoteTrackRef = useRef<MediaStreamTrack | null>(null);
  const mountedRef = useRef(true);

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

  const stop = useCallback(() => {
    pendingRemoteTrackRef.current = null;
    const runtime = runtimeRef.current;
    runtimeRef.current = createRuntimeState();
    closeRuntimeState(runtime);
    setSafeError(null);
    setSafeStatus("idle");
  }, [setSafeError, setSafeStatus]);

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

      if (!isMuted) {
        connectStream(localStream);
      }

      for (const participant of participants.values()) {
        if (participant.isMuted) continue;
        if (isVoiceAgentUserId(participant.userId)) continue;
        connectStream(participant.audioStream);
        connectStream(participant.screenShareAudioStream);
      }

      if (context.state === "suspended") {
        await context.resume().catch(() => undefined);
      }
    },
    [isMuted, localStream, participants]
  );

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

  const start = useCallback(
    async (providedApiKey?: string) => {
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
      if (!SFU_BASE_URL) {
        setSafeError("Missing EXPO_PUBLIC_SFU_BASE_URL for mobile.");
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
        ensureWebRTCGlobals();
        const AudioContextCtor = getAudioContextCtor();
        if (AudioContextCtor) {
          runtime.openAiMixContext = new AudioContextCtor({
            latencyHint: "interactive",
          });
          runtime.openAiMixDestination =
            runtime.openAiMixContext.createMediaStreamDestination();
          runtime.openAiMicStream = runtime.openAiMixDestination.stream;
          runtime.shouldStopMicTracks = true;
          await rebuildOpenAiMix(runtime);
        } else {
          // RN fallback path: use exactly one local audio track.
          // Adding multiple remote/consumer tracks can fail with "transceiver could not be added".
          const fallbackTrack = getPrimaryLiveAudioTrack(localStream);
          if (!fallbackTrack) {
            throw new Error(
              "Audio mixing is unavailable on this device. Turn your mic on and try again."
            );
          }
          const fallbackStream = new MediaStream([fallbackTrack]);
          runtime.openAiMicStream = fallbackStream;
          runtime.shouldStopMicTracks = false;
        }

        const sessionPayload = {
          session: {
            type: "realtime" as const,
            model,
            instructions,
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
          }
        );

        const clientSecretBody = (await clientSecretResponse
          .json()
          .catch(() => null)) as RealtimeClientSecretResponse | null;

        const clientSecret =
          clientSecretBody?.client_secret?.value?.trim() ||
          clientSecretBody?.value?.trim() ||
          "";
        if (!clientSecretResponse.ok || !clientSecret) {
          throw new Error(
            clientSecretBody?.error?.message ??
              "Failed to create voice agent session secret."
          );
        }

        runtime.openAiPc = new RTCPeerConnection();
        runtime.openAiDataChannel = runtime.openAiPc.createDataChannel("oai-events");
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

        const micTracks = runtime.openAiMicStream?.getAudioTracks() ?? [];
        if (micTracks.length === 0) {
          throw new Error(
            "No available meeting audio track for the voice agent input."
          );
        }
        for (const track of micTracks) {
          try {
            runtime.openAiPc.addTrack(track, runtime.openAiMicStream as MediaStream);
          } catch {
            throw new Error(
              "Failed to attach audio input to Realtime. Try restarting the voice agent."
            );
          }
        }

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
            `Realtime call failed (${sdpResponse.status}): ${reason || "Unknown error"}`
          );
        }

        const answerSdp = await sdpResponse.text();
        await runtime.openAiPc.setRemoteDescription({
          type: "answer",
          sdp: answerSdp,
        });

        const agentSessionId = buildRandomId("agent-session");
        const agentUserId = buildRandomId("voice-agent");
        const joinInfoResponse = await fetch(buildApiUrl("/api/sfu/join"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-sfu-client": SFU_CLIENT_ID,
          },
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

        const joinInfo = (await joinInfoResponse
          .json()
          .catch(() => null)) as JoinInfo | null;
        const token = joinInfo?.token?.trim();
        const sfuUrl = joinInfo?.sfuUrl?.trim();
        if (!joinInfoResponse.ok || !token || !sfuUrl) {
          throw new Error(
            joinInfo?.error ?? "Failed to create SFU token for voice agent."
          );
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
          agentSessionId
        );

        const { Device } = await import("mediasoup-client");
        const device = new Device();
        await device.load({
          routerRtpCapabilities: joinRoomResponse.rtpCapabilities,
        });

        const { stunIceServers, turnIceServers } = splitIceServersByType(
          Array.isArray(joinInfo?.iceServers) ? joinInfo.iceServers : undefined
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
            stunOnlyIceServers
          );
        } catch (stunTransportError) {
          if (!turnFallbackIceServers) {
            throw stunTransportError;
          }
          console.warn(
            "[Voice Agent] STUN-only transport failed. Retrying with TURN fallback.",
            stunTransportError
          );
          runtime.producerTransport = await createProducerTransport(
            runtime.sfuSocket,
            device,
            turnFallbackIceServers
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
          startError instanceof Error ? startError.message : "Failed to start voice agent.";
        pendingRemoteTrackRef.current = null;
        closeRuntimeState(runtime);
        runtimeRef.current = createRuntimeState();
        setSafeError(message);
        setSafeStatus("error");
      }
    },
    [
      instructions,
      isAdmin,
      isJoined,
      localStream,
      model,
      producePendingTrack,
      rebuildOpenAiMix,
      roomId,
      setSafeError,
      setSafeStatus,
      status,
      voice,
    ]
  );

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
