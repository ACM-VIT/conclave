"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { Device } from "mediasoup-client";
import {
  DEFAULT_AUDIO_CONSTRAINTS,
  LOW_QUALITY_CONSTRAINTS,
  OPUS_MAX_AVERAGE_BITRATE,
  SCREEN_AUDIO_OPUS_MAX_AVERAGE_BITRATE,
  STANDARD_QUALITY_CONSTRAINTS,
} from "../lib/constants";
import type {
  MediaState,
  MeetError,
  Producer,
  ProducerType,
  Transport,
  VideoQuality,
} from "../lib/types";
import { createMeetError } from "../lib/utils";
import { buildScreenShareEncoding } from "../lib/video-encodings";
import {
  getPreferredScreenShareCodec,
  getPreferredWebcamCodec,
  produceWebcamTrack,
} from "../lib/webcam-codec";
import { prewarmVideoEffectsAssets } from "./useVideoEffects";

interface UseMeetMediaOptions {
  ghostEnabled: boolean;
  isObserverMode?: boolean;
  connectionState: string;
  isMuted: boolean;
  setIsMuted: (value: boolean) => void;
  isCameraOff: boolean;
  setIsCameraOff: (value: boolean) => void;
  isScreenSharing: boolean;
  setIsScreenSharing: (value: boolean) => void;
  activeScreenShareId: string | null;
  setActiveScreenShareId: (value: string | null) => void;
  localStream: MediaStream | null;
  setLocalStream: React.Dispatch<React.SetStateAction<MediaStream | null>>;
  setMeetError: (error: MeetError | null) => void;
  selectedAudioInputDeviceId?: string;
  setSelectedAudioInputDeviceId: (value: string) => void;
  selectedAudioOutputDeviceId?: string;
  setSelectedAudioOutputDeviceId: (value: string) => void;
  videoQuality: VideoQuality;
  videoQualityRef: React.MutableRefObject<VideoQuality>;
  activeVideoEffectsCount?: number;
  getVideoPublishTrackRef?: React.MutableRefObject<
    ((stream?: MediaStream | null) => MediaStreamTrack | null) | null
  >;
  socketRef: React.MutableRefObject<Socket | null>;
  deviceRef: React.MutableRefObject<Device | null>;
  producerTransportRef: React.MutableRefObject<Transport | null>;
  ensureProducerTransportRef?: React.MutableRefObject<
    (() => Promise<boolean>) | null
  >;
  audioProducerRef: React.MutableRefObject<Producer | null>;
  videoProducerRef: React.MutableRefObject<Producer | null>;
  screenProducerRef: React.MutableRefObject<Producer | null>;
  screenAudioProducerRef: React.MutableRefObject<Producer | null>;
  localStreamRef: React.MutableRefObject<MediaStream | null>;
  intentionalTrackStopsRef: React.MutableRefObject<
    WeakSet<MediaStreamTrack>
  >;
  permissionHintTimeoutRef: React.MutableRefObject<number | null>;
  audioContextRef: React.MutableRefObject<AudioContext | null>;
}

export function useMeetMedia({
  ghostEnabled,
  isObserverMode = false,
  connectionState,
  isMuted,
  setIsMuted,
  isCameraOff,
  setIsCameraOff,
  isScreenSharing,
  setIsScreenSharing,
  activeScreenShareId,
  setActiveScreenShareId,
  localStream,
  setLocalStream,
  setMeetError,
  selectedAudioInputDeviceId,
  setSelectedAudioInputDeviceId,
  selectedAudioOutputDeviceId,
  setSelectedAudioOutputDeviceId,
  videoQuality,
  videoQualityRef,
  activeVideoEffectsCount = 0,
  getVideoPublishTrackRef,
  socketRef,
  deviceRef,
  producerTransportRef,
  ensureProducerTransportRef,
  audioProducerRef,
  videoProducerRef,
  screenProducerRef,
  screenAudioProducerRef,
  localStreamRef,
  intentionalTrackStopsRef,
  permissionHintTimeoutRef,
  audioContextRef,
}: UseMeetMediaOptions) {
  const [mediaState, setMediaState] = useState<MediaState>({
    hasAudioPermission: false,
    hasVideoPermission: false,
  });
  const [showPermissionHint, setShowPermissionHint] = useState(false);
  const updateVideoQualityRef = useRef<
    (quality: VideoQuality) => Promise<void>
  >(async () => {});
  const audioRecoveryInFlightRef = useRef(false);
  const cameraRecoveryInFlightRef = useRef(false);
  const [cameraProducerRecoveryPulse, setCameraProducerRecoveryPulse] =
    useState(0);
  const toggleMuteInFlightRef = useRef(false);
  const [isMuteTogglePending, setIsMuteTogglePending] = useState(false);
  const toggleCameraInFlightRef = useRef(false);
  const buildAudioConstraints = useCallback(
    (deviceId?: string): MediaTrackConstraints => ({
      ...DEFAULT_AUDIO_CONSTRAINTS,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    }),
    []
  );

  const buildVideoConstraints = useCallback(
    (deviceId?: string): MediaTrackConstraints => ({
      ...(videoQualityRef.current === "low"
        ? LOW_QUALITY_CONSTRAINTS
        : STANDARD_QUALITY_CONSTRAINTS),
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    }),
    [videoQualityRef]
  );

  const getAudioContext = useCallback(() => {
    const AudioContextConstructor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;

    if (!AudioContextConstructor) return null;

    if (!audioContextRef.current || audioContextRef.current.state === "closed") {
      audioContextRef.current = new AudioContextConstructor();
    }

    return audioContextRef.current;
  }, [audioContextRef]);

  const playNotificationSound = useCallback(
    (type: "join" | "leave" | "waiting" | "handRaise") => {
      const audioContext = getAudioContext();
      if (!audioContext) return;

      const playPattern = () => {
        const now = audioContext.currentTime;
        const frequencies =
          type === "join"
            ? [523.25, 659.25]
            : type === "waiting"
            ? [440.0, 523.25, 659.25]
            : type === "handRaise"
            ? [587.33]
            : [392.0, 261.63];
        const duration =
          type === "waiting" ? 0.1 : type === "handRaise" ? 0.12 : 0.12;
        const gap = 0.03;
        const peakGain = type === "handRaise" ? 0.13 : 0.16;

        frequencies.forEach((frequency, index) => {
          const start = now + index * (duration + gap);
          const oscillator = audioContext.createOscillator();
          const gain = audioContext.createGain();
          oscillator.type = "sine";
          oscillator.frequency.value = frequency;

          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(peakGain, start + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

          oscillator.connect(gain);
          gain.connect(audioContext.destination);
          oscillator.start(start);
          oscillator.stop(start + duration + 0.02);
        });
      };

      if (audioContext.state === "suspended") {
        audioContext
          .resume()
          .then(() => {
            playPattern();
          })
          .catch(() => {});
        return;
      }

      playPattern();
    },
    [getAudioContext]
  );

  const primeAudioOutput = useCallback(() => {
    const audioContext = getAudioContext();
    if (!audioContext) return;
    if (audioContext.state === "suspended") {
      audioContext.resume().catch(() => {});
    }
  }, [getAudioContext]);

  const emitToggleMute = useCallback(
    (producerId: string, paused: boolean) => {
      const socket = socketRef.current;
      if (!socket || !socket.connected) {
        return Promise.resolve({
          ok: false,
          error: "Socket not connected",
        });
      }

      return new Promise<{ ok: boolean; error?: string }>((resolve) => {
        let settled = false;
        // 1500ms was too tight: a slow-but-healthy ack would time out and (on
        // unmute) trigger a destructive producer-recreate. The toggle itself is
        // delivered reliably (TCP) and the SFU acts on the event, not the ack —
        // so we can afford to wait for the ack rather than assume failure.
        const timeout = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({ ok: false, error: "toggleMute timeout" });
        }, 5000);

        socket.emit(
          "toggleMute",
          { producerId, paused },
          (response: { success: boolean } | { error: string }) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout);
            if ("error" in response) {
              resolve({ ok: false, error: response.error });
              return;
            }
            resolve({ ok: true });
          }
        );
      });
    },
    [socketRef]
  );

  const resetAudioProducer = useCallback(
    (producer: Producer | null) => {
      if (!producer) return;
      try {
        producer.close();
      } catch {}
      if (audioProducerRef.current?.id === producer.id) {
        audioProducerRef.current = null;
      }
    },
    [audioProducerRef]
  );

  const waitForPreferredVideoPublishTrack = useCallback(
    async (stream: MediaStream, rawTrack: MediaStreamTrack) => {
      if (activeVideoEffectsCount <= 0) return rawTrack;

      const startedAt = performance.now();
      let latestTrack: MediaStreamTrack | null = null;
      while (performance.now() - startedAt < 900) {
        const candidate = getVideoPublishTrackRef?.current?.(stream) ?? null;
        if (candidate?.readyState === "live") {
          latestTrack = candidate;
          if (candidate.id !== rawTrack.id) {
            return candidate;
          }
        }
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }

      if (latestTrack?.readyState === "live") {
        return latestTrack;
      }

      return rawTrack;
    },
    [activeVideoEffectsCount, getVideoPublishTrackRef]
  );

  const stopLocalTrack = useCallback(
    (track?: MediaStreamTrack | null) => {
      if (!track) return;
      intentionalTrackStopsRef.current.add(track);
      try {
        track.stop();
      } catch {}
    },
    [intentionalTrackStopsRef]
  );

  const consumeIntentionalStop = useCallback(
    (track?: MediaStreamTrack | null) => {
      if (!track) return false;
      const marked = intentionalTrackStopsRef.current.has(track);
      if (marked) {
        intentionalTrackStopsRef.current.delete(track);
      }
      return marked;
    },
    [intentionalTrackStopsRef]
  );

  const handleLocalTrackEnded = useCallback(
    (kind: "audio" | "video", track: MediaStreamTrack) => {
      if (consumeIntentionalStop(track)) return;

      if (kind === "audio") {
        setIsMuted(true);
        const producer = audioProducerRef.current;
        if (producer) {
          socketRef.current?.emit(
            "closeProducer",
            { producerId: producer.id },
            () => {}
          );
          try {
            producer.close();
          } catch {}
          audioProducerRef.current = null;
        }
      } else {
        setIsCameraOff(true);
        const producer = videoProducerRef.current;
        if (producer) {
          socketRef.current?.emit(
            "closeProducer",
            { producerId: producer.id },
            () => {}
          );
          try {
            producer.close();
          } catch {}
          videoProducerRef.current = null;
        }
      }

      setLocalStream((prev) => {
        if (!prev) return prev;
        const remaining = prev.getTracks().filter((t) => t.kind !== kind);
        return new MediaStream(remaining);
      });
    },
    [
      consumeIntentionalStop,
      setIsMuted,
      setIsCameraOff,
      setLocalStream,
      audioProducerRef,
      videoProducerRef,
      socketRef,
    ]
  );

  const requestMediaPermissions = useCallback(async (): Promise<
    MediaStream | null
  > => {
    if (permissionHintTimeoutRef.current) {
      window.clearTimeout(permissionHintTimeoutRef.current);
    }
    setShowPermissionHint(false);
    permissionHintTimeoutRef.current = window.setTimeout(() => {
      setShowPermissionHint(true);
    }, 450);

    try {
      const videoConstraints =
        videoQuality === "low"
          ? { ...LOW_QUALITY_CONSTRAINTS }
          : { ...STANDARD_QUALITY_CONSTRAINTS };

      const audioConstraints = isMuted
        ? false
        : buildAudioConstraints(selectedAudioInputDeviceId);
      const videoConstraintsForRequest = isCameraOff
        ? false
        : videoConstraints;

      if (!audioConstraints && !videoConstraintsForRequest) {
        setMediaState({
          hasAudioPermission: false,
          hasVideoPermission: false,
        });
        return new MediaStream();
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: videoConstraintsForRequest,
      });

      setMediaState({
        hasAudioPermission: stream.getAudioTracks().length > 0,
        hasVideoPermission: stream.getVideoTracks().length > 0,
      });

      stream.getTracks().forEach((track) => {
        track.onended = () => {
          console.log(`[Meets] Track ended: ${track.kind}`);
          if (track.kind === "audio" || track.kind === "video") {
            handleLocalTrackEnded(track.kind as "audio" | "video", track);
          }
        };
      });
      stream.getVideoTracks().forEach((track) => {
        if ("contentHint" in track) {
          track.contentHint = "motion";
        }
      });

      return stream;
    } catch (err) {
      const meetErr = createMeetError(err, "PERMISSION_DENIED");
      setMeetError(meetErr);
      setIsCameraOff(true);
      if (meetErr.code === "PERMISSION_DENIED") {
        setIsMuted(true);
      }

      if (
        meetErr.code === "PERMISSION_DENIED" ||
        meetErr.code === "MEDIA_ERROR"
      ) {
        try {
          if (isMuted) {
            return null;
          }

          const audioOnlyConstraints = buildAudioConstraints(
            selectedAudioInputDeviceId
          );

          const audioStream = await navigator.mediaDevices.getUserMedia({
            audio: audioOnlyConstraints,
          });
          const audioTrack = audioStream.getAudioTracks()[0];
          if (audioTrack) {
            audioTrack.onended = () => {
              handleLocalTrackEnded("audio", audioTrack);
            };
          }
          setMediaState({
            hasAudioPermission: true,
            hasVideoPermission: false,
          });
          setIsCameraOff(true);
          return audioStream;
        } catch {
          return null;
        }
      }
      return null;
    } finally {
      if (permissionHintTimeoutRef.current) {
        window.clearTimeout(permissionHintTimeoutRef.current);
        permissionHintTimeoutRef.current = null;
      }
      setShowPermissionHint(false);
    }
  }, [
    videoQuality,
    selectedAudioInputDeviceId,
    isMuted,
    isCameraOff,
    handleLocalTrackEnded,
    buildAudioConstraints,
    permissionHintTimeoutRef,
    setMeetError,
    setIsCameraOff,
    setIsMuted,
  ]);

  const handleAudioInputDeviceChange = useCallback(
    async (deviceId: string) => {
      setSelectedAudioInputDeviceId(deviceId);

      if (connectionState === "joined") {
        try {
          const newStream = await navigator.mediaDevices.getUserMedia({
            audio: buildAudioConstraints(deviceId),
          });

          const newAudioTrack = newStream.getAudioTracks()[0];
          if (newAudioTrack) {
            newAudioTrack.onended = () => {
              handleLocalTrackEnded("audio", newAudioTrack);
            };
            newAudioTrack.enabled = !isMuted;
            const oldAudioTrack = localStream?.getAudioTracks()[0];

            if (audioProducerRef.current) {
              await audioProducerRef.current.replaceTrack({
                track: newAudioTrack,
              });
            }

            setLocalStream((prev) => {
              if (prev) {
                if (oldAudioTrack) {
                  prev.removeTrack(oldAudioTrack);
                }
                prev.addTrack(newAudioTrack);
                if (oldAudioTrack) {
                  stopLocalTrack(oldAudioTrack);
                }
                return new MediaStream(prev.getTracks());
              }
              return newStream;
            });
          }
        } catch (err) {
          console.error("[Meets] Failed to switch audio input device:", err);
        }
      }
    },
    [
      connectionState,
      isMuted,
      localStream,
      handleLocalTrackEnded,
      stopLocalTrack,
      setSelectedAudioInputDeviceId,
      audioProducerRef,
      setLocalStream,
      buildAudioConstraints,
    ]
  );

  const handleVideoInputDeviceChange = useCallback(
    async (deviceId: string) => {
      if (connectionState !== "joined") return;
      if (isCameraOff) return;

      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          video: buildVideoConstraints(deviceId),
        });

        const newVideoTrack = newStream.getVideoTracks()[0];
        if (newVideoTrack) {
          if ("contentHint" in newVideoTrack) {
            newVideoTrack.contentHint = "motion";
          }
          newVideoTrack.onended = () => {
            handleLocalTrackEnded("video", newVideoTrack);
          };
          const previousStream = localStreamRef.current ?? localStream;
          const oldVideoTrack = previousStream?.getVideoTracks()[0] ?? null;
          const remainingTracks =
            previousStream
              ?.getTracks()
              .filter((track) => track.kind !== "video") ?? [];
          const nextStream = new MediaStream([...remainingTracks, newVideoTrack]);
          localStreamRef.current = nextStream;
          setLocalStream(nextStream);

          if (videoProducerRef.current) {
            const publishTrack = await waitForPreferredVideoPublishTrack(
              nextStream,
              newVideoTrack,
            );
            try {
              await videoProducerRef.current.replaceTrack({
                track: publishTrack,
              });
            } catch (err) {
              if (publishTrack.id === newVideoTrack.id) throw err;
              console.warn(
                "[Meets] Processed device-switch track failed; retrying raw camera:",
                err,
              );
              await videoProducerRef.current.replaceTrack({
                track: newVideoTrack,
              });
            }
          }

          if (oldVideoTrack && oldVideoTrack !== newVideoTrack) {
            stopLocalTrack(oldVideoTrack);
          }
        }
      } catch (err) {
        console.error("[Meets] Failed to switch video input device:", err);
      }
    },
    [
      connectionState,
      isCameraOff,
      localStream,
      handleLocalTrackEnded,
      stopLocalTrack,
      videoProducerRef,
      setLocalStream,
      buildVideoConstraints,
      localStreamRef,
      waitForPreferredVideoPublishTrack,
    ]
  );

  const handleAudioOutputDeviceChange = useCallback(
    async (deviceId: string) => {
      setSelectedAudioOutputDeviceId(deviceId);

      const audioElements = document.querySelectorAll("audio");
      for (const audio of audioElements) {
        const audioElement = audio as HTMLAudioElement & {
          setSinkId?: (sinkId: string) => Promise<void>;
        };
        if (audioElement.setSinkId) {
          try {
            await audioElement.setSinkId(deviceId);
          } catch (err) {
            console.error("[Meets] Failed to set audio output device:", err);
          }
        }
      }

      const videoElements = document.querySelectorAll("video");
      for (const video of videoElements) {
        const videoElement = video as HTMLVideoElement & {
          setSinkId?: (sinkId: string) => Promise<void>;
        };
        if (videoElement.setSinkId) {
          try {
            await videoElement.setSinkId(deviceId);
          } catch (_err) {
            // Video elements may not have audio
          }
        }
      }
    },
    [setSelectedAudioOutputDeviceId]
  );

  const updateVideoQuality = useCallback(
    async (quality: VideoQuality) => {
      if (isCameraOff) return;
      if (!localStream) return;

      try {
        const constraints =
          quality === "low"
            ? LOW_QUALITY_CONSTRAINTS
            : STANDARD_QUALITY_CONSTRAINTS;

        console.log(
          `[Meets] Switching to ${quality} quality`,
          JSON.stringify(constraints)
        );

        const currentTrack = localStream.getVideoTracks()[0];
        if (currentTrack && currentTrack.readyState === "live") {
          currentTrack.onended = () => {
            handleLocalTrackEnded("video", currentTrack);
          };
          try {
            await currentTrack.applyConstraints(constraints);
          } catch (err) {
            console.warn(
              "[Meets] applyConstraints failed, reopening camera:",
              err
            );
          }
        }

        let nextVideoTrack = localStream.getVideoTracks()[0];
        let publishStream = localStreamRef.current ?? localStream;
        let oldVideoTrackToStop: MediaStreamTrack | null = null;

        if (!nextVideoTrack || nextVideoTrack.readyState !== "live") {
          const newStream = await navigator.mediaDevices.getUserMedia({
            video: constraints,
          });
          const newVideoTrack = newStream.getVideoTracks()[0];
          if (!newVideoTrack) {
            throw new Error("No video track obtained");
          }
          if ("contentHint" in newVideoTrack) {
            newVideoTrack.contentHint = "motion";
          }
          newVideoTrack.onended = () => {
            handleLocalTrackEnded("video", newVideoTrack);
          };

          const previousStream = localStreamRef.current ?? localStream;
          oldVideoTrackToStop = previousStream?.getVideoTracks()[0] ?? null;
          const remainingTracks = previousStream
            .getTracks()
            .filter((track) => track.kind !== "video");
          publishStream = new MediaStream([...remainingTracks, newVideoTrack]);
          localStreamRef.current = publishStream;
          setLocalStream(publishStream);
          nextVideoTrack = newVideoTrack;
        }

        const previousProducer = videoProducerRef.current;

        if (!nextVideoTrack) {
          return;
        }

        const publishTrack = await waitForPreferredVideoPublishTrack(
          publishStream,
          nextVideoTrack,
        );

        if (previousProducer && !previousProducer.closed) {
          if (previousProducer.track?.id !== publishTrack.id) {
            try {
              await previousProducer.replaceTrack({ track: publishTrack });
            } catch (err) {
              if (publishTrack.id === nextVideoTrack.id) throw err;
              console.warn(
                "[Meets] Processed quality-switch track failed; retrying raw camera:",
                err,
              );
              await previousProducer.replaceTrack({ track: nextVideoTrack });
            }
          }
          if (
            oldVideoTrackToStop &&
            oldVideoTrackToStop !== nextVideoTrack &&
            oldVideoTrackToStop !== previousProducer.track
          ) {
            stopLocalTrack(oldVideoTrackToStop);
          }
          return;
        }

        const transport = producerTransportRef.current;
        if (!transport) {
          return;
        }

        const preferredWebcamCodec = getPreferredWebcamCodec(deviceRef.current);
        const nextProducer = await produceWebcamTrack({
          transport,
          track: publishTrack,
          quality,
          paused: false,
          preferredCodec: preferredWebcamCodec,
        });

        videoProducerRef.current = nextProducer;
        const nextProducerId = nextProducer.id;
        nextProducer.on("transportclose", () => {
          if (videoProducerRef.current?.id === nextProducerId) {
            videoProducerRef.current = null;
          }
        });

        if (
          previousProducer &&
          previousProducer.id !== nextProducerId
        ) {
          socketRef.current?.emit(
            "closeProducer",
            { producerId: previousProducer.id },
            () => {}
          );
          try {
            previousProducer.close();
          } catch {}
        }
        if (oldVideoTrackToStop && oldVideoTrackToStop !== nextVideoTrack) {
          stopLocalTrack(oldVideoTrackToStop);
        }
      } catch (err) {
        console.error("[Meets] Failed to update video quality:", err);
      }
    },
    [
      isCameraOff,
      localStream,
      handleLocalTrackEnded,
      stopLocalTrack,
      setLocalStream,
      socketRef,
      deviceRef,
      producerTransportRef,
      videoProducerRef,
      localStreamRef,
      waitForPreferredVideoPublishTrack,
    ]
  );

  useEffect(() => {
    updateVideoQualityRef.current = updateVideoQuality;
  }, [updateVideoQuality]);

  const toggleMute = useCallback(async () => {
    if (ghostEnabled || isObserverMode) return;
    if (toggleMuteInFlightRef.current) return;
    toggleMuteInFlightRef.current = true;
    setIsMuteTogglePending(true);
    const previousMuted = isMuted;
    const nextMuted = !previousMuted;
    let producer = audioProducerRef.current;
    let createdTrack: MediaStreamTrack | null = null;
    try {
      if (
        producer &&
        (producer.closed || producer.track?.readyState !== "live")
      ) {
        socketRef.current?.emit(
          "closeProducer",
          { producerId: producer.id },
          () => {}
        );
        resetAudioProducer(producer);
        producer = null;
      }

      if (nextMuted) {
        const currentTrack = localStreamRef.current?.getAudioTracks()[0];
        if (currentTrack && currentTrack.readyState === "live") {
          currentTrack.enabled = false;
        }

        if (producer) {
          try {
            producer.pause();
          } catch {}
          const toggleResult = await emitToggleMute(producer.id, true);
          if (!toggleResult.ok) {
            console.warn(
              "[Meets] toggleMute failed, rolling back mute:",
              toggleResult.error
            );
            if (currentTrack && currentTrack.readyState === "live") {
              currentTrack.enabled = true;
            }
            try {
              producer.resume();
            } catch {}
            setIsMuted(false);
            setMeetError({
              code: "TRANSPORT_ERROR",
              message: toggleResult.error || "Failed to mute microphone",
              recoverable: true,
            });
            return;
          }
        }
        setIsMuted(true);
        return;
      }

      let transport = producerTransportRef.current;
      if (!transport || transport.closed) {
        const transportReady =
          (await ensureProducerTransportRef?.current?.()) ?? false;
        transport = producerTransportRef.current;
        if (!transportReady || !transport || transport.closed) {
          throw new Error("Audio transport unavailable");
        }
      }

      let audioTrack = localStreamRef.current?.getAudioTracks()[0] ?? null;

      if (audioTrack && audioTrack.readyState !== "live") {
        stopLocalTrack(audioTrack);
        audioTrack = null;
      }

      if (!audioTrack) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: buildAudioConstraints(selectedAudioInputDeviceId),
        });
        const nextAudioTrack = stream.getAudioTracks()[0];
        createdTrack = nextAudioTrack ?? null;

        if (!nextAudioTrack) throw new Error("No audio track obtained");
        nextAudioTrack.onended = () => {
          handleLocalTrackEnded("audio", nextAudioTrack);
        };

        setLocalStream((prev) => {
          if (prev) {
            const newStream = new MediaStream(prev.getTracks());
            newStream.getAudioTracks().forEach((t) => {
              if (t.id === nextAudioTrack.id) return;
              stopLocalTrack(t);
              newStream.removeTrack(t);
            });
            if (!newStream.getAudioTracks().some((t) => t.id === nextAudioTrack.id)) {
              newStream.addTrack(nextAudioTrack);
            }
            return newStream;
          }
          return new MediaStream([nextAudioTrack]);
        });

        audioTrack = nextAudioTrack;
      }

      audioTrack.enabled = true;

      if (producer) {
        if (!producer.track || producer.track.id !== audioTrack.id) {
          await producer.replaceTrack({ track: audioTrack });
        }
        try {
          producer.resume();
        } catch {}
        const toggleResult = await emitToggleMute(producer.id, false);
        if (!toggleResult.ok) {
          const isTimeout = toggleResult.error === "toggleMute timeout";
          const producerDead =
            producer.closed || producer.track?.readyState !== "live";
          if (isTimeout && !producerDead) {
            // A slow/lost ACK on a healthy producer does NOT mean the producer
            // is broken: the SFU resumes its producer from the toggleMute event
            // itself (reliably delivered), not the ack. Keep the producer and
            // retry the toggle idempotently rather than recreating it — a
            // recreate fires producerClosed+newProducer and forces every
            // listener to re-consume (a multi-RTT audio gap, and a prime cause
            // of "I unmuted but nobody can hear me").
            console.warn(
              "[Meets] unmute ack timed out but producer is healthy — retrying toggle:",
              toggleResult.error
            );
            const retry = await emitToggleMute(producer.id, false);
            if (!retry.ok) {
              // The retry ALSO failed (likely a real disconnect/non-delivery,
              // not just a slow ack). Don't claim "unmuted" over a producer that
              // may still be paused server-side — recreate so a fresh, resumed
              // producer is published (or transport.produce() throws and we roll
              // back to muted below).
              console.warn(
                "[Meets] unmute retry also failed — recreating to be safe:",
                retry.error
              );
              resetAudioProducer(producer);
              producer = null;
            }
          } else {
            // An EXPLICIT server error (e.g. "Microphone producer not found")
            // or a dead local producer means the SFU has no live producer for
            // us — keeping it would leave us silently muted server-side. Tear
            // down + recreate so a fresh producer is published.
            console.warn(
              "[Meets] unmute failed (server error / dead producer) — recreating:",
              toggleResult.error
            );
            resetAudioProducer(producer);
            producer = null;
          }
        }
      }

      if (!producer) {
        const audioProducer = await transport.produce({
          track: audioTrack,
          codecOptions: {
            opusStereo: true,
            opusFec: true,
            opusDtx: false,
            opusMaxAverageBitrate: OPUS_MAX_AVERAGE_BITRATE,
          },
          appData: { type: "webcam" as ProducerType, paused: false },
        });

        audioProducerRef.current = audioProducer;
        const audioProducerId = audioProducer.id;
        audioProducer.on("transportclose", () => {
          if (audioProducerRef.current?.id === audioProducerId) {
            audioProducerRef.current = null;
          }
        });
      }
      setIsMuted(false);
    } catch (err) {
      console.error("[Meets] Failed to restart audio:", err);
      if (createdTrack) {
        stopLocalTrack(createdTrack);
        setLocalStream((prev) => {
          if (!prev) return prev;
          const remaining = prev
            .getTracks()
            .filter((track) => track !== createdTrack && track.kind !== "audio");
          return new MediaStream(remaining);
        });
      }
      setIsMuted(previousMuted);
      setMeetError(createMeetError(err, "MEDIA_ERROR"));
    } finally {
      toggleMuteInFlightRef.current = false;
      setIsMuteTogglePending(false);
    }
  }, [
    ghostEnabled,
    isObserverMode,
    isMuted,
    selectedAudioInputDeviceId,
    handleLocalTrackEnded,
    stopLocalTrack,
    buildAudioConstraints,
    socketRef,
    emitToggleMute,
    audioProducerRef,
    localStreamRef,
    setLocalStream,
    producerTransportRef,
    ensureProducerTransportRef,
    setIsMuted,
    setMeetError,
    OPUS_MAX_AVERAGE_BITRATE,
    resetAudioProducer,
    toggleMuteInFlightRef,
  ]);

  useEffect(() => {
    if (ghostEnabled || isObserverMode) return;
    if (connectionState !== "joined") return;
    if (isMuted) return;
    if (audioProducerRef.current) {
      const existingProducer = audioProducerRef.current;
      if (
        existingProducer.closed ||
        existingProducer.track?.readyState !== "live"
      ) {
        resetAudioProducer(existingProducer);
      } else {
        return;
      }
    }
    if (audioRecoveryInFlightRef.current) return;

    const transport = producerTransportRef.current;
    if (!transport) return;

    let cancelled = false;
    audioRecoveryInFlightRef.current = true;

    const recoverAudioProducer = async () => {
      let createdTrack: MediaStreamTrack | null = null;
      try {
        let audioTrack = localStreamRef.current?.getAudioTracks()[0] ?? null;

        if (!audioTrack || audioTrack.readyState !== "live") {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: buildAudioConstraints(selectedAudioInputDeviceId),
          });
          audioTrack = stream.getAudioTracks()[0] ?? null;
          createdTrack = audioTrack;
        }

        if (!audioTrack) {
          throw new Error("No audio track available for recovery");
        }

        audioTrack.onended = () => {
          handleLocalTrackEnded("audio", audioTrack);
        };

        if (createdTrack) {
          setLocalStream((prev) => {
            if (prev) {
              const next = new MediaStream(prev.getTracks());
              next.getAudioTracks().forEach((track) => {
                stopLocalTrack(track);
                next.removeTrack(track);
              });
              next.addTrack(audioTrack);
              return next;
            }
            return new MediaStream([audioTrack]);
          });
        }

        const audioProducer = await transport.produce({
          track: audioTrack,
          codecOptions: {
            opusStereo: true,
            opusFec: true,
            opusDtx: false,
            opusMaxAverageBitrate: OPUS_MAX_AVERAGE_BITRATE,
          },
          appData: { type: "webcam" as ProducerType, paused: false },
        });

        if (cancelled) {
          try {
            audioProducer.close();
          } catch {}
          return;
        }

        audioProducerRef.current = audioProducer;
        audioProducer.on("transportclose", () => {
          if (audioProducerRef.current?.id === audioProducer.id) {
            audioProducerRef.current = null;
          }
        });
      } catch (err) {
        console.error("[Meets] Audio producer recovery failed:", err);
        if (!cancelled) {
          const existingAudioTracks = localStreamRef.current?.getAudioTracks() ?? [];
          existingAudioTracks.forEach((track) => {
            stopLocalTrack(track);
          });
          setLocalStream((prev) => {
            if (!prev) return prev;
            const remaining = prev
              .getTracks()
              .filter((track) => track.kind !== "audio");
            return new MediaStream(remaining);
          });
          setIsMuted(true);
          setMeetError(createMeetError(err, "MEDIA_ERROR"));
        }
      } finally {
        audioRecoveryInFlightRef.current = false;
      }
    };

    void recoverAudioProducer();

    return () => {
      cancelled = true;
    };
  }, [
    ghostEnabled,
    isObserverMode,
    connectionState,
    isMuted,
    selectedAudioInputDeviceId,
    handleLocalTrackEnded,
    stopLocalTrack,
    buildAudioConstraints,
    producerTransportRef,
    audioProducerRef,
    localStreamRef,
    setLocalStream,
    setIsMuted,
    setMeetError,
    OPUS_MAX_AVERAGE_BITRATE,
    resetAudioProducer,
  ]);

  const toggleCamera = useCallback(async () => {
    if (ghostEnabled || isObserverMode) return;
    if (toggleCameraInFlightRef.current) return;
    toggleCameraInFlightRef.current = true;

    try {
      const producer = videoProducerRef.current;

      if (producer) {
        const newCameraOff = !isCameraOff;
        if (newCameraOff) {
          setIsCameraOff(true);
          socketRef.current?.emit(
            "closeProducer",
            { producerId: producer.id },
            (response: { success: boolean } | { error: string }) => {
              if ("error" in response) {
                console.error("[Meets] Failed to close video producer:", response);
              }
            }
          );
          try {
            producer.close();
          } catch {}
          videoProducerRef.current = null;

          setLocalStream((prev) => {
            if (!prev) return prev;
            prev.getVideoTracks().forEach((track) => {
              stopLocalTrack(track);
            });
            const remainingTracks = prev
              .getTracks()
              .filter((track) => track.kind !== "video");
            return new MediaStream(remainingTracks);
          });
          return;
        }

        if (producer.track?.readyState === "live") {
          producer.resume();
          setIsCameraOff(false);
          socketRef.current?.emit(
            "toggleCamera",
            { producerId: producer.id, paused: false },
            () => {}
          );
          return;
        }

        socketRef.current?.emit(
          "closeProducer",
          { producerId: producer.id },
          (response: { success: boolean } | { error: string }) => {
            if ("error" in response) {
              console.error(
                "[Meets] Failed to close stale video producer:",
                response
              );
            }
          }
        );
        try {
          producer.close();
        } catch {}
        videoProducerRef.current = null;
      }

      if (isCameraOff) {
        let createdTrack: MediaStreamTrack | null = null;
        try {
          void prewarmVideoEffectsAssets({
            segmentation: true,
            face: true,
            reason: "camera-toggle-live",
          });

          let transport = producerTransportRef.current;
          if (!transport || transport.closed) {
            const transportReady =
              (await ensureProducerTransportRef?.current?.()) ?? false;
            transport = producerTransportRef.current;
            if (!transportReady || !transport || transport.closed) {
              throw new Error("Video transport unavailable");
            }
          }
          if (!transport) {
            throw new Error("Video transport unavailable");
          }

          const stream = await navigator.mediaDevices.getUserMedia({
            video:
              videoQualityRef.current === "low"
                ? LOW_QUALITY_CONSTRAINTS
                : STANDARD_QUALITY_CONSTRAINTS,
          });
          const videoTrack = stream.getVideoTracks()[0];
          createdTrack = videoTrack ?? null;

          if (!videoTrack) throw new Error("No video track obtained");
          if ("contentHint" in videoTrack) {
            videoTrack.contentHint = "motion";
          }
          videoTrack.onended = () => {
            handleLocalTrackEnded("video", videoTrack);
          };

          const previousStream = localStreamRef.current;
          previousStream?.getVideoTracks().forEach((track) => {
            stopLocalTrack(track);
          });
          const remainingTracks =
            previousStream
              ?.getTracks()
              .filter((track) => track.kind !== "video") ?? [];
          const nextStream = new MediaStream([...remainingTracks, videoTrack]);
          localStreamRef.current = nextStream;
          setLocalStream(nextStream);
          const publishTrack = await waitForPreferredVideoPublishTrack(
            nextStream,
            videoTrack,
          );

          const quality = videoQualityRef.current;
          const preferredWebcamCodec = getPreferredWebcamCodec(deviceRef.current);
          const videoProducer = await produceWebcamTrack({
            transport,
            track: publishTrack,
            quality,
            paused: false,
            preferredCodec: preferredWebcamCodec,
          });

          videoProducerRef.current = videoProducer;
          const videoProducerId = videoProducer.id;
          videoProducer.on("transportclose", () => {
            if (videoProducerRef.current?.id === videoProducerId) {
              videoProducerRef.current = null;
            }
          });
          setIsCameraOff(false);
        } catch (err) {
          console.error("[Meets] Failed to restart video:", err);
          if (createdTrack) {
            stopLocalTrack(createdTrack);
            setLocalStream((prev) => {
              if (!prev) return prev;
              const remaining = prev
                .getTracks()
                .filter(
                  (track) => track !== createdTrack && track.kind !== "video",
                );
              return new MediaStream(remaining);
            });
          }
          setIsCameraOff(true);
          setMeetError(createMeetError(err, "MEDIA_ERROR"));
        }
      }
    } finally {
      toggleCameraInFlightRef.current = false;
    }
  }, [
    ghostEnabled,
    isObserverMode,
    isCameraOff,
    handleLocalTrackEnded,
    stopLocalTrack,
    socketRef,
    deviceRef,
    videoProducerRef,
    producerTransportRef,
    ensureProducerTransportRef,
    setLocalStream,
    localStreamRef,
    videoQualityRef,
    setIsCameraOff,
    setMeetError,
    waitForPreferredVideoPublishTrack,
  ]);

  useEffect(() => {
    if (ghostEnabled || isObserverMode) return;
    if (connectionState !== "joined") return;
    if (isCameraOff) return;

    let disposed = false;
    const requestRecovery = (reason: "initial" | "watchdog") => {
      if (disposed || cameraRecoveryInFlightRef.current) return;

      const producer = videoProducerRef.current;
      const producerTrack = producer?.track ?? null;
      const needsRecovery =
        !producer || producer.closed || producerTrack?.readyState !== "live";
      if (!needsRecovery) return;

      if (producer && videoProducerRef.current?.id === producer.id) {
        try {
          producer.close();
        } catch {}
        videoProducerRef.current = null;
      }

      console.warn("[Meets] Camera producer recovery triggered:", {
        reason,
        hasProducer: Boolean(producer),
        producerClosed: producer?.closed ?? null,
        producerId: producer?.id ?? null,
        trackId: producerTrack?.id ?? null,
        trackState: producerTrack?.readyState ?? null,
      });
      setCameraProducerRecoveryPulse((value) => value + 1);
    };

    const initialTimeout = window.setTimeout(
      () => requestRecovery("initial"),
      250,
    );
    const watchdogInterval = window.setInterval(
      () => requestRecovery("watchdog"),
      1500,
    );

    return () => {
      disposed = true;
      window.clearTimeout(initialTimeout);
      window.clearInterval(watchdogInterval);
    };
  }, [
    connectionState,
    ghostEnabled,
    isCameraOff,
    isObserverMode,
    videoProducerRef,
  ]);

  useEffect(() => {
    if (ghostEnabled || isObserverMode) return;
    if (connectionState !== "joined") return;
    if (isCameraOff) return;
    const existingProducer = videoProducerRef.current;
    const existingTrack = existingProducer?.track ?? null;
    if (
      existingProducer &&
      !existingProducer.closed &&
      existingTrack?.readyState === "live"
    ) {
      return;
    }
    if (existingProducer) {
      try {
        existingProducer.close();
      } catch {}
      if (videoProducerRef.current?.id === existingProducer.id) {
        videoProducerRef.current = null;
      }
    }
    if (cameraRecoveryInFlightRef.current) return;

    let cancelled = false;
    cameraRecoveryInFlightRef.current = true;

    const recoverCameraProducer = async () => {
      let createdTrack: MediaStreamTrack | null = null;
      try {
        let transport = producerTransportRef.current;
        if (!transport || transport.closed) {
          const transportReady =
            (await ensureProducerTransportRef?.current?.()) ?? false;
          transport = producerTransportRef.current;
          if (!transportReady || !transport || transport.closed) {
            throw new Error("Video transport unavailable");
          }
        }

        let videoTrack = localStreamRef.current?.getVideoTracks()[0] ?? null;

        if (!videoTrack || videoTrack.readyState !== "live") {
          const stream = await navigator.mediaDevices.getUserMedia({
            video:
              videoQualityRef.current === "low"
                ? LOW_QUALITY_CONSTRAINTS
                : STANDARD_QUALITY_CONSTRAINTS,
          });
          videoTrack = stream.getVideoTracks()[0] ?? null;
          createdTrack = videoTrack;
        }

        if (!videoTrack) {
          throw new Error("No video track available for recovery");
        }

        if ("contentHint" in videoTrack) {
          videoTrack.contentHint = "motion";
        }
        videoTrack.onended = () => {
          handleLocalTrackEnded("video", videoTrack);
        };

        if (createdTrack) {
          const previousStream = localStreamRef.current;
          previousStream?.getVideoTracks().forEach((track) => {
            stopLocalTrack(track);
          });
          const remainingTracks =
            previousStream
              ?.getTracks()
              .filter((track) => track.kind !== "video") ?? [];
          const nextStream = new MediaStream([...remainingTracks, videoTrack]);
          localStreamRef.current = nextStream;
          setLocalStream(nextStream);
        }

        const publishStream =
          localStreamRef.current ?? new MediaStream([videoTrack]);
        const publishTrack = await waitForPreferredVideoPublishTrack(
          publishStream,
          videoTrack,
        );
        const quality = videoQualityRef.current;
        const preferredWebcamCodec = getPreferredWebcamCodec(deviceRef.current);
        const recoveredProducer = await produceWebcamTrack({
          transport,
          track: publishTrack,
          quality,
          paused: false,
          preferredCodec: preferredWebcamCodec,
        });

        if (cancelled) {
          try {
            recoveredProducer.close();
          } catch {}
          return;
        }

        videoProducerRef.current = recoveredProducer;
        recoveredProducer.on("transportclose", () => {
          if (videoProducerRef.current?.id === recoveredProducer.id) {
            videoProducerRef.current = null;
            setCameraProducerRecoveryPulse((value) => value + 1);
          }
        });
        setIsCameraOff(false);
      } catch (err) {
        console.error("[Meets] Camera producer recovery failed:", err);
        if (!cancelled) {
          const existingVideoTracks = localStreamRef.current?.getVideoTracks() ?? [];
          existingVideoTracks.forEach((track) => {
            stopLocalTrack(track);
          });
          setLocalStream((prev) => {
            if (!prev) return prev;
            const remaining = prev
              .getTracks()
              .filter((track) => track.kind !== "video");
            return new MediaStream(remaining);
          });
          setIsCameraOff(true);
          setMeetError(createMeetError(err, "MEDIA_ERROR"));
        }
      } finally {
        cameraRecoveryInFlightRef.current = false;
      }
    };

    void recoverCameraProducer();

    return () => {
      cancelled = true;
    };
  }, [
    ghostEnabled,
    isObserverMode,
    connectionState,
    cameraProducerRecoveryPulse,
    isCameraOff,
    handleLocalTrackEnded,
    stopLocalTrack,
    setLocalStream,
    setIsCameraOff,
    setMeetError,
    producerTransportRef,
    ensureProducerTransportRef,
    deviceRef,
    videoProducerRef,
    localStreamRef,
    videoQualityRef,
    waitForPreferredVideoPublishTrack,
  ]);

  const toggleScreenShare = useCallback(async () => {
    if (ghostEnabled || isObserverMode) return;
    if (isScreenSharing) {
      const producer = screenProducerRef.current;
      const audioProducer = screenAudioProducerRef.current;
      if (producer) {
        socketRef.current?.emit(
          "closeProducer",
          { producerId: producer.id },
          () => {}
        );
        try {
          producer.close();
        } catch {}
        if (producer.track) {
          producer.track.onended = null;
        }
      }
      screenProducerRef.current = null;
      if (audioProducer) {
        socketRef.current?.emit(
          "closeProducer",
          { producerId: audioProducer.id },
          () => {}
        );
        try {
          audioProducer.close();
        } catch {}
        if (audioProducer.track) {
          audioProducer.track.onended = null;
        }
      }
      screenAudioProducerRef.current = null;
      setIsScreenSharing(false);
      return;
    }

    if (activeScreenShareId) {
      setMeetError({
        code: "UNKNOWN",
        message: "Someone else is already sharing their screen",
        recoverable: true,
      });
      return;
    }

    const transport = producerTransportRef.current;
    if (!transport) return;

    try {
      const videoConstraints: MediaTrackConstraints & {
        cursor?: "always" | "motion" | "never";
      } = {
        frameRate: { ideal: 30, max: 30 },
        width: { ideal: 1920, max: 3840 },
        height: { ideal: 1080, max: 2160 },
        cursor: "always",
      };

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: true,
      });
      const track = stream.getVideoTracks()[0];
      if (track && "contentHint" in track) {
        track.contentHint = "detail";
      }

      const preferredScreenShareCodec = getPreferredScreenShareCodec(
        deviceRef.current,
      );
      const producer = await transport.produce({
        track,
        encodings: [buildScreenShareEncoding()],
        ...(preferredScreenShareCodec ? { codec: preferredScreenShareCodec } : {}),
        appData: { type: "screen" as ProducerType },
      });

      screenProducerRef.current = producer;
      setIsScreenSharing(true);

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack && audioTrack.readyState === "live") {
        try {
          const audioProducer = await transport.produce({
            track: audioTrack,
            codecOptions: {
              opusStereo: true,
              opusFec: true,
              opusDtx: false,
              opusMaxAverageBitrate: SCREEN_AUDIO_OPUS_MAX_AVERAGE_BITRATE,
            },
            appData: { type: "screen" as ProducerType },
          });

          screenAudioProducerRef.current = audioProducer;
          const audioProducerId = audioProducer.id;
          audioProducer.on("transportclose", () => {
            if (screenAudioProducerRef.current?.id === audioProducerId) {
              screenAudioProducerRef.current = null;
            }
          });

          audioTrack.onended = () => {
            socketRef.current?.emit(
              "closeProducer",
              { producerId: audioProducer.id },
              () => {}
            );
            try {
              audioProducer.close();
            } catch {}
            if (screenAudioProducerRef.current?.id === audioProducer.id) {
              screenAudioProducerRef.current = null;
            }
          };
        } catch (audioErr) {
          console.warn("[Meets] Failed to share screen audio:", audioErr);
        }
      }

      track.onended = () => {
        socketRef.current?.emit(
          "closeProducer",
          { producerId: producer.id },
          () => {}
        );
        try {
          producer.close();
        } catch {}
        screenProducerRef.current = null;
        const currentAudioProducer = screenAudioProducerRef.current;
        if (currentAudioProducer) {
          socketRef.current?.emit(
            "closeProducer",
            { producerId: currentAudioProducer.id },
            () => {}
          );
          try {
            currentAudioProducer.close();
          } catch {}
          if (currentAudioProducer.track) {
            currentAudioProducer.track.onended = null;
          }
          screenAudioProducerRef.current = null;
        }
        setIsScreenSharing(false);
      };
    } catch (err) {
      if ((err as Error).name === "NotAllowedError") {
        console.log("[Meets] Screen share cancelled by user");
      } else {
        console.error("[Meets] Error starting screen share:", err);
        setMeetError(createMeetError(err, "MEDIA_ERROR"));
      }
    }
  }, [
    ghostEnabled,
    isObserverMode,
    isScreenSharing,
    activeScreenShareId,
    setIsScreenSharing,
    producerTransportRef,
    screenProducerRef,
    screenAudioProducerRef,
    socketRef,
    setMeetError,
    OPUS_MAX_AVERAGE_BITRATE,
  ]);

  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream, localStreamRef]);

  return {
    mediaState,
    showPermissionHint,
    isMuteTogglePending,
    requestMediaPermissions,
    handleAudioInputDeviceChange,
    handleVideoInputDeviceChange,
    handleAudioOutputDeviceChange,
    updateVideoQuality,
    updateVideoQualityRef,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    stopLocalTrack,
    handleLocalTrackEnded,
    primeAudioOutput,
    playNotificationSound,
  };
}
