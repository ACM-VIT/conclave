"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { Device } from "mediasoup-client";
import {
  buildCameraVideoConstraints,
  DEFAULT_AUDIO_CONSTRAINTS,
  buildMicrophoneOpusCodecOptions,
  buildScreenShareAudioOpusCodecOptions,
} from "../lib/constants";
import type {
  MediaState,
  MeetError,
  Producer,
  ProducerType,
  Transport,
  VideoQuality,
} from "../lib/types";
import {
  getBrowserNetworkSnapshot,
  shouldDeferBandwidthHeavyPreload,
} from "../lib/network-information";
import { clampMeetVolume, DEFAULT_MEET_VOLUME } from "../lib/meet-volume";
import { createMeetError } from "../lib/utils";
import { prewarmVideoEffectsAssetsDeferred } from "../lib/video-effects-lazy";
import {
  applyWebcamProducerNetworkProfile,
  applyScreenShareTrackNetworkProfile,
  buildScreenShareEncodingForNetworkProfile,
  buildScreenShareVideoConstraintsForNetworkProfile,
  getFallbackWebcamCodec,
  getPreferredScreenShareCodec,
  getPreferredWebcamCodec,
  produceWebcamTrack,
  shouldUseWebcamSimulcast,
  type WebcamProducerNetworkProfile,
} from "../lib/webcam-codec";
import type { ConnectionQualityStats } from "./useConnectionQuality";

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
  meetVolume?: number;
  videoQuality: VideoQuality;
  videoQualityRef: React.MutableRefObject<VideoQuality>;
  activeVideoEffectsCount?: number;
  shouldUsePreferredVideoPublishTrack?: boolean;
  getVideoPublishTrackRef?: React.MutableRefObject<
    ((stream?: MediaStream | null) => MediaStreamTrack | null) | null
  >;
  onPreferredVideoPublishTrackRejected?: (
    track: MediaStreamTrack,
    reason: string,
  ) => void;
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
  screenShareStreamRef: React.MutableRefObject<MediaStream | null>;
  intentionalLocalProducerCloseIdsRef: React.MutableRefObject<Set<string>>;
  localStreamRef: React.MutableRefObject<MediaStream | null>;
  connectionQualityRef?: React.MutableRefObject<ConnectionQualityStats | null>;
  intentionalTrackStopsRef: React.MutableRefObject<
    WeakSet<MediaStreamTrack>
  >;
  permissionHintTimeoutRef: React.MutableRefObject<number | null>;
  audioContextRef: React.MutableRefObject<AudioContext | null>;
  mediaRecoveryBlockedRef?: React.MutableRefObject<boolean>;
}

const getStartupAwarePublishQuality = (
  stats: ConnectionQualityStats | null | undefined,
  browserNetwork: ReturnType<typeof getBrowserNetworkSnapshot>,
) => {
  if (stats?.publishQuality && stats.publishQuality !== "unknown") {
    return stats.publishQuality;
  }
  return browserNetwork.startupQuality;
};

const isPublishEmergencyProfile = (
  stats: ConnectionQualityStats | null | undefined,
  browserNetwork: ReturnType<typeof getBrowserNetworkSnapshot>,
) =>
  browserNetwork.emergency ||
  (stats?.publishEmergencyMode === true && stats.publishQuality !== "good");

const getFirstLiveTrack = <T extends MediaStreamTrack>(
  tracks: readonly T[],
): T | null => tracks.find((track) => track.readyState === "live") ?? null;

const TOGGLE_MUTE_STRICT_ACK_TIMEOUT_MS = 5000;
const TOGGLE_MUTE_FAST_ACK_TIMEOUT_MS = 1500;
const TOGGLE_MUTE_BACKGROUND_ACK_TIMEOUT_MS = 3000;

const shouldUpdateCaptureConstraintsForQualitySwitch = (
  quality: VideoQuality,
  profile: WebcamProducerNetworkProfile,
): boolean => quality === "standard" && profile === "good";

const getUsableProducerTransport = (
  transport: Transport | null | undefined,
): Transport | null => {
  if (!transport || transport.closed) return null;
  if (
    transport.connectionState === "closed" ||
    transport.connectionState === "failed"
  ) {
    return null;
  }
  return transport;
};

type OutboundVideoProgressSample = {
  frames: number | null;
  bytes: number | null;
  framesPerSecond: number | null;
  qualityLimitationReason: string | null;
};

type CameraOutboundStallState = {
  producerId: string | null;
  trackId: string | null;
  frames: number | null;
  bytes: number | null;
  stalledSamples: number;
  rawRepairAttempted: boolean;
  lastRecoveryAtMs: number;
};

const CAMERA_OUTBOUND_STALL_CHECK_MS = 2000;
const CAMERA_OUTBOUND_STALL_SAMPLES_BEFORE_RECOVERY = 3;
const CAMERA_OUTBOUND_STALL_RECOVERY_COOLDOWN_MS = 10000;
const MIN_OUTBOUND_VIDEO_BYTE_DELTA_FOR_PROGRESS = 1200;

const createCameraOutboundStallState = (
  producerId: string | null = null,
  trackId: string | null = null,
): CameraOutboundStallState => ({
  producerId,
  trackId,
  frames: null,
  bytes: null,
  stalledSamples: 0,
  rawRepairAttempted: false,
  lastRecoveryAtMs: 0,
});

const getRtcStatsNumber = (
  stat: Record<string, unknown>,
  key: string,
): number | null => {
  const value = stat[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const readOutboundVideoProgressSample = (
  report: RTCStatsReport,
): OutboundVideoProgressSample => {
  let frames = 0;
  let hasFrames = false;
  let bytes = 0;
  let hasBytes = false;
  let framesPerSecond: number | null = null;
  let qualityLimitationReason: string | null = null;

  report.forEach((entry) => {
    const stat = entry as unknown as Record<string, unknown>;
    if (stat.type !== "outbound-rtp") return;
    const kind = stat.kind ?? stat.mediaType;
    if (kind !== "video") return;
    if (stat.isRemote === true) return;

    const frameCount =
      getRtcStatsNumber(stat, "framesEncoded") ??
      getRtcStatsNumber(stat, "framesSent");
    if (frameCount !== null) {
      frames += Math.max(0, frameCount);
      hasFrames = true;
    }

    const byteCount = getRtcStatsNumber(stat, "bytesSent");
    if (byteCount !== null) {
      bytes += Math.max(0, byteCount);
      hasBytes = true;
    }

    const currentFramesPerSecond = getRtcStatsNumber(stat, "framesPerSecond");
    if (currentFramesPerSecond !== null) {
      framesPerSecond = Math.max(framesPerSecond ?? 0, currentFramesPerSecond);
    }

    if (
      typeof stat.qualityLimitationReason === "string" &&
      stat.qualityLimitationReason &&
      stat.qualityLimitationReason !== "none"
    ) {
      qualityLimitationReason = stat.qualityLimitationReason;
    }
  });

  return {
    frames: hasFrames ? frames : null,
    bytes: hasBytes ? bytes : null,
    framesPerSecond,
    qualityLimitationReason,
  };
};

const isEncoderLimitedOutboundSample = (
  sample: OutboundVideoProgressSample,
): boolean =>
  sample.qualityLimitationReason === "bandwidth" ||
  sample.qualityLimitationReason === "cpu";

const hasOutboundVideoProgress = (
  previous: CameraOutboundStallState,
  sample: OutboundVideoProgressSample,
): boolean => {
  // When frame counters exist, they are the strongest signal. A healthy camera
  // sender should either advance frames or report a positive FPS; flat frames
  // with flat bytes is a dead sender, and flat frames with only bytes moving is
  // usually padding/retransmission without usable video.
  if (previous.frames !== null && sample.frames !== null) {
    if (sample.frames > previous.frames) return true;
    if (sample.framesPerSecond !== null && sample.framesPerSecond > 0) {
      return true;
    }
    return false;
  }

  if (
    sample.framesPerSecond !== null &&
    sample.framesPerSecond > 0
  ) {
    return true;
  }

  if (
    previous.bytes !== null &&
    sample.bytes !== null &&
    sample.bytes - previous.bytes >= MIN_OUTBOUND_VIDEO_BYTE_DELTA_FOR_PROGRESS
  ) {
    return true;
  }

  return false;
};

const shouldDisableMediaIntentAfterRecoveryFailure = (
  error: unknown,
  meetError: MeetError,
): boolean => {
  if (meetError.code === "PERMISSION_DENIED") return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("NotFoundError") ||
    message.includes("DevicesNotFoundError")
  );
};

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
  meetVolume = DEFAULT_MEET_VOLUME,
  videoQuality,
  videoQualityRef,
  activeVideoEffectsCount = 0,
  shouldUsePreferredVideoPublishTrack = activeVideoEffectsCount > 0,
  getVideoPublishTrackRef,
  onPreferredVideoPublishTrackRejected,
  socketRef,
  deviceRef,
  producerTransportRef,
  ensureProducerTransportRef,
  audioProducerRef,
  videoProducerRef,
  screenProducerRef,
  screenAudioProducerRef,
  screenShareStreamRef,
  intentionalLocalProducerCloseIdsRef,
  localStreamRef,
  connectionQualityRef,
  intentionalTrackStopsRef,
  permissionHintTimeoutRef,
  audioContextRef,
  mediaRecoveryBlockedRef,
}: UseMeetMediaOptions) {
  const [mediaState, setMediaState] = useState<MediaState>({
    hasAudioPermission: false,
    hasVideoPermission: false,
  });
  const [showPermissionHint, setShowPermissionHint] = useState(false);
  const updateVideoQualityRef = useRef<
    (
      quality: VideoQuality,
      networkProfileOverride?: WebcamProducerNetworkProfile,
    ) => Promise<void>
  >(async () => {});
  const audioRecoveryInFlightRef = useRef(false);
  const isMediaRecoveryBlocked = useCallback(
    () => mediaRecoveryBlockedRef?.current === true,
    [mediaRecoveryBlockedRef],
  );
  const [audioProducerRecoveryPulse, setAudioProducerRecoveryPulse] =
    useState(0);
  const cameraRecoveryInFlightRef = useRef(false);
  const [cameraProducerRecoveryPulse, setCameraProducerRecoveryPulse] =
    useState(0);
  const pendingAudioProducerRecoveryRef = useRef(false);
  const pendingCameraProducerRecoveryRef = useRef(false);
  const [blockedProducerRecoveryFlushPulse, setBlockedProducerRecoveryFlushPulse] =
    useState(0);
  const flushQueuedProducerRecoveries = useCallback(() => {
    if (pendingAudioProducerRecoveryRef.current) {
      pendingAudioProducerRecoveryRef.current = false;
      setAudioProducerRecoveryPulse((value) => value + 1);
    }
    if (pendingCameraProducerRecoveryRef.current) {
      pendingCameraProducerRecoveryRef.current = false;
      setCameraProducerRecoveryPulse((value) => value + 1);
    }
  }, []);
  const queueBlockedProducerRecovery = useCallback(
    (kind: "audio" | "camera") => {
      if (kind === "audio") {
        pendingAudioProducerRecoveryRef.current = true;
      } else {
        pendingCameraProducerRecoveryRef.current = true;
      }
      setBlockedProducerRecoveryFlushPulse((value) => value + 1);
    },
    [],
  );
  const notificationVolume = clampMeetVolume(meetVolume);
  const requestAudioProducerRecovery = useCallback(() => {
    if (isMediaRecoveryBlocked()) {
      queueBlockedProducerRecovery("audio");
      return;
    }
    setAudioProducerRecoveryPulse((value) => value + 1);
  }, [isMediaRecoveryBlocked, queueBlockedProducerRecovery]);
  const requestCameraProducerRecovery = useCallback(() => {
    if (isMediaRecoveryBlocked()) {
      queueBlockedProducerRecovery("camera");
      return;
    }
    setCameraProducerRecoveryPulse((value) => value + 1);
  }, [isMediaRecoveryBlocked, queueBlockedProducerRecovery]);
  useEffect(() => {
    if (
      !pendingAudioProducerRecoveryRef.current &&
      !pendingCameraProducerRecoveryRef.current
    ) {
      return;
    }
    if (!isMediaRecoveryBlocked()) {
      flushQueuedProducerRecoveries();
      return;
    }
    const intervalId = window.setInterval(() => {
      if (isMediaRecoveryBlocked()) return;
      window.clearInterval(intervalId);
      flushQueuedProducerRecoveries();
    }, 250);
    return () => window.clearInterval(intervalId);
  }, [
    blockedProducerRecoveryFlushPulse,
    flushQueuedProducerRecoveries,
    isMediaRecoveryBlocked,
  ]);
  const cameraProducerTrackRepairInFlightRef = useRef(false);
  const cameraRecoveryCodecOverrideRef = useRef<ReturnType<
    typeof getPreferredWebcamCodec
  > | null>(null);
  const cameraRecoveryForceSingleLayerRef = useRef(false);
  const cameraOutboundStallStateRef = useRef<CameraOutboundStallState>(
    createCameraOutboundStallState(),
  );
  const connectionStateRef = useRef(connectionState);
  if (connectionStateRef.current !== connectionState) {
    connectionStateRef.current = connectionState;
  }
  const isMutedRef = useRef(isMuted);
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);
  const setMutedIntent = useCallback(
    (value: boolean) => {
      isMutedRef.current = value;
      setIsMuted(value);
    },
    [setIsMuted],
  );
  const toggleMuteInFlightRef = useRef(false);
  const [isMuteTogglePending, setIsMuteTogglePending] = useState(false);
  const toggleCameraInFlightRef = useRef(false);
  const markAudioTrackForSpeech = useCallback(
    (track?: MediaStreamTrack | null) => {
      if (track && "contentHint" in track) {
        track.contentHint = "speech";
      }
    },
    []
  );
  const buildAudioConstraints = useCallback(
    (deviceId?: string): MediaTrackConstraints => ({
      ...DEFAULT_AUDIO_CONSTRAINTS,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    }),
    []
  );

  const buildVideoConstraints = useCallback(
    (deviceId?: string): MediaTrackConstraints => {
      const stats = connectionQualityRef?.current;
      const browserNetwork = stats?.browserNetwork ?? getBrowserNetworkSnapshot();
      const publishQuality = getStartupAwarePublishQuality(
        stats,
        browserNetwork,
      );
      const networkProfile: WebcamProducerNetworkProfile =
        isPublishEmergencyProfile(stats, browserNetwork)
          ? "emergency"
          : publishQuality === "poor"
          ? "poor"
          : publishQuality === "fair"
          ? "fair"
          : "good";
      return buildCameraVideoConstraints(
        videoQualityRef.current,
        networkProfile,
        deviceId,
      );
    },
    [connectionQualityRef, videoQualityRef]
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
      if (notificationVolume <= 0) return;
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
        const basePeakGain = type === "handRaise" ? 0.13 : 0.16;
        const peakGain = basePeakGain * notificationVolume;

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
    [getAudioContext, notificationVolume]
  );

  const primeAudioOutput = useCallback(() => {
    const audioContext = getAudioContext();
    if (!audioContext) return;
    if (audioContext.state === "suspended") {
      audioContext.resume().catch(() => {});
    }
  }, [getAudioContext]);

  const emitToggleMute = useCallback(
    (
      producerId: string,
      paused: boolean,
      options?: { timeoutMs?: number },
    ) => {
      const socket = socketRef.current;
      if (!socket || !socket.connected) {
        return Promise.resolve({
          ok: false,
          error: "Socket not connected",
        });
      }

      return new Promise<{ ok: boolean; error?: string }>((resolve) => {
        let settled = false;
        const timeoutMs =
          options?.timeoutMs ?? TOGGLE_MUTE_STRICT_ACK_TIMEOUT_MS;
        const timeout = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({ ok: false, error: "toggleMute timeout" });
        }, timeoutMs);

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

  const closeLocalAudioProducerForReplacement = useCallback(
    (producer: Producer | null) => {
      if (!producer) return;
      intentionalLocalProducerCloseIdsRef.current.add(producer.id);
      socketRef.current?.emit(
        "closeProducer",
        { producerId: producer.id },
        () => {},
      );
      try {
        producer.close();
      } catch {}
      if (audioProducerRef.current?.id === producer.id) {
        audioProducerRef.current = null;
      }
    },
    [audioProducerRef, intentionalLocalProducerCloseIdsRef, socketRef],
  );

  const confirmAudioProducerUnmuted = useCallback(
    (producerId: string) => {
      void (async () => {
        const firstResult = await emitToggleMute(producerId, false, {
          timeoutMs: TOGGLE_MUTE_FAST_ACK_TIMEOUT_MS,
        });
        if (firstResult.ok) return;

        let currentProducer = audioProducerRef.current;
        if (
          isMutedRef.current ||
          !currentProducer ||
          currentProducer.id !== producerId ||
          currentProducer.closed
        ) {
          return;
        }

        let confirmationError = firstResult.error;
        if (firstResult.error === "toggleMute timeout") {
          console.warn(
            "[Meets] unmute ack timed out; confirming microphone state in background:",
            firstResult.error,
          );
          const retryResult = await emitToggleMute(producerId, false, {
            timeoutMs: TOGGLE_MUTE_BACKGROUND_ACK_TIMEOUT_MS,
          });
          if (retryResult.ok) return;
          confirmationError = retryResult.error;
        }

        currentProducer = audioProducerRef.current;
        if (
          isMutedRef.current ||
          !currentProducer ||
          currentProducer.id !== producerId ||
          currentProducer.closed
        ) {
          return;
        }

        console.warn(
          "[Meets] unmute confirmation failed; refreshing microphone producer:",
          confirmationError,
        );
        closeLocalAudioProducerForReplacement(currentProducer);
        requestAudioProducerRecovery();
      })();
    },
    [
      audioProducerRef,
      closeLocalAudioProducerForReplacement,
      emitToggleMute,
      requestAudioProducerRecovery,
    ],
  );

  const getPublishNetworkProfile =
    useCallback((): WebcamProducerNetworkProfile => {
      const stats = connectionQualityRef?.current;
      const browserNetwork = stats?.browserNetwork ?? getBrowserNetworkSnapshot();
      if (isPublishEmergencyProfile(stats, browserNetwork)) {
        return "emergency";
      }

      const quality = getStartupAwarePublishQuality(stats, browserNetwork);
      if (quality === "poor") return "poor";
      if (quality === "fair") return "fair";
      return "good";
    }, [connectionQualityRef]);

  const waitForPreferredVideoPublishTrack = useCallback(
    async (stream: MediaStream, rawTrack: MediaStreamTrack) => {
      if (!shouldUsePreferredVideoPublishTrack) return rawTrack;

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
    [getVideoPublishTrackRef, shouldUsePreferredVideoPublishTrack]
  );

  const produceCameraTrackWithRawFallback = useCallback(
    async ({
      transport,
      publishTrack,
      rawTrack,
      quality,
      networkProfile,
      paused,
      preferredCodec,
      forceSingleLayer = false,
      context,
    }: {
      transport: Transport;
      publishTrack: MediaStreamTrack;
      rawTrack: MediaStreamTrack;
      quality: VideoQuality;
      networkProfile: WebcamProducerNetworkProfile;
      paused: boolean;
      preferredCodec: ReturnType<typeof getPreferredWebcamCodec>;
      forceSingleLayer?: boolean;
      context: string;
    }) => {
      try {
        return await produceWebcamTrack({
          transport,
          track: publishTrack,
          quality,
          networkProfile,
          paused,
          preferredCodec,
          forceSingleLayer,
        });
      } catch (err) {
        if (
          publishTrack.id === rawTrack.id ||
          rawTrack.readyState !== "live"
        ) {
          throw err;
        }

        console.warn(
          `[Meets] Processed ${context} camera publish failed; retrying raw camera:`,
          err,
        );
        onPreferredVideoPublishTrackRejected?.(
          publishTrack,
          `${context}-raw-produce-fallback`,
        );
        return produceWebcamTrack({
          transport,
          track: rawTrack,
          quality,
          networkProfile,
          paused,
          preferredCodec,
          forceSingleLayer,
        });
      }
    },
    [onPreferredVideoPublishTrackRejected],
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

  const commitLocalStream = useCallback(
    (nextStream: MediaStream | null) => {
      localStreamRef.current = nextStream;
      setLocalStream(nextStream);
    },
    [localStreamRef, setLocalStream],
  );

  const stopTracksExcept = useCallback(
    (
      tracks: readonly MediaStreamTrack[],
      keepTracks: readonly (MediaStreamTrack | null | undefined)[],
    ) => {
      const keepTrackIds = new Set(
        keepTracks
          .filter((track): track is MediaStreamTrack => Boolean(track))
          .map((track) => track.id),
      );
      for (const track of tracks) {
        if (!keepTrackIds.has(track.id)) {
          stopLocalTrack(track);
        }
      }
    },
    [stopLocalTrack],
  );

  const closeLocalVideoProducerForReplacement = useCallback(
    (producer: Producer) => {
      intentionalLocalProducerCloseIdsRef.current.add(producer.id);
      socketRef.current?.emit(
        "closeProducer",
        { producerId: producer.id },
        () => {},
      );
      try {
        producer.close();
      } catch {}
      if (videoProducerRef.current?.id === producer.id) {
        videoProducerRef.current = null;
      }
    },
    [intentionalLocalProducerCloseIdsRef, socketRef, videoProducerRef],
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

      const currentStream = localStreamRef.current;
      const hasCurrentLocalTrack =
        currentStream
          ?.getTracks()
          .some(
            (currentTrack) =>
              currentTrack === track || currentTrack.id === track.id,
          ) === true;
      const activeProducer =
        kind === "audio" ? audioProducerRef.current : videoProducerRef.current;
      const producerTrack = activeProducer?.track ?? null;
      const hasCurrentProducerTrack =
        producerTrack === track || producerTrack?.id === track.id;

      if (!hasCurrentLocalTrack && !hasCurrentProducerTrack) {
        console.info("[Meets] Ignoring ended stale local track:", {
          kind,
          trackId: track.id,
          activeProducerId: activeProducer?.id ?? null,
          activeProducerTrackId: producerTrack?.id ?? null,
        });
        return;
      }

      if (kind === "audio") {
        const producer = audioProducerRef.current;
        if (producer) {
          closeLocalAudioProducerForReplacement(producer);
        }
        if (connectionStateRef.current === "joined") {
          console.warn(
            "[Meets] Local audio track ended unexpectedly; recovering audio producer.",
          );
          requestAudioProducerRecovery();
        } else {
          setIsMuted(true);
        }
      } else {
        const producer = videoProducerRef.current;
        if (producer) {
          closeLocalVideoProducerForReplacement(producer);
        }
        if (connectionStateRef.current === "joined") {
          console.warn(
            "[Meets] Local video track ended unexpectedly; recovering camera producer.",
          );
          requestCameraProducerRecovery();
        } else {
          setIsCameraOff(true);
        }
      }

      if (hasCurrentLocalTrack && currentStream) {
        const remaining = currentStream
          .getTracks()
          .filter(
            (currentTrack) =>
              currentTrack !== track && currentTrack.id !== track.id,
          );
        commitLocalStream(new MediaStream(remaining));
      }
    },
    [
      consumeIntentionalStop,
      closeLocalAudioProducerForReplacement,
      closeLocalVideoProducerForReplacement,
      commitLocalStream,
      setIsMuted,
      setIsCameraOff,
      localStreamRef,
      audioProducerRef,
      videoProducerRef,
      requestAudioProducerRecovery,
      requestCameraProducerRecovery,
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
      const audioConstraints = isMuted
        ? false
        : buildAudioConstraints(selectedAudioInputDeviceId);
      const videoConstraintsForRequest = isCameraOff
        ? false
        : buildVideoConstraints();

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

      stream.getAudioTracks().forEach(markAudioTrackForSpeech);
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
            markAudioTrackForSpeech(audioTrack);
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
    selectedAudioInputDeviceId,
    isMuted,
    isCameraOff,
    handleLocalTrackEnded,
    buildAudioConstraints,
    buildVideoConstraints,
    markAudioTrackForSpeech,
    permissionHintTimeoutRef,
    setMeetError,
    setIsCameraOff,
    setIsMuted,
  ]);

  const handleAudioInputDeviceChange = useCallback(
    async (deviceId: string) => {
      setSelectedAudioInputDeviceId(deviceId);

      if (connectionState === "joined") {
        let acquiredAudioTracks: MediaStreamTrack[] = [];
        let committedNewAudioTrack: MediaStreamTrack | null = null;
        try {
          const newStream = await navigator.mediaDevices.getUserMedia({
            audio: buildAudioConstraints(deviceId),
          });

          acquiredAudioTracks = newStream.getAudioTracks();
          const newAudioTrack = newStream.getAudioTracks()[0];
          if (newAudioTrack) {
            markAudioTrackForSpeech(newAudioTrack);
            newAudioTrack.onended = () => {
              handleLocalTrackEnded("audio", newAudioTrack);
            };
            newAudioTrack.enabled = !isMuted;
            const previousStream = localStreamRef.current;
            const previousAudioTracks = previousStream?.getAudioTracks() ?? [];

            const currentAudioProducer = audioProducerRef.current;
            if (currentAudioProducer?.closed) {
              closeLocalAudioProducerForReplacement(currentAudioProducer);
            }
            const audioProducer = audioProducerRef.current;
            if (audioProducer) {
              await audioProducer.replaceTrack({
                track: newAudioTrack,
              });
            } else {
              requestAudioProducerRecovery();
            }

            const remainingTracks =
              previousStream
                ?.getTracks()
                .filter((track) => track.kind !== "audio") ?? [];
            const nextStream = new MediaStream([
              ...remainingTracks,
              newAudioTrack,
            ]);
            commitLocalStream(nextStream);
            committedNewAudioTrack = newAudioTrack;
            stopTracksExcept(previousAudioTracks, [newAudioTrack]);
          }
        } catch (err) {
          stopTracksExcept(acquiredAudioTracks, [committedNewAudioTrack]);
          console.error("[Meets] Failed to switch audio input device:", err);
        }
      }
    },
    [
      connectionState,
      isMuted,
      handleLocalTrackEnded,
      setSelectedAudioInputDeviceId,
      audioProducerRef,
      localStreamRef,
      commitLocalStream,
      buildAudioConstraints,
      markAudioTrackForSpeech,
      closeLocalAudioProducerForReplacement,
      stopTracksExcept,
      requestAudioProducerRecovery,
    ]
  );

  const handleVideoInputDeviceChange = useCallback(
    async (deviceId: string) => {
      if (connectionState !== "joined") return;
      if (isCameraOff) return;

      let acquiredVideoTracks: MediaStreamTrack[] = [];
      let committedNewVideoTrack: MediaStreamTrack | null = null;
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          video: buildVideoConstraints(deviceId),
        });

        acquiredVideoTracks = newStream.getVideoTracks();
        const newVideoTrack = newStream.getVideoTracks()[0];
        if (newVideoTrack) {
          if ("contentHint" in newVideoTrack) {
            newVideoTrack.contentHint = "motion";
          }
          newVideoTrack.onended = () => {
            handleLocalTrackEnded("video", newVideoTrack);
          };
          const previousStream = localStreamRef.current ?? localStream;
          const previousVideoTracks = previousStream?.getVideoTracks() ?? [];
          const remainingTracks =
            previousStream
              ?.getTracks()
              .filter((track) => track.kind !== "video") ?? [];
          const nextStream = new MediaStream([...remainingTracks, newVideoTrack]);

          const currentVideoProducer = videoProducerRef.current;
          if (currentVideoProducer?.closed) {
            closeLocalVideoProducerForReplacement(currentVideoProducer);
          }
          const videoProducer = videoProducerRef.current;
          if (videoProducer) {
            const publishTrack = await waitForPreferredVideoPublishTrack(
              nextStream,
              newVideoTrack,
            );
            try {
              await videoProducer.replaceTrack({
                track: publishTrack,
              });
            } catch (err) {
              if (publishTrack.id === newVideoTrack.id) throw err;
              console.warn(
                "[Meets] Processed device-switch track failed; retrying raw camera:",
                err,
              );
              onPreferredVideoPublishTrackRejected?.(
                publishTrack,
                "device-switch-raw-replace-fallback",
              );
              await videoProducer.replaceTrack({
                track: newVideoTrack,
              });
            }
          } else {
            requestCameraProducerRecovery();
          }

          localStreamRef.current = nextStream;
          setLocalStream(nextStream);
          committedNewVideoTrack = newVideoTrack;
          stopTracksExcept(previousVideoTracks, [
            newVideoTrack,
            videoProducerRef.current?.track ?? null,
          ]);
        }
      } catch (err) {
        stopTracksExcept(acquiredVideoTracks, [committedNewVideoTrack]);
        console.error("[Meets] Failed to switch video input device:", err);
      }
    },
    [
      connectionState,
      isCameraOff,
      localStream,
      handleLocalTrackEnded,
      videoProducerRef,
      setLocalStream,
      buildVideoConstraints,
      localStreamRef,
      waitForPreferredVideoPublishTrack,
      onPreferredVideoPublishTrackRejected,
      stopTracksExcept,
      closeLocalVideoProducerForReplacement,
      requestCameraProducerRecovery,
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
    async (
      quality: VideoQuality,
      networkProfileOverride?: WebcamProducerNetworkProfile,
    ) => {
      if (isCameraOff) return;
      const currentStream = localStreamRef.current ?? localStream;
      if (!currentStream) return;

      let rollbackStream: MediaStream | null = null;
      let replacementTrack: MediaStreamTrack | null = null;

      try {
        const publishNetworkProfile =
          networkProfileOverride ?? getPublishNetworkProfile();
        const constraints = buildCameraVideoConstraints(
          quality,
          publishNetworkProfile,
        );

        console.log(
          `[Meets] Switching to ${quality} quality`,
          JSON.stringify(constraints)
        );

        const currentTrack = getFirstLiveTrack(currentStream.getVideoTracks());
        const shouldUpdateCaptureConstraints =
          shouldUpdateCaptureConstraintsForQualitySwitch(
            quality,
            publishNetworkProfile,
          );
        if (
          currentTrack &&
          currentTrack.readyState === "live" &&
          shouldUpdateCaptureConstraints
        ) {
          currentTrack.onended = () => {
            handleLocalTrackEnded("video", currentTrack);
          };
          try {
            await currentTrack.applyConstraints(constraints);
          } catch (err) {
            console.warn(
              "[Meets] Camera constraints update failed; keeping current capture:",
              err
            );
          }
        }

        let nextVideoTrack = getFirstLiveTrack(currentStream.getVideoTracks());
        let publishStream = currentStream;
        let oldVideoTracksToStop: MediaStreamTrack[] = [];

        if (
          !nextVideoTrack ||
          nextVideoTrack.readyState !== "live"
        ) {
          const currentDeviceId =
            currentTrack?.readyState === "live"
              ? currentTrack.getSettings().deviceId
              : undefined;
          let newStream: MediaStream;
          try {
            newStream = await navigator.mediaDevices.getUserMedia({
              video:
                typeof currentDeviceId === "string" && currentDeviceId
                  ? {
                      ...constraints,
                      deviceId: { exact: currentDeviceId },
                    }
                  : constraints,
            });
          } catch (err) {
            if (!currentDeviceId) throw err;
            console.warn(
              "[Meets] Camera reopen with current device failed, retrying default device:",
              err,
            );
            newStream = await navigator.mediaDevices.getUserMedia({
              video: constraints,
            });
          }
          let newVideoTrack = newStream.getVideoTracks()[0] ?? null;
          if (!newVideoTrack) {
            throw new Error("No video track obtained");
          }
          if ("contentHint" in newVideoTrack) {
            newVideoTrack.contentHint = "motion";
          }
          newVideoTrack.onended = () => {
            handleLocalTrackEnded("video", newVideoTrack);
          };

          const previousStream = localStreamRef.current ?? currentStream;
          rollbackStream = previousStream;
          oldVideoTracksToStop = previousStream?.getVideoTracks() ?? [];
          const remainingTracks = previousStream
            .getTracks()
            .filter((track) => track.kind !== "video");
          publishStream = new MediaStream([...remainingTracks, newVideoTrack]);
          replacementTrack = newVideoTrack;
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
        const preferredWebcamCodec = getPreferredWebcamCodec(deviceRef.current);
        const previousEncodingCount =
          previousProducer?.rtpSender?.getParameters().encodings?.length ??
          previousProducer?.rtpParameters.encodings?.length ??
          0;
        const needsStandardSimulcastRecreate =
          shouldUseWebcamSimulcast(preferredWebcamCodec) &&
          quality === "standard" &&
          Boolean(previousProducer && !previousProducer.closed) &&
          previousEncodingCount > 0 &&
          previousEncodingCount < 3;

        if (
          previousProducer &&
          !previousProducer.closed &&
          !needsStandardSimulcastRecreate
        ) {
          if (previousProducer.track?.id !== publishTrack.id) {
            try {
              await previousProducer.replaceTrack({ track: publishTrack });
            } catch (err) {
              if (publishTrack.id === nextVideoTrack.id) throw err;
              console.warn(
                "[Meets] Processed quality-switch track failed; retrying raw camera:",
                err,
              );
              onPreferredVideoPublishTrackRejected?.(
                publishTrack,
                "quality-switch-raw-replace-fallback",
              );
              await previousProducer.replaceTrack({ track: nextVideoTrack });
            }
          }
          await applyWebcamProducerNetworkProfile(
            previousProducer,
            quality,
            publishNetworkProfile,
          );
          stopTracksExcept(oldVideoTracksToStop, [
            nextVideoTrack,
            previousProducer.track,
          ]);
          return;
        }

        let transport = getUsableProducerTransport(producerTransportRef.current);
        if (!transport) {
          const transportReady =
            (await ensureProducerTransportRef?.current?.()) ?? false;
          transport = getUsableProducerTransport(producerTransportRef.current);
          if (!transportReady || !transport) {
            throw new Error("Video transport unavailable");
          }
        }

        const nextProducer = await produceCameraTrackWithRawFallback({
          transport,
          publishTrack,
          rawTrack: nextVideoTrack,
          quality,
          networkProfile: publishNetworkProfile,
          paused: false,
          preferredCodec: preferredWebcamCodec,
          context: "quality-switch",
        });

        videoProducerRef.current = nextProducer;
        const nextProducerId = nextProducer.id;
        nextProducer.on("transportclose", () => {
          if (videoProducerRef.current?.id === nextProducerId) {
            videoProducerRef.current = null;
            requestCameraProducerRecovery();
          }
        });

        if (
          previousProducer &&
          previousProducer.id !== nextProducerId
        ) {
          intentionalLocalProducerCloseIdsRef.current.add(previousProducer.id);
          socketRef.current?.emit(
            "closeProducer",
            { producerId: previousProducer.id },
            () => {}
          );
          try {
            previousProducer.close();
          } catch {}
        }
        stopTracksExcept(oldVideoTracksToStop, [
          nextVideoTrack,
          nextProducer.track,
        ]);
      } catch (err) {
        console.error("[Meets] Failed to update video quality:", err);
        if (rollbackStream && replacementTrack) {
          localStreamRef.current = rollbackStream;
          setLocalStream(rollbackStream);
          stopLocalTrack(replacementTrack);
        }
        throw err;
      }
    },
    [
      isCameraOff,
      localStream,
      handleLocalTrackEnded,
      stopLocalTrack,
      stopTracksExcept,
      setLocalStream,
      socketRef,
      deviceRef,
      producerTransportRef,
      ensureProducerTransportRef,
      videoProducerRef,
      intentionalLocalProducerCloseIdsRef,
      localStreamRef,
      waitForPreferredVideoPublishTrack,
      onPreferredVideoPublishTrackRejected,
      getPublishNetworkProfile,
      produceCameraTrackWithRawFallback,
      requestCameraProducerRecovery,
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
        closeLocalAudioProducerForReplacement(producer);
        producer = null;
      }

      if (nextMuted) {
        const currentAudioTracks =
          localStreamRef.current?.getAudioTracks() ?? [];
        const liveAudioTracks = currentAudioTracks.filter(
          (track) => track.readyState === "live",
        );
        liveAudioTracks.forEach((track) => {
          track.enabled = false;
        });

        if (producer) {
          try {
            producer.pause();
          } catch {}
          const toggleResult = await emitToggleMute(producer.id, true, {
            timeoutMs: TOGGLE_MUTE_STRICT_ACK_TIMEOUT_MS,
          });
          if (!toggleResult.ok) {
            console.warn(
              "[Meets] toggleMute failed, rolling back mute:",
              toggleResult.error
            );
            liveAudioTracks.forEach((track) => {
              if (track.readyState === "live") {
                track.enabled = true;
              }
            });
            try {
              producer.resume();
            } catch {}
            setMutedIntent(false);
            setMeetError({
              code: "TRANSPORT_ERROR",
              message: toggleResult.error || "Failed to mute microphone",
              recoverable: true,
            });
            return;
          }
        }
        setMutedIntent(true);
        return;
      }

      let audioTrack = getFirstLiveTrack(
        localStreamRef.current?.getAudioTracks() ?? [],
      );

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
        markAudioTrackForSpeech(nextAudioTrack);
        nextAudioTrack.onended = () => {
          handleLocalTrackEnded("audio", nextAudioTrack);
        };

        const previousStream = localStreamRef.current;
        previousStream?.getAudioTracks().forEach((track) => {
          if (track.id !== nextAudioTrack.id) {
            stopLocalTrack(track);
          }
        });
        const remainingTracks =
          previousStream
            ?.getTracks()
            .filter((track) => track.kind !== "audio") ?? [];
        const nextStream = new MediaStream([
          ...remainingTracks,
          nextAudioTrack,
        ]);
        localStreamRef.current = nextStream;
        setLocalStream(nextStream);

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
        setMutedIntent(false);
        setMeetError(null);
        confirmAudioProducerUnmuted(producer.id);
        return;
      }

      setMutedIntent(false);
      setMeetError(null);
      requestAudioProducerRecovery();
      return;
    } catch (err) {
      console.error("[Meets] Failed to restart audio:", err);
      const meetErr = createMeetError(err, "MEDIA_ERROR");
      const liveAudioTrackAfterFailure = getFirstLiveTrack(
        localStreamRef.current?.getAudioTracks() ?? [],
      );
      const shouldRetryAudioUnmute =
        !nextMuted &&
        liveAudioTrackAfterFailure !== null &&
        !shouldDisableMediaIntentAfterRecoveryFailure(err, meetErr);

      if (shouldRetryAudioUnmute) {
        liveAudioTrackAfterFailure.enabled = true;
        if (
          producer &&
          !producer.closed &&
          audioProducerRef.current?.id === producer.id
        ) {
          closeLocalAudioProducerForReplacement(producer);
        }
        setMutedIntent(false);
        setMeetError(null);
        requestAudioProducerRecovery();
        return;
      }

      if (createdTrack) {
        stopLocalTrack(createdTrack);
        const currentStream = localStreamRef.current;
        if (currentStream?.getTracks().includes(createdTrack)) {
          const remaining = currentStream
            .getTracks()
            .filter((track) => track !== createdTrack && track.kind !== "audio");
          commitLocalStream(new MediaStream(remaining));
        }
      }
      setMutedIntent(previousMuted);
      setMeetError(meetErr);
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
    commitLocalStream,
    setMeetError,
    closeLocalAudioProducerForReplacement,
    confirmAudioProducerUnmuted,
    markAudioTrackForSpeech,
    setMutedIntent,
    requestAudioProducerRecovery,
    toggleMuteInFlightRef,
  ]);

  useEffect(() => {
    if (ghostEnabled || isObserverMode) return;
    if (connectionState !== "joined") return;
    const getReusableAudioTrack = () =>
      getFirstLiveTrack(
        (localStreamRef.current ?? localStream)?.getAudioTracks() ?? [],
      );
    if (isMuted && !getReusableAudioTrack()) return;
    if (isMediaRecoveryBlocked()) return;

    let disposed = false;
    const requestRecovery = (reason: "initial" | "watchdog") => {
      if (disposed || audioRecoveryInFlightRef.current) return;
      if (isMediaRecoveryBlocked()) return;
      const liveAudioTrack = getReusableAudioTrack();
      if (isMutedRef.current && !liveAudioTrack) return;

      const producer = audioProducerRef.current;
      const producerTrack = producer?.track ?? null;
      const needsRecovery =
        !producer || producer.closed || producerTrack?.readyState !== "live";
      if (!needsRecovery) return;

      if (producer && audioProducerRef.current?.id === producer.id) {
        closeLocalAudioProducerForReplacement(producer);
      }

      console.warn("[Meets] Audio producer recovery triggered:", {
        reason,
        hasProducer: Boolean(producer),
        producerClosed: producer?.closed ?? null,
        producerId: producer?.id ?? null,
        trackId: producerTrack?.id ?? null,
        trackState: producerTrack?.readyState ?? null,
      });
      requestAudioProducerRecovery();
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
    isMuted,
    isObserverMode,
    isMediaRecoveryBlocked,
    audioProducerRef,
    localStream,
    localStreamRef,
    closeLocalAudioProducerForReplacement,
    requestAudioProducerRecovery,
  ]);

  useEffect(() => {
    if (ghostEnabled || isObserverMode) return;
    if (connectionState !== "joined") return;
    const reusableAudioTrack = getFirstLiveTrack(
      (localStreamRef.current ?? localStream)?.getAudioTracks() ?? [],
    );
    if (isMuted && !reusableAudioTrack) return;
    if (isMediaRecoveryBlocked()) return;
    if (audioProducerRef.current) {
      const existingProducer = audioProducerRef.current;
      if (
        existingProducer.closed ||
        existingProducer.track?.readyState !== "live"
      ) {
        closeLocalAudioProducerForReplacement(existingProducer);
      } else {
        return;
      }
    }
    if (audioRecoveryInFlightRef.current) return;

    let cancelled = false;
    let createdTrack: MediaStreamTrack | null = null;
    const removeCreatedTrackFromLocalStream = () => {
      if (!createdTrack) return;
      stopLocalTrack(createdTrack);
      const currentStream = localStreamRef.current;
      if (currentStream?.getTracks().includes(createdTrack)) {
        const remaining = currentStream
          .getTracks()
          .filter((track) => track !== createdTrack);
        const nextStream = new MediaStream(remaining);
        localStreamRef.current = nextStream;
        setLocalStream(nextStream);
      }
      createdTrack = null;
    };
    audioRecoveryInFlightRef.current = true;

    const recoverAudioProducer = async () => {
      const hadLiveAudioTrackBeforeRecovery =
        localStreamRef.current
          ?.getAudioTracks()
          .some((track) => track.readyState === "live") === true;

      try {
        if (isMediaRecoveryBlocked()) return;
        let transport = getUsableProducerTransport(
          producerTransportRef.current,
        );
        if (!transport) {
          const transportReady =
            (await ensureProducerTransportRef?.current?.()) ?? false;
          transport = getUsableProducerTransport(producerTransportRef.current);
          if (!transportReady || !transport) {
            console.warn(
              "[Meets] Audio producer recovery waiting for producer transport.",
            );
            return;
          }
        }

        const shouldStartPaused = isMutedRef.current;
        let audioTrack = getFirstLiveTrack(
          (localStreamRef.current ?? localStream)?.getAudioTracks() ?? [],
        );

        if (!audioTrack || audioTrack.readyState !== "live") {
          if (shouldStartPaused) {
            console.info(
              "[Meets] Skipping muted microphone producer warmup without a reusable audio track.",
            );
            return;
          }
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: buildAudioConstraints(selectedAudioInputDeviceId),
          });
          audioTrack = stream.getAudioTracks()[0] ?? null;
          createdTrack = audioTrack;
        }

        if (!audioTrack) {
          throw new Error("No audio track available for recovery");
        }
        if (isMediaRecoveryBlocked()) {
          removeCreatedTrackFromLocalStream();
          return;
        }

        markAudioTrackForSpeech(audioTrack);
        audioTrack.enabled = !shouldStartPaused;
        audioTrack.onended = () => {
          handleLocalTrackEnded("audio", audioTrack);
        };

        if (createdTrack) {
          const previousStream = localStreamRef.current;
          previousStream?.getAudioTracks().forEach((track) => {
            stopLocalTrack(track);
          });
          const remainingTracks =
            previousStream
              ?.getTracks()
              .filter((track) => track.kind !== "audio") ?? [];
          const nextStream = new MediaStream([...remainingTracks, audioTrack]);
          localStreamRef.current = nextStream;
          setLocalStream(nextStream);
        }
        if (isMediaRecoveryBlocked()) {
          removeCreatedTrackFromLocalStream();
          return;
        }

        const audioProducer = await transport.produce({
          track: audioTrack,
          codecOptions: buildMicrophoneOpusCodecOptions(
            getPublishNetworkProfile(),
          ),
          stopTracks: false,
          appData: { type: "webcam" as ProducerType, paused: shouldStartPaused },
        });

        if (shouldStartPaused) {
          try {
            audioProducer.pause();
          } catch {}
        }

        if (cancelled) {
          try {
            audioProducer.close();
          } catch {}
          removeCreatedTrackFromLocalStream();
          return;
        }

        audioProducerRef.current = audioProducer;
        createdTrack = null;
        audioProducer.on("transportclose", () => {
          if (audioProducerRef.current?.id === audioProducer.id) {
            audioProducerRef.current = null;
            requestAudioProducerRecovery();
          }
        });
      } catch (err) {
        console.error("[Meets] Audio producer recovery failed:", err);
        removeCreatedTrackFromLocalStream();
        if (!cancelled) {
          const meetErr = createMeetError(err, "MEDIA_ERROR");
          const failedMutedWarmup =
            isMutedRef.current &&
            hadLiveAudioTrackBeforeRecovery &&
            !shouldDisableMediaIntentAfterRecoveryFailure(err, meetErr);
          if (
            !hadLiveAudioTrackBeforeRecovery &&
            shouldDisableMediaIntentAfterRecoveryFailure(err, meetErr)
          ) {
            setIsMuted(true);
          }
          if (!failedMutedWarmup) {
            setMeetError(meetErr);
          }
        }
      } finally {
        audioRecoveryInFlightRef.current = false;
      }
    };

    void recoverAudioProducer();

    return () => {
      cancelled = true;
      removeCreatedTrackFromLocalStream();
    };
  }, [
    ghostEnabled,
    isObserverMode,
    connectionState,
    audioProducerRecoveryPulse,
    isMuted,
    localStream,
    isMediaRecoveryBlocked,
    selectedAudioInputDeviceId,
    handleLocalTrackEnded,
    stopLocalTrack,
    buildAudioConstraints,
    producerTransportRef,
    ensureProducerTransportRef,
    audioProducerRef,
    localStreamRef,
    setLocalStream,
    setIsMuted,
    setMeetError,
    closeLocalAudioProducerForReplacement,
    getPublishNetworkProfile,
    markAudioTrackForSpeech,
    requestAudioProducerRecovery,
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

          const previousStream = localStreamRef.current;
          if (previousStream) {
            previousStream.getVideoTracks().forEach((track) => {
              stopLocalTrack(track);
            });
            const remainingTracks = previousStream
              .getTracks()
              .filter((track) => track.kind !== "video");
            commitLocalStream(new MediaStream(remainingTracks));
          }
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
          if (
            activeVideoEffectsCount > 0 &&
            !shouldDeferBandwidthHeavyPreload()
          ) {
            void prewarmVideoEffectsAssetsDeferred({
              segmentation: true,
              face: true,
              reason: "camera-toggle-live",
            });
          }

          let transport = getUsableProducerTransport(
            producerTransportRef.current,
          );
          if (!transport) {
            const transportReady =
              (await ensureProducerTransportRef?.current?.()) ?? false;
            transport = getUsableProducerTransport(producerTransportRef.current);
            if (!transportReady || !transport) {
              throw new Error("Video transport unavailable");
            }
          }
          if (!transport) {
            throw new Error("Video transport unavailable");
          }

          const stream = await navigator.mediaDevices.getUserMedia({
            video: buildVideoConstraints(),
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
          const networkProfile = getPublishNetworkProfile();
          const preferredWebcamCodec = getPreferredWebcamCodec(deviceRef.current);
          const videoProducer = await produceCameraTrackWithRawFallback({
            transport,
            publishTrack,
            rawTrack: videoTrack,
            quality,
            networkProfile,
            paused: false,
            preferredCodec: preferredWebcamCodec,
            context: "camera-toggle",
          });

          videoProducerRef.current = videoProducer;
          const videoProducerId = videoProducer.id;
          videoProducer.on("transportclose", () => {
            if (videoProducerRef.current?.id === videoProducerId) {
              videoProducerRef.current = null;
              requestCameraProducerRecovery();
            }
          });
          setIsCameraOff(false);
        } catch (err) {
          console.error("[Meets] Failed to restart video:", err);
          if (createdTrack) {
            stopLocalTrack(createdTrack);
            const currentStream = localStreamRef.current;
            if (currentStream?.getTracks().includes(createdTrack)) {
              const remaining = currentStream
                .getTracks()
                .filter(
                  (track) => track !== createdTrack && track.kind !== "video",
                );
              commitLocalStream(new MediaStream(remaining));
            }
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
    commitLocalStream,
    localStreamRef,
    videoQualityRef,
    setIsCameraOff,
    setMeetError,
    waitForPreferredVideoPublishTrack,
    buildVideoConstraints,
    getPublishNetworkProfile,
    produceCameraTrackWithRawFallback,
    requestCameraProducerRecovery,
  ]);

  useEffect(() => {
    if (ghostEnabled || isObserverMode) return;
    if (connectionState !== "joined") return;
    if (isCameraOff) return;
    if (isMediaRecoveryBlocked()) return;

    let disposed = false;
    const requestRecovery = (reason: "initial" | "watchdog") => {
      if (
        disposed ||
        cameraRecoveryInFlightRef.current ||
        isMediaRecoveryBlocked()
      ) {
        return;
      }

      const producer = videoProducerRef.current;
      const producerTrack = producer?.track ?? null;
      const needsRecovery =
        !producer || producer.closed || producerTrack?.readyState !== "live";
      if (!needsRecovery) return;

      const rawCameraTrack = getFirstLiveTrack(
        localStreamRef.current?.getVideoTracks() ?? [],
      );
      if (
        producer &&
        !producer.closed &&
        rawCameraTrack &&
        producerTrack?.readyState !== "live"
      ) {
        if (cameraProducerTrackRepairInFlightRef.current) return;
        cameraProducerTrackRepairInFlightRef.current = true;
        void (async () => {
          try {
            if (
              videoProducerRef.current?.id !== producer.id ||
              producer.closed ||
              isMediaRecoveryBlocked()
            ) {
              return;
            }
            if ("contentHint" in rawCameraTrack) {
              rawCameraTrack.contentHint = "motion";
            }
            rawCameraTrack.onended = () => {
              handleLocalTrackEnded("video", rawCameraTrack);
            };
            await producer.replaceTrack({ track: rawCameraTrack });
            if (producerTrack && producerTrack.id !== rawCameraTrack.id) {
              onPreferredVideoPublishTrackRejected?.(
                producerTrack,
                "camera-producer-raw-repair",
              );
            }
            await applyWebcamProducerNetworkProfile(
              producer,
              videoQualityRef.current,
              getPublishNetworkProfile(),
            );
            console.info("[Meets] Repaired camera producer with raw track:", {
              reason,
              producerId: producer.id,
              previousTrackId: producerTrack?.id ?? null,
              rawTrackId: rawCameraTrack.id,
            });
          } catch (err) {
            console.warn(
              "[Meets] Camera producer raw-track repair failed; recreating producer:",
              err,
            );
            if (
              !isMediaRecoveryBlocked() &&
              videoProducerRef.current?.id === producer.id
            ) {
              closeLocalVideoProducerForReplacement(producer);
              requestCameraProducerRecovery();
            }
          } finally {
            cameraProducerTrackRepairInFlightRef.current = false;
          }
        })();
        return;
      }

      if (producer && videoProducerRef.current?.id === producer.id) {
        closeLocalVideoProducerForReplacement(producer);
      }

      console.warn("[Meets] Camera producer recovery triggered:", {
        reason,
        hasProducer: Boolean(producer),
        producerClosed: producer?.closed ?? null,
        producerId: producer?.id ?? null,
        trackId: producerTrack?.id ?? null,
        trackState: producerTrack?.readyState ?? null,
      });
      requestCameraProducerRecovery();
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
    isMediaRecoveryBlocked,
    isObserverMode,
    videoProducerRef,
    localStreamRef,
    videoQualityRef,
    handleLocalTrackEnded,
    waitForPreferredVideoPublishTrack,
    getPublishNetworkProfile,
    onPreferredVideoPublishTrackRejected,
    closeLocalVideoProducerForReplacement,
    requestCameraProducerRecovery,
  ]);

  useEffect(() => {
    if (ghostEnabled || isObserverMode) {
      cameraOutboundStallStateRef.current = createCameraOutboundStallState();
      return;
    }
    if (
      connectionState !== "joined" ||
      isCameraOff ||
      isMediaRecoveryBlocked()
    ) {
      cameraOutboundStallStateRef.current = createCameraOutboundStallState();
      return;
    }

    let disposed = false;

    const resetStallState = (
      producerId: string | null = null,
      trackId: string | null = null,
    ) => {
      cameraOutboundStallStateRef.current =
        createCameraOutboundStallState(producerId, trackId);
    };

    const recoverStalledProducer = async ({
      producer,
      producerTrack,
      sample,
      state,
      allowProducerRecreate,
    }: {
      producer: Producer;
      producerTrack: MediaStreamTrack;
      sample: OutboundVideoProgressSample;
      state: CameraOutboundStallState;
      allowProducerRecreate: boolean;
    }) => {
      if (disposed) return;
      if (cameraProducerTrackRepairInFlightRef.current) return;
      if (cameraRecoveryInFlightRef.current) return;
      if (isMediaRecoveryBlocked()) {
        cameraOutboundStallStateRef.current = {
          ...state,
          lastRecoveryAtMs: performance.now(),
        };
        return;
      }

      const now = performance.now();
      if (
        state.lastRecoveryAtMs > 0 &&
        now - state.lastRecoveryAtMs <
          CAMERA_OUTBOUND_STALL_RECOVERY_COOLDOWN_MS
      ) {
        return;
      }

      const rawCameraTrack = getFirstLiveTrack(
        localStreamRef.current?.getVideoTracks() ?? [],
      );
      if (
        !rawCameraTrack ||
        rawCameraTrack.readyState !== "live" ||
        rawCameraTrack.muted
      ) {
        return;
      }

      cameraProducerTrackRepairInFlightRef.current = true;
      try {
        if (
          disposed ||
          videoProducerRef.current?.id !== producer.id ||
          producer.closed ||
          isMediaRecoveryBlocked()
        ) {
          return;
        }

        const shouldTryPreferredRepair = !state.rawRepairAttempted;
        if (shouldTryPreferredRepair) {
          const publishStream =
            localStreamRef.current ?? new MediaStream([rawCameraTrack]);
          const publishTrack = await waitForPreferredVideoPublishTrack(
            publishStream,
            rawCameraTrack,
          );
          if (!publishTrack || publishTrack.readyState !== "live") {
            return;
          }
          if ("contentHint" in rawCameraTrack) {
            rawCameraTrack.contentHint = "motion";
          }
          rawCameraTrack.onended = () => {
            handleLocalTrackEnded("video", rawCameraTrack);
          };
          await producer.replaceTrack({ track: publishTrack });
          if (
            publishTrack.id === rawCameraTrack.id &&
            producerTrack.id !== rawCameraTrack.id
          ) {
            onPreferredVideoPublishTrackRejected?.(
              producerTrack,
              "camera-outbound-stall-raw-repair",
            );
          }
          await applyWebcamProducerNetworkProfile(
            producer,
            videoQualityRef.current,
            getPublishNetworkProfile(),
          );
          cameraOutboundStallStateRef.current = {
            ...createCameraOutboundStallState(producer.id, publishTrack.id),
            frames: sample.frames,
            bytes: sample.bytes,
            rawRepairAttempted: true,
            lastRecoveryAtMs: now,
          };
          console.warn(
            "[Meets] Refreshed stalled camera sender with preferred camera track:",
            {
              producerId: producer.id,
              previousTrackId: producerTrack.id,
              publishTrackId: publishTrack.id,
              rawTrackId: rawCameraTrack.id,
              usedRawFallback: publishTrack.id === rawCameraTrack.id,
              stalledSamples: state.stalledSamples,
              frames: sample.frames,
              bytes: sample.bytes,
            },
          );
          return;
        }

        if (!allowProducerRecreate) {
          cameraOutboundStallStateRef.current = {
            ...state,
            lastRecoveryAtMs: now,
          };
          console.warn(
            "[Meets] Camera sender stalled in background; keeping producer open.",
            {
              producerId: producer.id,
              trackId: producerTrack.id,
              rawTrackId: rawCameraTrack.id,
              stalledSamples: state.stalledSamples,
              frames: sample.frames,
              bytes: sample.bytes,
            },
          );
          return;
        }

        console.warn("[Meets] Recreating stalled camera sender:", {
          producerId: producer.id,
          trackId: producerTrack.id,
          rawTrackId: rawCameraTrack.id,
          stalledSamples: state.stalledSamples,
          frames: sample.frames,
          bytes: sample.bytes,
        });
        const currentCodecMimeType =
          producer.rtpParameters.codecs
            .find((codec) => codec.mimeType.toLowerCase().startsWith("video/"))
            ?.mimeType.toLowerCase() ?? null;
        const device = deviceRef.current;
        const currentCodec =
          device?.rtpCapabilities.codecs?.find(
            (codec) =>
              currentCodecMimeType !== null &&
              codec.mimeType.toLowerCase() === currentCodecMimeType,
          ) ?? getPreferredWebcamCodec(device);
        const fallbackCodec = getFallbackWebcamCodec(device, currentCodec);
        cameraRecoveryCodecOverrideRef.current =
          fallbackCodec ?? currentCodec ?? null;
        cameraRecoveryForceSingleLayerRef.current = true;
        console.warn("[Meets] Next camera recovery will use single-layer codec:", {
          currentCodec: currentCodec?.mimeType ?? currentCodecMimeType,
          fallbackCodec: fallbackCodec?.mimeType ?? null,
        });
        closeLocalVideoProducerForReplacement(producer);
        resetStallState();
        requestCameraProducerRecovery();
      } catch (err) {
        if (
          !allowProducerRecreate ||
          isMediaRecoveryBlocked() ||
          videoProducerRef.current?.id !== producer.id
        ) {
          cameraOutboundStallStateRef.current = {
            ...state,
            lastRecoveryAtMs: performance.now(),
          };
          console.warn(
            "[Meets] Stalled camera sender recovery failed; keeping producer open:",
            err,
          );
          return;
        }

        console.warn(
          "[Meets] Stalled camera sender recovery failed; recreating producer:",
          err,
        );
        closeLocalVideoProducerForReplacement(producer);
        resetStallState();
        requestCameraProducerRecovery();
      } finally {
        cameraProducerTrackRepairInFlightRef.current = false;
      }
    };

    const pollOutboundProgress = () => {
      if (disposed) return;
      if (isMediaRecoveryBlocked()) {
        resetStallState();
        return;
      }
      if (
        cameraProducerTrackRepairInFlightRef.current ||
        cameraRecoveryInFlightRef.current
      ) {
        return;
      }

      const producer = videoProducerRef.current;
      const producerTrack = producer?.track ?? null;
      if (!producer || producer.closed || producer.paused || !producerTrack) {
        resetStallState();
        return;
      }
      if (
        producerTrack.readyState !== "live" ||
        !producerTrack.enabled ||
        producerTrack.muted
      ) {
        resetStallState(producer.id, producerTrack.id);
        return;
      }

      void producer
        .getStats()
        .then((report) => {
          if (disposed || isMediaRecoveryBlocked()) return;
          if (
            videoProducerRef.current?.id !== producer.id ||
            producer.closed ||
            producer.paused ||
            producer.track?.id !== producerTrack.id ||
            producerTrack.readyState !== "live" ||
            !producerTrack.enabled ||
            producerTrack.muted
          ) {
            resetStallState(
              videoProducerRef.current?.id ?? null,
              videoProducerRef.current?.track?.id ?? null,
            );
            return;
          }

          const sample = readOutboundVideoProgressSample(report);
          const allowProducerRecreate =
            typeof document === "undefined" ||
            document.visibilityState === "visible";
          const currentState = cameraOutboundStallStateRef.current;
          const previous =
            currentState.producerId === producer.id &&
            currentState.trackId === producerTrack.id
              ? currentState
              : createCameraOutboundStallState(producer.id, producerTrack.id);
          const hasBaseline =
            previous.frames !== null || previous.bytes !== null;
          const stalledSamples =
            hasBaseline && !hasOutboundVideoProgress(previous, sample)
              ? previous.stalledSamples + 1
              : 0;
          const nextState: CameraOutboundStallState = {
            ...previous,
            producerId: producer.id,
            trackId: producerTrack.id,
            frames: sample.frames,
            bytes: sample.bytes,
            stalledSamples,
          };
          cameraOutboundStallStateRef.current = nextState;

          if (
            stalledSamples < CAMERA_OUTBOUND_STALL_SAMPLES_BEFORE_RECOVERY ||
            isEncoderLimitedOutboundSample(sample)
          ) {
            return;
          }

          void recoverStalledProducer({
            producer,
            producerTrack,
            sample,
            state: nextState,
            allowProducerRecreate,
          });
        })
        .catch(() => {
          resetStallState(
            videoProducerRef.current?.id ?? null,
            videoProducerRef.current?.track?.id ?? null,
          );
        });
    };

    pollOutboundProgress();
    const interval = window.setInterval(
      pollOutboundProgress,
      CAMERA_OUTBOUND_STALL_CHECK_MS,
    );

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [
    connectionState,
    ghostEnabled,
    isCameraOff,
    isObserverMode,
    isMediaRecoveryBlocked,
    videoProducerRef,
    deviceRef,
    localStreamRef,
    videoQualityRef,
    handleLocalTrackEnded,
    getPublishNetworkProfile,
    onPreferredVideoPublishTrackRejected,
    closeLocalVideoProducerForReplacement,
    requestCameraProducerRecovery,
  ]);

  useEffect(() => {
    if (ghostEnabled || isObserverMode) return;
    if (connectionState !== "joined") return;
    if (isCameraOff) return;
    if (isMediaRecoveryBlocked()) return;
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
      closeLocalVideoProducerForReplacement(existingProducer);
    }
    if (cameraRecoveryInFlightRef.current) return;

    let cancelled = false;
    let createdTrack: MediaStreamTrack | null = null;
    const removeCreatedTrackFromLocalStream = () => {
      if (!createdTrack) return;
      stopLocalTrack(createdTrack);
      const currentStream = localStreamRef.current;
      if (currentStream?.getTracks().includes(createdTrack)) {
        const remaining = currentStream
          .getTracks()
          .filter((track) => track !== createdTrack);
        const nextStream = new MediaStream(remaining);
        localStreamRef.current = nextStream;
        setLocalStream(nextStream);
      }
      createdTrack = null;
    };
    cameraRecoveryInFlightRef.current = true;

    const recoverCameraProducer = async () => {
      let consumedRecoveryPublishOverride = false;
      const hadLiveCameraTrackBeforeRecovery =
        localStreamRef.current
          ?.getVideoTracks()
          .some((track) => track.readyState === "live") === true;

      try {
        if (isMediaRecoveryBlocked()) return;
        let transport = getUsableProducerTransport(producerTransportRef.current);
        if (!transport) {
          const transportReady =
            (await ensureProducerTransportRef?.current?.()) ?? false;
          transport = getUsableProducerTransport(producerTransportRef.current);
          if (!transportReady || !transport) {
            console.warn(
              "[Meets] Camera producer recovery waiting for producer transport.",
            );
            return;
          }
        }

        let videoTrack = getFirstLiveTrack(
          localStreamRef.current?.getVideoTracks() ?? [],
        );

        if (!videoTrack || videoTrack.readyState !== "live") {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: buildVideoConstraints(),
          });
          videoTrack = stream.getVideoTracks()[0] ?? null;
          createdTrack = videoTrack;
        }

        if (!videoTrack) {
          throw new Error("No video track available for recovery");
        }
        if (isMediaRecoveryBlocked()) {
          removeCreatedTrackFromLocalStream();
          return;
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
        if (isMediaRecoveryBlocked()) {
          removeCreatedTrackFromLocalStream();
          return;
        }

        const publishStream =
          localStreamRef.current ?? new MediaStream([videoTrack]);
        const publishTrack = await waitForPreferredVideoPublishTrack(
          publishStream,
          videoTrack,
        );
        const quality = videoQualityRef.current;
        const networkProfile = getPublishNetworkProfile();
        const forceSingleLayer = cameraRecoveryForceSingleLayerRef.current;
        const recoveryCodecOverride = cameraRecoveryCodecOverrideRef.current;
        consumedRecoveryPublishOverride =
          forceSingleLayer || recoveryCodecOverride !== null;
        const preferredWebcamCodec =
          recoveryCodecOverride ?? getPreferredWebcamCodec(deviceRef.current);
        const recoveredProducer = await produceCameraTrackWithRawFallback({
          transport,
          publishTrack,
          rawTrack: videoTrack,
          quality,
          networkProfile,
          paused: false,
          preferredCodec: preferredWebcamCodec,
          forceSingleLayer,
          context: "camera-recovery",
        });

        if (cancelled) {
          try {
            recoveredProducer.close();
          } catch {}
          removeCreatedTrackFromLocalStream();
          return;
        }

        videoProducerRef.current = recoveredProducer;
        createdTrack = null;
        recoveredProducer.on("transportclose", () => {
          if (videoProducerRef.current?.id === recoveredProducer.id) {
            videoProducerRef.current = null;
            requestCameraProducerRecovery();
          }
        });
        setIsCameraOff(false);
      } catch (err) {
        console.error("[Meets] Camera producer recovery failed:", err);
        removeCreatedTrackFromLocalStream();
        if (!cancelled) {
          const meetErr = createMeetError(err, "MEDIA_ERROR");
          if (
            !hadLiveCameraTrackBeforeRecovery &&
            shouldDisableMediaIntentAfterRecoveryFailure(err, meetErr)
          ) {
            setIsCameraOff(true);
          }
          setMeetError(meetErr);
        }
      } finally {
        if (consumedRecoveryPublishOverride) {
          cameraRecoveryCodecOverrideRef.current = null;
          cameraRecoveryForceSingleLayerRef.current = false;
        }
        cameraRecoveryInFlightRef.current = false;
      }
    };

    void recoverCameraProducer();

    return () => {
      cancelled = true;
      removeCreatedTrackFromLocalStream();
    };
  }, [
    ghostEnabled,
    isObserverMode,
    connectionState,
    cameraProducerRecoveryPulse,
    isCameraOff,
    isMediaRecoveryBlocked,
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
    buildVideoConstraints,
    getPublishNetworkProfile,
    produceCameraTrackWithRawFallback,
    closeLocalVideoProducerForReplacement,
    requestCameraProducerRecovery,
  ]);

  const stopScreenShareStream = useCallback(
    (screenStream: MediaStream | null) => {
      if (!screenStream) return;
      for (const track of screenStream.getTracks()) {
        track.onended = null;
        stopLocalTrack(track);
      }
    },
    [stopLocalTrack],
  );

  const toggleScreenShare = useCallback(async () => {
    if (ghostEnabled || isObserverMode) return;
    if (isScreenSharing) {
      const producer = screenProducerRef.current;
      const audioProducer = screenAudioProducerRef.current;
      const screenStream = screenShareStreamRef.current;
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
      stopScreenShareStream(screenStream);
      screenShareStreamRef.current = null;
      setIsScreenSharing(false);
      setActiveScreenShareId(null);
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

    try {
      let transport = getUsableProducerTransport(producerTransportRef.current);
      if (!transport) {
        const transportReady =
          (await ensureProducerTransportRef?.current?.()) ?? false;
        transport = getUsableProducerTransport(producerTransportRef.current);
        if (!transportReady || !transport) {
          throw new Error("Screen share transport unavailable");
        }
      }

      const screenNetworkProfile = getPublishNetworkProfile();
      const videoConstraints =
        buildScreenShareVideoConstraintsForNetworkProfile(
          screenNetworkProfile,
        );

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: true,
      });
      const track = stream.getVideoTracks()[0];
      if (track && "contentHint" in track) {
        track.contentHint = "detail";
      }
      await applyScreenShareTrackNetworkProfile(track, screenNetworkProfile);

      const preferredScreenShareCodec = getPreferredScreenShareCodec(
        deviceRef.current,
      );
      const producer = await transport.produce({
        track,
        encodings: [
          buildScreenShareEncodingForNetworkProfile(screenNetworkProfile),
        ],
        stopTracks: false,
        ...(preferredScreenShareCodec ? { codec: preferredScreenShareCodec } : {}),
        appData: { type: "screen" as ProducerType },
      });

      screenShareStreamRef.current = stream;
      screenProducerRef.current = producer;
      setIsScreenSharing(true);
      setActiveScreenShareId(producer.id);

      let screenVideoEnded = false;
      const closeScreenAudioProducer = (audioProducer: Producer) => {
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
        if (screenAudioProducerRef.current?.id === audioProducer.id) {
          screenAudioProducerRef.current = null;
        }
      };
      const finishScreenShare = () => {
        if (screenVideoEnded) return;
        screenVideoEnded = true;
        socketRef.current?.emit(
          "closeProducer",
          { producerId: producer.id },
          () => {}
        );
        try {
          producer.close();
        } catch {}
        if (screenProducerRef.current?.id === producer.id) {
          screenProducerRef.current = null;
        }
        const currentAudioProducer = screenAudioProducerRef.current;
        if (currentAudioProducer) {
          closeScreenAudioProducer(currentAudioProducer);
        }
        stopScreenShareStream(screenShareStreamRef.current);
        screenShareStreamRef.current = null;
        setIsScreenSharing(false);
        setActiveScreenShareId(null);
      };
      track.onended = finishScreenShare;

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack && audioTrack.readyState === "live") {
        try {
          const audioProducer = await transport.produce({
            track: audioTrack,
            codecOptions: buildScreenShareAudioOpusCodecOptions(
              screenNetworkProfile,
            ),
            stopTracks: false,
            appData: { type: "screen" as ProducerType },
          });

          if (
            screenVideoEnded ||
            track.readyState !== "live" ||
            screenShareStreamRef.current !== stream
          ) {
            if (!screenVideoEnded) {
              finishScreenShare();
            }
            closeScreenAudioProducer(audioProducer);
            return;
          }

          screenAudioProducerRef.current = audioProducer;
          const audioProducerId = audioProducer.id;
          audioProducer.on("transportclose", () => {
            if (screenAudioProducerRef.current?.id === audioProducerId) {
              screenAudioProducerRef.current = null;
            }
          });

          audioTrack.onended = () => {
            closeScreenAudioProducer(audioProducer);
          };
        } catch (audioErr) {
          console.warn("[Meets] Failed to share screen audio:", audioErr);
        }
      }
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
    setActiveScreenShareId,
    producerTransportRef,
    screenProducerRef,
    screenAudioProducerRef,
    screenShareStreamRef,
    socketRef,
    setMeetError,
    ensureProducerTransportRef,
    getPublishNetworkProfile,
    stopScreenShareStream,
    stopLocalTrack,
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
    requestAudioProducerRecovery,
    requestCameraProducerRecovery,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    stopLocalTrack,
    handleLocalTrackEnded,
    primeAudioOutput,
    playNotificationSound,
  };
}
