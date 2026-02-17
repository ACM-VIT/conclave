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
  buildWebcamSingleLayerEncoding,
} from "../lib/video-encodings";

interface UseMeetMediaOptions {
  ghostEnabled: boolean;
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
  localStreamRef: React.MutableRefObject<MediaStream | null>;
  intentionalTrackStopsRef: React.MutableRefObject<
    WeakSet<MediaStreamTrack>
  >;
  permissionHintTimeoutRef: React.MutableRefObject<number | null>;
  audioContextRef: React.MutableRefObject<AudioContext | null>;
}

export function useMeetMedia({
  ghostEnabled,
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
            return;
          } catch (err) {
            console.warn(
              "[Meets] applyConstraints failed, reopening camera:",
              err
            );
          }
        }

        const newStream = await navigator.mediaDevices.getUserMedia({
          video: constraints,
        });
        const newVideoTrack = newStream.getVideoTracks()[0];
        if (newVideoTrack && "contentHint" in newVideoTrack) {
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

        const producer = videoProducerRef.current;
        if (producer) {
          await producer.replaceTrack({ track: newVideoTrack });
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
      videoProducerRef,
    ]
  );

  useEffect(() => {
    updateVideoQualityRef.current = updateVideoQuality;
  }, [updateVideoQuality]);

  const toggleMute = useCallback(async () => {
    if (ghostEnabled) return;
    let producer = audioProducerRef.current;
    const nextMuted = !isMuted;

    if (producer && producer.track?.readyState !== "live") {
      socketRef.current?.emit(
        "closeProducer",
        { producerId: producer.id },
        () => {}
      );
      try {
        producer.close();
      } catch {}
      audioProducerRef.current = null;
      producer = null;
    }

    if (nextMuted) {
      const currentTrack = localStreamRef.current?.getAudioTracks()[0];
      if (currentTrack) {
        stopLocalTrack(currentTrack);
      }

      setLocalStream((prev) => {
        if (!prev) return prev;
        const remaining = prev
          .getTracks()
          .filter((track) => track.kind !== "audio");
        return new MediaStream(remaining);
      });

      if (producer) {
        try {
          await producer.replaceTrack({ track: null });
        } catch (err) {
          console.warn("[Meets] Failed to detach audio track:", err);
        }
        try {
          producer.pause();
        } catch {}
        socketRef.current?.emit(
          "toggleMute",
          { producerId: producer.id, paused: true },
          () => {}
        );
      }

      setIsMuted(true);
      return;
    }

    try {
      const transport = producerTransportRef.current;
      if (!transport) return;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: buildAudioConstraints(selectedAudioInputDeviceId),
      });
      const audioTrack = stream.getAudioTracks()[0];

      if (!audioTrack) throw new Error("No audio track obtained");
      audioTrack.onended = () => {
        handleLocalTrackEnded("audio", audioTrack);
      };

      setLocalStream((prev) => {
        if (prev) {
          const newStream = new MediaStream(prev.getTracks());
          newStream.getAudioTracks().forEach((t) => {
            stopLocalTrack(t);
            newStream.removeTrack(t);
          });
          newStream.addTrack(audioTrack);
          return newStream;
        }
        return new MediaStream([audioTrack]);
      });

      if (producer) {
        await producer.replaceTrack({ track: audioTrack });
        try {
          producer.resume();
        } catch {}
        socketRef.current?.emit(
          "toggleMute",
          { producerId: producer.id, paused: false },
          () => {}
        );
      } else {
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
        audioProducer.on("transportclose", () => {
          audioProducerRef.current = null;
        });
      }

      setIsMuted(false);
    } catch (err) {
      console.error("[Meets] Failed to restart audio:", err);
      setIsMuted(true);
      setMeetError(createMeetError(err, "MEDIA_ERROR"));
    }
  }, [
    ghostEnabled,
    isMuted,
    selectedAudioInputDeviceId,
    handleLocalTrackEnded,
    stopLocalTrack,
    buildAudioConstraints,
    socketRef,
    audioProducerRef,
    localStreamRef,
    setLocalStream,
    producerTransportRef,
    setIsMuted,
    setMeetError,
    OPUS_MAX_AVERAGE_BITRATE,
  ]);

  const toggleCamera = useCallback(async () => {
    if (ghostEnabled) return;
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
      try {
        setIsCameraOff(false);
        const transport = producerTransportRef.current;
        if (!transport) return;

        const stream = await navigator.mediaDevices.getUserMedia({
          video:
            videoQualityRef.current === "low"
              ? LOW_QUALITY_CONSTRAINTS
              : STANDARD_QUALITY_CONSTRAINTS,
        });
        const videoTrack = stream.getVideoTracks()[0];

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
        videoProducer.on("transportclose", () => {
          videoProducerRef.current = null;
        });
      } catch (err) {
        console.error("[Meets] Failed to restart video:", err);
        setIsCameraOff(true);
        setMeetError(createMeetError(err, "MEDIA_ERROR"));
      }
    }
  }, [
    ghostEnabled,
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

  const toggleScreenShare = useCallback(async () => {
    if (ghostEnabled) return;
    if (isScreenSharing) {
      const producer = screenProducerRef.current;
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
        frameRate: { ideal: 30, max: 60 },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
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
        encodings: [{ maxBitrate: 2500000 }],
        appData: { type: "screen" as ProducerType },
      });

      screenProducerRef.current = producer;
      setIsScreenSharing(true);

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
    isScreenSharing,
    activeScreenShareId,
    setIsScreenSharing,
    producerTransportRef,
    screenProducerRef,
    socketRef,
    setMeetError,
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
