import { useCallback, useEffect } from "react";
import type { Socket } from "socket.io-client";
import type { Device } from "mediasoup-client";
import {
  MAX_RECONNECT_ATTEMPTS,
  MEETS_ICE_SERVERS,
  LOW_VIDEO_MAX_BITRATE,
  OPUS_MAX_AVERAGE_BITRATE,
  RECONNECT_DELAY_MS,
  SOCKET_TIMEOUT_MS,
  SOCKET_CONNECT_TIMEOUT_MS,
  STANDARD_VIDEO_MAX_BITRATE,
  TRANSPORT_DISCONNECT_GRACE_MS,
  PRODUCER_SYNC_INTERVAL_MS,
} from "../constants";
import type {
  ChatMessage,
  ConnectionState,
  ConsumeResponse,
  HandRaisedNotification,
  HandRaisedSnapshot,
  JoinRoomResponse,
  MeetError,
  ProducerInfo,
  ProducerType,
  ReactionNotification,
  ReactionPayload,
  DtlsParameters,
  RtpParameters,
  TransportResponse,
  RestartIceResponse,
  VideoQuality,
} from "../types";
import type { ParticipantAction } from "../participant-reducer";
import { createMeetError, normalizeDisplayName } from "../utils";
import { normalizeChatMessage } from "../chat-commands";
import type { MeetRefs } from "./use-meet-refs";

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
    }
  ) => Promise<{
    token: string;
    sfuUrl: string;
  }>;
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
  isMuted: boolean;
  setIsMuted: (value: boolean) => void;
  isCameraOff: boolean;
  setIsCameraOff: (value: boolean) => void;
  setIsScreenSharing: (value: boolean) => void;
  setIsHandRaised: (value: boolean) => void;
  setIsRoomLocked: (value: boolean) => void;
  setActiveScreenShareId: (value: string | null) => void;
  setVideoQuality: (value: VideoQuality) => void;
  videoQualityRef: React.MutableRefObject<VideoQuality>;
  updateVideoQualityRef: React.MutableRefObject<
    (quality: VideoQuality) => Promise<void>
  >;
  requestMediaPermissions: (options?: { forceVideo?: boolean }) => Promise<MediaStream | null>;
  stopLocalTrack: (track?: MediaStreamTrack | null) => void;
  handleLocalTrackEnded: (kind: "audio" | "video", track: MediaStreamTrack) => void;
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
  isAppActiveRef?: React.MutableRefObject<boolean>;
  onTtsMessage?: (payload: {
    userId: string;
    displayName: string;
    text: string;
  }) => void;
  prewarm?: {
    Device: typeof import("mediasoup-client").Device | null;
    io: typeof import("socket.io-client").io | null;
    isReady: boolean;
    getCachedToken?: (roomId: string) => { token: string; sfuUrl: string } | null;
  };
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
  isMuted,
  setIsMuted,
  isCameraOff,
  setIsCameraOff,
  setIsScreenSharing,
  setIsHandRaised,
  setIsRoomLocked,
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
  isAppActiveRef,
  onTtsMessage,
  prewarm,
}: UseMeetSocketOptions) {
  const now = useCallback(
    () =>
      typeof globalThis.performance?.now === "function"
        ? globalThis.performance.now()
        : Date.now(),
    []
  );
  const {
    socketRef,
    deviceRef,
    producerTransportRef,
    consumerTransportRef,
    audioProducerRef,
    videoProducerRef,
    screenProducerRef,
    screenShareStreamRef,
    consumersRef,
    producerMapRef,
    pendingProducersRef,
    leaveTimeoutsRef,
    reconnectAttemptsRef,
    reconnectInFlightRef,
    intentionalDisconnectRef,
    lastAuthIsHostRef,
    currentRoomIdRef,
    handleRedirectRef,
    handleReconnectRef,
    shouldAutoJoinRef,
    joinOptionsRef,
    localStreamRef,
    sessionIdRef,
    producerTransportDisconnectTimeoutRef,
    consumerTransportDisconnectTimeoutRef,
    iceRestartInFlightRef,
    producerSyncIntervalRef,
  } = refs;

  const cleanupRoomResources = useCallback(
    (options?: { resetRoomId?: boolean }) => {
      const resetRoomId = options?.resetRoomId !== false;
      console.log("[Meets] Cleaning up room resources...");
      if (producerSyncIntervalRef.current) {
        clearInterval(producerSyncIntervalRef.current);
        producerSyncIntervalRef.current = null;
      }

      consumersRef.current.forEach((consumer) => {
        try {
          consumer.close();
        } catch { }
      });
      consumersRef.current.clear();
      producerMapRef.current.clear();
      pendingProducersRef.current.clear();
      leaveTimeoutsRef.current.forEach((timeoutId) => {
        clearTimeout(timeoutId);
      });
      leaveTimeoutsRef.current.clear();
      clearReactions();
      setPendingUsers(new Map());
      setDisplayNames(new Map());

      try {
        audioProducerRef.current?.close();
      } catch { }
      try {
        videoProducerRef.current?.close();
      } catch { }
      try {
        screenProducerRef.current?.close();
      } catch { }
      audioProducerRef.current = null;
      videoProducerRef.current = null;
      screenProducerRef.current = null;

      if (screenShareStreamRef.current) {
        screenShareStreamRef.current
          .getTracks()
          .forEach((track) => stopLocalTrack(track));
        screenShareStreamRef.current = null;
      }

      try {
        producerTransportRef.current?.close();
      } catch { }
      try {
        consumerTransportRef.current?.close();
      } catch { }
      producerTransportRef.current = null;
      consumerTransportRef.current = null;
      if (producerTransportDisconnectTimeoutRef.current) {
        clearTimeout(producerTransportDisconnectTimeoutRef.current);
        producerTransportDisconnectTimeoutRef.current = null;
      }
      if (consumerTransportDisconnectTimeoutRef.current) {
        clearTimeout(consumerTransportDisconnectTimeoutRef.current);
        consumerTransportDisconnectTimeoutRef.current = null;
      }

      dispatchParticipants({ type: "CLEAR_ALL" });
      setIsScreenSharing(false);
      setActiveScreenShareId(null);
      setIsHandRaised(false);
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
      screenProducerRef,
      screenShareStreamRef,
      setActiveScreenShareId,
      setDisplayNames,
      setIsHandRaised,
      setIsScreenSharing,
      setPendingUsers,
      clearReactions,
      stopLocalTrack,
      videoProducerRef,
      producerTransportDisconnectTimeoutRef,
      consumerTransportDisconnectTimeoutRef,
      producerSyncIntervalRef,
    ]
  );

  const cleanup = useCallback(() => {
    console.log("[Meets] Running full cleanup...");

    intentionalDisconnectRef.current = true;
    cleanupRoomResources();
    if (producerSyncIntervalRef.current) {
      clearInterval(producerSyncIntervalRef.current);
      producerSyncIntervalRef.current = null;
    }

    localStream?.getTracks().forEach((track) => {
      stopLocalTrack(track);
    });

    socketRef.current?.disconnect();
    socketRef.current = null;
    deviceRef.current = null;
    lastAuthIsHostRef.current = null;

    setConnectionState("disconnected");
    setLocalStream(null);
    setWaitingMessage(null);
    reconnectAttemptsRef.current = 0;
  }, [
    cleanupRoomResources,
    intentionalDisconnectRef,
    localStream,
    reconnectAttemptsRef,
    setConnectionState,
    setLocalStream,
    setWaitingMessage,
    socketRef,
    deviceRef,
    stopLocalTrack,
    producerSyncIntervalRef,
    lastAuthIsHostRef,
  ]);

  const scheduleParticipantRemoval = useCallback(
    (leftUserId: string) => {
      const existingTimeout = leaveTimeoutsRef.current.get(leftUserId);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }
      const timeoutId = setTimeout(() => {
        leaveTimeoutsRef.current.delete(leftUserId);
        dispatchParticipants({ type: "REMOVE_PARTICIPANT", userId: leftUserId });
      }, 200);
      leaveTimeoutsRef.current.set(leftUserId, timeoutId);
    },
    [dispatchParticipants, leaveTimeoutsRef]
  );

  const isRoomEvent = useCallback(
    (eventRoomId?: string) => {
      if (!eventRoomId) return true;
      if (!currentRoomIdRef.current) return true;
      return eventRoomId === currentRoomIdRef.current;
    },
    [currentRoomIdRef]
  );

  const handleProducerClosed = useCallback(
    (producerId: string) => {
      pendingProducersRef.current.delete(producerId);
      const consumer = consumersRef.current.get(producerId);
      if (consumer) {
        try {
          if (consumer.track) {
            consumer.track.stop();
          }
          consumer.close();
        } catch { }
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
        } else if (info.kind === "audio") {
          dispatchParticipants({
            type: "UPDATE_MUTED",
            userId: info.userId,
            muted: true,
          });
        }

        if (info.type === "screen") {
          setActiveScreenShareId(null);
        }

        producerMapRef.current.delete(producerId);
      }
    },
    [
      consumersRef,
      dispatchParticipants,
      pendingProducersRef,
      producerMapRef,
      setActiveScreenShareId,
    ]
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
        console.log(`[Meets] ${transportKind} transport ICE restart succeeded.`);
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
    [socketRef, producerTransportRef, consumerTransportRef, iceRestartInFlightRef],
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
              iceServers: MEETS_ICE_SERVERS.length
                ? MEETS_ICE_SERVERS
                : undefined,
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
                  (res: { success: boolean } | { error: string }) => {
                    if ("error" in res) errback(new Error(res.error));
                    else callback();
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
                  appData: unknown;
                },
                callback: (data: { id: string }) => void,
                errback: (error: Error) => void
              ) => {
                socket.emit(
                  "produce",
                  { transportId: transport.id, kind, rtpParameters, appData },
                  (res: { producerId: string } | { error: string }) => {
                    if ("error" in res) errback(new Error(res.error));
                    else callback({ id: res.producerId });
                  }
                );
              }
            );

            transport.on("connectionstatechange", (state: string) => {
              console.log("[Meets] Producer transport state:", state);
              if (state === "connected") {
                if (producerTransportDisconnectTimeoutRef.current) {
                  clearTimeout(
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
                    setTimeout(() => {
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
                clearTimeout(producerTransportDisconnectTimeoutRef.current);
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
          }
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
    ]
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
              iceServers: MEETS_ICE_SERVERS.length
                ? MEETS_ICE_SERVERS
                : undefined,
            });

            transport.on(
              "connect",
              (
                { dtlsParameters }: { dtlsParameters: DtlsParameters },
                callback: () => void,
                errback: (error: Error) => void
              ) => {
                socket.emit(
                  "connectConsumerTransport",
                  { transportId: transport.id, dtlsParameters },
                  (res: { success: boolean } | { error: string }) => {
                    if ("error" in res) errback(new Error(res.error));
                    else callback();
                  }
                );
              }
            );

            transport.on("connectionstatechange", (state: string) => {
              console.log("[Meets] Consumer transport state:", state);
              if (state === "connected") {
                if (consumerTransportDisconnectTimeoutRef.current) {
                  clearTimeout(
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
                    setTimeout(() => {
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
                clearTimeout(consumerTransportDisconnectTimeoutRef.current);
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
          }
        );
      });
    },
    [
      consumerTransportRef,
      handleReconnectRef,
      intentionalDisconnectRef,
      consumerTransportDisconnectTimeoutRef,
      attemptIceRestart,
    ]
  );

  const produce = useCallback(
    async (stream: MediaStream): Promise<void> => {
      const transport = producerTransportRef.current;
      if (!transport) return;

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack && audioTrack.readyState === "live") {
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

          audioProducer.on("transportclose", () => {
            audioProducerRef.current = null;
          });
        } catch (err) {
          console.error("[Meets] Failed to produce audio:", err);
        }
      } else if (audioTrack) {
        console.warn("[Meets] Skipping ended audio track before produce");
        setIsMuted(true);
      }

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack && videoTrack.readyState === "live") {
        try {
          const maxBitrate =
            videoQualityRef.current === "low"
              ? LOW_VIDEO_MAX_BITRATE
              : STANDARD_VIDEO_MAX_BITRATE;
          const videoProducer = await transport.produce({
            track: videoTrack,
            encodings: [{ maxBitrate }],
            appData: { type: "webcam" as ProducerType, paused: isCameraOff },
          });

          if (isCameraOff) {
            videoProducer.pause();
          }

          videoProducerRef.current = videoProducer;

          videoProducer.on("transportclose", () => {
            videoProducerRef.current = null;
          });
        } catch (err) {
          console.error("[Meets] Failed to produce video:", err);
        }
      } else if (videoTrack) {
        console.warn("[Meets] Skipping ended video track before produce");
        setIsCameraOff(true);
      }
    },
    [
      producerTransportRef,
      audioProducerRef,
      videoProducerRef,
      isMuted,
      isCameraOff,
      setIsMuted,
      setIsCameraOff,
      videoQualityRef,
    ]
  );

  const consumeProducer = useCallback(
    async (producerInfo: ProducerInfo): Promise<void> => {
      if (producerInfo.producerUserId === userId) {
        return;
      }
      if (consumersRef.current.has(producerInfo.producerId)) {
        return;
      }

      const socket = socketRef.current;
      const device = deviceRef.current;
      const transport = consumerTransportRef.current;

      if (!socket || !device || !transport) {
        pendingProducersRef.current.set(producerInfo.producerId, producerInfo);
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

              if (response.kind === "video") {
                consumer.track.enabled = true;
              }
              if (typeof consumer.resume === "function") {
                consumer.resume();
              }

              consumersRef.current.set(producerInfo.producerId, consumer);
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

              const handleTrackMuted = () => {
                if (response.kind === "audio") {
                  updateMutedState(true);
                } else {
                  updateCameraState(true);
                }
              };

              const handleTrackUnmuted = () => {
                if (response.kind === "audio") {
                  updateMutedState(false);
                } else {
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

              if (producerInfo.type === "screen") {
                setActiveScreenShareId(producerInfo.producerId);
              }

              if (producerInfo.paused) {
                if (response.kind === "audio") {
                  dispatchParticipants({
                    type: "UPDATE_MUTED",
                    userId: producerInfo.producerUserId,
                    muted: true,
                  });
                } else if (
                  response.kind === "video" &&
                  producerInfo.type === "webcam"
                ) {
                  dispatchParticipants({
                    type: "UPDATE_CAMERA_OFF",
                    userId: producerInfo.producerUserId,
                    cameraOff: true,
                  });
                }
              }

              socket.emit(
                "resumeConsumer",
                { consumerId: consumer.id },
                () => { }
              );
              resolve();
            } catch (err) {
              console.error("[Meets] Failed to create consumer:", err);
              resolve();
            }
          }
        );
      });
    },
    [
      consumersRef,
      pendingProducersRef,
      socketRef,
      deviceRef,
      consumerTransportRef,
      producerMapRef,
      dispatchParticipants,
      handleProducerClosed,
      setActiveScreenShareId,
      userId,
    ]
  );

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

      for (const producerId of producerMapRef.current.keys()) {
        if (!serverProducerIds.has(producerId)) {
          handleProducerClosed(producerId);
        }
      }

      for (const producerInfo of producers) {
        if (consumersRef.current.has(producerInfo.producerId)) continue;
        if (pendingProducersRef.current.has(producerInfo.producerId)) continue;
        await consumeProducer(producerInfo);
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
    consumeProducer,
    handleProducerClosed,
  ]);

  const startProducerSync = useCallback(() => {
    if (producerSyncIntervalRef.current) {
      clearInterval(producerSyncIntervalRef.current);
    }
    producerSyncIntervalRef.current = setInterval(() => {
      void syncProducers();
    }, PRODUCER_SYNC_INTERVAL_MS);
  }, [producerSyncIntervalRef, syncProducers]);

  const flushPendingProducers = useCallback(async () => {
    if (!pendingProducersRef.current.size) return;
    const pending = Array.from(pendingProducersRef.current.values());
    pendingProducersRef.current.clear();
    await Promise.all(pending.map((producerInfo) => consumeProducer(producerInfo)));
  }, [pendingProducersRef, consumeProducer]);

  const joinRoomInternal = useCallback(
    async (
      targetRoomId: string,
      stream: MediaStream | null,
      joinOptions: { displayName?: string; isGhost: boolean }
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
          },
          async (response: JoinRoomResponse | { error: string }) => {
            if ("error" in response) {
              reject(new Error(response.error));
              return;
            }

            if (response.status === "waiting") {
              setConnectionState("waiting");
              currentRoomIdRef.current = targetRoomId;
              resolve("waiting");
              return;
            }

            try {
              const joinedTime = now();
              console.log(
                "[Meets] Joined room, existing producers:",
                response.existingProducers
              );
              currentRoomIdRef.current = targetRoomId;

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
                `[Meets] Device loaded in ${(now() - joinedTime).toFixed(0)}ms`
              );

              const shouldProduce = !!stream && !joinOptions.isGhost;

              await Promise.all([
                shouldProduce
                  ? createProducerTransport(socket, device)
                  : Promise.resolve(),
                createConsumerTransport(socket, device),
              ]);

              const producePromise =
                shouldProduce && stream
                  ? produce(stream)
                  : Promise.resolve();

              const consumePromises = response.existingProducers.map(
                (producer) => consumeProducer(producer)
              );

              await Promise.all([producePromise, ...consumePromises]);
              await flushPendingProducers();

              setConnectionState("joined");
              startProducerSync();
              void syncProducers();
              playNotificationSound("join");
              resolve("joined");
            } catch (err) {
              reject(err);
            }
          }
        );
      });
    },
    [
      socketRef,
      sessionIdRef,
      setWaitingMessage,
      setConnectionState,
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
    ]
  );

  const connectSocket = useCallback(
    (
      targetRoomId: string,
      options?: { isHost?: boolean }
    ): Promise<Socket> => {
      return new Promise((resolve, reject) => {
        (async () => {
          try {
            const desiredIsHost = options?.isHost ?? isAdmin;
            if (socketRef.current?.connected) {
              if (lastAuthIsHostRef.current === desiredIsHost) {
                resolve(socketRef.current);
                return;
              }
              socketRef.current.disconnect();
              socketRef.current = null;
            }

            setConnectionState("connecting");

            const roomIdForJoin = targetRoomId || currentRoomIdRef.current || "";
            if (!roomIdForJoin) {
              throw new Error("Missing room ID");
            }

            const joinStartTime = now();

            const socketIoPromise = prewarm?.io
              ? Promise.resolve({ io: prewarm.io })
              : import("socket.io-client");

            const cachedToken = prewarm?.getCachedToken?.(roomIdForJoin);
            const isHost = desiredIsHost;
            const tokenPromise = cachedToken
              ? Promise.resolve(cachedToken)
              : getJoinInfo(roomIdForJoin, sessionIdRef.current, {
                user,
                isHost,
              });

            const [{ token, sfuUrl }, socketIoModule] = await Promise.all([
              tokenPromise,
              socketIoPromise,
            ]);

            let ioFn =
              (socketIoModule as { io?: typeof import("socket.io-client").io }).io ??
              (socketIoModule as { default?: typeof import("socket.io-client").io })
                .default ??
              (socketIoModule as { default?: { io?: typeof import("socket.io-client").io } })
                .default?.io ??
              (socketIoModule as unknown as typeof import("socket.io-client")).io;

            if (typeof ioFn !== "function") {
              const required = require("socket.io-client") as
                | { io?: typeof import("socket.io-client").io; default?: typeof import("socket.io-client").io }
                | ((...args: any[]) => any);
              ioFn =
                typeof required === "function"
                  ? required
                  : required.io ?? required.default;
            }

            if (typeof ioFn !== "function") {
              throw new Error("socket.io-client io() not available");
            }

            const socket = ioFn(sfuUrl, {
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
                `[Meets] Connected to SFU in ${(now() - joinStartTime).toFixed(0)}ms`
              );
              lastAuthIsHostRef.current = isHost;
              setConnectionState("connected");
              setMeetError(null);
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
              ({ roomId: eventRoomId }: { roomId?: string }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setIsAdmin(true);
                setWaitingMessage(null);
              }
            );

            socket.on("newProducer", async (data: ProducerInfo) => {
              console.log("[Meets] New producer:", data);
              await consumeProducer(data);
            });

            socket.on(
              "producerClosed",
              ({ producerId }: { producerId: string }) => {
                console.log("[Meets] Producer closed:", producerId);
                handleProducerClosed(producerId);

                if (audioProducerRef.current?.id === producerId) {
                  setIsMuted(true);
                  audioProducerRef.current.close();
                  audioProducerRef.current = null;
                } else if (videoProducerRef.current?.id === producerId) {
                  setIsCameraOff(true);
                  videoProducerRef.current.close();
                  videoProducerRef.current = null;
                  const track = localStream?.getVideoTracks()[0];
                  if (track) {
                    stopLocalTrack(track);
                    track.enabled = false;
                  }
                  setLocalStream((prev) => {
                    if (!prev) return prev;
                    const remaining = prev
                      .getTracks()
                      .filter((item) => item.kind !== "video");
                    return new MediaStream(remaining);
                  });
                } else if (screenProducerRef.current?.id === producerId) {
                  if (screenProducerRef.current.track) {
                    screenProducerRef.current.track.stop();
                  }
                  setIsScreenSharing(false);
                  screenProducerRef.current.close();
                  screenProducerRef.current = null;
                  if (screenShareStreamRef.current) {
                    screenShareStreamRef.current
                      .getTracks()
                      .forEach((track) => stopLocalTrack(track));
                    screenShareStreamRef.current = null;
                  }
                  setActiveScreenShareId(null);
                }
              }
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
                if (joinedUserId !== userId) {
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
                  clearTimeout(leaveTimeout);
                  leaveTimeoutsRef.current.delete(joinedUserId);
                }
                dispatchParticipants({
                  type: "ADD_PARTICIPANT",
                  userId: joinedUserId,
                  isGhost,
                });
              }
            );

            socket.on(
              "userLeft",
              ({ userId: leftUserId }: { userId: string }) => {
                console.log("[Meets] User left:", leftUserId);
                if (leftUserId !== userId) {
                  playNotificationSound("leave");
                }
                setDisplayNames((prev) => {
                  if (!prev.has(leftUserId)) return prev;
                  const next = new Map(prev);
                  next.delete(leftUserId);
                  return next;
                });

                const producersToClose = Array.from(
                  producerMapRef.current.entries()
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
              }
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
                (users || []).forEach(({ userId, displayName }) => {
                  if (displayName) {
                    snapshot.set(userId, displayName);
                  }
                });
                setDisplayNames(snapshot);
              }
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
              }
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
              }
            );

            socket.on(
              "participantMuted",
              ({ userId, muted }: { userId: string; muted: boolean }) => {
                dispatchParticipants({
                  type: "UPDATE_MUTED",
                  userId,
                  muted,
                });
              }
            );

            socket.on(
              "participantCameraOff",
              ({
                userId: camUserId,
                cameraOff,
              }: {
                userId: string;
                cameraOff: boolean;
              }) => {
                dispatchParticipants({
                  type: "UPDATE_CAMERA_OFF",
                  userId: camUserId,
                  cameraOff,
                });
              }
            );

            socket.on(
              "setVideoQuality",
              async ({ quality }: { quality: VideoQuality }) => {
                console.log(`[Meets] Setting video quality to: ${quality}`);
                setVideoQuality(quality);
                await updateVideoQualityRef.current(quality);
              }
            );

            socket.on("chatMessage", (message: ChatMessage) => {
              console.log("[Meets] Chat message received:", message);
              const { message: normalized, ttsText } = normalizeChatMessage(message);
              chat.setChatMessages((prev) => [...prev, normalized]);
              if (normalized.userId !== userId) {
                chat.setChatOverlayMessages((prev) => [...prev, normalized]);
                setTimeout(() => {
                  chat.setChatOverlayMessages((prev) =>
                    prev.filter((m) => m.id !== normalized.id)
                  );
                }, 5000);
              }
              if (ttsText) {
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
              }
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
                  `[Meets] Redirect received. Initiating full switch to ${newRoomId}`
                );
                handleRedirectRef.current(newRoomId);
              }
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
              }
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
                  ])
                );
                setPendingUsers(snapshot);
              }
            );

            socket.on(
              "userAdmitted",
              ({ userId, roomId: eventRoomId }: { userId: string; roomId?: string }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setPendingUsers((prev) => {
                  const newMap = new Map(prev);
                  newMap.delete(userId);
                  return newMap;
                });
              }
            );

            socket.on(
              "userRejected",
              ({ userId, roomId: eventRoomId }: { userId: string; roomId?: string }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setPendingUsers((prev) => {
                  const newMap = new Map(prev);
                  newMap.delete(userId);
                  return newMap;
                });
              }
            );

            socket.on(
              "pendingUserLeft",
              ({ userId, roomId: eventRoomId }: { userId: string; roomId?: string }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setPendingUsers((prev) => {
                  const newMap = new Map(prev);
                  newMap.delete(userId);
                  return newMap;
                });
              }
            );

            socket.on("joinApproved", async () => {
              console.log("[Meets] Join approved! Re-attempting join...");
              const joinOptions = joinOptionsRef.current;
              let stream = localStreamRef.current;

              if (!stream && !joinOptions.isGhost) {
                stream = await requestMediaPermissions();
                if (stream) {
                  localStreamRef.current = stream;
                  setLocalStream(stream);
                }
              }
              if (currentRoomIdRef.current && (stream || joinOptions.isGhost)) {
                joinRoomInternal(
                  currentRoomIdRef.current,
                  stream,
                  joinOptions
                ).catch(console.error);
              } else {
                console.error(
                  "[Meets] Cannot re-join: missing room ID or local stream",
                  {
                    roomId: currentRoomIdRef.current,
                    hasStream: !!localStreamRef.current,
                    isGhost: joinOptionsRef.current.isGhost,
                  }
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
              }
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
              }
            );

            socketRef.current = socket;
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
      setLocalStream,
      setMeetError,
      setPendingUsers,
      setWaitingMessage,
      setVideoQuality,
      socketRef,
      stopLocalTrack,
      requestMediaPermissions,
      updateVideoQualityRef,
      user,
      userId,
      onTtsMessage,
      lastAuthIsHostRef,
    ]
  );

  const handleReconnect = useCallback(async (options?: { immediate?: boolean }) => {
    if (reconnectInFlightRef.current) return;
    reconnectInFlightRef.current = true;

    try {
      while (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
        if (isAppActiveRef && !isAppActiveRef.current) {
          await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
          continue;
        }
        setConnectionState("reconnecting");
        reconnectAttemptsRef.current++;
        const delay = options?.immediate
          ? 0
          : RECONNECT_DELAY_MS * 2 ** (reconnectAttemptsRef.current - 1);

        console.log(
          `[Meets] Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})`
        );
        await new Promise((r) => setTimeout(r, delay));

        try {
          const reconnectRoomId = currentRoomIdRef.current;
          cleanupRoomResources({ resetRoomId: false });
          socketRef.current?.disconnect();
          socketRef.current = null;
          if (!reconnectRoomId) {
            throw new Error("Missing room ID for reconnect");
          }
          await connectSocket(reconnectRoomId);

          const joinOptions = joinOptionsRef.current;
          let stream = localStreamRef.current || localStream;
          if (!stream && !joinOptions.isGhost) {
            stream = await requestMediaPermissions();
            if (stream) {
              localStreamRef.current = stream;
              setLocalStream(stream);
            }
          }
          if (reconnectRoomId && (stream || joinOptions.isGhost)) {
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
      const streamToStop = localStreamRef.current || localStream;
      if (streamToStop) {
        streamToStop.getTracks().forEach((track) => stopLocalTrack(track));
      }
      localStreamRef.current = null;
      setLocalStream(null);
    } finally {
      reconnectInFlightRef.current = false;
    }
  }, [
    cleanupRoomResources,
    connectSocket,
    currentRoomIdRef,
    isAppActiveRef,
    joinOptionsRef,
    joinRoomInternal,
    localStream,
    localStreamRef,
    reconnectAttemptsRef,
    reconnectInFlightRef,
    requestMediaPermissions,
    setConnectionState,
    setMeetError,
    setLocalStream,
    socketRef,
    stopLocalTrack,
  ]);

  useEffect(() => {
    handleReconnectRef.current = handleReconnect;
  }, [handleReconnect, handleReconnectRef]);

  const handleRedirectCallback = useCallback(
    async (newRoomId: string) => {
      console.log(`[Meets] Executing hard redirect to ${newRoomId}`);

      cleanup();
      setRoomId(newRoomId);
      shouldAutoJoinRef.current = true;
    },
    [cleanup, setRoomId, shouldAutoJoinRef]
  );

  useEffect(() => {
    handleRedirectRef.current = handleRedirectCallback;
  }, [handleRedirectCallback, handleRedirectRef]);

  const startJoin = useCallback(
    async (targetRoomId: string, options?: { isHost?: boolean }) => {
      if (refs.abortControllerRef.current?.signal.aborted) return;

      setMeetError(null);
      setConnectionState("connecting");
      primeAudioOutput();
      refs.intentionalDisconnectRef.current = false;
      setRoomId(targetRoomId);
      const normalizedDisplayName = normalizeDisplayName(displayNameInput);
      const isHost = options?.isHost ?? isAdmin;
      const joinOptions = {
        displayName: isHost ? normalizedDisplayName || undefined : undefined,
        isGhost: ghostEnabled,
      };
      joinOptionsRef.current = joinOptions;

      try {
        const [, stream] = await Promise.all([
          connectSocket(targetRoomId, options),
          joinOptions.isGhost
            ? Promise.resolve(null)
            : requestMediaPermissions(),
        ]);

        if (!joinOptions.isGhost && !stream) {
          setConnectionState("error");
          return;
        }

        localStreamRef.current = stream;
        setLocalStream(stream);

        await joinRoomInternal(targetRoomId, stream, joinOptions);
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
      isAdmin,
      joinOptionsRef,
      joinRoomInternal,
      localStreamRef,
      primeAudioOutput,
      requestMediaPermissions,
      refs.abortControllerRef,
      refs.intentionalDisconnectRef,
      setConnectionState,
      setLocalStream,
      setMeetError,
      setRoomId,
      stopLocalTrack,
    ]
  );

  const joinRoom = useCallback(async () => {
    await startJoin(roomId);
  }, [roomId, startJoin]);

  const joinRoomById = useCallback(
    async (targetRoomId: string, options?: { isHost?: boolean }) => {
      await startJoin(targetRoomId, options);
    },
    [startJoin]
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
          (response: { success: boolean; locked?: boolean } | { error: string }) => {
            if ("error" in response) {
              console.error("[Meets] Failed to toggle room lock:", response.error);
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

  const admitUser = useCallback(
    (targetUserId: string): Promise<boolean> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(false);

      return new Promise((resolve) => {
        socket.emit(
          "admitUser",
          { userId: targetUserId },
          (response: { success?: boolean; error?: string }) => {
            if (response?.error) {
              console.error("[Meets] Failed to admit user:", response.error);
              resolve(false);
            } else {
              resolve(Boolean(response?.success ?? true));
            }
          }
        );
      });
    },
    [socketRef]
  );

  const rejectUser = useCallback(
    (targetUserId: string): Promise<boolean> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(false);

      return new Promise((resolve) => {
        socket.emit(
          "rejectUser",
          { userId: targetUserId },
          (response: { success?: boolean; error?: string }) => {
            if (response?.error) {
              console.error("[Meets] Failed to reject user:", response.error);
              resolve(false);
            } else {
              resolve(Boolean(response?.success ?? true));
            }
          }
        );
      });
    },
    [socketRef]
  );

  return {
    cleanup,
    cleanupRoomResources,
    connectSocket,
    joinRoom,
    joinRoomById,
    toggleRoomLock,
    admitUser,
    rejectUser,
  };
}
