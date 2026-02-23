"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import {
  DEFAULT_AUDIO_CONSTRAINTS,
  LOW_QUALITY_CONSTRAINTS,
  OPUS_MAX_AVERAGE_BITRATE,
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
import {
  buildWebcamSimulcastEncodings,
  buildScreenShareEncoding,
  buildWebcamSingleLayerEncoding,
} from "../lib/video-encodings";

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
  socketRef: React.MutableRefObject<Socket | null>;
  producerTransportRef: React.MutableRefObject<Transport | null>;
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
  socketRef,
  producerTransportRef,
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
  const buildAudioConstraints = useCallback(
    (deviceId?: string): MediaTrackConstraints => ({
      ...DEFAULT_AUDIO_CONSTRAINTS,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    }),
    []
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
    (type: "join" | "leave" | "waiting") => {
      const audioContext = getAudioContext();
      if (!audioContext) return;

      if (audioContext.state === "suspended") {
        audioContext.resume().catch(() => {});
      }

      const now = audioContext.currentTime;
      const frequencies =
        type === "join"
          ? [523.25, 659.25]
          : type === "waiting"
          ? [440.0, 523.25, 659.25]
          : [392.0, 261.63];
      const duration = type === "waiting" ? 0.1 : 0.12;
      const gap = 0.03;

      frequencies.forEach((frequency, index) => {
        const start = now + index * (duration + gap);
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;

        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.16, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start(start);
        oscillator.stop(start + duration + 0.02);
      });
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
        const timeout = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({ ok: false, error: "toggleMute timeout" });
        }, 1500);

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

      const audioConstraints = buildAudioConstraints(
        selectedAudioInputDeviceId
      );

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: isCameraOff ? false : videoConstraints,
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

          const oldVideoTrack = localStream.getVideoTracks()[0];
          if (oldVideoTrack) {
            stopLocalTrack(oldVideoTrack);
            localStream.removeTrack(oldVideoTrack);
          }
          localStream.addTrack(newVideoTrack);
          setLocalStream(new MediaStream(localStream.getTracks()));
          nextVideoTrack = newVideoTrack;
        }

        const transport = producerTransportRef.current;
        const previousProducer = videoProducerRef.current;

        if (!transport || !nextVideoTrack) {
          return;
        }

        let nextProducer: Producer;
        try {
          nextProducer = await transport.produce({
            track: nextVideoTrack,
            encodings: buildWebcamSimulcastEncodings(quality),
            appData: { type: "webcam" as ProducerType, paused: false },
          });
        } catch (simulcastError) {
          console.warn(
            "[Meets] Simulcast video quality update failed, retrying single-layer:",
            simulcastError
          );
          nextProducer = await transport.produce({
            track: nextVideoTrack,
            encodings: [buildWebcamSingleLayerEncoding(quality)],
            appData: { type: "webcam" as ProducerType, paused: false },
          });
        }

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
      producerTransportRef,
      videoProducerRef,
    ]
  );

  useEffect(() => {
    updateVideoQualityRef.current = updateVideoQuality;
  }, [updateVideoQuality]);

  const toggleMute = useCallback(async () => {
    if (ghostEnabled || isObserverMode) return;
    const previousMuted = isMuted;
    const nextMuted = !previousMuted;
    let producer = audioProducerRef.current;

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
        void emitToggleMute(producer.id, true);
      }
      setIsMuted(true);
      return;
    }

    let createdTrack: MediaStreamTrack | null = null;
    try {
      const transport = producerTransportRef.current;
      if (!transport) {
        setIsMuted(previousMuted);
        return;
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
          console.warn(
            "[Meets] toggleMute failed, restarting audio producer:",
            toggleResult.error
          );
          resetAudioProducer(producer);
          producer = null;
        }
      }

      if (!producer) {
        const audioProducer = await transport.produce({
          track: audioTrack,
          codecOptions: {
            opusStereo: true,
            opusFec: true,
            opusDtx: true,
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
    setIsMuted,
    setMeetError,
    OPUS_MAX_AVERAGE_BITRATE,
    resetAudioProducer,
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
            opusDtx: true,
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
        const transport = producerTransportRef.current;
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

        setLocalStream((prev) => {
          if (prev) {
            prev.getVideoTracks().forEach((track) => {
              stopLocalTrack(track);
            });
            const remainingTracks = prev
              .getTracks()
              .filter((track) => track.kind !== "video");
            return new MediaStream([...remainingTracks, videoTrack]);
          }
          return new MediaStream([videoTrack]);
        });

        const quality = videoQualityRef.current;
        let videoProducer;
        try {
          videoProducer = await transport.produce({
            track: videoTrack,
            encodings: buildWebcamSimulcastEncodings(quality),
            appData: { type: "webcam" as ProducerType, paused: false },
          });
        } catch (simulcastError) {
          console.warn(
            "[Meets] Simulcast video restart failed, retrying single-layer:",
            simulcastError
          );
          videoProducer = await transport.produce({
            track: videoTrack,
            encodings: [buildWebcamSingleLayerEncoding(quality)],
            appData: { type: "webcam" as ProducerType, paused: false },
          });
        }

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
              .filter((track) => track !== createdTrack && track.kind !== "video");
            return new MediaStream(remaining);
          });
        }
        setIsCameraOff(true);
        setMeetError(createMeetError(err, "MEDIA_ERROR"));
      }
    }
  }, [
    ghostEnabled,
    isObserverMode,
    isCameraOff,
    handleLocalTrackEnded,
    stopLocalTrack,
    socketRef,
    videoProducerRef,
    producerTransportRef,
    setLocalStream,
    videoQualityRef,
    setIsCameraOff,
    setMeetError,
  ]);

  useEffect(() => {
    if (ghostEnabled || isObserverMode) return;
    if (connectionState !== "joined") return;
    if (isCameraOff) return;
    if (videoProducerRef.current) return;
    if (cameraRecoveryInFlightRef.current) return;

    const transport = producerTransportRef.current;
    if (!transport) return;

    let cancelled = false;
    cameraRecoveryInFlightRef.current = true;

    const recoverCameraProducer = async () => {
      let createdTrack: MediaStreamTrack | null = null;
      try {
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
          setLocalStream((prev) => {
            if (prev) {
              prev.getVideoTracks().forEach((track) => {
                stopLocalTrack(track);
              });
              const remaining = prev
                .getTracks()
                .filter((track) => track.kind !== "video");
              return new MediaStream([...remaining, videoTrack]);
            }
            return new MediaStream([videoTrack]);
          });
        }

        const quality = videoQualityRef.current;
        let recoveredProducer: Producer;
        try {
          recoveredProducer = await transport.produce({
            track: videoTrack,
            encodings: buildWebcamSimulcastEncodings(quality),
            appData: { type: "webcam" as ProducerType, paused: false },
          });
        } catch (simulcastError) {
          console.warn(
            "[Meets] Simulcast camera recovery failed, retrying single-layer:",
            simulcastError
          );
          recoveredProducer = await transport.produce({
            track: videoTrack,
            encodings: [buildWebcamSingleLayerEncoding(quality)],
            appData: { type: "webcam" as ProducerType, paused: false },
          });
        }

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
          }
        });
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
    isCameraOff,
    handleLocalTrackEnded,
    stopLocalTrack,
    setLocalStream,
    setIsCameraOff,
    setMeetError,
    producerTransportRef,
    videoProducerRef,
    localStreamRef,
    videoQualityRef,
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
        frameRate: { ideal: 24, max: 24 },
        width: { ideal: 1600, max: 1920 },
        height: { ideal: 900, max: 1080 },
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

      const producer = await transport.produce({
        track,
        encodings: [buildScreenShareEncoding()],
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
              opusDtx: true,
              opusMaxAverageBitrate: OPUS_MAX_AVERAGE_BITRATE,
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
    requestMediaPermissions,
    handleAudioInputDeviceChange,
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
