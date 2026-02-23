"use client";

import { useCallback, useEffect, useRef } from "react";
import type { Socket } from "socket.io-client";
import type { Device } from "mediasoup-client";
import {
  MAX_RECONNECT_ATTEMPTS,
  MEETS_ICE_SERVERS,
  OPUS_MAX_AVERAGE_BITRATE,
  RECONNECT_DELAY_MS,
  SOCKET_TIMEOUT_MS,
  SOCKET_CONNECT_TIMEOUT_MS,
  TRANSPORT_DISCONNECT_GRACE_MS,
  PRODUCER_SYNC_INTERVAL_MS,
} from "../lib/constants";
import type {
  ChatMessage,
  ConnectionState,
  ConsumeResponse,
  HandRaisedNotification,
  HandRaisedSnapshot,
  JoinMode,
  JoinRoomResponse,
  MeetError,
  MeetingConfigSnapshot,
  MeetingUpdateRequest,
  ProducerInfo,
  ProducerType,
  ReactionNotification,
  ReactionPayload,
  DtlsParameters,
  RtpParameters,
  TransportResponse,
  RestartIceResponse,
  VideoQuality,
  WebinarConfigSnapshot,
  WebinarFeedChangedNotification,
  WebinarLinkResponse,
  ServerRestartNotification,
  WebinarUpdateRequest,
} from "../lib/types";
import type { ParticipantAction } from "../lib/participant-reducer";
import { createMeetError, isSystemUserId, normalizeDisplayName } from "../lib/utils";
import { normalizeChatMessage } from "../lib/chat-commands";
import {
  buildWebcamSimulcastEncodings,
  buildWebcamSingleLayerEncoding,
} from "../lib/video-encodings";
import type { MeetRefs } from "./useMeetRefs";

type JoinInfo = {
  token: string;
  sfuUrl: string;
  iceServers?: RTCIceServer[];
};

const DEFAULT_SERVER_RESTART_NOTICE =
  "Meeting server is restarting. You will be reconnected automatically.";

interface UseMeetSocketOptions {
  refs: MeetRefs;
  roomId: string;
  setRoomId: (roomId: string) => void;
  isAdmin: boolean;
  setIsAdmin: (value: boolean) => void;
  user?: { id?: string; email?: string | null; name?: string | null };
  userId: string;
  getJoinInfo: (
    roomId: string,
    sessionId: string,
    options?: {
      user?: { id?: string; email?: string | null; name?: string | null };
      isHost?: boolean;
      joinMode?: JoinMode;
    },
  ) => Promise<JoinInfo>;
  joinMode?: JoinMode;
  requestWebinarInviteCode?: () => Promise<string | null>;
  requestMeetingInviteCode?: () => Promise<string | null>;
  ghostEnabled: boolean;
  displayNameInput: string;
  localStream: MediaStream | null;
  setLocalStream: React.Dispatch<React.SetStateAction<MediaStream | null>>;
  dispatchParticipants: (action: ParticipantAction) => void;
  setDisplayNames: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  setPendingUsers: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  setConnectionState: (state: ConnectionState) => void;
  setMeetError: (error: MeetError | null) => void;
  setWaitingMessage: (message: string | null) => void;
  setHostUserId: (userId: string | null) => void;
  setServerRestartNotice: (notice: string | null) => void;
  setWebinarConfig: React.Dispatch<
    React.SetStateAction<WebinarConfigSnapshot | null>
  >;
  setWebinarRole: (role: "attendee" | "participant" | "host" | null) => void;
  setWebinarSpeakerUserId: (userId: string | null) => void;
  isMuted: boolean;
  setIsMuted: (value: boolean) => void;
  isCameraOff: boolean;
  setIsCameraOff: (value: boolean) => void;
  setIsScreenSharing: (value: boolean) => void;
  setIsHandRaised: (value: boolean) => void;
  setIsRoomLocked: (value: boolean) => void;
  setIsNoGuests: (value: boolean) => void;
  setIsChatLocked: (value: boolean) => void;
  setMeetingRequiresInviteCode: (value: boolean) => void;
  isTtsDisabled: boolean;
  setIsTtsDisabled: (value: boolean) => void;
  setIsDmEnabled: (value: boolean) => void;
  setActiveScreenShareId: (value: string | null) => void;
  setVideoQuality: (value: VideoQuality) => void;
  videoQualityRef: React.MutableRefObject<VideoQuality>;
  updateVideoQualityRef: React.MutableRefObject<
    (quality: VideoQuality) => Promise<void>
  >;
  requestMediaPermissions: () => Promise<MediaStream | null>;
  stopLocalTrack: (track?: MediaStreamTrack | null) => void;
  handleLocalTrackEnded: (
    kind: "audio" | "video",
    track: MediaStreamTrack,
  ) => void;
  playNotificationSound: (type: "join" | "leave" | "waiting") => void;
  primeAudioOutput: () => void;
  addReaction: (reaction: ReactionPayload) => void;
  clearReactions: () => void;
  chat: {
    setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
    setChatOverlayMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
    setUnreadCount: React.Dispatch<React.SetStateAction<number>>;
    isChatOpenRef: React.MutableRefObject<boolean>;
  };
  onTtsMessage?: (payload: {
    userId: string;
    displayName: string;
    text: string;
  }) => void;
  prewarm?: {
    Device: typeof import("mediasoup-client").Device | null;
    io: typeof import("socket.io-client").io | null;
    isReady: boolean;
    getCachedToken?: (roomId: string) => JoinInfo | null;
  };
  onSocketReady?: (socket: Socket | null) => void;
  bypassMediaPermissions?: boolean;
}

export function useMeetSocket({
  refs,
  roomId,
  setRoomId,
  isAdmin,
  setIsAdmin,
  user,
  userId,
  getJoinInfo,
  joinMode = "meeting",
  requestWebinarInviteCode,
  requestMeetingInviteCode,
  ghostEnabled,
  displayNameInput,
  localStream,
  setLocalStream,
  dispatchParticipants,
  setDisplayNames,
  setPendingUsers,
  setConnectionState,
  setMeetError,
  setWaitingMessage,
  setHostUserId,
  setServerRestartNotice,
  setWebinarConfig,
  setWebinarRole,
  setWebinarSpeakerUserId,
  isMuted,
  setIsMuted,
  isCameraOff,
  setIsCameraOff,
  setIsScreenSharing,
  setIsHandRaised,
  setIsRoomLocked,
  setIsNoGuests,
  setIsChatLocked,
  setMeetingRequiresInviteCode,
  isTtsDisabled,
  setIsTtsDisabled,
  setIsDmEnabled,
  setActiveScreenShareId,
  setVideoQuality,
  videoQualityRef,
  updateVideoQualityRef,
  requestMediaPermissions,
  stopLocalTrack,
  handleLocalTrackEnded,
  playNotificationSound,
  primeAudioOutput,
  addReaction,
  clearReactions,
  chat,
  onTtsMessage,
  prewarm,
  onSocketReady,
  bypassMediaPermissions = false,
}: UseMeetSocketOptions) {
  const participantIdsRef = useRef<Set<string>>(new Set([userId]));
  const serverRoomIdRef = useRef<string | null>(null);
  const runtimeIceServersRef = useRef<RTCIceServer[] | null>(null);
  const consumeRetryAttemptsRef = useRef<Map<string, number>>(new Map());
  const consumeProducerRef = useRef<
    (producerInfo: ProducerInfo) => Promise<void>
  >(async () => {});

  const {
    socketRef,
    deviceRef,
    producerTransportRef,
    consumerTransportRef,
    audioProducerRef,
    videoProducerRef,
    screenProducerRef,
    consumersRef,
    producerMapRef,
    pendingProducersRef,
    leaveTimeoutsRef,
    reconnectAttemptsRef,
    reconnectInFlightRef,
    intentionalDisconnectRef,
    currentRoomIdRef,
    handleRedirectRef,
    handleReconnectRef,
    shouldAutoJoinRef,
    joinOptionsRef,
    localStreamRef,
    sessionIdRef,
    producerTransportDisconnectTimeoutRef,
    consumerTransportDisconnectTimeoutRef,
    pendingProducerRetryTimeoutRef,
    iceRestartInFlightRef,
    producerSyncIntervalRef,
  } = refs;

  useEffect(() => {
    participantIdsRef.current = new Set([userId]);
  }, [userId]);

  const shouldPlayJoinLeaveSound = useCallback(
    (type: "join" | "leave", targetUserId: string) => {
      if (isSystemUserId(targetUserId)) return false;
      const participantIds = participantIdsRef.current;
      if (type === "join") {
        if (participantIds.has(targetUserId)) return false;
        participantIds.add(targetUserId);
        return true;
      }
      if (!participantIds.has(targetUserId)) return false;
      participantIds.delete(targetUserId);
      return true;
    },
    [],
  );
  const isTtsDisabledRef = useRef(isTtsDisabled);
  useEffect(() => {
    isTtsDisabledRef.current = isTtsDisabled;
  }, [isTtsDisabled]);

  const resolveIceServers = useCallback((): RTCIceServer[] | undefined => {
    const runtimeIceServers = runtimeIceServersRef.current;
    if (runtimeIceServers && runtimeIceServers.length > 0) {
      return runtimeIceServers;
    }
    return MEETS_ICE_SERVERS.length > 0 ? MEETS_ICE_SERVERS : undefined;
  }, []);

  const cleanupRoomResources = useCallback(
    (options?: { resetRoomId?: boolean }) => {
      const resetRoomId = options?.resetRoomId !== false;
      console.log("[Meets] Cleaning up room resources...");
      if (producerSyncIntervalRef.current) {
        window.clearInterval(producerSyncIntervalRef.current);
        producerSyncIntervalRef.current = null;
      }
      if (pendingProducerRetryTimeoutRef.current) {
        window.clearTimeout(pendingProducerRetryTimeoutRef.current);
        pendingProducerRetryTimeoutRef.current = null;
      }

      consumersRef.current.forEach((consumer) => {
        try {
          consumer.close();
        } catch {}
      });
      consumersRef.current.clear();
      producerMapRef.current.clear();
      pendingProducersRef.current.clear();
      consumeRetryAttemptsRef.current.clear();
      leaveTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      leaveTimeoutsRef.current.clear();
      clearReactions();
      setPendingUsers(new Map());
      setDisplayNames(new Map());
      setHostUserId(null);
      setWebinarRole(null);
      setWebinarSpeakerUserId(null);
      participantIdsRef.current = new Set([userId]);
      serverRoomIdRef.current = null;

      try {
        audioProducerRef.current?.close();
      } catch {}
      try {
        videoProducerRef.current?.close();
      } catch {}
      try {
        screenProducerRef.current?.close();
      } catch {}
      audioProducerRef.current = null;
      videoProducerRef.current = null;
      screenProducerRef.current = null;

      try {
        producerTransportRef.current?.close();
      } catch {}
      try {
        consumerTransportRef.current?.close();
      } catch {}
      producerTransportRef.current = null;
      consumerTransportRef.current = null;
      if (producerTransportDisconnectTimeoutRef.current) {
        window.clearTimeout(producerTransportDisconnectTimeoutRef.current);
        producerTransportDisconnectTimeoutRef.current = null;
      }
      if (consumerTransportDisconnectTimeoutRef.current) {
        window.clearTimeout(consumerTransportDisconnectTimeoutRef.current);
        consumerTransportDisconnectTimeoutRef.current = null;
      }

      dispatchParticipants({ type: "CLEAR_ALL" });
      setIsScreenSharing(false);
      setActiveScreenShareId(null);
      setIsHandRaised(false);
      setIsTtsDisabled(false);
      setIsDmEnabled(true);
      setMeetingRequiresInviteCode(false);
      setWebinarConfig(null);
      if (resetRoomId) {
        currentRoomIdRef.current = null;
      }
    },
    [
      audioProducerRef,
      consumerTransportRef,
      consumersRef,
      currentRoomIdRef,
      dispatchParticipants,
      leaveTimeoutsRef,
      pendingProducersRef,
      producerMapRef,
      producerTransportRef,
      serverRoomIdRef,
      screenProducerRef,
      setActiveScreenShareId,
      setDisplayNames,
      setIsHandRaised,
      setIsScreenSharing,
      setPendingUsers,
      setHostUserId,
      setWebinarRole,
      setWebinarSpeakerUserId,
      setIsTtsDisabled,
      setIsDmEnabled,
      setMeetingRequiresInviteCode,
      setWebinarConfig,
      clearReactions,
      videoProducerRef,
      userId,
      producerTransportDisconnectTimeoutRef,
      consumerTransportDisconnectTimeoutRef,
      pendingProducerRetryTimeoutRef,
      producerSyncIntervalRef,
      consumeRetryAttemptsRef,
    ],
  );

  const cleanup = useCallback(() => {
    console.log("[Meets] Running full cleanup...");

    intentionalDisconnectRef.current = true;
    cleanupRoomResources();
    if (producerSyncIntervalRef.current) {
      window.clearInterval(producerSyncIntervalRef.current);
      producerSyncIntervalRef.current = null;
    }

    localStream?.getTracks().forEach((track) => {
      stopLocalTrack(track);
    });

    socketRef.current?.disconnect();
    socketRef.current = null;
    onSocketReady?.(null);
    deviceRef.current = null;

    setConnectionState("disconnected");
    setLocalStream(null);
    setWaitingMessage(null);
    setServerRestartNotice(null);
    reconnectAttemptsRef.current = 0;
  }, [
    cleanupRoomResources,
    intentionalDisconnectRef,
    localStream,
    reconnectAttemptsRef,
    setConnectionState,
    setLocalStream,
    setServerRestartNotice,
    setWaitingMessage,
    socketRef,
    deviceRef,
    stopLocalTrack,
    producerSyncIntervalRef,
    onSocketReady,
  ]);

  const scheduleParticipantRemoval = useCallback(
    (leftUserId: string) => {
      const existingTimeout = leaveTimeoutsRef.current.get(leftUserId);
      if (existingTimeout) {
        window.clearTimeout(existingTimeout);
      }
      const timeoutId = window.setTimeout(() => {
        leaveTimeoutsRef.current.delete(leftUserId);
        dispatchParticipants({
          type: "REMOVE_PARTICIPANT",
          userId: leftUserId,
        });
      }, 200);
      leaveTimeoutsRef.current.set(leftUserId, timeoutId);
    },
    [dispatchParticipants, leaveTimeoutsRef],
  );

  const isRoomEvent = useCallback(
    (eventRoomId?: string) => {
      if (!eventRoomId) return true;
      if (!currentRoomIdRef.current && !serverRoomIdRef.current) return true;
      return (
        eventRoomId === currentRoomIdRef.current ||
        eventRoomId === serverRoomIdRef.current
      );
    },
    [currentRoomIdRef, serverRoomIdRef],
  );

  const handleProducerClosed = useCallback(
    (producerId: string) => {
      pendingProducersRef.current.delete(producerId);
      consumeRetryAttemptsRef.current.delete(producerId);
      const consumer = consumersRef.current.get(producerId);
      if (consumer) {
        try {
          if (consumer.track) {
            consumer.track.stop();
          }
          consumer.close();
        } catch {}
        consumersRef.current.delete(producerId);
      }

      const info = producerMapRef.current.get(producerId);
      if (info) {
        dispatchParticipants({
          type: "UPDATE_STREAM",
          userId: info.userId,
          kind: info.kind,
          streamType: info.type,
          stream: null,
          producerId: producerId,
        });

        if (info.kind === "video" && info.type === "webcam") {
          dispatchParticipants({
            type: "UPDATE_CAMERA_OFF",
            userId: info.userId,
            cameraOff: true,
          });
        } else if (info.kind === "audio" && info.type === "webcam") {
          dispatchParticipants({
            type: "UPDATE_MUTED",
            userId: info.userId,
            muted: true,
          });
        }

        if (info.type === "screen" && info.kind === "video") {
          setActiveScreenShareId(null);
        }

        producerMapRef.current.delete(producerId);
      }
    },
    [
      consumersRef,
      dispatchParticipants,
      pendingProducersRef,
      consumeRetryAttemptsRef,
      producerMapRef,
      setActiveScreenShareId,
    ],
  );

  const queueProducerConsumeRetry = useCallback(
    (producerInfo: ProducerInfo, delayMs = 300) => {
      const attemptCount =
        (consumeRetryAttemptsRef.current.get(producerInfo.producerId) ?? 0) + 1;
      if (attemptCount > 4) {
        pendingProducersRef.current.delete(producerInfo.producerId);
        consumeRetryAttemptsRef.current.delete(producerInfo.producerId);
        return;
      }

      consumeRetryAttemptsRef.current.set(producerInfo.producerId, attemptCount);
      pendingProducersRef.current.set(producerInfo.producerId, producerInfo);

      if (pendingProducerRetryTimeoutRef.current) return;

      pendingProducerRetryTimeoutRef.current = window.setTimeout(() => {
        pendingProducerRetryTimeoutRef.current = null;
        const pending = Array.from(pendingProducersRef.current.values());
        pendingProducersRef.current.clear();
        for (const pendingProducer of pending) {
          void consumeProducerRef.current(pendingProducer);
        }
      }, delayMs);
    },
    [
      consumeRetryAttemptsRef,
      pendingProducersRef,
      pendingProducerRetryTimeoutRef,
    ],
  );

  const attemptIceRestart = useCallback(
    async (transportKind: "producer" | "consumer"): Promise<boolean> => {
      const socket = socketRef.current;
      if (!socket || !socket.connected) return false;

      const transport =
        transportKind === "producer"
          ? producerTransportRef.current
          : consumerTransportRef.current;

      if (!transport) return false;

      const inFlight = iceRestartInFlightRef.current;
      if (inFlight[transportKind]) return false;
      inFlight[transportKind] = true;

      try {
        const response = await new Promise<RestartIceResponse>(
          (resolve, reject) => {
            socket.emit(
              "restartIce",
              { transport: transportKind },
              (res: RestartIceResponse | { error: string }) => {
                if ("error" in res) {
                  reject(new Error(res.error));
                } else {
                  resolve(res);
                }
              },
            );
          },
        );

        await transport.restartIce({ iceParameters: response.iceParameters });
        console.log(
          `[Meets] ${transportKind} transport ICE restart succeeded.`,
        );
        return true;
      } catch (err) {
        console.error(
          `[Meets] ${transportKind} transport ICE restart failed:`,
          err,
        );
        return false;
      } finally {
        inFlight[transportKind] = false;
      }
    },
    [
      socketRef,
      producerTransportRef,
      consumerTransportRef,
      iceRestartInFlightRef,
    ],
  );

  const createProducerTransport = useCallback(
    async (socket: Socket, device: Device): Promise<void> => {
      return new Promise((resolve, reject) => {
        socket.emit(
          "createProducerTransport",
          (response: TransportResponse | { error: string }) => {
            if ("error" in response) {
              reject(new Error(response.error));
              return;
            }

            const transport = device.createSendTransport({
              ...response,
              iceServers: resolveIceServers(),
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
                  (res: { success: boolean } | { error: string }) => {
                    if ("error" in res) errback(new Error(res.error));
                    else callback();
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
                  appData: unknown;
                },
                callback: (data: { id: string }) => void,
                errback: (error: Error) => void,
              ) => {
                socket.emit(
                  "produce",
                  { transportId: transport.id, kind, rtpParameters, appData },
                  (res: { producerId: string } | { error: string }) => {
                    if ("error" in res) errback(new Error(res.error));
                    else callback({ id: res.producerId });
                  },
                );
              },
            );

            transport.on("connectionstatechange", (state: string) => {
              console.log("[Meets] Producer transport state:", state);
              if (state === "connected") {
                if (producerTransportDisconnectTimeoutRef.current) {
                  window.clearTimeout(
                    producerTransportDisconnectTimeoutRef.current,
                  );
                  producerTransportDisconnectTimeoutRef.current = null;
                }
                return;
              }

              if (state === "disconnected") {
                if (
                  !intentionalDisconnectRef.current &&
                  !producerTransportDisconnectTimeoutRef.current
                ) {
                  producerTransportDisconnectTimeoutRef.current =
                    window.setTimeout(() => {
                      producerTransportDisconnectTimeoutRef.current = null;
                      if (
                        !intentionalDisconnectRef.current &&
                        transport.connectionState === "disconnected"
                      ) {
                        attemptIceRestart("producer").then((restarted) => {
                          if (!restarted) {
                            setMeetError({
                              code: "TRANSPORT_ERROR",
                              message: "Producer transport interrupted",
                              recoverable: true,
                            });
                            handleReconnectRef.current?.();
                          }
                        });
                      }
                    }, TRANSPORT_DISCONNECT_GRACE_MS);
                }
                return;
              }

              if (producerTransportDisconnectTimeoutRef.current) {
                window.clearTimeout(
                  producerTransportDisconnectTimeoutRef.current,
                );
                producerTransportDisconnectTimeoutRef.current = null;
              }

              if (state === "failed") {
                if (!intentionalDisconnectRef.current) {
                  attemptIceRestart("producer").then((restarted) => {
                    if (!restarted) {
                      setMeetError({
                        code: "TRANSPORT_ERROR",
                        message: "Producer transport failed",
                        recoverable: true,
                      });
                      handleReconnectRef.current?.();
                    }
                  });
                }
              } else if (state === "closed") {
                if (!intentionalDisconnectRef.current) {
                  setMeetError({
                    code: "TRANSPORT_ERROR",
                    message: "Producer transport closed",
                    recoverable: true,
                  });
                }
              }
            });

            producerTransportRef.current = transport;
            resolve();
          },
        );
      });
    },
    [
      producerTransportRef,
      setMeetError,
      handleReconnectRef,
      intentionalDisconnectRef,
      producerTransportDisconnectTimeoutRef,
      attemptIceRestart,
      resolveIceServers,
    ],
  );

  const createConsumerTransport = useCallback(
    async (socket: Socket, device: Device): Promise<void> => {
      return new Promise((resolve, reject) => {
        socket.emit(
          "createConsumerTransport",
          (response: TransportResponse | { error: string }) => {
            if ("error" in response) {
              reject(new Error(response.error));
              return;
            }

            const transport = device.createRecvTransport({
              ...response,
              iceServers: resolveIceServers(),
            });

            transport.on(
              "connect",
              (
                { dtlsParameters }: { dtlsParameters: DtlsParameters },
                callback: () => void,
                errback: (error: Error) => void,
              ) => {
                socket.emit(
                  "connectConsumerTransport",
                  { transportId: transport.id, dtlsParameters },
                  (res: { success: boolean } | { error: string }) => {
                    if ("error" in res) errback(new Error(res.error));
                    else callback();
                  },
                );
              },
            );

            transport.on("connectionstatechange", (state: string) => {
              console.log("[Meets] Consumer transport state:", state);
              if (state === "connected") {
                if (consumerTransportDisconnectTimeoutRef.current) {
                  window.clearTimeout(
                    consumerTransportDisconnectTimeoutRef.current,
                  );
                  consumerTransportDisconnectTimeoutRef.current = null;
                }
                return;
              }

              if (state === "disconnected") {
                if (
                  !intentionalDisconnectRef.current &&
                  !consumerTransportDisconnectTimeoutRef.current
                ) {
                  consumerTransportDisconnectTimeoutRef.current =
                    window.setTimeout(() => {
                      consumerTransportDisconnectTimeoutRef.current = null;
                      if (
                        !intentionalDisconnectRef.current &&
                        transport.connectionState === "disconnected"
                      ) {
                        attemptIceRestart("consumer").then((restarted) => {
                          if (!restarted) {
                            handleReconnectRef.current?.();
                          }
                        });
                      }
                    }, TRANSPORT_DISCONNECT_GRACE_MS);
                }
                return;
              }

              if (consumerTransportDisconnectTimeoutRef.current) {
                window.clearTimeout(
                  consumerTransportDisconnectTimeoutRef.current,
                );
                consumerTransportDisconnectTimeoutRef.current = null;
              }

              if (state === "failed") {
                if (!intentionalDisconnectRef.current) {
                  attemptIceRestart("consumer").then((restarted) => {
                    if (!restarted) {
                      handleReconnectRef.current?.();
                    }
                  });
                }
              }
            });

            consumerTransportRef.current = transport;
            resolve();
          },
        );
      });
    },
    [
      consumerTransportRef,
      handleReconnectRef,
      intentionalDisconnectRef,
      consumerTransportDisconnectTimeoutRef,
      attemptIceRestart,
      resolveIceServers,
    ],
  );

  const produce = useCallback(
    async (stream: MediaStream): Promise<void> => {
      const transport = producerTransportRef.current;
      if (!transport) return;

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        try {
          const audioProducer = await transport.produce({
            track: audioTrack,
            codecOptions: {
              opusStereo: true,
              opusFec: true,
              opusDtx: true,
              opusMaxAverageBitrate: OPUS_MAX_AVERAGE_BITRATE,
            },
            appData: { type: "webcam" as ProducerType, paused: isMuted },
          });

          if (isMuted) {
            audioProducer.pause();
          }

          audioProducerRef.current = audioProducer;
          const audioProducerId = audioProducer.id;

          audioProducer.on("transportclose", () => {
            if (audioProducerRef.current?.id === audioProducerId) {
              audioProducerRef.current = null;
            }
          });
        } catch (err) {
          console.error("[Meets] Failed to produce audio:", err);
        }
      }

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        try {
          const quality = videoQualityRef.current;
          let videoProducer;
          try {
            videoProducer = await transport.produce({
              track: videoTrack,
              encodings: buildWebcamSimulcastEncodings(quality),
              appData: { type: "webcam" as ProducerType, paused: isCameraOff },
            });
          } catch (simulcastError) {
            console.warn(
              "[Meets] Simulcast video produce failed, retrying single-layer:",
              simulcastError,
            );
            videoProducer = await transport.produce({
              track: videoTrack,
              encodings: [buildWebcamSingleLayerEncoding(quality)],
              appData: { type: "webcam" as ProducerType, paused: isCameraOff },
            });
          }

          if (isCameraOff) {
            videoProducer.pause();
          }

          videoProducerRef.current = videoProducer;
          const videoProducerId = videoProducer.id;

          videoProducer.on("transportclose", () => {
            if (videoProducerRef.current?.id === videoProducerId) {
              videoProducerRef.current = null;
            }
          });
        } catch (err) {
          console.error("[Meets] Failed to produce video:", err);
        }
      }
    },
    [
      producerTransportRef,
      audioProducerRef,
      videoProducerRef,
      isMuted,
      isCameraOff,
      videoQualityRef,
    ],
  );

  const consumeProducer = useCallback(
    async (producerInfo: ProducerInfo): Promise<void> => {
      if (producerInfo.producerUserId === userId) {
        return;
      }
      if (consumersRef.current.has(producerInfo.producerId)) {
        consumeRetryAttemptsRef.current.delete(producerInfo.producerId);
        return;
      }

      const socket = socketRef.current;
      const device = deviceRef.current;
      const transport = consumerTransportRef.current;

      if (!socket || !device || !transport) {
        queueProducerConsumeRetry(producerInfo, 300);
        return;
      }

      return new Promise((resolve) => {
        socket.emit(
          "consume",
          {
            producerId: producerInfo.producerId,
            rtpCapabilities: device.rtpCapabilities,
          },
          async (response: ConsumeResponse | { error: string }) => {
            if ("error" in response) {
              console.error("[Meets] Consume error:", response.error);
              queueProducerConsumeRetry(producerInfo, 300);
              resolve();
              return;
            }

            try {
              const consumer = await transport.consume({
                id: response.id,
                producerId: response.producerId,
                kind: response.kind,
                rtpParameters: response.rtpParameters,
              });
              if (
                joinMode === "webinar_attendee" &&
                response.kind === "video" &&
                producerInfo.type === "webcam"
              ) {
                try {
                  const layerConsumer = consumer as typeof consumer & {
                    setPreferredLayers?: (layers: {
                      spatialLayer: number;
                      temporalLayer?: number;
                    }) => Promise<void>;
                  };
                  await layerConsumer.setPreferredLayers?.({
                    spatialLayer: 0,
                    temporalLayer: 1,
                  });
                } catch {
                  // Simulcast layers may be unavailable in some browser/device paths.
                }
              }

              consumersRef.current.set(producerInfo.producerId, consumer);
              consumeRetryAttemptsRef.current.delete(producerInfo.producerId);
              producerMapRef.current.set(producerInfo.producerId, {
                userId: producerInfo.producerUserId,
                kind: response.kind,
                type: producerInfo.type,
              });

              const updateMutedState = (muted: boolean) => {
                dispatchParticipants({
                  type: "UPDATE_MUTED",
                  userId: producerInfo.producerUserId,
                  muted,
                });
              };

              const updateCameraState = (cameraOff: boolean) => {
                if (producerInfo.type !== "webcam") return;
                dispatchParticipants({
                  type: "UPDATE_CAMERA_OFF",
                  userId: producerInfo.producerUserId,
                  cameraOff,
                });
              };

              const isWebcamAudio =
                response.kind === "audio" && producerInfo.type === "webcam";
              const isWebcamVideo =
                response.kind === "video" && producerInfo.type === "webcam";

              const handleTrackMuted = () => {
                if (isWebcamAudio) {
                  updateMutedState(true);
                } else if (isWebcamVideo) {
                  updateCameraState(true);
                }
              };

              const handleTrackUnmuted = () => {
                if (isWebcamAudio) {
                  updateMutedState(false);
                } else if (isWebcamVideo) {
                  updateCameraState(false);
                }
              };

              consumer.on("trackended", () => {
                handleProducerClosed(producerInfo.producerId);
              });
              consumer.track.onmute = handleTrackMuted;
              consumer.track.onunmute = handleTrackUnmuted;
              const stream = new MediaStream([consumer.track]);
              dispatchParticipants({
                type: "UPDATE_STREAM",
                userId: producerInfo.producerUserId,
                kind: response.kind,
                streamType: producerInfo.type,
                stream,
                producerId: producerInfo.producerId,
              });

              if (producerInfo.type === "screen" && response.kind === "video") {
                setActiveScreenShareId(producerInfo.producerId);
              }

              if (producerInfo.paused) {
                if (isWebcamAudio) {
                  updateMutedState(true);
                } else if (isWebcamVideo) {
                  updateCameraState(true);
                }
              }

              socket.emit(
                "resumeConsumer",
                { consumerId: consumer.id },
                () => {},
              );
              resolve();
            } catch (err) {
              console.error("[Meets] Failed to create consumer:", err);
              queueProducerConsumeRetry(producerInfo, 350);
              resolve();
            }
          },
        );
      });
    },
    [
      consumersRef,
      consumeRetryAttemptsRef,
      pendingProducersRef,
      socketRef,
      deviceRef,
      consumerTransportRef,
      producerMapRef,
      dispatchParticipants,
      handleProducerClosed,
      joinMode,
      queueProducerConsumeRetry,
      setActiveScreenShareId,
      userId,
    ],
  );
  consumeProducerRef.current = consumeProducer;

  const syncProducers = useCallback(async () => {
    const socket = socketRef.current;
    const device = deviceRef.current;
    if (!socket || !socket.connected || !device) return;
    if (!currentRoomIdRef.current) return;

    try {
      const producers = await new Promise<ProducerInfo[]>((resolve, reject) => {
        socket.emit(
          "getProducers",
          (response: { producers: ProducerInfo[] } | { error: string }) => {
            if ("error" in response) {
              reject(new Error(response.error));
            } else {
              resolve(response.producers || []);
            }
          },
        );
      });

      const serverProducerIds = new Set(
        producers.map((producer) => producer.producerId),
      );

      const staleConsumerIds: string[] = [];
      for (const [producerId, consumer] of consumersRef.current.entries()) {
        if (consumer.closed || consumer.track?.readyState === "ended") {
          staleConsumerIds.push(producerId);
        }
      }

      for (const producerId of staleConsumerIds) {
        handleProducerClosed(producerId);
      }

      for (const producerInfo of producers) {
        if (producerInfo.type !== "webcam") continue;
        if (producerInfo.kind === "audio") {
          dispatchParticipants({
            type: "UPDATE_MUTED",
            userId: producerInfo.producerUserId,
            muted: Boolean(producerInfo.paused),
          });
        } else if (producerInfo.kind === "video") {
          dispatchParticipants({
            type: "UPDATE_CAMERA_OFF",
            userId: producerInfo.producerUserId,
            cameraOff: Boolean(producerInfo.paused),
          });
        }
      }

      for (const producerId of producerMapRef.current.keys()) {
        if (!serverProducerIds.has(producerId)) {
          handleProducerClosed(producerId);
        }
      }

      for (const producerInfo of producers) {
        const consumer = consumersRef.current.get(producerInfo.producerId);
        if (consumer) {
          if (!producerInfo.paused) {
            socket.emit(
              "resumeConsumer",
              { consumerId: consumer.id },
              () => {},
            );
          }
          continue;
        }
        if (pendingProducersRef.current.has(producerInfo.producerId)) continue;
      }

      const consumeTasks: Promise<void>[] = [];
      for (const producerInfo of producers) {
        if (consumersRef.current.has(producerInfo.producerId)) continue;
        if (pendingProducersRef.current.has(producerInfo.producerId)) continue;
        consumeTasks.push(consumeProducer(producerInfo));
      }
      if (consumeTasks.length > 0) {
        await Promise.all(consumeTasks);
      }
    } catch (err) {
      console.error("[Meets] Failed to sync producers:", err);
    }
  }, [
    socketRef,
    deviceRef,
    currentRoomIdRef,
    producerMapRef,
    consumersRef,
    pendingProducersRef,
    dispatchParticipants,
    consumeProducer,
    handleProducerClosed,
  ]);

  const applyWebinarFeedProducers = useCallback(
    async (producers: ProducerInfo[]) => {
      const serverProducerIds = new Set(
        producers.map((producer) => producer.producerId),
      );
      for (const producerId of producerMapRef.current.keys()) {
        if (!serverProducerIds.has(producerId)) {
          handleProducerClosed(producerId);
        }
      }
      await Promise.all(producers.map((producer) => consumeProducer(producer)));
    },
    [consumeProducer, handleProducerClosed, producerMapRef],
  );

  const startProducerSync = useCallback(() => {
    if (producerSyncIntervalRef.current) {
      window.clearInterval(producerSyncIntervalRef.current);
    }
    producerSyncIntervalRef.current = window.setInterval(() => {
      void syncProducers();
    }, PRODUCER_SYNC_INTERVAL_MS);
  }, [producerSyncIntervalRef, syncProducers]);

  const flushPendingProducers = useCallback(async () => {
    if (!pendingProducersRef.current.size) return;
    const pending = Array.from(pendingProducersRef.current.values());
    pendingProducersRef.current.clear();
    await Promise.all(
      pending.map((producerInfo) => consumeProducer(producerInfo)),
    );
  }, [pendingProducersRef, consumeProducer]);

  const joinRoomInternal = useCallback(
    async (
      targetRoomId: string,
      stream: MediaStream | null,
      joinOptions: {
        displayName?: string;
        isGhost: boolean;
        joinMode: JoinMode;
        webinarInviteCode?: string;
        meetingInviteCode?: string;
      },
    ): Promise<"joined" | "waiting"> => {
      const socket = socketRef.current;
      if (!socket) throw new Error("Socket not connected");

      setWaitingMessage(null);
      setConnectionState("joining");

      return new Promise<"joined" | "waiting">((resolve, reject) => {
        socket.emit(
          "joinRoom",
          {
            roomId: targetRoomId,
            sessionId: sessionIdRef.current,
            displayName: joinOptions.displayName,
            ghost: joinOptions.isGhost,
            webinarInviteCode: joinOptions.webinarInviteCode,
            meetingInviteCode: joinOptions.meetingInviteCode,
          },
          async (response: JoinRoomResponse | { error: string }) => {
            if ("error" in response) {
              reject(new Error(response.error));
              return;
            }

            if (response.status === "waiting") {
              setConnectionState("waiting");
              setHostUserId(response.hostUserId ?? null);
              setMeetingRequiresInviteCode(
                response.meetingRequiresInviteCode ?? false,
              );
              setWebinarRole(response.webinarRole ?? null);
              setWebinarSpeakerUserId(
                response.existingProducers?.[0]?.producerUserId ?? null,
              );
              setWebinarConfig((previous) => ({
                enabled: response.isWebinarEnabled ?? previous?.enabled ?? false,
                publicAccess: previous?.publicAccess ?? false,
                locked: response.webinarLocked ?? previous?.locked ?? false,
                maxAttendees:
                  response.webinarMaxAttendees ??
                  previous?.maxAttendees ??
                  500,
                attendeeCount:
                  response.webinarAttendeeCount ??
                  previous?.attendeeCount ??
                  0,
                requiresInviteCode:
                  response.webinarRequiresInviteCode ??
                  previous?.requiresInviteCode ??
                  false,
                linkSlug: previous?.linkSlug ?? null,
                feedMode: previous?.feedMode ?? "active-speaker",
              }));
              currentRoomIdRef.current = targetRoomId;
              serverRoomIdRef.current = response.roomId ?? targetRoomId;
              setIsTtsDisabled(response.isTtsDisabled ?? false);
              setIsDmEnabled(response.isDmEnabled ?? true);
              resolve("waiting");
              return;
            }

            try {
              const joinedTime = performance.now();
              console.log(
                "[Meets] Joined room, existing producers:",
                response.existingProducers,
              );
              currentRoomIdRef.current = targetRoomId;
              serverRoomIdRef.current = response.roomId ?? targetRoomId;
              setIsRoomLocked(response.isLocked ?? false);
              setMeetingRequiresInviteCode(
                response.meetingRequiresInviteCode ?? false,
              );
              setIsTtsDisabled(response.isTtsDisabled ?? false);
              setIsDmEnabled(response.isDmEnabled ?? true);
              setWebinarRole(response.webinarRole ?? null);
              setWebinarSpeakerUserId(
                response.existingProducers?.[0]?.producerUserId ?? null,
              );
              setWebinarConfig((previous) => ({
                enabled: response.isWebinarEnabled ?? previous?.enabled ?? false,
                publicAccess: previous?.publicAccess ?? false,
                locked: response.webinarLocked ?? previous?.locked ?? false,
                maxAttendees:
                  response.webinarMaxAttendees ??
                  previous?.maxAttendees ??
                  500,
                attendeeCount:
                  response.webinarAttendeeCount ??
                  previous?.attendeeCount ??
                  0,
                requiresInviteCode:
                  response.webinarRequiresInviteCode ??
                  previous?.requiresInviteCode ??
                  false,
                linkSlug: previous?.linkSlug ?? null,
                feedMode: previous?.feedMode ?? "active-speaker",
              }));

              // Use pre-warmed Device if available, otherwise dynamic import
              const DeviceClass = prewarm?.Device
                ? prewarm.Device
                : (await import("mediasoup-client")).Device;

              const device = new DeviceClass();
              await device.load({
                routerRtpCapabilities: response.rtpCapabilities,
              });
              deviceRef.current = device;
              console.log(
                `[Meets] Device loaded in ${(performance.now() - joinedTime).toFixed(0)}ms`,
              );

              const shouldProduce =
                !!stream &&
                !joinOptions.isGhost &&
                joinOptions.joinMode !== "webinar_attendee";

              await Promise.all([
                shouldProduce
                  ? createProducerTransport(socket, device)
                  : Promise.resolve(),
                createConsumerTransport(socket, device),
              ]);

              const producePromise =
                shouldProduce && stream ? produce(stream) : Promise.resolve();

              const consumePromises = response.existingProducers.map(
                (producer) => consumeProducer(producer),
              );

              await Promise.all([producePromise, ...consumePromises]);
              await flushPendingProducers();

              setConnectionState("joined");
              setHostUserId(response.hostUserId ?? null);
              startProducerSync();
              void syncProducers();
              playNotificationSound("join");
              resolve("joined");
            } catch (err) {
              reject(err);
            }
          },
        );
      });
    },
    [
      socketRef,
      sessionIdRef,
      setWaitingMessage,
      setConnectionState,
      setHostUserId,
      setMeetingRequiresInviteCode,
      setWebinarConfig,
      setWebinarRole,
      setWebinarSpeakerUserId,
      currentRoomIdRef,
      deviceRef,
      createProducerTransport,
      createConsumerTransport,
      produce,
      consumeProducer,
      flushPendingProducers,
      playNotificationSound,
      startProducerSync,
      syncProducers,
      setIsRoomLocked,
      setIsTtsDisabled,
      setIsDmEnabled,
    ],
  );

  const connectSocket = useCallback(
    (targetRoomId: string): Promise<Socket> => {
      return new Promise((resolve, reject) => {
        (async () => {
          try {
            if (socketRef.current?.connected) {
              resolve(socketRef.current);
              return;
            }

            setConnectionState("connecting");

            const roomIdForJoin =
              targetRoomId || currentRoomIdRef.current || "";
            if (!roomIdForJoin) {
              throw new Error("Missing room ID");
            }

            const joinStartTime = performance.now();

            const socketIoPromise = prewarm?.io
              ? Promise.resolve({ io: prewarm.io })
              : import("socket.io-client");

            const cachedToken = prewarm?.getCachedToken?.(roomIdForJoin);
            const tokenPromise = cachedToken
              ? Promise.resolve(cachedToken)
                : getJoinInfo(roomIdForJoin, sessionIdRef.current, {
                    user,
                    isHost: isAdmin,
                    joinMode,
                  });

            const [{ token, sfuUrl, iceServers }, { io }] = await Promise.all([
              tokenPromise,
              socketIoPromise,
            ]);

            if (Array.isArray(iceServers)) {
              runtimeIceServersRef.current =
                iceServers.length > 0 ? iceServers : null;
            }

            const socket = io(sfuUrl, {
              transports: ["websocket", "polling"],
              timeout: SOCKET_TIMEOUT_MS,
              reconnection: false,
              auth: { token },
            });

            const connectionTimeout = setTimeout(() => {
              socket.disconnect();
              reject(new Error("Connection timeout"));
            }, SOCKET_CONNECT_TIMEOUT_MS);

            socket.on("connect", () => {
              clearTimeout(connectionTimeout);
              console.log(
                `[Meets] Connected to SFU in ${(performance.now() - joinStartTime).toFixed(0)}ms`,
              );
              setConnectionState("connected");
              setMeetError(null);
              setServerRestartNotice(null);
              reconnectAttemptsRef.current = 0;
              intentionalDisconnectRef.current = false;
              resolve(socket);
            });

            socket.on("disconnect", (reason) => {
              console.log("[Meets] Disconnected:", reason);
              if (intentionalDisconnectRef.current) {
                setConnectionState("disconnected");
                return;
              }

              if (currentRoomIdRef.current) {
                handleReconnectRef.current();
              } else {
                setConnectionState("disconnected");
              }
            });

            socket.on("roomClosed", ({ reason }: { reason: string }) => {
              console.log("[Meets] Room closed:", reason);
              setMeetError({
                code: "UNKNOWN",
                message: `Room closed: ${reason}`,
                recoverable: false,
              });
              setWaitingMessage(null);
              cleanup();
            });

            socket.on("connect_error", (err) => {
              clearTimeout(connectionTimeout);
              console.error("[Meets] Connection error:", err);
              setMeetError(createMeetError(err, "CONNECTION_FAILED"));
              setConnectionState("error");
              reject(err);
            });

            socket.on(
              "hostAssigned",
              ({
                roomId: eventRoomId,
                hostUserId,
              }: {
                roomId?: string;
                hostUserId?: string | null;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setIsAdmin(true);
                setHostUserId(hostUserId ?? userId);
                setWaitingMessage(null);
              },
            );

            socket.on(
              "serverRestarting",
              (notification: ServerRestartNotification) => {
                if (!isRoomEvent(notification?.roomId)) return;
                const message = notification?.message?.trim();
                setServerRestartNotice(
                  message || DEFAULT_SERVER_RESTART_NOTICE,
                );
              },
            );

            socket.on(
              "hostChanged",
              ({
                roomId: eventRoomId,
                hostUserId,
              }: {
                roomId?: string;
                hostUserId?: string | null;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setHostUserId(hostUserId ?? null);
              },
            );

            socket.on("newProducer", async (data: ProducerInfo) => {
              console.log("[Meets] New producer:", data);
              if (data.producerUserId === userId) {
                return;
              }
              if (joinMode === "webinar_attendee") {
                void syncProducers();
                return;
              }
              await consumeProducer(data);
            });

            socket.on(
              "producerClosed",
              ({
                producerId,
                producerUserId,
              }: {
                producerId: string;
                producerUserId?: string;
              }) => {
                console.log("[Meets] Producer closed:", producerId);
                const localAudioProducer = audioProducerRef.current;
                const localVideoProducer = videoProducerRef.current;
                const localScreenProducer = screenProducerRef.current;
                const matchesLocalProducer =
                  localAudioProducer?.id === producerId ||
                  localVideoProducer?.id === producerId ||
                  localScreenProducer?.id === producerId;

                if (
                  producerUserId === userId ||
                  (producerUserId == null && matchesLocalProducer)
                ) {
                  if (localAudioProducer?.id === producerId) {
                    try {
                      localAudioProducer.close();
                    } catch {}
                    if (audioProducerRef.current?.id === producerId) {
                      audioProducerRef.current = null;
                    }
                    return;
                  }

                  if (localVideoProducer?.id === producerId) {
                    try {
                      localVideoProducer.close();
                    } catch {}
                    if (videoProducerRef.current?.id === producerId) {
                      videoProducerRef.current = null;
                    }
                    return;
                  }

                  if (localScreenProducer?.id === producerId) {
                    if (localScreenProducer.track) {
                      localScreenProducer.track.stop();
                    }
                    try {
                      localScreenProducer.close();
                    } catch {}
                    if (screenProducerRef.current?.id === producerId) {
                      screenProducerRef.current = null;
                    }
                    setIsScreenSharing(false);
                    setActiveScreenShareId(null);
                    return;
                  }
                }

                handleProducerClosed(producerId);
              },
            );

            socket.on(
              "userJoined",
              ({
                userId: joinedUserId,
                displayName,
                isGhost,
              }: {
                userId: string;
                displayName?: string;
                isGhost?: boolean;
              }) => {
                console.log("[Meets] User joined:", joinedUserId);
                if (joinedUserId === userId) {
                  return;
                }
                if (shouldPlayJoinLeaveSound("join", joinedUserId)) {
                  playNotificationSound("join");
                }
                if (displayName) {
                  setDisplayNames((prev) => {
                    const next = new Map(prev);
                    next.set(joinedUserId, displayName);
                    return next;
                  });
                }
                const leaveTimeout = leaveTimeoutsRef.current.get(joinedUserId);
                if (leaveTimeout) {
                  window.clearTimeout(leaveTimeout);
                  leaveTimeoutsRef.current.delete(joinedUserId);
                }
                dispatchParticipants({
                  type: "ADD_PARTICIPANT",
                  userId: joinedUserId,
                  isGhost,
                });
              },
            );

            socket.on(
              "userLeft",
              ({ userId: leftUserId }: { userId: string }) => {
                console.log("[Meets] User left:", leftUserId);
                if (
                  leftUserId !== userId &&
                  shouldPlayJoinLeaveSound("leave", leftUserId)
                ) {
                  playNotificationSound("leave");
                }
                setDisplayNames((prev) => {
                  if (!prev.has(leftUserId)) return prev;
                  const next = new Map(prev);
                  next.delete(leftUserId);
                  return next;
                });

                const producersToClose = Array.from(
                  producerMapRef.current.entries(),
                )
                  .filter(([, info]) => info.userId === leftUserId)
                  .map(([producerId]) => producerId);

                for (const [producerId, info] of pendingProducersRef.current) {
                  if (info.producerUserId === leftUserId) {
                    pendingProducersRef.current.delete(producerId);
                  }
                }

                for (const producerId of producersToClose) {
                  handleProducerClosed(producerId);
                }

                dispatchParticipants({
                  type: "MARK_LEAVING",
                  userId: leftUserId,
                });

                scheduleParticipantRemoval(leftUserId);
              },
            );

            socket.on(
              "displayNameSnapshot",
              ({
                users,
                roomId: eventRoomId,
              }: {
                users: { userId: string; displayName?: string }[];
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                const snapshot = new Map<string, string>();
                const nextParticipantIds = new Set<string>([userId]);
                (users || []).forEach(
                  ({ userId: snapshotUserId, displayName }) => {
                    if (displayName) {
                      snapshot.set(snapshotUserId, displayName);
                    }
                    if (snapshotUserId !== userId) {
                      if (!isSystemUserId(snapshotUserId)) {
                        nextParticipantIds.add(snapshotUserId);
                      }
                      const leaveTimeout =
                        leaveTimeoutsRef.current.get(snapshotUserId);
                      if (leaveTimeout) {
                        window.clearTimeout(leaveTimeout);
                        leaveTimeoutsRef.current.delete(snapshotUserId);
                      }
                      dispatchParticipants({
                        type: "ADD_PARTICIPANT",
                        userId: snapshotUserId,
                      });
                    }
                  },
                );
                participantIdsRef.current = nextParticipantIds;
                setDisplayNames(snapshot);
              },
            );

            socket.on(
              "handRaisedSnapshot",
              ({ users, roomId: eventRoomId }: HandRaisedSnapshot) => {
                if (!isRoomEvent(eventRoomId)) return;
                (users || []).forEach(({ userId: raisedUserId, raised }) => {
                  if (raisedUserId === userId) {
                    setIsHandRaised(raised);
                    return;
                  }
                  dispatchParticipants({
                    type: "UPDATE_HAND_RAISED",
                    userId: raisedUserId,
                    raised,
                  });
                });
              },
            );

            socket.on(
              "displayNameUpdated",
              ({
                userId: updatedUserId,
                displayName,
                roomId: eventRoomId,
              }: {
                userId: string;
                displayName: string;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setDisplayNames((prev) => {
                  const next = new Map(prev);
                  next.set(updatedUserId, displayName);
                  return next;
                });
              },
            );

            socket.on(
              "participantMuted",
              ({
                userId: mutedUserId,
                muted,
                roomId: eventRoomId,
              }: {
                userId: string;
                muted: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                dispatchParticipants({
                  type: "UPDATE_MUTED",
                  userId: mutedUserId,
                  muted,
                });
              },
            );

            socket.on(
              "participantCameraOff",
              ({
                userId: camUserId,
                cameraOff,
                roomId: eventRoomId,
              }: {
                userId: string;
                cameraOff: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                dispatchParticipants({
                  type: "UPDATE_CAMERA_OFF",
                  userId: camUserId,
                  cameraOff,
                });
              },
            );

            socket.on(
              "setVideoQuality",
              async ({ quality }: { quality: VideoQuality }) => {
                console.log(`[Meets] Setting video quality to: ${quality}`);
                videoQualityRef.current = quality;
                setVideoQuality(quality);
                await updateVideoQualityRef.current(quality);
              },
            );

            socket.on("chatMessage", (message: ChatMessage) => {
              console.log("[Meets] Chat message received:", message);
              const { message: normalized, ttsText } =
                normalizeChatMessage(message);
              chat.setChatMessages((prev) => [...prev, normalized]);
              if (normalized.userId !== userId) {
                chat.setChatOverlayMessages((prev) => [...prev, normalized]);
                setTimeout(() => {
                  chat.setChatOverlayMessages((prev) =>
                    prev.filter((m) => m.id !== normalized.id),
                  );
                }, 5000);
              }
              if (ttsText && !isTtsDisabledRef.current) {
                onTtsMessage?.({
                  userId: normalized.userId,
                  displayName: normalized.displayName,
                  text: ttsText,
                });
              }
              if (!chat.isChatOpenRef.current) {
                chat.setUnreadCount((prev) => prev + 1);
              }
            });

            socket.on("reaction", (reaction: ReactionNotification) => {
              if (reaction.kind && reaction.value) {
                addReaction({
                  userId: reaction.userId,
                  kind: reaction.kind,
                  value: reaction.value,
                  label: reaction.label,
                  timestamp: reaction.timestamp,
                });
                return;
              }

              if (reaction.emoji) {
                addReaction({
                  userId: reaction.userId,
                  kind: "emoji",
                  value: reaction.emoji,
                  timestamp: reaction.timestamp,
                });
              }
            });

            socket.on(
              "handRaised",
              ({ userId: raisedUserId, raised }: HandRaisedNotification) => {
                if (raisedUserId === userId) {
                  setIsHandRaised(raised);
                  return;
                }
                dispatchParticipants({
                  type: "UPDATE_HAND_RAISED",
                  userId: raisedUserId,
                  raised,
                });
              },
            );

            socket.on("kicked", () => {
              cleanup();
              setMeetError({
                code: "UNKNOWN",
                message: "You have been kicked from the meeting.",
                recoverable: false,
              });
            });

            socket.on(
              "redirect",
              async ({ newRoomId }: { newRoomId: string }) => {
                console.log(
                  `[Meets] Redirect received. Initiating full switch to ${newRoomId}`,
                );
                handleRedirectRef.current(newRoomId);
              },
            );

            socket.on(
              "userRequestedJoin",
              ({
                userId,
                displayName,
                roomId: eventRoomId,
              }: {
                userId: string;
                displayName: string;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                console.log("[Meets] User requesting to join:", userId);
                playNotificationSound("waiting");
                setPendingUsers((prev) => {
                  const newMap = new Map(prev);
                  newMap.set(userId, displayName);
                  return newMap;
                });
              },
            );

            socket.on(
              "pendingUsersSnapshot",
              ({
                users,
                roomId: eventRoomId,
              }: {
                users: { userId: string; displayName?: string }[];
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                const snapshot = new Map(
                  (users || []).map(({ userId, displayName }) => [
                    userId,
                    displayName || userId,
                  ]),
                );
                setPendingUsers(snapshot);
              },
            );

            socket.on(
              "userAdmitted",
              ({
                userId,
                roomId: eventRoomId,
              }: {
                userId: string;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setPendingUsers((prev) => {
                  const newMap = new Map(prev);
                  newMap.delete(userId);
                  return newMap;
                });
              },
            );

            socket.on(
              "userRejected",
              ({
                userId,
                roomId: eventRoomId,
              }: {
                userId: string;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setPendingUsers((prev) => {
                  const newMap = new Map(prev);
                  newMap.delete(userId);
                  return newMap;
                });
              },
            );

            socket.on(
              "pendingUserLeft",
              ({
                userId,
                roomId: eventRoomId,
              }: {
                userId: string;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setPendingUsers((prev) => {
                  const newMap = new Map(prev);
                  newMap.delete(userId);
                  return newMap;
                });
              },
            );

            socket.on("joinApproved", async () => {
              console.log("[Meets] Join approved! Re-attempting join...");
              const joinOptions = joinOptionsRef.current;
              let stream = localStreamRef.current;
              const shouldRequestMedia =
                !joinOptions.isGhost &&
                joinOptions.joinMode !== "webinar_attendee" &&
                !bypassMediaPermissions;

              if (!stream && shouldRequestMedia) {
                stream = await requestMediaPermissions();
                if (stream) {
                  localStreamRef.current = stream;
                  setLocalStream(stream);
                }
              }
              if (
                currentRoomIdRef.current &&
                (stream ||
                  joinOptions.isGhost ||
                  joinOptions.joinMode === "webinar_attendee" ||
                  bypassMediaPermissions)
              ) {
                joinRoomInternal(
                  currentRoomIdRef.current,
                  stream,
                  joinOptions,
                ).catch(console.error);
              } else {
                console.error(
                  "[Meets] Cannot re-join: missing room ID or local stream",
                  {
                    roomId: currentRoomIdRef.current,
                    hasStream: !!localStreamRef.current,
                    isGhost: joinOptionsRef.current.isGhost,
                    bypassMediaPermissions,
                  },
                );
              }
            });

            socket.on("joinRejected", () => {
              console.log("[Meets] Join rejected.");
              setMeetError({
                code: "PERMISSION_DENIED",
                message: "The host has denied your request to join.",
                recoverable: false,
              });
              setConnectionState("error");
              setWaitingMessage(null);
              cleanup();
            });

            socket.on(
              "waitingRoomStatus",
              ({
                message,
                roomId: eventRoomId,
              }: {
                message: string;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setWaitingMessage(message);
              },
            );

            socket.on(
              "roomLockChanged",
              ({
                locked,
                roomId: eventRoomId,
              }: {
                locked: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                console.log("[Meets] Room lock changed:", locked);
                setIsRoomLocked(locked);
              },
            );

            socket.on(
              "ttsDisabledChanged",
              ({
                disabled,
                roomId: eventRoomId,
              }: {
                disabled: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                console.log("[Meets] Room TTS disabled changed:", disabled);
                setIsTtsDisabled(disabled);
              },
            );

            socket.on(
              "dmStateChanged",
              ({
                enabled,
                roomId: eventRoomId,
              }: {
                enabled: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                console.log("[Meets] Room DM state changed:", enabled);
                setIsDmEnabled(enabled);
              },
            );

            socket.on(
              "noGuestsChanged",
              ({
                noGuests,
                roomId: eventRoomId,
              }: {
                noGuests: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                console.log("[Meets] No-guests changed:", noGuests);
                setIsNoGuests(noGuests);
              }
            );

            socket.on(
              "chatLockChanged",
              ({
                locked,
                roomId: eventRoomId,
              }: {
                locked: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                console.log("[Meets] Chat lock changed:", locked);
                setIsChatLocked(locked);
              }
            );

            socket.on(
              "meeting:configChanged",
              (nextConfig: MeetingConfigSnapshot) => {
                setMeetingRequiresInviteCode(
                  Boolean(nextConfig.requiresInviteCode),
                );
              },
            );

            socket.on(
              "webinar:configChanged",
              (nextConfig: WebinarConfigSnapshot) => {
                setWebinarConfig(nextConfig);
              },
            );

            socket.on(
              "webinar:attendeeCountChanged",
              ({
                attendeeCount,
                maxAttendees,
                roomId: eventRoomId,
              }: {
                attendeeCount: number;
                maxAttendees: number;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setWebinarConfig((previous) => ({
                  enabled: previous?.enabled ?? false,
                  publicAccess: previous?.publicAccess ?? false,
                  locked: previous?.locked ?? false,
                  maxAttendees: maxAttendees ?? previous?.maxAttendees ?? 500,
                  attendeeCount:
                    attendeeCount ?? previous?.attendeeCount ?? 0,
                  requiresInviteCode: previous?.requiresInviteCode ?? false,
                  linkSlug: previous?.linkSlug ?? null,
                  feedMode: previous?.feedMode ?? "active-speaker",
                }));
              },
            );

            socket.on(
              "webinar:feedChanged",
              (notification: WebinarFeedChangedNotification) => {
                if (joinMode !== "webinar_attendee") return;
                if (!isRoomEvent(notification.roomId)) return;
                setWebinarSpeakerUserId(
                  notification.speakerUserId ??
                    notification.producers?.[0]?.producerUserId ??
                    null,
                );
                void applyWebinarFeedProducers(notification.producers).finally(() => {
                  void syncProducers();
                });
              },
            );

            socketRef.current = socket;
            onSocketReady?.(socket);
          } catch (err) {
            console.error("Failed to get join info:", err);
            setMeetError({
              code: "CONNECTION_FAILED",
              message: "Authentication failed",
              recoverable: false,
            });
            setConnectionState("error");
            reject(err);
          }
        })();
      });
    },
    [
      addReaction,
      audioProducerRef,
      cleanup,
      consumeProducer,
      currentRoomIdRef,
      deviceRef,
      dispatchParticipants,
      handleLocalTrackEnded,
      handleProducerClosed,
      handleRedirectRef,
      handleReconnectRef,
      getJoinInfo,
      joinMode,
      isAdmin,
      setIsAdmin,
      isRoomEvent,
      joinOptionsRef,
      joinRoomInternal,
      leaveTimeoutsRef,
      localStream,
      localStreamRef,
      pendingProducersRef,
      playNotificationSound,
      shouldPlayJoinLeaveSound,
      applyWebinarFeedProducers,
      producerMapRef,
      reconnectAttemptsRef,
      screenProducerRef,
      setActiveScreenShareId,
      setConnectionState,
      setDisplayNames,
      setIsCameraOff,
      setIsMuted,
      setIsScreenSharing,
      setIsHandRaised,
      setIsRoomLocked,
      setMeetingRequiresInviteCode,
      setIsTtsDisabled,
      setIsDmEnabled,
      setHostUserId,
      setWebinarRole,
      setWebinarSpeakerUserId,
      setWebinarConfig,
      setServerRestartNotice,
      setLocalStream,
      setMeetError,
      setPendingUsers,
      setWaitingMessage,
      setVideoQuality,
      socketRef,
      stopLocalTrack,
      requestMediaPermissions,
      syncProducers,
      updateVideoQualityRef,
      user,
      userId,
      onTtsMessage,
      onSocketReady,
      bypassMediaPermissions,
    ],
  );

  const handleReconnect = useCallback(async () => {
    if (reconnectInFlightRef.current) return;
    reconnectInFlightRef.current = true;

    try {
      while (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
        setConnectionState("reconnecting");
        reconnectAttemptsRef.current++;
        const delay =
          RECONNECT_DELAY_MS * 2 ** (reconnectAttemptsRef.current - 1);

        console.log(
          `[Meets] Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})`,
        );
        await new Promise((r) => setTimeout(r, delay));

        try {
          const reconnectRoomId = currentRoomIdRef.current;
          cleanupRoomResources({ resetRoomId: false });
          socketRef.current?.disconnect();
          socketRef.current = null;
          onSocketReady?.(null);
          if (!reconnectRoomId) {
            throw new Error("Missing room ID for reconnect");
          }
          await connectSocket(reconnectRoomId);

          const joinOptions = joinOptionsRef.current;
          const stream = localStreamRef.current || localStream;
          if (
            reconnectRoomId &&
            (stream ||
              joinOptions.isGhost ||
              joinOptions.joinMode === "webinar_attendee" ||
              bypassMediaPermissions)
          ) {
            await joinRoomInternal(reconnectRoomId, stream, joinOptions);
          }
          return;
        } catch (_err) {
          // retry
        }
      }

      setMeetError({
        code: "CONNECTION_FAILED",
        message: "Failed to reconnect after multiple attempts",
        recoverable: false,
      });
      setConnectionState("error");
    } finally {
      reconnectInFlightRef.current = false;
    }
  }, [
    cleanupRoomResources,
    connectSocket,
    currentRoomIdRef,
    joinOptionsRef,
    joinRoomInternal,
    localStream,
    localStreamRef,
    reconnectAttemptsRef,
    reconnectInFlightRef,
    setConnectionState,
    setMeetError,
    socketRef,
    bypassMediaPermissions,
  ]);

  useEffect(() => {
    handleReconnectRef.current = handleReconnect;
  }, [handleReconnect, handleReconnectRef]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleOnline = () => {
      if (intentionalDisconnectRef.current) return;
      if (!currentRoomIdRef.current) return;

      const socket = socketRef.current;
      if (socket?.connected) {
        void syncProducers();
        return;
      }

      handleReconnectRef.current?.();
    };

    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("online", handleOnline);
    };
  }, [
    currentRoomIdRef,
    handleReconnectRef,
    intentionalDisconnectRef,
    socketRef,
    syncProducers,
  ]);

  const handleRedirectCallback = useCallback(
    async (newRoomId: string) => {
      console.log(`[Meets] Executing hard redirect to ${newRoomId}`);

      cleanup();
      setRoomId(newRoomId);
      shouldAutoJoinRef.current = true;
    },
    [cleanup, setRoomId, shouldAutoJoinRef],
  );

  useEffect(() => {
    handleRedirectRef.current = handleRedirectCallback;
  }, [handleRedirectCallback, handleRedirectRef]);

  const startJoin = useCallback(
    async (targetRoomId: string) => {
      if (refs.abortControllerRef.current?.signal.aborted) return;

      setMeetError(null);
      setConnectionState("connecting");
      primeAudioOutput();
      refs.intentionalDisconnectRef.current = false;
      serverRoomIdRef.current = null;
      setRoomId(targetRoomId);
      if (joinMode === "webinar_attendee") {
        setIsAdmin(false);
      }
      const normalizedDisplayName = normalizeDisplayName(displayNameInput);
      const joinOptions: {
        displayName?: string;
        isGhost: boolean;
        joinMode: JoinMode;
        webinarInviteCode?: string;
        meetingInviteCode?: string;
      } = {
        displayName: isAdmin ? normalizedDisplayName || undefined : undefined,
        isGhost: ghostEnabled,
        joinMode,
      };
      joinOptionsRef.current = joinOptions;
      const shouldRequestMedia =
        !joinOptions.isGhost &&
        joinOptions.joinMode !== "webinar_attendee" &&
        !bypassMediaPermissions;

      try {
        const [, stream] = await Promise.all([
          connectSocket(targetRoomId),
          shouldRequestMedia
            ? requestMediaPermissions()
            : Promise.resolve(null),
        ]);

        if (shouldRequestMedia && !stream) {
          setConnectionState("error");
          return;
        }

        localStreamRef.current = stream;
        setLocalStream(stream);

        try {
          await joinRoomInternal(targetRoomId, stream, joinOptions);
        } catch (joinError) {
          const joinMessage =
            joinError instanceof Error
              ? joinError.message
              : String(joinError ?? "");
          const isMeetingInviteCodeValidationError =
            /meeting invite code required/i.test(joinMessage) ||
            /invalid meeting invite code/i.test(joinMessage);
          const shouldPromptMeetingInviteCode =
            joinOptions.joinMode !== "webinar_attendee" &&
            !joinOptions.meetingInviteCode &&
            isMeetingInviteCodeValidationError &&
            typeof requestMeetingInviteCode === "function";

          const isWebinarInviteCodeValidationError =
            /webinar invite code required/i.test(joinMessage) ||
            /invalid webinar invite code/i.test(joinMessage);
          const shouldPromptWebinarInviteCode =
            joinOptions.joinMode === "webinar_attendee" &&
            !joinOptions.webinarInviteCode &&
            isWebinarInviteCodeValidationError &&
            typeof requestWebinarInviteCode === "function";

          if (!shouldPromptMeetingInviteCode && !shouldPromptWebinarInviteCode) {
            throw joinError;
          }

          const inviteCode = shouldPromptMeetingInviteCode
            ? await requestMeetingInviteCode!()
            : await requestWebinarInviteCode!();
          if (!inviteCode || !inviteCode.trim()) {
            throw joinError;
          }

          const retryJoinOptions = shouldPromptMeetingInviteCode
            ? {
                ...joinOptions,
                meetingInviteCode: inviteCode.trim(),
              }
            : {
                ...joinOptions,
                webinarInviteCode: inviteCode.trim(),
              };
          joinOptionsRef.current = retryJoinOptions;
          await joinRoomInternal(targetRoomId, stream, retryJoinOptions);
        }
      } catch (err) {
        console.error("[Meets] Error joining room:", err);
        const stream = localStreamRef.current;
        if (stream) {
          stream.getTracks().forEach((track) => stopLocalTrack(track));
          setLocalStream(null);
        }
        setMeetError(createMeetError(err));
        setConnectionState("error");
      }
    },
    [
      connectSocket,
      displayNameInput,
      ghostEnabled,
      joinMode,
      isAdmin,
      joinOptionsRef,
      joinRoomInternal,
      localStreamRef,
      primeAudioOutput,
      requestMediaPermissions,
      requestMeetingInviteCode,
      requestWebinarInviteCode,
      bypassMediaPermissions,
      refs.abortControllerRef,
      refs.intentionalDisconnectRef,
      setConnectionState,
      setLocalStream,
      setMeetError,
      setRoomId,
      stopLocalTrack,
    ],
  );

  const joinRoom = useCallback(async () => {
    await startJoin(roomId);
  }, [roomId, startJoin]);

  const joinRoomById = useCallback(
    async (targetRoomId: string) => {
      await startJoin(targetRoomId);
    },
    [startJoin],
  );

  useEffect(() => {
    if (shouldAutoJoinRef.current) {
      console.log("[Meets] Auto-joining new room...");
      shouldAutoJoinRef.current = false;
      joinRoom();
    }
  }, [joinRoom, shouldAutoJoinRef]);

  const toggleRoomLock = useCallback(
    (locked: boolean): Promise<boolean> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(false);

      return new Promise((resolve) => {
        socket.emit(
          "lockRoom",
          { locked },
          (
            response:
              | { success: boolean; locked?: boolean }
              | { error: string },
          ) => {
            if ("error" in response) {
              console.error(
                "[Meets] Failed to toggle room lock:",
                response.error,
              );
              resolve(false);
            } else {
              resolve(response.success);
            }
          },
        );
      });
    },
    [socketRef],
  );

  const toggleNoGuests = useCallback(
    (noGuests: boolean): Promise<boolean> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(false);

      return new Promise((resolve) => {
        socket.emit(
          "setNoGuests",
          { noGuests },
          (
            response:
              | { success: boolean; noGuests?: boolean }
              | { error: string }
          ) => {
            if ("error" in response) {
              console.error("[Meets] Failed to toggle no-guests:", response.error);
              resolve(false);
            } else {
              resolve(response.success);
            }
          }
        );
      });
    },
    [socketRef]
  );

  const toggleChatLock = useCallback(
    (locked: boolean): Promise<boolean> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(false);

      return new Promise((resolve) => {
        socket.emit(
          "lockChat",
          { locked },
          (response: { success: boolean; locked?: boolean } | { error: string }) => {
            if ("error" in response) {
              console.error("[Meets] Failed to toggle chat lock:", response.error);
              resolve(false);
            } else {
              resolve(response.success);
            }
          }
        );
      });
    },
    [socketRef]
  );

  const getMeetingConfig = useCallback(
    (): Promise<MeetingConfigSnapshot | null> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(null);

      return new Promise((resolve) => {
        socket.emit(
          "meeting:getConfig",
          (response: MeetingConfigSnapshot | { error: string }) => {
            if ("error" in response) {
              console.error(
                "[Meets] Failed to fetch meeting config:",
                response.error,
              );
              resolve(null);
              return;
            }
            setMeetingRequiresInviteCode(Boolean(response.requiresInviteCode));
            resolve(response);
          },
        );
      });
    },
    [setMeetingRequiresInviteCode, socketRef],
  );

  const updateMeetingConfig = useCallback(
    (update: MeetingUpdateRequest): Promise<MeetingConfigSnapshot | null> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(null);

      return new Promise((resolve) => {
        socket.emit(
          "meeting:updateConfig",
          update,
          (
            response:
              | { success: boolean; config: MeetingConfigSnapshot }
              | { error: string },
          ) => {
            if ("error" in response) {
              console.error(
                "[Meets] Failed to update meeting config:",
                response.error,
              );
              resolve(null);
              return;
            }
            setMeetingRequiresInviteCode(
              Boolean(response.config.requiresInviteCode),
            );
            resolve(response.config);
          },
        );
      });
    },
    [setMeetingRequiresInviteCode, socketRef],
  );

  const getWebinarConfig = useCallback((): Promise<WebinarConfigSnapshot | null> => {
    const socket = socketRef.current;
    if (!socket) return Promise.resolve(null);

    return new Promise((resolve) => {
      socket.emit(
        "webinar:getConfig",
        (response: WebinarConfigSnapshot | { error: string }) => {
          if ("error" in response) {
            console.error("[Meets] Failed to fetch webinar config:", response.error);
            resolve(null);
            return;
          }
          setWebinarConfig(response);
          resolve(response);
        },
      );
    });
  }, [setWebinarConfig, socketRef]);

  const updateWebinarConfig = useCallback(
    (update: WebinarUpdateRequest): Promise<WebinarConfigSnapshot | null> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(null);

      return new Promise((resolve) => {
        socket.emit(
          "webinar:updateConfig",
          update,
          (
            response:
              | { success: boolean; config: WebinarConfigSnapshot }
              | { error: string },
          ) => {
            if ("error" in response) {
              console.error("[Meets] Failed to update webinar config:", response.error);
              resolve(null);
              return;
            }
            setWebinarConfig(response.config);
            resolve(response.config);
          },
        );
      });
    },
    [setWebinarConfig, socketRef],
  );

  const rotateWebinarLink = useCallback((): Promise<WebinarLinkResponse | null> => {
    const socket = socketRef.current;
    if (!socket) return Promise.resolve(null);

    return new Promise((resolve) => {
      socket.emit(
        "webinar:rotateLink",
        (response: WebinarLinkResponse | { error: string }) => {
          if ("error" in response) {
            console.error("[Meets] Failed to rotate webinar link:", response.error);
            resolve(null);
            return;
          }
          resolve(response);
        },
      );
    });
  }, [socketRef]);

  const generateWebinarLink = useCallback(
    (): Promise<WebinarLinkResponse | null> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(null);

      return new Promise((resolve) => {
        socket.emit(
          "webinar:generateLink",
          (response: WebinarLinkResponse | { error: string }) => {
            if ("error" in response) {
              console.error("[Meets] Failed to generate webinar link:", response.error);
              resolve(null);
              return;
            }
            resolve(response);
          },
        );
      });
    },
    [socketRef],
  );

  return {
    cleanup,
    cleanupRoomResources,
    connectSocket,
    joinRoom,
    joinRoomById,
    toggleRoomLock,
    toggleNoGuests,
    toggleChatLock,
    getMeetingConfig,
    updateMeetingConfig,
    getWebinarConfig,
    updateWebinarConfig,
    rotateWebinarLink,
    generateWebinarLink,
  };
}
