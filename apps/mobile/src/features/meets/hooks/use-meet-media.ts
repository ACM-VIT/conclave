import { useCallback, useEffect, useRef, useState } from "react";
import { PermissionsAndroid, Platform, type Permission } from "react-native";
import type { Socket } from "socket.io-client";
import { mediaDevices } from "react-native-webrtc";
import {
  DEFAULT_AUDIO_CONSTRAINTS,
  LOW_QUALITY_CONSTRAINTS,
  OPUS_MAX_AVERAGE_BITRATE,
  STANDARD_QUALITY_CONSTRAINTS,
} from "../constants";
import type {
  MediaState,
  MeetError,
  Producer,
  ProducerType,
  Transport,
  VideoQuality,
} from "../types";
import { createMeetError } from "../utils";
import {
  buildWebcamSimulcastEncodings,
  buildWebcamSingleLayerEncoding,
} from "../video-encodings";
import { setAudioRoute } from "@/lib/call-service";

const ANDROID_BLUETOOTH_CONNECT_PERMISSION =
  "android.permission.BLUETOOTH_CONNECT" as Permission;

const shouldRequestBluetoothConnectPermission = () =>
  Platform.OS === "android" &&
  typeof Platform.Version === "number" &&
  Platform.Version >= 31;

interface UseMeetMediaOptions {
  ghostEnabled: boolean;
  connectionState: string;
  isMuted: boolean;
  setIsMuted: (value: boolean) => void;
  isCameraOff: boolean;
  setIsCameraOff: (value: boolean) => void;
  isScreenSharing: boolean;
  setIsScreenSharing: (value: boolean) => void;
  setScreenShareStream: (stream: MediaStream | null) => void;
  screenShareStreamRef: React.MutableRefObject<MediaStream | null>;
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
  permissionHintTimeoutRef: React.MutableRefObject<
    ReturnType<typeof setTimeout> | null
  >;
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
  setScreenShareStream,
  screenShareStreamRef,
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
    permissionsReady: false,
  });
  const [showPermissionHint, setShowPermissionHint] = useState(false);
  const updateVideoQualityRef = useRef<
    (quality: VideoQuality) => Promise<void>
  >(async () => {});
  const keepAliveOscRef = useRef<OscillatorNode | null>(null);
  const keepAliveGainRef = useRef<GainNode | null>(null);
  const syncPermissionState = useCallback(async () => {
    if (Platform.OS !== "android") {
      setMediaState((prev) => ({
        ...prev,
        hasAudioPermission: true,
        hasVideoPermission: true,
        permissionsReady: true,
      }));
      return { audioGranted: true, videoGranted: true };
    }

    try {
      const [audioGranted, videoGranted] = await Promise.all([
        PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO),
        PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA),
      ]);
      setMediaState((prev) => ({
        ...prev,
        hasAudioPermission: audioGranted,
        hasVideoPermission: videoGranted,
        permissionsReady: true,
      }));
      return { audioGranted, videoGranted };
    } catch {
      setMediaState((prev) => ({
        ...prev,
        permissionsReady: true,
      }));
      return { audioGranted: false, videoGranted: false };
    }
  }, []);

  useEffect(() => {
    void syncPermissionState();
  }, [syncPermissionState]);
  const buildAudioConstraints = useCallback(
    (deviceId?: string): MediaTrackConstraints => ({
      ...DEFAULT_AUDIO_CONSTRAINTS,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    }),
    []
  );
  const getUserMedia = useCallback(
    async (
      constraints:
        | Parameters<typeof mediaDevices.getUserMedia>[0]
        | MediaStreamConstraints
    ) => {
      if (mediaDevices?.getUserMedia) {
        return mediaDevices.getUserMedia(
          constraints as Parameters<typeof mediaDevices.getUserMedia>[0]
        );
      }
      const fallback = globalThis.navigator?.mediaDevices?.getUserMedia;
      if (fallback) {
        return fallback.call(
          globalThis.navigator?.mediaDevices,
          constraints as MediaStreamConstraints
        );
      }
      throw new Error("getUserMedia is not available");
    },
    []
  );
  const requestAndroidPermissions = useCallback(
    async (options: { audio?: boolean; video?: boolean }) => {
      if (Platform.OS !== "android") {
        return {
          audio: options.audio ? true : false,
          video: options.video ? true : false,
        };
      }

      const permissions: Permission[] = [];
      if (options.audio) {
        permissions.push(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
        if (shouldRequestBluetoothConnectPermission()) {
          permissions.push(ANDROID_BLUETOOTH_CONNECT_PERMISSION);
        }
      }
      if (options.video) {
        permissions.push(PermissionsAndroid.PERMISSIONS.CAMERA);
      }
      if (!permissions.length) {
        return { audio: false, video: false };
      }

      const results = await PermissionsAndroid.requestMultiple(permissions);
      const audioGranted = options.audio
        ? results[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] ===
          PermissionsAndroid.RESULTS.GRANTED
        : false;
      const videoGranted = options.video
        ? results[PermissionsAndroid.PERMISSIONS.CAMERA] ===
          PermissionsAndroid.RESULTS.GRANTED
        : false;
      const bluetoothStatus = results[ANDROID_BLUETOOTH_CONNECT_PERMISSION];
      if (
        options.audio &&
        shouldRequestBluetoothConnectPermission() &&
        bluetoothStatus &&
        bluetoothStatus !== PermissionsAndroid.RESULTS.GRANTED
      ) {
        console.warn(
          "[Permissions] Bluetooth permission denied; headset audio routing may be unavailable"
        );
      }
      return {
        audio: audioGranted,
        video: videoGranted,
      };
    },
    []
  );
  const getDisplayMedia = useCallback(async () => {
    const display = mediaDevices?.getDisplayMedia;
    if (display) {
      return display.call(mediaDevices);
    }
    return null;
  }, []);

  const collectRtcStatsEntries = useCallback((report: RTCStatsReport) => {
    const entries: Array<{
      type?: string;
      kind?: string;
      mediaType?: string;
      bytesSent?: number;
      framesSent?: number;
      framesEncoded?: number;
    }> = [];
    const maybeReport = report as RTCStatsReport & {
      values?: () => IterableIterator<unknown>;
      forEach?: (cb: (value: unknown) => void) => void;
    };

    if (typeof maybeReport.values === "function") {
      for (const value of maybeReport.values()) {
        if (value && typeof value === "object") {
          entries.push(value as (typeof entries)[number]);
        }
      }
      return entries;
    }

    if (typeof maybeReport.forEach === "function") {
      maybeReport.forEach((value: unknown) => {
        if (value && typeof value === "object") {
          entries.push(value as (typeof entries)[number]);
        }
      });
    }

    return entries;
  }, []);

  const getOutboundVideoProgress = useCallback(
    (report: RTCStatsReport) => {
      let bytesSent = 0;
      let framesSent = 0;
      let foundVideoOutbound = false;

      for (const stats of collectRtcStatsEntries(report)) {
        if (stats.type !== "outbound-rtp") continue;
        const mediaType = stats.kind || stats.mediaType;
        if (mediaType !== "video") continue;
        foundVideoOutbound = true;
        if (typeof stats.bytesSent === "number") {
          bytesSent += stats.bytesSent;
        }
        if (typeof stats.framesSent === "number") {
          framesSent += stats.framesSent;
        } else if (typeof stats.framesEncoded === "number") {
          framesSent += stats.framesEncoded;
        }
      }

      if (!foundVideoOutbound) {
        return null;
      }

      return { bytesSent, framesSent };
    },
    [collectRtcStatsEntries]
  );

  const waitForOutgoingScreenFrames = useCallback(
    async (producer: Producer) => {
      const timeoutMs = Platform.OS === "ios" ? 7000 : 4500;
      const pollMs = 350;
      const deadline = Date.now() + timeoutMs;
      let seenOutboundStats = false;
      let previousBytesSent = 0;

      while (Date.now() < deadline) {
        const track = producer.track;
        if (producer.closed || !track || track.readyState === "ended") {
          throw new Error("Screen share ended before capture started.");
        }

        try {
          const stats = await producer.getStats();
          const progress = getOutboundVideoProgress(stats);
          if (progress) {
            seenOutboundStats = true;
            if (progress.framesSent > 0) {
              return;
            }
            if (progress.bytesSent > previousBytesSent + 1024) {
              return;
            }
            previousBytesSent = Math.max(previousBytesSent, progress.bytesSent);
          }
        } catch (statsError) {
          console.warn(
            "[Meets] Screen share stats unavailable; skipping startup verification:",
            statsError
          );
          return;
        }

        await new Promise<void>((resolve) => {
          setTimeout(resolve, pollMs);
        });
      }

      if (seenOutboundStats) {
        throw new Error("No screen frames were captured.");
      }
      console.warn(
        "[Meets] Screen share startup stats were unavailable; continuing without verification."
      );
    },
    [getOutboundVideoProgress]
  );

  const getAudioContext = useCallback(() => {
    const AudioContextConstructor =
      globalThis.AudioContext ||
      (globalThis as typeof globalThis & {
        webkitAudioContext?: typeof AudioContext;
      }).webkitAudioContext;

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

  const startAudioKeepAlive = useCallback(() => {
    const audioContext = getAudioContext();
    if (!audioContext) return;

    if (audioContext.state === "suspended") {
      audioContext.resume().catch(() => {});
    }

    if (keepAliveOscRef.current || keepAliveGainRef.current) return;

    try {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 30;
      gain.gain.value = 0.0001;
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start();
      keepAliveOscRef.current = oscillator;
      keepAliveGainRef.current = gain;
    } catch (error) {
      console.warn("[Meets] Failed to start audio keepalive:", error);
    }
  }, [getAudioContext]);

  const stopAudioKeepAlive = useCallback(() => {
    if (keepAliveOscRef.current) {
      try {
        keepAliveOscRef.current.stop();
      } catch {}
      keepAliveOscRef.current.disconnect();
      keepAliveOscRef.current = null;
    }
    if (keepAliveGainRef.current) {
      keepAliveGainRef.current.disconnect();
      keepAliveGainRef.current = null;
    }
  }, []);

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

      const cleanupTrack = () => {
        setLocalStream((prev) => {
          if (!prev) return prev;
          const remaining = prev.getTracks().filter((t) => t.kind !== kind);
          return new MediaStream(remaining);
        });
      };

      const closeProducer = () => {
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
      };

      if (kind === "audio" && connectionState === "joined" && !ghostEnabled && !isMuted) {
        void (async () => {
          try {
            const permissionState = await requestAndroidPermissions({ audio: true });
            if (!permissionState.audio) {
              closeProducer();
              cleanupTrack();
              return;
            }

            let recoveredStream: MediaStream | null = null;
            try {
              recoveredStream = await getUserMedia({
                audio: buildAudioConstraints(selectedAudioInputDeviceId),
              });
            } catch (err) {
              if (selectedAudioInputDeviceId) {
                try {
                  recoveredStream = await getUserMedia({
                    audio: buildAudioConstraints(),
                  });
                  setSelectedAudioInputDeviceId("");
                } catch {
                  recoveredStream = null;
                }
              }
              if (!recoveredStream) {
                throw err;
              }
            }

            const newAudioTrack = recoveredStream.getAudioTracks()[0];
            if (!newAudioTrack) {
              closeProducer();
              cleanupTrack();
              return;
            }

            newAudioTrack.onended = () => {
              handleLocalTrackEnded("audio", newAudioTrack);
            };

            const producer = audioProducerRef.current;
            if (producer) {
              await producer.replaceTrack({ track: newAudioTrack });
              try {
                producer.resume();
              } catch {}
              socketRef.current?.emit(
                "toggleMute",
                { producerId: producer.id, paused: false },
                () => {}
              );
            }

            setLocalStream((prev) => {
              if (prev) {
                const remaining = prev.getTracks().filter((t) => t.kind !== "audio");
                return new MediaStream([...remaining, newAudioTrack]);
              }
              return new MediaStream([newAudioTrack]);
            });

            setIsMuted(false);
            return;
          } catch (err) {
            console.error("[Meets] Failed to recover audio track:", err);
            closeProducer();
            cleanupTrack();
          }
        })();
        return;
      }

      if (kind === "video" && connectionState === "joined" && !ghostEnabled && !isCameraOff) {
        void (async () => {
          try {
            const permissionState = await requestAndroidPermissions({ video: true });
            if (!permissionState.video) {
              closeProducer();
              cleanupTrack();
              return;
            }

            const constraints =
              videoQualityRef.current === "low"
                ? LOW_QUALITY_CONSTRAINTS
                : STANDARD_QUALITY_CONSTRAINTS;

            const recoveredStream = await getUserMedia({ video: constraints });
            const newVideoTrack = recoveredStream.getVideoTracks()[0];
            if (!newVideoTrack) {
              closeProducer();
              cleanupTrack();
              return;
            }

            if ("contentHint" in newVideoTrack) {
              newVideoTrack.contentHint = "motion";
            }

            newVideoTrack.onended = () => {
              handleLocalTrackEnded("video", newVideoTrack);
            };

            const producer = videoProducerRef.current;
            if (producer) {
              await producer.replaceTrack({ track: newVideoTrack });
              try {
                producer.resume();
              } catch {}
            }

            setLocalStream((prev) => {
              if (prev) {
                const remaining = prev.getTracks().filter((t) => t.kind !== "video");
                return new MediaStream([...remaining, newVideoTrack]);
              }
              return new MediaStream([newVideoTrack]);
            });

            setIsCameraOff(false);
            return;
          } catch (err) {
            console.error("[Meets] Failed to recover video track:", err);
            closeProducer();
            cleanupTrack();
          }
        })();
        return;
      }

      closeProducer();
      cleanupTrack();
    },
    [
      consumeIntentionalStop,
      connectionState,
      ghostEnabled,
      isMuted,
      isCameraOff,
      requestAndroidPermissions,
      getUserMedia,
      buildAudioConstraints,
      selectedAudioInputDeviceId,
      setSelectedAudioInputDeviceId,
      videoQualityRef,
      setIsMuted,
      setIsCameraOff,
      setLocalStream,
      audioProducerRef,
      videoProducerRef,
      socketRef,
    ]
  );

  const requestMediaPermissions = useCallback(
    async (options?: { forceVideo?: boolean }): Promise<MediaStream | null> => {
    if (permissionHintTimeoutRef.current) {
      clearTimeout(permissionHintTimeoutRef.current);
    }
    setShowPermissionHint(false);
    permissionHintTimeoutRef.current = setTimeout(() => {
      setShowPermissionHint(true);
    }, 450);

    try {
      const needsVideo = options?.forceVideo ? true : !isCameraOff;
      const permissionState = await requestAndroidPermissions({
        audio: true,
        video: needsVideo,
      });
      const audioAllowed = permissionState.audio;
      const videoAllowed = needsVideo ? permissionState.video : false;

      if (!audioAllowed) {
        setIsMuted(true);
      }
      if (needsVideo && !videoAllowed) {
        setIsCameraOff(true);
      }

      if (!audioAllowed && !videoAllowed) {
        setMeetError({
          code: "PERMISSION_DENIED",
          message: needsVideo
            ? "Camera/microphone permission denied"
            : "Microphone permission denied",
          recoverable: true,
        });
        return null;
      }
      if (!audioAllowed || (needsVideo && !videoAllowed)) {
        setMeetError({
          code: "PERMISSION_DENIED",
          message: !audioAllowed
            ? "Microphone permission denied"
            : "Camera permission denied",
          recoverable: true,
        });
      }

      const videoConstraints =
        videoQuality === "low"
          ? { ...LOW_QUALITY_CONSTRAINTS }
          : { ...STANDARD_QUALITY_CONSTRAINTS };

      const audioConstraints = buildAudioConstraints(
        selectedAudioInputDeviceId
      );

      const stream = await getUserMedia({
        audio: audioAllowed ? audioConstraints : false,
        video: needsVideo && videoAllowed ? videoConstraints : false,
      });

      await syncPermissionState();

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
          const permissionState = await requestAndroidPermissions({
            audio: true,
          });
          if (!permissionState.audio) {
            setIsMuted(true);
            return null;
          }

          const audioOnlyConstraints = buildAudioConstraints(
            selectedAudioInputDeviceId
          );

          const audioStream = await getUserMedia({
            audio: audioOnlyConstraints,
          });
          const audioTrack = audioStream.getAudioTracks()[0];
          if (audioTrack) {
            audioTrack.onended = () => {
              handleLocalTrackEnded("audio", audioTrack);
            };
          }
          await syncPermissionState();
          setIsCameraOff(true);
          return audioStream;
        } catch {
          return null;
        }
      }
      return null;
    } finally {
      if (permissionHintTimeoutRef.current) {
        clearTimeout(permissionHintTimeoutRef.current);
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
    requestAndroidPermissions,
    syncPermissionState,
  ]);

  const handleAudioInputDeviceChange = useCallback(
    async (deviceId: string) => {
      setSelectedAudioInputDeviceId(deviceId);

      if (connectionState === "joined") {
        try {
          const newStream = await getUserMedia({
            audio: buildAudioConstraints(deviceId),
          });

          const newAudioTrack = newStream.getAudioTracks()[0];
          if (newAudioTrack) {
            newAudioTrack.onended = () => {
              handleLocalTrackEnded("audio", newAudioTrack);
            };
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
    (deviceId: string) => {
      setSelectedAudioOutputDeviceId(deviceId);

      if (deviceId === "route:speaker") {
        setAudioRoute("speaker");
        return;
      }
      if (deviceId === "route:earpiece") {
        setAudioRoute("earpiece");
        return;
      }
      if (deviceId === "route:auto") {
        setAudioRoute("auto");
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
          const newStream = await getUserMedia({
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
    if (ghostEnabled) return;
    const previousMuted = isMuted;
    const nextMuted = !previousMuted;
    setIsMuted(nextMuted);

    let producer = audioProducerRef.current;
    const transport = producerTransportRef.current;

    if (!transport) {
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
        return;
      }

      try {
        const permissionState = await requestAndroidPermissions({
          audio: true,
        });
        if (!permissionState.audio) {
          setIsMuted(previousMuted);
          setMeetError({
            code: "PERMISSION_DENIED",
            message: "Microphone permission denied",
            recoverable: true,
          });
          return;
        }

        const stream = await getUserMedia({
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
      } catch (err) {
        console.error("[Meets] Failed to enable audio preview:", err);
        setIsMuted(previousMuted);
        setMeetError(createMeetError(err, "MEDIA_ERROR"));
      }
      return;
    }

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
      if (currentTrack && currentTrack.readyState === "live") {
        currentTrack.enabled = false;
      }

      if (producer) {
        try {
          producer.pause();
        } catch {}
        socketRef.current?.emit(
          "toggleMute",
          { producerId: producer.id, paused: true },
          () => {}
        );
      }
      return;
    }

    try {
      if (!transport) return;

      let audioTrack = localStreamRef.current?.getAudioTracks()[0] ?? null;

      if (audioTrack && audioTrack.readyState !== "live") {
        stopLocalTrack(audioTrack);
        audioTrack = null;
      }

      if (!audioTrack) {
        const permissionState = await requestAndroidPermissions({
          audio: true,
        });
        if (!permissionState.audio) {
          setIsMuted(previousMuted);
          setMeetError({
            code: "PERMISSION_DENIED",
            message: "Microphone permission denied",
            recoverable: true,
          });
          return;
        }

        const stream = await getUserMedia({
          audio: buildAudioConstraints(selectedAudioInputDeviceId),
        });
        const nextAudioTrack = stream.getAudioTracks()[0];

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
        const audioProducerId = audioProducer.id;
        audioProducer.on("transportclose", () => {
          if (audioProducerRef.current?.id === audioProducerId) {
            audioProducerRef.current = null;
          }
        });
      }
    } catch (err) {
      console.error("[Meets] Failed to restart audio:", err);
      setIsMuted(previousMuted);
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
    requestAndroidPermissions,
  ]);

  const toggleCamera = useCallback(async () => {
    if (ghostEnabled) return;
    const producer = videoProducerRef.current;
    const transport = producerTransportRef.current;

    if (!transport) {
      if (isCameraOff) {
        try {
          setIsCameraOff(false);
          const permissionState = await requestAndroidPermissions({
            video: true,
          });
          if (!permissionState.video) {
            setIsCameraOff(true);
            setMeetError({
              code: "PERMISSION_DENIED",
              message: "Camera permission denied",
              recoverable: true,
            });
            return;
          }

          const stream = await getUserMedia({
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
        } catch (err) {
          console.error("[Meets] Failed to enable video preview:", err);
          setIsCameraOff(true);
          setMeetError(createMeetError(err, "MEDIA_ERROR"));
        }
        return;
      }

      setIsCameraOff(true);
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

        const permissionState = await requestAndroidPermissions({
          video: true,
        });
        if (!permissionState.video) {
          setIsCameraOff(true);
          setMeetError({
            code: "PERMISSION_DENIED",
            message: "Camera permission denied",
            recoverable: true,
          });
          return;
        }

        const stream = await getUserMedia({
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
        const videoProducerId = videoProducer.id;
        videoProducer.on("transportclose", () => {
          if (videoProducerRef.current?.id === videoProducerId) {
            videoProducerRef.current = null;
          }
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
    requestAndroidPermissions,
  ]);

  const stopScreenShare = useCallback(
    (options?: { notify?: boolean }) => {
      const producer = screenProducerRef.current;
      const producerId = producer?.id ?? null;
      const shouldNotify = options?.notify !== false;

      if (producer) {
        if (shouldNotify) {
          socketRef.current?.emit(
            "closeProducer",
            { producerId: producer.id },
            () => {}
          );
        }
        try {
          producer.close();
        } catch {}
        if (producer.track) {
          producer.track.onended = null;
          stopLocalTrack(producer.track);
          if (Platform.OS === "ios" && "release" in producer.track) {
            try {
              (producer.track as MediaStreamTrack & { release?: () => void }).release?.();
            } catch {}
          }
        }
      }

      screenProducerRef.current = null;

      if (screenShareStreamRef.current) {
        screenShareStreamRef.current
          .getTracks()
          .forEach((track) => {
            stopLocalTrack(track);
            if (Platform.OS === "ios" && "release" in track) {
              try {
                (track as MediaStreamTrack & { release?: () => void }).release?.();
              } catch {}
            }
          });
        screenShareStreamRef.current = null;
      }

      if (producerId && activeScreenShareId === producerId) {
        setActiveScreenShareId(null);
      }

      setScreenShareStream(null);
      setIsScreenSharing(false);
    },
    [
      activeScreenShareId,
      screenProducerRef,
      screenShareStreamRef,
      socketRef,
      setScreenShareStream,
      setIsScreenSharing,
      setActiveScreenShareId,
      stopLocalTrack,
    ]
  );

  const toggleScreenShare = useCallback(async () => {
    if (ghostEnabled) return;
    if (isScreenSharing) {
      stopScreenShare({ notify: true });
      return;
    }

    if (connectionState !== "joined") {
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

    let producer: Producer | null = null;
    try {
      if (Platform.OS === "android" && Platform.Version >= 33) {
        const status = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
        );
        if (status !== PermissionsAndroid.RESULTS.GRANTED) {
          setMeetError(
            createMeetError(
              "Allow notifications to start screen sharing on Android."
            )
          );
          return;
        }
      }

      const stream = await getDisplayMedia();
      if (!stream) {
        throw new Error("Screen sharing is not available on mobile yet.");
      }
      const track = stream.getVideoTracks()[0];
      if (!track) {
        stream.getTracks().forEach((streamTrack) => stopLocalTrack(streamTrack));
        throw new Error("No screen video track available.");
      }
      track.enabled = true;
      screenShareStreamRef.current = stream;
      if (track && "contentHint" in track) {
        track.contentHint = "detail";
      }

      producer = await transport.produce({
        track,
        encodings: [{ maxBitrate: 2500000 }],
        appData: { type: "screen" as ProducerType },
      });

      track.onended = () => {
        stopScreenShare({ notify: true });
      };

      screenProducerRef.current = producer;
      await waitForOutgoingScreenFrames(producer);

      if (connectionState !== "joined") {
        stopScreenShare({ notify: false });
        return;
      }

      setScreenShareStream(stream);
      setIsScreenSharing(true);
    } catch (err) {
      if (producer) {
        try {
          producer.close();
        } catch {}
        if (screenProducerRef.current?.id === producer.id) {
          screenProducerRef.current = null;
        }
      }
      if (screenShareStreamRef.current) {
        screenShareStreamRef.current
          .getTracks()
          .forEach((track) => stopLocalTrack(track));
        screenShareStreamRef.current = null;
        setScreenShareStream(null);
      }
      if (
        err &&
        typeof err === "object" &&
        "name" in err &&
        (err as { name?: string }).name
      ) {
        const errorName = String((err as { name?: string }).name);
        if (errorName === "NotAllowedError" || errorName === "AbortError") {
          console.log("[Meets] Screen share cancelled or not ready");
          return;
        }
      }

      const message =
        typeof err === "string"
          ? err
          : (err as { message?: string })?.message;
      if (message?.includes("AbortError")) {
        console.log("[Meets] Screen share cancelled or not ready");
        return;
      }

      console.error("[Meets] Error starting screen share:", err);
      setMeetError(createMeetError(err, "MEDIA_ERROR"));
    }
  }, [
    ghostEnabled,
    isScreenSharing,
    activeScreenShareId,
    setIsScreenSharing,
    connectionState,
    producerTransportRef,
    screenProducerRef,
    socketRef,
    setScreenShareStream,
    screenShareStreamRef,
    setMeetError,
    stopLocalTrack,
    stopScreenShare,
    waitForOutgoingScreenFrames,
  ]);

  useEffect(() => {
    if (!isScreenSharing) return;
    const streamTrack = screenShareStreamRef.current?.getVideoTracks()[0];
    const producerTrack = screenProducerRef.current?.track;
    const track = streamTrack ?? producerTrack;
    if (!track) return;

    let cancelled = false;
    const previousOnEnded = track.onended;

    const handleEnded = () => {
      if (cancelled) return;
      stopScreenShare({ notify: true });
    };

    const interval = setInterval(() => {
      if (cancelled) return;
      if (track.readyState === "ended") {
        handleEnded();
      }
    }, 1000);

    track.onended = handleEnded;

    return () => {
      cancelled = true;
      clearInterval(interval);
      if (track.onended === handleEnded) {
        track.onended = previousOnEnded ?? null;
      }
    };
  }, [isScreenSharing, screenShareStreamRef, screenProducerRef, stopScreenShare]);

  useEffect(() => {
    if (isScreenSharing) return;
    if (!screenShareStreamRef.current) return;
    screenShareStreamRef.current
      .getTracks()
      .forEach((track) => stopLocalTrack(track));
    screenShareStreamRef.current = null;
    setScreenShareStream(null);
  }, [
    isScreenSharing,
    screenShareStreamRef,
    setScreenShareStream,
    stopLocalTrack,
  ]);

  useEffect(() => {
    if (connectionState === "joined") return;
    if (isScreenSharing) {
      stopScreenShare({ notify: false });
    }
  }, [connectionState, isScreenSharing, stopScreenShare]);

  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream, localStreamRef]);

  useEffect(() => {
    return () => {
      stopAudioKeepAlive();
    };
  }, [stopAudioKeepAlive]);

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
    stopScreenShare,
    stopLocalTrack,
    handleLocalTrackEnded,
    primeAudioOutput,
    playNotificationSound,
    startAudioKeepAlive,
    stopAudioKeepAlive,
  };
}
