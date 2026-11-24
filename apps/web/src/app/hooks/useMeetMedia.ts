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
  WebcamCodecPolicy,
} from "../lib/types";
import {
  getBrowserNetworkSnapshot,
  isLikelyMobileOrTabletNavigator,
  shouldDeferBandwidthHeavyPreload,
} from "../lib/network-information";
import {
  getBrowserMediaAdaptationQuality,
  hasBrowserMediaEmergencyEvidence,
} from "../lib/connection-quality-policy";
import { clampMeetVolume, DEFAULT_MEET_VOLUME } from "../lib/meet-volume";
import { applyAudioOutputDevice } from "../lib/audio-output";
import {
  getUserMediaWithTimeout,
  MEDIA_CAPTURE_PERMISSION_TIMEOUT_MS,
  MEDIA_CAPTURE_RECOVERY_TIMEOUT_MS,
} from "../lib/media-capture-timeout";
import {
  captureDisplayMedia,
  captureGeneration,
  holdClone,
  isCaptureReleased,
} from "../lib/media-captures";
import { installProducer } from "../lib/producer-slot";
import type { Device as IntentDevice, DeviceIntentStore } from "../lib/device-intent";
import {
  clearMediaDeviceError,
  createMediaDeviceError,
  createMeetError,
  mergeMediaDeviceError,
  type MediaDeviceFailures,
} from "../lib/utils";
import { acquireLocalTracks, settleLocalTracks } from "../lib/media-acquisition";
import {
  createCapturedSurfaceControlState,
  createCaptureController,
  getCapturedDisplaySurface,
  getDefaultCapturedSurfaceControlState,
  type CaptureControllerLike,
} from "../lib/captured-surface-control";
import { prewarmVideoEffectsAssetsDeferred } from "../lib/video-effects-lazy";
import {
  createNoiseCancellationPipeline,
  getNoiseCancellationSourceTrack,
  isNoiseCancellationProcessedTrack,
  setNoiseCancellationTrackEnabled,
  stopNoiseCancellationForTrack,
} from "../lib/noise-cancellation";
import {
  applyAudioProducerNetworkProfile,
  applyScreenShareProducerNetworkProfile,
  applyWebcamProducerNetworkProfile,
  applyScreenShareTrackNetworkProfile,
  getFallbackWebcamCodec,
  getPreferredScreenShareCodec,
  getPreferredWebcamCodec,
  getWebcamProducerTopology,
  isVp9SvcWebcamProducer,
  produceScreenShareTrack,
  produceWebcamTrack,
  produceWebcamTrackWithRawTrackFallback,
  requestVideoSenderKeyFrame,
  shouldRecreateWebcamProducerForQuality,
  shouldUseWebcamSimulcast,
  type WebcamProducerNetworkProfile,
  type WebcamReceiverCapacityTransition,
} from "../lib/webcam-codec";
import {
  attachVp9ZeroFrameReproducer,
  classifyVp9CodecFailure,
  createVp9ZeroFrameProof,
  getProvenVp9ZeroFrameStall,
  normalizeWebcamCodecPolicy,
  rememberProvenVp9EncoderIncompatibility,
  resolveWebcamCodecRecoveryOverride,
  type Vp9ZeroFrameProof,
  type WebcamCodecRecoveryOverride,
} from "../lib/webcam-codec-policy";
import {
  selectScreenSharePublishNetworkProfile,
} from "../lib/screen-share-network-profile";
import {
  advanceScreenShareTrackRefreshAttempts,
  getScreenShareStallRecoveryAction,
  MAX_SCREEN_SHARE_TRACK_REFRESH_ATTEMPTS,
  shouldReopenCameraAfterConstraintFailure,
} from "../lib/media-recovery-policy";
import {
  getScreenShareLiveVideoSettingsSignature,
  resolveEffectiveCameraPublishSettings,
  resolveScreenSharePublishSettings,
  type MediaQualitySettings,
} from "../lib/media-quality-settings";
import {
  createLatestWinsAsyncQueue,
  type LatestWinsAsyncQueue,
} from "../lib/latest-wins-async-queue";
import { resumeProducerWithServerConfirmation } from "../lib/media-toggle-policy";
import {
  createLatestWinsTopologyReplacementQueue,
  getWebcamTopologyReplacementFailureDisposition,
  type LatestWinsTopologyReplacementQueue,
  type WebcamProducerTopology,
  type WebcamTopologyReplacementResult,
  type WebcamTopologyReplacementTarget,
} from "../lib/webcam-topology-transition";
import type { ConnectionQualityStats } from "./useConnectionQuality";

interface UseMeetMediaOptions {
  isObserverMode?: boolean;
  deviceIntents: DeviceIntentStore;
  connectionState: string;
  isMuted: boolean;
  setIsMuted: (value: boolean) => void;
  isCameraOff: boolean;
  setIsCameraOff: (value: boolean) => void;
  cameraDisabled?: boolean;
  microphoneUnmuteDisabled?: boolean;
  cameraEnableDisabled?: boolean;
  isScreenSharing: boolean;
  setIsScreenSharing: (value: boolean) => void;
  activeScreenShareId: string | null;
  setActiveScreenShareId: (value: string | null) => void;
  localStream: MediaStream | null;
  setLocalStream: React.Dispatch<React.SetStateAction<MediaStream | null>>;
  setMeetError: React.Dispatch<React.SetStateAction<MeetError | null>>;
  setMediaError: React.Dispatch<React.SetStateAction<MeetError | null>>;
  selectedAudioInputDeviceId?: string;
  setSelectedAudioInputDeviceId: React.Dispatch<
    React.SetStateAction<string | undefined>
  >;
  setSelectedAudioOutputDeviceId: React.Dispatch<
    React.SetStateAction<string | undefined>
  >;
  selectedVideoInputDeviceId?: string;
  setSelectedVideoInputDeviceId: React.Dispatch<
    React.SetStateAction<string | undefined>
  >;
  isNoiseCancellationEnabled?: boolean;
  meetVolume?: number;
  videoQualityRef: React.MutableRefObject<VideoQuality>;
  mediaQualitySettings: MediaQualitySettings;
  mediaQualitySettingsRef: React.MutableRefObject<MediaQualitySettings>;
  webcamCodecPolicyRef: React.MutableRefObject<WebcamCodecPolicy>;
  dataSaverMode?: boolean;
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
    ((options?: ProducerTransportEnsureOptions) => Promise<boolean>) | null
  >;
  republishScreenShareRef?: React.MutableRefObject<
    ((
      reason: string,
      options?: ScreenShareRepublishOptions,
    ) => Promise<boolean>) | null
  >;
  audioProducerRef: React.MutableRefObject<Producer | null>;
  videoProducerRef: React.MutableRefObject<Producer | null>;
  screenProducerRef: React.MutableRefObject<Producer | null>;
  screenAudioProducerRef: React.MutableRefObject<Producer | null>;
  screenShareStreamRef: React.MutableRefObject<MediaStream | null>;
  screenShareCaptureControllerRef: React.MutableRefObject<CaptureControllerLike | null>;
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

export type ProducerTransportEnsureOptions = {
  forCameraPublish?: boolean;
};

export type ScreenShareRepublishOptions = {
  replaceCurrent?: boolean;
};

export type RequestMediaPermissionsOptions = {
  audio?: boolean;
  video?: boolean;
  audioRequired?: boolean;
  videoRequired?: boolean;
};

export type WebcamProducerTopologyReplacementRequest = {
  target: WebcamTopologyReplacementTarget;
  expectedProducerId: string;
  quality: VideoQuality;
  networkProfile: WebcamProducerNetworkProfile;
  transition?: WebcamReceiverCapacityTransition;
};

type ScreenAudioProducerAppData = {
  type: ProducerType;
  networkProfile?: WebcamProducerNetworkProfile;
};

type DisplayMediaSurfaceHint =
  | "application"
  | "browser"
  | "monitor"
  | "window";

type DisplayMediaVideoConstraints = MediaTrackConstraints & {
  cursor?: "always" | "motion" | "never";
  displaySurface?: DisplayMediaSurfaceHint;
};

type DisplayMediaIncludePreference = "include" | "exclude";

type ExtendedDisplayMediaStreamOptions = DisplayMediaStreamOptions & {
  controller?: CaptureControllerLike;
  monitorTypeSurfaces?: DisplayMediaIncludePreference;
  selfBrowserSurface?: DisplayMediaIncludePreference;
  surfaceSwitching?: DisplayMediaIncludePreference;
  systemAudio?: DisplayMediaIncludePreference;
};

const getStartupAwarePublishQuality = (
  stats: ConnectionQualityStats | null | undefined,
  browserNetwork: ReturnType<typeof getBrowserNetworkSnapshot>,
) => {
  if (
    stats?.publishAdaptationQuality &&
    stats.publishAdaptationQuality !== "unknown"
  ) {
    return stats.publishAdaptationQuality;
  }
  return getBrowserMediaAdaptationQuality(browserNetwork);
};

const isPublishEmergencyProfile = (
  stats: ConnectionQualityStats | null | undefined,
  browserNetwork: ReturnType<typeof getBrowserNetworkSnapshot>,
) =>
  hasBrowserMediaEmergencyEvidence(browserNetwork) ||
  (stats?.publishEmergencyMode === true &&
    stats.publishAdaptationQuality !== "good");

const getFirstLiveTrack = <T extends MediaStreamTrack>(
  tracks: readonly T[],
): T | null => tracks.find((track) => track.readyState === "live") ?? null;

const getInputDevices = (
  devices: readonly MediaDeviceInfo[],
  kind: "audioinput" | "videoinput",
) => devices.filter((device) => device.kind === kind && device.deviceId);

const hasInputDeviceId = (
  devices: readonly MediaDeviceInfo[],
  deviceId: string | undefined,
) => Boolean(deviceId && devices.some((device) => device.deviceId === deviceId));

const getFallbackInputDeviceId = (devices: readonly MediaDeviceInfo[]) =>
  devices.find((device) => device.label && device.deviceId)?.deviceId;

const TOGGLE_MUTE_STRICT_ACK_TIMEOUT_MS = 5000;
const TOGGLE_MUTE_FAST_ACK_TIMEOUT_MS = 1500;
const TOGGLE_MUTE_BACKGROUND_ACK_TIMEOUT_MS = 3000;
const TOGGLE_CAMERA_ACK_TIMEOUT_MS = 5000;

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

const isDisplayMediaConstraintRetryableError = (error: unknown): boolean => {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";
  return (
    name === "TypeError" ||
    name === "OverconstrainedError" ||
    name === "ConstraintNotSatisfiedError"
  );
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
  trackRefreshAttemptsWithoutProgress: number;
  lastRecoveryAtMs: number;
};

const CAMERA_OUTBOUND_STALL_CHECK_MS = 2000;
const CAMERA_OUTBOUND_STALL_SAMPLES_BEFORE_RECOVERY = 3;
const SCREEN_SHARE_OUTBOUND_STALL_SAMPLES_BEFORE_REFRESH = 2;
const CAMERA_OUTBOUND_STALL_RECOVERY_COOLDOWN_MS = 10000;
const MIN_OUTBOUND_VIDEO_BYTE_DELTA_FOR_PROGRESS = 1200;
const MIN_SCREEN_SHARE_OUTBOUND_BYTE_DELTA_FOR_STALL = 8000;
const LOCAL_AUDIO_MUTED_RECOVERY_DELAY_MS = 4000;
const LOCAL_AUDIO_MUTED_RECOVERY_COOLDOWN_MS = 15000;
const LOCAL_VIDEO_MUTED_RECOVERY_DELAY_MS = 5000;
const LOCAL_VIDEO_MUTED_RECOVERY_COOLDOWN_MS = 15000;
const SCREEN_SHARE_MUTED_WARNING_DELAY_MS = 5000;
const SCREEN_SHARE_SOURCE_STALLED_MESSAGE =
  "Screen sharing is not sending frames. Bring the shared window back into view, or stop sharing and share again.";

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
  trackRefreshAttemptsWithoutProgress: 0,
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

const isDocumentVisibleForMediaRecovery = (): boolean =>
  typeof document === "undefined" || document.visibilityState === "visible";

const hasOutboundVideoProgress = (
  previous: CameraOutboundStallState,
  sample: OutboundVideoProgressSample,
): boolean => {
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

const hasOutboundScreenShareStallEvidence = (
  previous: CameraOutboundStallState,
  sample: OutboundVideoProgressSample,
): boolean => {
  const byteDelta =
    previous.bytes !== null && sample.bytes !== null
      ? sample.bytes - previous.bytes
      : null;
  if (
    byteDelta === null ||
    byteDelta < MIN_SCREEN_SHARE_OUTBOUND_BYTE_DELTA_FOR_STALL
  ) {
    return false;
  }

  if (previous.frames !== null && sample.frames !== null) {
    if (sample.frames > previous.frames) return false;
    if (sample.framesPerSecond !== null && sample.framesPerSecond > 0) {
      return false;
    }
    return true;
  }

  if (sample.framesPerSecond !== null) {
    return sample.framesPerSecond <= 0;
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
    (error instanceof Error && error.name === "NotFoundError") ||
    message.includes("NotFoundError") ||
    message.includes("DevicesNotFoundError")
  );
};

export function useMeetMedia({
  isObserverMode = false,
  deviceIntents,
  connectionState,
  isMuted,
  setIsMuted,
  isCameraOff,
  setIsCameraOff,
  cameraDisabled = false,
  microphoneUnmuteDisabled = false,
  cameraEnableDisabled = false,
  isScreenSharing,
  setIsScreenSharing,
  activeScreenShareId,
  setActiveScreenShareId,
  localStream,
  setLocalStream,
  setMeetError,
  setMediaError,
  selectedAudioInputDeviceId,
  setSelectedAudioInputDeviceId,
  setSelectedAudioOutputDeviceId,
  selectedVideoInputDeviceId,
  setSelectedVideoInputDeviceId,
  isNoiseCancellationEnabled = true,
  meetVolume = DEFAULT_MEET_VOLUME,
  videoQualityRef,
  mediaQualitySettings,
  mediaQualitySettingsRef,
  webcamCodecPolicyRef,
  dataSaverMode = false,
  activeVideoEffectsCount = 0,
  shouldUsePreferredVideoPublishTrack = activeVideoEffectsCount > 0,
  getVideoPublishTrackRef,
  onPreferredVideoPublishTrackRejected,
  socketRef,
  deviceRef,
  producerTransportRef,
  ensureProducerTransportRef,
  republishScreenShareRef,
  audioProducerRef,
  videoProducerRef,
  screenProducerRef,
  screenAudioProducerRef,
  screenShareStreamRef,
  screenShareCaptureControllerRef,
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
  const [screenShareControlState, setScreenShareControlState] = useState(
    getDefaultCapturedSurfaceControlState,
  );
  const resetScreenShareControlState = useCallback(() => {
    screenShareCaptureControllerRef.current = null;
    setScreenShareControlState(getDefaultCapturedSurfaceControlState());
  }, [screenShareCaptureControllerRef]);
  const updateVideoQualityRef = useRef<
    (
      quality: VideoQuality,
      networkProfileOverride?: WebcamProducerNetworkProfile,
      forceCaptureRefresh?: boolean,
    ) => Promise<void>
  >(async () => {});
  const previousCameraQualitySettingsRef = useRef(
    JSON.stringify({
      settings: mediaQualitySettings.camera,
      effectsActive: activeVideoEffectsCount > 0,
    }),
  );
  const previousScreenShareQualitySettingsRef = useRef(
    getScreenShareLiveVideoSettingsSignature(mediaQualitySettings.screenShare),
  );
  const applyLatestCameraQualitySettingsRef = useRef<
    (signature: string) => Promise<void>
  >(async () => {});
  const applyLatestScreenShareQualitySettingsRef = useRef<
    (signature: string) => Promise<void>
  >(async () => {});
  const cameraQualitySettingsQueueRef = useRef<
    LatestWinsAsyncQueue<string> | null
  >(null);
  const screenShareQualitySettingsQueueRef = useRef<
    LatestWinsAsyncQueue<string> | null
  >(null);
  if (cameraQualitySettingsQueueRef.current === null) {
    cameraQualitySettingsQueueRef.current = createLatestWinsAsyncQueue(
      (signature) => applyLatestCameraQualitySettingsRef.current(signature),
      (error) => {
        console.warn("[Meets] Failed to apply camera quality settings:", error);
      },
    );
  }
  if (screenShareQualitySettingsQueueRef.current === null) {
    screenShareQualitySettingsQueueRef.current = createLatestWinsAsyncQueue(
      (signature) =>
        applyLatestScreenShareQualitySettingsRef.current(signature),
      (error) => {
        console.warn(
          "[Meets] Failed to apply screen-share quality settings:",
          error,
        );
      },
    );
  }
  const audioRecoveryInFlightRef = useRef(false);
  const localAudioTrackHandlersRef = useRef<WeakSet<MediaStreamTrack>>(
    new WeakSet(),
  );
  const noiseCancellationSourceHandlersRef = useRef<
    WeakMap<
      MediaStreamTrack,
      {
        processedTrack: MediaStreamTrack;
        onEnded: () => void;
      }
    >
  >(new WeakMap());
  const localVideoTrackHandlersRef = useRef<WeakSet<MediaStreamTrack>>(
    new WeakSet(),
  );
  const screenShareTrackHandlersRef = useRef<WeakSet<MediaStreamTrack>>(
    new WeakSet(),
  );
  const localAudioMutedRecoveryTimeoutsRef = useRef<Map<string, number>>(
    new Map(),
  );
  const localVideoMutedRecoveryTimeoutsRef = useRef<Map<string, number>>(
    new Map(),
  );
  const screenShareMutedWarningTimeoutsRef = useRef<Map<string, number>>(
    new Map(),
  );
  const screenShareMutedWarningErrorTrackIdRef = useRef<string | null>(null);
  const lastLocalAudioMutedRecoveryAtRef = useRef(0);
  const lastLocalVideoMutedRecoveryAtRef = useRef(0);
  const isMediaRecoveryBlocked = useCallback(
    () => mediaRecoveryBlockedRef?.current === true,
    [mediaRecoveryBlockedRef],
  );
  const [audioProducerRecoveryPulse, setAudioProducerRecoveryPulse] =
    useState(0);
  const pendingAudioProcessingSwitchRef = useRef(false);
  const [audioProcessingSwitchPulse, setAudioProcessingSwitchPulse] =
    useState(0);
  const cameraRecoveryInFlightRef = useRef(false);
  const cameraTopologyReplacementInFlightRef = useRef(false);
  const cameraTopologyReplacementPromiseRef = useRef<Promise<unknown> | null>(
    null,
  );
  const [cameraProducerRecoveryPulse, setCameraProducerRecoveryPulse] =
    useState(0);
  const screenAudioProducerRefreshInFlightRef = useRef(false);

  useEffect(() => {
    if (!isScreenSharing) {
      resetScreenShareControlState();
    }
  }, [isScreenSharing, resetScreenShareControlState]);

  useEffect(() => {
    const audioRecoveryTimeouts = localAudioMutedRecoveryTimeoutsRef.current;
    const videoRecoveryTimeouts = localVideoMutedRecoveryTimeoutsRef.current;
    const screenShareWarningTimeouts =
      screenShareMutedWarningTimeoutsRef.current;
    return () => {
      audioRecoveryTimeouts.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      audioRecoveryTimeouts.clear();
      videoRecoveryTimeouts.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      videoRecoveryTimeouts.clear();
      screenShareWarningTimeouts.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      screenShareWarningTimeouts.clear();
    };
  }, []);

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
  const flushPendingAudioProcessingSwitch = useCallback(() => {
    if (!pendingAudioProcessingSwitchRef.current) return;
    pendingAudioProcessingSwitchRef.current = false;
    setAudioProcessingSwitchPulse((value) => value + 1);
  }, []);
  const notificationVolume = clampMeetVolume(meetVolume);
  const requestAudioProducerRecovery = useCallback(() => {
    if (isMediaRecoveryBlocked()) {
      queueBlockedProducerRecovery("audio");
      return;
    }
    if (audioRecoveryInFlightRef.current) {
      pendingAudioProducerRecoveryRef.current = true;
      return;
    }
    setAudioProducerRecoveryPulse((value) => value + 1);
  }, [isMediaRecoveryBlocked, queueBlockedProducerRecovery]);
  const finishAudioTrackOperation = useCallback(() => {
    audioRecoveryInFlightRef.current = false;
    flushPendingAudioProcessingSwitch();
    if (!pendingAudioProducerRecoveryRef.current) return;
    if (isMediaRecoveryBlocked()) {
      queueBlockedProducerRecovery("audio");
    } else {
      flushQueuedProducerRecoveries();
    }
  }, [
    flushPendingAudioProcessingSwitch,
    flushQueuedProducerRecoveries,
    isMediaRecoveryBlocked,
    queueBlockedProducerRecovery,
  ]);
  const finishCameraRecovery = useCallback(() => {
    cameraRecoveryInFlightRef.current = false;
    if (!pendingCameraProducerRecoveryRef.current) return;
    if (isMediaRecoveryBlocked()) {
      queueBlockedProducerRecovery("camera");
    } else {
      flushQueuedProducerRecoveries();
    }
  }, [flushQueuedProducerRecoveries, isMediaRecoveryBlocked, queueBlockedProducerRecovery]);
  const mediaOperationsDisposedRef = useRef(false);
  useEffect(() => {
    mediaOperationsDisposedRef.current = false;
    return () => {
      mediaOperationsDisposedRef.current = true;
    };
  }, []);
  const requestCameraProducerRecovery = useCallback(() => {
    if (isMediaRecoveryBlocked()) {
      queueBlockedProducerRecovery("camera");
      return;
    }
    if (cameraRecoveryInFlightRef.current) {
      pendingCameraProducerRecoveryRef.current = true;
      return;
    }
    if (cameraTopologyReplacementInFlightRef.current) {
      pendingCameraProducerRecoveryRef.current = true;
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
  const cameraRecoveryPublishOverrideRef = useRef<
    WebcamCodecRecoveryOverride<ReturnType<typeof getPreferredWebcamCodec>> | null
  >(null);
  const vp9ZeroFrameProofRef = useRef<Vp9ZeroFrameProof | null>(null);
  const vp9ZeroFrameFailureReportedEpochRef = useRef<number | null>(null);
  const vp9DiagnosticTrackRef = useRef<MediaStreamTrack | null>(null);
  const cameraOutboundStallStateRef = useRef<CameraOutboundStallState>(
    createCameraOutboundStallState(),
  );
  const screenProducerTrackRepairInFlightRef = useRef(false);
  const screenOutboundStallStateRef = useRef<CameraOutboundStallState>(
    createCameraOutboundStallState(),
  );
  const connectionStateRef = useRef(connectionState);
  if (connectionStateRef.current !== connectionState) {
    connectionStateRef.current = connectionState;
  }
  const microphoneUnmuteDisabledRef = useRef(microphoneUnmuteDisabled);
  microphoneUnmuteDisabledRef.current = microphoneUnmuteDisabled;
  const noiseCancellationChoiceRef = useRef(isNoiseCancellationEnabled);
  noiseCancellationChoiceRef.current = isNoiseCancellationEnabled;
  const cameraPublishingDisabledRef = useRef(
    cameraDisabled || cameraEnableDisabled,
  );
  cameraPublishingDisabledRef.current = cameraDisabled || cameraEnableDisabled;
  const screenSharePublishingDisabledRef = useRef(cameraDisabled);
  screenSharePublishingDisabledRef.current = cameraDisabled;
  const isScreenSharingRef = useRef(isScreenSharing);
  useEffect(() => {
    isScreenSharingRef.current = isScreenSharing;
  }, [isScreenSharing]);
  const toggleMuteInFlightRef = useRef(false);
  const claimDevice = useCallback(
    (device: IntentDevice, startCapture = false) => {
      const generation = captureGeneration();
      if (startCapture) {
        const intents = deviceIntents.dispatch({ type: "capture", device });
        return { device, request: intents[device].request, generation };
      }
      return { device, request: deviceIntents.get()[device].request, generation };
    },
    [deviceIntents],
  );
  const claimHolds = useCallback(
    (claim: { device: IntentDevice; request: number; generation: number }) => {
      const intent = deviceIntents.get()[claim.device];
      return claim.generation === captureGeneration() && intent.request === claim.request && intent.chosen;
    },
    [deviceIntents],
  );
  const settleClaim = useCallback(
    (claim: { device: IntentDevice; request: number }, chosen: boolean) => {
      deviceIntents.dispatch({ type: "settle", device: claim.device, request: claim.request, chosen });
    },
    [deviceIntents],
  );
  const microphoneChosen = useCallback(() => deviceIntents.get().audio.chosen, [deviceIntents]);
  const cameraChosen = useCallback(() => deviceIntents.get().video.chosen, [deviceIntents]);
  const micTrackOperationRef = useRef<Promise<unknown>>(Promise.resolve());
  const runMicTrackOperation = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const run = micTrackOperationRef.current.then(operation);
    micTrackOperationRef.current = run.catch(() => {});
    return run;
  }, []);
  const cameraTrackOperationRef = useRef<Promise<unknown>>(Promise.resolve());
  const runCameraTrackOperation = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const run = cameraTrackOperationRef.current.then(operation);
    cameraTrackOperationRef.current = run.catch(() => {});
    return run;
  }, []);
  const toggleCameraInFlightRef = useRef(false);
  const screenShareStartInFlightRef = useRef(false);
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
      const targetDeviceId = deviceId ?? selectedVideoInputDeviceId;
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
        targetDeviceId,
        resolveEffectiveCameraPublishSettings(
          mediaQualitySettingsRef.current.camera,
          activeVideoEffectsCount > 0,
        ),
      );
    },
    [
      connectionQualityRef,
      activeVideoEffectsCount,
      mediaQualitySettingsRef,
      selectedVideoInputDeviceId,
      videoQualityRef,
    ]
  );

  const getCameraPublishSettings = useCallback(
    () =>
      resolveEffectiveCameraPublishSettings(
        mediaQualitySettingsRef.current.camera,
        activeVideoEffectsCount > 0,
      ),
    [activeVideoEffectsCount, mediaQualitySettingsRef],
  );
  const getScreenSharePublishSettings = useCallback(
    () =>
      resolveScreenSharePublishSettings(
        mediaQualitySettingsRef.current.screenShare,
      ),
    [mediaQualitySettingsRef],
  );
  const applyCameraContentHint = useCallback(
    (track: MediaStreamTrack | null | undefined) => {
      if (track && "contentHint" in track) {
        track.contentHint = getCameraPublishSettings().contentHint;
      }
    },
    [getCameraPublishSettings],
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

      const ctxWithReverb = audioContext as AudioContext & {
        __notificationReverb?: ConvolverNode;
      };
      const getReverb = (): ConvolverNode => {
        if (ctxWithReverb.__notificationReverb) {
          return ctxWithReverb.__notificationReverb;
        }
        const seconds = 0.9;
        const length = Math.floor(audioContext.sampleRate * seconds);
        const impulse = audioContext.createBuffer(
          2,
          length,
          audioContext.sampleRate
        );
        for (let channel = 0; channel < 2; channel += 1) {
          const data = impulse.getChannelData(channel);
          let seed = channel === 0 ? 0x9e3779b9 : 0x85ebca6b;
          for (let i = 0; i < length; i += 1) {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            const white = (seed / 0xffffffff) * 2 - 1;
            data[i] = white * Math.pow(1 - i / length, 2.6);
          }
        }
        const convolver = audioContext.createConvolver();
        convolver.buffer = impulse;
        ctxWithReverb.__notificationReverb = convolver;
        return convolver;
      };

      const playVoice = (
        frequency: number,
        start: number,
        duration: number,
        peak: number,
        masterIn: AudioNode
      ) => {
        const partials: Array<{ ratio: number; gain: number; decay: number }> = [
          { ratio: 1, gain: 1, decay: 1 },
          { ratio: 2.0, gain: 0.22, decay: 0.7 },
          { ratio: 3.01, gain: 0.07, decay: 0.5 },
        ];
        const attack = 0.008;

        partials.forEach(({ ratio, gain: partialGain, decay }) => {
          const oscillator = audioContext.createOscillator();
          const env = audioContext.createGain();
          oscillator.type = "sine";
          oscillator.frequency.value = frequency * ratio;
          oscillator.detune.value = (ratio - 1) * 1.5;

          const partialPeak = peak * partialGain;
          const end = start + duration * decay;
          env.gain.setValueAtTime(0.0001, start);
          env.gain.linearRampToValueAtTime(partialPeak, start + attack);
          env.gain.exponentialRampToValueAtTime(0.0001, end);

          oscillator.connect(env);
          env.connect(masterIn);
          oscillator.start(start);
          oscillator.stop(end + 0.05);
        });
      };

      const playPattern = () => {
        const now = audioContext.currentTime + 0.02;

        const lowpass = audioContext.createBiquadFilter();
        lowpass.type = "lowpass";
        lowpass.frequency.value = 3200;
        lowpass.Q.value = 0.4;

        const master = audioContext.createGain();
        master.gain.value = 1;

        const dry = audioContext.createGain();
        dry.gain.value = 1;
        const wet = audioContext.createGain();
        wet.gain.value = type === "handRaise" ? 0.18 : 0.26;

        lowpass.connect(master);
        master.connect(dry);
        dry.connect(audioContext.destination);
        master.connect(wet);
        wet.connect(getReverb());
        getReverb().connect(audioContext.destination);

        const notes: Array<{ freq: number; dur: number }> =
          type === "join"
            ? [
                { freq: 261.63, dur: 0.55 },
                { freq: 329.63, dur: 0.55 },
                { freq: 523.25, dur: 0.8 },
              ]
            : type === "leave"
            ? [
                { freq: 329.63, dur: 0.6 },
                { freq: 261.63, dur: 0.9 },
              ]
            : type === "waiting"
            ? [
                { freq: 220.0, dur: 0.46 },
                { freq: 261.63, dur: 0.46 },
                { freq: 329.63, dur: 0.7 },
              ]
            : [{ freq: 440.0, dur: 0.55 }];

        const stride =
          type === "join" ? 0.11 : type === "waiting" ? 0.13 : 0.14;
        const basePeak = type === "handRaise" ? 0.16 : 0.2;
        const peak = basePeak * notificationVolume;

        let cursor = now;
        notes.forEach((note, index) => {
          const notePeak = peak * (1 - index * 0.08);
          playVoice(note.freq, cursor, note.dur, notePeak, lowpass);
          cursor += stride;
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

  const emitToggleMedia = useCallback(
    (
      eventName: "toggleMute" | "toggleCamera",
      producerId: string,
      paused: boolean,
      timeoutMs: number,
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
        const timeout = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({ ok: false, error: `${eventName} timeout` });
        }, timeoutMs);

        socket.emit(
          eventName,
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

  const emitToggleMute = useCallback(
    (
      producerId: string,
      paused: boolean,
      options?: { timeoutMs?: number },
    ) =>
      emitToggleMedia(
        "toggleMute",
        producerId,
        paused,
        options?.timeoutMs ?? TOGGLE_MUTE_STRICT_ACK_TIMEOUT_MS,
      ),
    [emitToggleMedia],
  );

  const emitToggleCamera = useCallback(
    (producerId: string, paused: boolean) =>
      emitToggleMedia(
        "toggleCamera",
        producerId,
        paused,
        TOGGLE_CAMERA_ACK_TIMEOUT_MS,
      ),
    [emitToggleMedia],
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
          !microphoneChosen() ||
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
          !microphoneChosen() ||
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
      if (dataSaverMode) {
        return "poor";
      }

      const quality = getStartupAwarePublishQuality(stats, browserNetwork);
      if (quality === "poor") return "poor";
      if (quality === "fair") return "fair";
      return "good";
    }, [connectionQualityRef, dataSaverMode]);

  const getScreenSharePublishNetworkProfile =
    useCallback((): WebcamProducerNetworkProfile => {
      const baseProfile = getPublishNetworkProfile();
      const stats = connectionQualityRef?.current;
      const browserNetwork = stats?.browserNetwork ?? getBrowserNetworkSnapshot();
      return selectScreenSharePublishNetworkProfile({
        baseProfile,
        availableOutgoingBitrateBps: stats?.availableOutgoingBitrate,
        emergencyMode: isPublishEmergencyProfile(stats, browserNetwork),
        browserNetwork,
        observedPublishQuality: stats?.publishAdaptationQuality,
      });
    }, [connectionQualityRef, getPublishNetworkProfile, microphoneChosen]);

  const reportCurrentWebcamCodecFailure = useCallback(
    async (error: unknown): Promise<boolean> => {
      const policy = webcamCodecPolicyRef.current;
      const classification = classifyVp9CodecFailure(error);
      if (
        policy.codec !== "vp9" ||
        classification === "transient-or-unknown"
      ) {
        return false;
      }

      rememberProvenVp9EncoderIncompatibility({
        handlerName: deviceRef.current?.handlerName ?? "unknown-handler",
        videoInputDeviceId: selectedVideoInputDeviceId,
      });

      const socket = socketRef.current;
      if (!socket?.connected) return false;

      console.warn(
        "[Meets] Proven VP9 sender incompatibility; requesting interoperable room fallback:",
        { classification, error },
      );
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const timeoutId = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve(false);
        }, 2000);
        socket.emit(
          "reportWebcamCodecFailure",
          { codec: "vp9", epoch: policy.epoch },
          (
            response:
              | { success: true; webcamCodecPolicy: WebcamCodecPolicy }
              | { error: string },
          ) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeoutId);
            if ("error" in response) {
              resolve(false);
              return;
            }
            const next = normalizeWebcamCodecPolicy(
              response.webcamCodecPolicy,
            );
            resolve(Boolean(next));
          },
        );
      });
    },
    [
      deviceRef,
      selectedVideoInputDeviceId,
      socketRef,
      webcamCodecPolicyRef,
    ],
  );

  const waitForPreferredVideoPublishTrack = useCallback(
    async (stream: MediaStream, rawTrack: MediaStreamTrack) => {
      const allowProcessedWarmupWait = !isLikelyMobileOrTabletNavigator();
      if (!shouldUsePreferredVideoPublishTrack || !allowProcessedWarmupWait) {
        return rawTrack;
      }

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
      forceSimulcast = false,
      receiverCapacityTransition,
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
      forceSimulcast?: boolean;
      receiverCapacityTransition?: WebcamReceiverCapacityTransition;
      context: string;
    }) => {
      return produceWebcamTrackWithRawTrackFallback({
        publishTrack,
        rawTrack,
        receiverCapacityTransition,
        produce: (track) =>
          produceWebcamTrack({
            transport,
            track,
            quality,
            networkProfile,
            paused,
            preferredCodec,
            forceSingleLayer,
            forceSimulcast,
            receiverCapacityTransition,
            codecPolicy: webcamCodecPolicyRef.current,
            publishSettings: getCameraPublishSettings(),
          }),
        onProcessedTrackFailure: (error) => {
          console.warn(
            `[Meets] Processed ${context} camera publish failed; retrying raw camera:`,
            error,
          );
          onPreferredVideoPublishTrackRejected?.(
            publishTrack,
            `${context}-raw-produce-fallback`,
          );
        },
        onTerminalFailure: reportCurrentWebcamCodecFailure,
      });
    },
    [
      onPreferredVideoPublishTrackRejected,
      reportCurrentWebcamCodecFailure,
      webcamCodecPolicyRef,
      getCameraPublishSettings,
    ],
  );

  const prepareCameraProducerTransport = useCallback(async () => {
    const ensureProducerTransport = ensureProducerTransportRef?.current;
    if (ensureProducerTransport) {
      const ready = await ensureProducerTransport({
        forCameraPublish: true,
      });
      const transport = getUsableProducerTransport(
        producerTransportRef.current,
      );
      if (!ready || !transport) {
        throw new Error("Video transport unavailable");
      }
      return transport;
    }

    const transport = getUsableProducerTransport(producerTransportRef.current);
    if (!transport) {
      throw new Error("Video transport unavailable");
    }
    return transport;
  }, [ensureProducerTransportRef, producerTransportRef]);

  const detachNoiseCancellationSourceHandler = useCallback(
    (track?: MediaStreamTrack | null) => {
      if (!track) return;
      const sourceTrack = getNoiseCancellationSourceTrack(track) ?? track;
      const entry = noiseCancellationSourceHandlersRef.current.get(sourceTrack);
      if (!entry) return;
      if (sourceTrack !== track && entry.processedTrack.id !== track.id) return;

      sourceTrack.removeEventListener("ended", entry.onEnded);
      noiseCancellationSourceHandlersRef.current.delete(sourceTrack);
    },
    [],
  );

  const stopLocalTrack = useCallback(
    (track?: MediaStreamTrack | null) => {
      if (!track) return;
      intentionalTrackStopsRef.current.add(track);
      detachNoiseCancellationSourceHandler(track);
      stopNoiseCancellationForTrack(track, {
        stopOutput: true,
        stopSource: true,
      });
      try {
        track.stop();
      } catch {}
    },
    [detachNoiseCancellationSourceHandler, intentionalTrackStopsRef]
  );

  const commitLocalStream = useCallback(
    (nextStream: MediaStream | null) => {
      localStreamRef.current = nextStream;
      setLocalStream(nextStream);
    },
    [localStreamRef, setLocalStream],
  );

  const commitAudioTrackToLocalStream = useCallback(
    (
      audioTrack: MediaStreamTrack,
      previousStream: MediaStream | null | undefined = localStreamRef.current,
      options: { stopReplacedTracks?: boolean } = {},
    ) => {
      const sourceTrack = getNoiseCancellationSourceTrack(audioTrack);
      const keepTrackIds = new Set(
        [audioTrack.id, sourceTrack?.id].filter(
          (trackId): trackId is string => Boolean(trackId),
        ),
      );
      const remainingTracks =
        previousStream?.getTracks().filter((track) => track.kind !== "audio") ??
        [];
      const nextStream = new MediaStream([...remainingTracks, audioTrack]);
      commitLocalStream(nextStream);

      if (options.stopReplacedTracks !== false) {
        previousStream?.getAudioTracks().forEach((track) => {
          if (!keepTrackIds.has(track.id)) {
            stopLocalTrack(track);
          }
        });
      }

      return nextStream;
    },
    [commitLocalStream, localStreamRef, stopLocalTrack],
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

  const retireVp9DiagnosticTrack = useCallback(() => {
    const diagnosticTrack = vp9DiagnosticTrackRef.current;
    if (!diagnosticTrack) return;
    const producer = videoProducerRef.current;
    if (producer && !producer.closed && producer.track?.id === diagnosticTrack.id) return;
    vp9DiagnosticTrackRef.current = null;
    stopLocalTrack(diagnosticTrack);
  }, [stopLocalTrack, videoProducerRef]);

  const replaceCameraProducerTrack = useCallback(
    async (producer: Producer, track: MediaStreamTrack | null) => {
      await producer.replaceTrack({ track });
      retireVp9DiagnosticTrack();
    },
    [retireVp9DiagnosticTrack],
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
    [
      intentionalLocalProducerCloseIdsRef,
      socketRef,
      videoProducerRef,
    ],
  );

  useEffect(
    () => () => {
      const diagnosticTrack = vp9DiagnosticTrackRef.current;
      if (diagnosticTrack) stopLocalTrack(diagnosticTrack);
      vp9DiagnosticTrackRef.current = null;
      vp9ZeroFrameProofRef.current = null;
    },
    [stopLocalTrack],
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

  const clearLocalAudioMutedRecoveryTimer = useCallback(
    (trackId: string) => {
      const timeoutId = localAudioMutedRecoveryTimeoutsRef.current.get(trackId);
      if (timeoutId === undefined) return;
      window.clearTimeout(timeoutId);
      localAudioMutedRecoveryTimeoutsRef.current.delete(trackId);
    },
    [],
  );

  const scheduleLocalAudioMutedRecovery = useCallback(
    (track: MediaStreamTrack) => {
      if (
        !microphoneChosen() ||
        connectionStateRef.current !== "joined" ||
        track.readyState !== "live" ||
        !track.enabled ||
        !track.muted ||
        localAudioMutedRecoveryTimeoutsRef.current.has(track.id)
      ) {
        return;
      }

      const timeoutId = window.setTimeout(() => {
        localAudioMutedRecoveryTimeoutsRef.current.delete(track.id);
        if (
          !microphoneChosen() ||
          connectionStateRef.current !== "joined" ||
          isMediaRecoveryBlocked() ||
          track.readyState !== "live" ||
          !track.enabled ||
          !track.muted
        ) {
          return;
        }

        const currentProducer = audioProducerRef.current;
        const producerTrack = currentProducer?.track ?? null;
        const producerUsesTrack =
          producerTrack === track || producerTrack?.id === track.id;
        const currentStream = localStreamRef.current;
        const streamUsesTrack =
          currentStream
            ?.getAudioTracks()
            .some(
              (currentTrack) =>
                currentTrack === track || currentTrack.id === track.id,
            ) === true;

        if (!producerUsesTrack && !streamUsesTrack) {
          return;
        }

        const now = performance.now();
        if (
          now - lastLocalAudioMutedRecoveryAtRef.current <
          LOCAL_AUDIO_MUTED_RECOVERY_COOLDOWN_MS
        ) {
          return;
        }
        lastLocalAudioMutedRecoveryAtRef.current = now;

        console.warn(
          "[Meets] Local microphone stopped sending data; refreshing audio producer.",
          {
            producerId: currentProducer?.id ?? null,
            trackId: track.id,
          },
        );

        if (currentProducer && producerUsesTrack) {
          closeLocalAudioProducerForReplacement(currentProducer);
        }
        if (streamUsesTrack && currentStream) {
          const remainingTracks = currentStream
            .getTracks()
            .filter(
              (currentTrack) =>
                currentTrack !== track && currentTrack.id !== track.id,
            );
          commitLocalStream(new MediaStream(remainingTracks));
        }
        stopLocalTrack(track);
        requestAudioProducerRecovery();
      }, LOCAL_AUDIO_MUTED_RECOVERY_DELAY_MS);

      localAudioMutedRecoveryTimeoutsRef.current.set(track.id, timeoutId);
    },
    [
      audioProducerRef,
      closeLocalAudioProducerForReplacement,
      commitLocalStream,
      isMediaRecoveryBlocked,
      localStreamRef,
      requestAudioProducerRecovery,
      stopLocalTrack,
    ],
  );

  const attachLocalAudioTrackHandlers = useCallback(
    (track: MediaStreamTrack) => {
      markAudioTrackForSpeech(track);

      if (!localAudioTrackHandlersRef.current.has(track)) {
        localAudioTrackHandlersRef.current.add(track);
        track.addEventListener("mute", () => {
          scheduleLocalAudioMutedRecovery(track);
        });
        track.addEventListener("unmute", () => {
          clearLocalAudioMutedRecoveryTimer(track.id);
        });
        track.onended = () => {
          clearLocalAudioMutedRecoveryTimer(track.id);
          handleLocalTrackEnded("audio", track);
        };
      }

      if (track.muted) {
        scheduleLocalAudioMutedRecovery(track);
      }
    },
    [
      clearLocalAudioMutedRecoveryTimer,
      handleLocalTrackEnded,
      markAudioTrackForSpeech,
      scheduleLocalAudioMutedRecovery,
    ],
  );

  const attachNoiseCancellationSourceHandlers = useCallback(
    (processedTrack: MediaStreamTrack) => {
      const sourceTrack = getNoiseCancellationSourceTrack(processedTrack);
      if (!sourceTrack) {
        return;
      }

      const existing =
        noiseCancellationSourceHandlersRef.current.get(sourceTrack);
      if (existing?.processedTrack.id === processedTrack.id) {
        return;
      }
      if (existing) {
        sourceTrack.removeEventListener("ended", existing.onEnded);
      }

      const onEnded = () => {
        noiseCancellationSourceHandlersRef.current.delete(sourceTrack);
        clearLocalAudioMutedRecoveryTimer(processedTrack.id);
        handleLocalTrackEnded("audio", processedTrack);
      };

      noiseCancellationSourceHandlersRef.current.set(sourceTrack, {
        processedTrack,
        onEnded,
      });
      sourceTrack.addEventListener("ended", onEnded, { once: true });
    },
    [clearLocalAudioMutedRecoveryTimer, handleLocalTrackEnded],
  );

  const prepareAudioPublishTrack = useCallback(
    async (track: MediaStreamTrack, requestedIn: number): Promise<MediaStreamTrack> => {
      markAudioTrackForSpeech(track);
      if (
        !isNoiseCancellationEnabled ||
        track.kind !== "audio" ||
        track.readyState !== "live" ||
        isNoiseCancellationProcessedTrack(track)
      ) {
        attachLocalAudioTrackHandlers(track);
        return track;
      }

      try {
        const pipeline = await createNoiseCancellationPipeline(track, requestedIn);
        const processedTrack = pipeline.outputTrack;
        setNoiseCancellationTrackEnabled(processedTrack, track.enabled);
        markAudioTrackForSpeech(processedTrack);
        attachLocalAudioTrackHandlers(processedTrack);
        attachNoiseCancellationSourceHandlers(processedTrack);
        console.info("[Meets] Noise cancellation enabled for microphone:", {
          sourceTrackId: track.id,
          outputTrackId: processedTrack.id,
          worklet: pipeline.usedWorklet,
          engine: pipeline.engine,
        });
        return processedTrack;
      } catch (error) {
        if (isCaptureReleased(error)) throw error;
        console.warn(
          "[Meets] Noise cancellation unavailable; publishing raw microphone:",
          error,
        );
        attachLocalAudioTrackHandlers(track);
        return track;
      }
    },
    [
      attachLocalAudioTrackHandlers,
      attachNoiseCancellationSourceHandlers,
      isNoiseCancellationEnabled,
      markAudioTrackForSpeech,
    ],
  );

  const clearLocalVideoMutedRecoveryTimer = useCallback(
    (trackId: string) => {
      const timeoutId = localVideoMutedRecoveryTimeoutsRef.current.get(trackId);
      if (timeoutId === undefined) return;
      window.clearTimeout(timeoutId);
      localVideoMutedRecoveryTimeoutsRef.current.delete(trackId);
    },
    [],
  );

  const scheduleLocalVideoMutedRecovery = useCallback(
    (track: MediaStreamTrack) => {
      if (
        !cameraChosen() ||
        connectionStateRef.current !== "joined" ||
        track.readyState !== "live" ||
        !track.enabled ||
        !track.muted ||
        localVideoMutedRecoveryTimeoutsRef.current.has(track.id)
      ) {
        return;
      }

      const timeoutId = window.setTimeout(() => {
        localVideoMutedRecoveryTimeoutsRef.current.delete(track.id);
        if (
          !cameraChosen() ||
          connectionStateRef.current !== "joined" ||
          isMediaRecoveryBlocked() ||
          !isDocumentVisibleForMediaRecovery() ||
          cameraRecoveryInFlightRef.current ||
          track.readyState !== "live" ||
          !track.enabled ||
          !track.muted
        ) {
          return;
        }

        const currentProducer = videoProducerRef.current;
        const producerTrack = currentProducer?.track ?? null;
        const producerUsesTrack =
          producerTrack === track || producerTrack?.id === track.id;
        const currentStream = localStreamRef.current;
        const streamUsesTrack =
          currentStream
            ?.getVideoTracks()
            .some(
              (currentTrack) =>
                currentTrack === track || currentTrack.id === track.id,
            ) === true;

        if (!producerUsesTrack && !streamUsesTrack) {
          return;
        }

        const now = performance.now();
        if (
          now - lastLocalVideoMutedRecoveryAtRef.current <
          LOCAL_VIDEO_MUTED_RECOVERY_COOLDOWN_MS
        ) {
          return;
        }
        lastLocalVideoMutedRecoveryAtRef.current = now;

        console.warn(
          "[Meets] Local camera stopped sending data; refreshing camera producer.",
          {
            producerId: currentProducer?.id ?? null,
            trackId: track.id,
            producerUsesTrack,
            streamUsesTrack,
          },
        );

        if (currentProducer && (producerUsesTrack || streamUsesTrack)) {
          closeLocalVideoProducerForReplacement(currentProducer);
        }
        if (streamUsesTrack && currentStream) {
          const remainingTracks = currentStream
            .getTracks()
            .filter(
              (currentTrack) =>
                currentTrack !== track && currentTrack.id !== track.id,
            );
          commitLocalStream(new MediaStream(remainingTracks));
        }
        stopLocalTrack(track);
        requestCameraProducerRecovery();
      }, LOCAL_VIDEO_MUTED_RECOVERY_DELAY_MS);

      localVideoMutedRecoveryTimeoutsRef.current.set(track.id, timeoutId);
    },
    [
      closeLocalVideoProducerForReplacement,
      commitLocalStream,
      isMediaRecoveryBlocked,
      localStreamRef,
      requestCameraProducerRecovery,
      stopLocalTrack,
      videoProducerRef,
    ],
  );

  const attachLocalVideoTrackHandlers = useCallback(
    (track: MediaStreamTrack) => {
      if (!localVideoTrackHandlersRef.current.has(track)) {
        localVideoTrackHandlersRef.current.add(track);
        track.addEventListener("mute", () => {
          scheduleLocalVideoMutedRecovery(track);
        });
        track.addEventListener("unmute", () => {
          clearLocalVideoMutedRecoveryTimer(track.id);
        });
      }

      if (track.muted) {
        scheduleLocalVideoMutedRecovery(track);
      }
    },
    [
      clearLocalVideoMutedRecoveryTimer,
      scheduleLocalVideoMutedRecovery,
    ],
  );

  const scheduleCurrentLocalVideoMutedRecovery = useCallback(() => {
    if (!isDocumentVisibleForMediaRecovery()) return;
    const seenTrackIds = new Set<string>();
    const tracks = [
      ...((localStreamRef.current ?? localStream)?.getVideoTracks() ?? []),
      videoProducerRef.current?.track ?? null,
    ];
    for (const track of tracks) {
      if (!track || seenTrackIds.has(track.id)) continue;
      seenTrackIds.add(track.id);
      attachLocalVideoTrackHandlers(track);
    }
  }, [
    attachLocalVideoTrackHandlers,
    localStream,
    localStreamRef,
    videoProducerRef,
  ]);

  useEffect(() => {
    if (isObserverMode) return;
    if (connectionState !== "joined") return;
    if (isMuted) return;

    const audioTrack = getFirstLiveTrack(
      (localStreamRef.current ?? localStream)?.getAudioTracks() ?? [],
    );
    if (!audioTrack) return;
    attachLocalAudioTrackHandlers(audioTrack);
  }, [
    attachLocalAudioTrackHandlers,
    connectionState,
    isMuted,
    isObserverMode,
    localStream,
    localStreamRef,
  ]);

  useEffect(() => {
    if (isObserverMode) return;
    if (connectionState !== "joined") return;
    if (isCameraOff) return;

    scheduleCurrentLocalVideoMutedRecovery();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleCurrentLocalVideoMutedRecovery();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    connectionState,
    isCameraOff,
    isObserverMode,
    scheduleCurrentLocalVideoMutedRecovery,
  ]);

  const requestMediaPermissions = useCallback(async (
    options: RequestMediaPermissionsOptions = {},
  ): Promise<MediaStream | null> => {
    if (permissionHintTimeoutRef.current) {
      window.clearTimeout(permissionHintTimeoutRef.current);
    }
    setShowPermissionHint(false);
    permissionHintTimeoutRef.current = window.setTimeout(() => {
      setShowPermissionHint(true);
    }, 450);

    try {
      const generation = captureGeneration();
      const wantsAudio = options.audio ?? true;
      const wantsVideo = options.video ?? cameraChosen();
      const audioRequired = options.audioRequired ?? microphoneChosen();
      const videoRequired = options.videoRequired ?? wantsVideo;
      const currentStream = localStreamRef.current;
      const reusableAudioTrack = wantsAudio
        ? getFirstLiveTrack(currentStream?.getAudioTracks() ?? [])
        : null;
      const reusableVideoTrack = wantsVideo
        ? getFirstLiveTrack(currentStream?.getVideoTracks() ?? [])
        : null;
      const shouldRequestAudio = wantsAudio && !reusableAudioTrack;
      const shouldRequestVideo = wantsVideo && !reusableVideoTrack;

      if (!wantsAudio && !wantsVideo) {
        setMediaState({
          hasAudioPermission: false,
          hasVideoPermission: false,
        });
        return new MediaStream();
      }

      const requestTracks = async (
        requestAudio: boolean,
        requestVideo: boolean,
      ): Promise<MediaStream> => {
        const audioConstraints = requestAudio
          ? buildAudioConstraints(selectedAudioInputDeviceId)
          : false;
        const videoConstraintsForRequest = requestVideo
          ? buildVideoConstraints()
          : false;

        console.debug("[Meets] Requesting local media:", {
          audio: audioConstraints,
          video: videoConstraintsForRequest,
        });

        return getUserMediaWithTimeout(
          {
            audio: audioConstraints,
            video: videoConstraintsForRequest,
          },
          {
            label: "local media permission request",
            timeoutMs: MEDIA_CAPTURE_PERMISSION_TIMEOUT_MS,
            generation,
          },
        );
      };
      const { streams: acquiredStreams, failures } = await acquireLocalTracks({
        audio: shouldRequestAudio,
        video: shouldRequestVideo,
        request: requestTracks,
      });
      const acquiredTracks = acquiredStreams.flatMap((stream) =>
        stream.getTracks().filter((track) => track.readyState === "live"),
      );
      if (failures.microphone && !audioRequired) {
        console.info("[Meets] Muted microphone warmup skipped:", failures.microphone);
      }

      const settled = await settleLocalTracks({
        acquired: acquiredTracks,
        reusable: { audio: reusableAudioTrack, video: reusableVideoTrack },
        prepareAudio: (track) => prepareAudioPublishTrack(track, generation),
      });
      if (generation !== captureGeneration()) {
        const fresh = settled.audio === reusableAudioTrack ? [] : [settled.audio];
        [...acquiredTracks, ...fresh].forEach((track) => stopLocalTrack(track));
        return null;
      }
      const nextAudioTrack = settled.audio;
      const cameraWanted = cameraChosen();
      if (!cameraWanted && settled.video && settled.video !== reusableVideoTrack) {
        stopLocalTrack(settled.video);
      }
      const nextVideoTrack = cameraWanted ? settled.video : null;
      if (settled.audioFailure !== undefined) failures.microphone = settled.audioFailure;
      const hasAudio = nextAudioTrack?.readyState === "live";
      const hasVideo = nextVideoTrack?.readyState === "live";
      const liveTracks = [hasAudio ? nextAudioTrack : null, hasVideo ? nextVideoTrack : null].filter(
        (track): track is MediaStreamTrack => Boolean(track),
      );

      setMediaState({
        hasAudioPermission: hasAudio,
        hasVideoPermission: hasVideo,
      });

      const requiredFailures: MediaDeviceFailures = {};
      if (audioRequired && !hasAudio) {
        requiredFailures.microphone =
          failures.microphone ?? new Error("Microphone access was unavailable");
        setIsMuted(true);
      }
      if (videoRequired && cameraWanted && !hasVideo) {
        requiredFailures.camera =
          failures.camera ?? new Error("Camera access was unavailable");
        setIsCameraOff(true);
      }
      const requiredError = createMediaDeviceError(requiredFailures, "PERMISSION_DENIED");
      setMediaError((current) => {
        let next = current;
        if (hasAudio) next = clearMediaDeviceError(next, "microphone");
        if (hasVideo) next = clearMediaDeviceError(next, "camera");
        return requiredError ? mergeMediaDeviceError(next, requiredError) : next;
      });

      if (nextAudioTrack) {
        setNoiseCancellationTrackEnabled(nextAudioTrack, microphoneChosen());
      }
      liveTracks.forEach((track) => {
        track.onended = () => {
          console.info(`[Meets] Track ended: ${track.kind}`);
          if (track.kind === "audio" || track.kind === "video") {
            handleLocalTrackEnded(track.kind, track);
          }
        };
      });
      applyCameraContentHint(nextVideoTrack);
      if (nextVideoTrack) {
        attachLocalVideoTrackHandlers(nextVideoTrack);
      }

      return liveTracks.length > 0 ? new MediaStream(liveTracks) : null;
    } catch (err) {
      console.error("[Meets] Local media setup failed:", err);
      setMeetError((current) => current ?? createMeetError(err, "MEDIA_ERROR"));
      setIsCameraOff(true);
      setIsMuted(true);
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
    microphoneChosen,
    cameraChosen,
    attachLocalAudioTrackHandlers,
    attachLocalVideoTrackHandlers,
    buildAudioConstraints,
    buildVideoConstraints,
    prepareAudioPublishTrack,
    localStreamRef,
    permissionHintTimeoutRef,
    setMeetError,
    setMediaError,
    setIsCameraOff,
    setIsMuted,
    stopLocalTrack,
  ]);

  const handleAudioInputDeviceChange = useCallback(
    async (deviceId: string) => {
      setSelectedAudioInputDeviceId(deviceId);

      const generation = captureGeneration();
      if (connectionState === "joined") await runMicTrackOperation(async () => {
        let acquiredAudioTracks: MediaStreamTrack[] = [];
        let preparedAudioTrack: MediaStreamTrack | null = null;
        let committedNewAudioTrack: MediaStreamTrack | null = null;
        try {
          const newStream = await getUserMediaWithTimeout(
            { audio: buildAudioConstraints(deviceId) },
            {
              label: "microphone device switch",
              timeoutMs: MEDIA_CAPTURE_RECOVERY_TIMEOUT_MS,
              generation,
            },
          );

          acquiredAudioTracks = newStream.getAudioTracks();
          const rawAudioTrack = newStream.getAudioTracks()[0];
          if (rawAudioTrack) {
            const newAudioTrack = await prepareAudioPublishTrack(rawAudioTrack, generation);
            preparedAudioTrack = newAudioTrack;
            if (generation !== captureGeneration()) {
              stopTracksExcept([...acquiredAudioTracks, newAudioTrack], []);
              return;
            }
            setNoiseCancellationTrackEnabled(newAudioTrack, microphoneChosen());
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
              if (generation !== captureGeneration()) {
                stopTracksExcept([...acquiredAudioTracks, newAudioTrack], []);
                return;
              }
              setNoiseCancellationTrackEnabled(newAudioTrack, microphoneChosen());
            } else {
              requestAudioProducerRecovery();
            }

            commitAudioTrackToLocalStream(newAudioTrack, localStreamRef.current ?? previousStream, {
              stopReplacedTracks: false,
            });
            committedNewAudioTrack = newAudioTrack;
            stopTracksExcept(previousAudioTracks, [newAudioTrack]);
          }
        } catch (err) {
          stopTracksExcept(
            [...acquiredAudioTracks, ...(preparedAudioTrack ? [preparedAudioTrack] : [])],
            [committedNewAudioTrack],
          );
          if (isCaptureReleased(err)) return;
          console.error("[Meets] Failed to switch audio input device:", err);
        }
      });
    },
    [
      connectionState,
      runMicTrackOperation,
      microphoneChosen,
      prepareAudioPublishTrack,
      setSelectedAudioInputDeviceId,
      audioProducerRef,
      localStreamRef,
      commitAudioTrackToLocalStream,
      buildAudioConstraints,
      closeLocalAudioProducerForReplacement,
      stopTracksExcept,
      requestAudioProducerRecovery,
    ]
  );

  const handleVideoInputDeviceChange = useCallback(
    async (deviceId: string) => {
      if (connectionState !== "joined") return;
      if (!deviceIntents.get().video.chosen) return;

      const claim = claimDevice("video", true);
      await runCameraTrackOperation(async () => {
        if (!claimHolds(claim)) return;
        let acquiredVideoTracks: MediaStreamTrack[] = [];
        let committedNewVideoTrack: MediaStreamTrack | null = null;
        try {
          const newStream = await getUserMediaWithTimeout(
            { video: buildVideoConstraints(deviceId) },
            {
              label: "camera device switch",
              timeoutMs: MEDIA_CAPTURE_RECOVERY_TIMEOUT_MS,
              generation: claim.generation,
            },
          );

          acquiredVideoTracks = newStream.getVideoTracks();
          const newVideoTrack = newStream.getVideoTracks()[0];
          if (!claimHolds(claim)) {
            stopTracksExcept(acquiredVideoTracks, []);
            return;
          }
          if (newVideoTrack) {
            applyCameraContentHint(newVideoTrack);
            attachLocalVideoTrackHandlers(newVideoTrack);
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
              if (!claimHolds(claim)) {
                stopTracksExcept([...acquiredVideoTracks, publishTrack], []);
                return;
              }
              attachLocalVideoTrackHandlers(publishTrack);
              try {
                await replaceCameraProducerTrack(videoProducer, publishTrack);
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
                await replaceCameraProducerTrack(videoProducer, newVideoTrack);
              }
              if (!claimHolds(claim)) {
                stopTracksExcept([...acquiredVideoTracks, publishTrack], []);
                return;
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
          settleClaim(claim, true);
        } catch (err) {
          stopTracksExcept(acquiredVideoTracks, [committedNewVideoTrack]);
          if (claimHolds(claim)) settleClaim(claim, true);
          if (isCaptureReleased(err)) return;
          console.error("[Meets] Failed to switch video input device:", err);
        }
      });
    },
    [
      runCameraTrackOperation,
      connectionState,
      deviceIntents,
      claimDevice,
      claimHolds,
      settleClaim,
      attachLocalVideoTrackHandlers,
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
      replaceCameraProducerTrack,
    ]
  );

  const handleAudioOutputDeviceChange = useCallback(
    async (deviceId: string) => {
      setSelectedAudioOutputDeviceId(deviceId);

      await Promise.all(
        Array.from(document.querySelectorAll<HTMLMediaElement>("audio, video"))
          .map(async (element) => {
            try {
              await applyAudioOutputDevice(element, deviceId, () => element.isConnected);
            } catch (err) {
              console.error("[Meets] Failed to set audio output device:", err);
            }
          }),
      );
    },
    [setSelectedAudioOutputDeviceId]
  );

  useEffect(() => {
    if (isObserverMode) return;
    if (connectionState !== "joined") return;
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices || !mediaDevices.addEventListener) {
      return;
    }

    let disposed = false;
    let timeoutId: number | null = null;
    let recoveryInFlight = false;

    const requestRecoveryForChangedDevices = async () => {
      timeoutId = null;
      if (disposed || recoveryInFlight || isMediaRecoveryBlocked()) return;
      recoveryInFlight = true;

      try {
        const devices = await mediaDevices.enumerateDevices();
        if (disposed || isMediaRecoveryBlocked()) return;

        const audioInputs = getInputDevices(devices, "audioinput");
        const videoInputs = getInputDevices(devices, "videoinput");
        const selectedAudioMissing =
          Boolean(selectedAudioInputDeviceId) &&
          !hasInputDeviceId(audioInputs, selectedAudioInputDeviceId);
        const selectedVideoMissing =
          Boolean(selectedVideoInputDeviceId) &&
          !hasInputDeviceId(videoInputs, selectedVideoInputDeviceId);
        const nextAudioDeviceId = selectedAudioMissing
          ? getFallbackInputDeviceId(audioInputs)
          : selectedAudioInputDeviceId;
        const nextVideoDeviceId = selectedVideoMissing
          ? getFallbackInputDeviceId(videoInputs)
          : selectedVideoInputDeviceId;
        const recoveryTasks: Promise<void>[] = [];

        if (selectedAudioMissing) {
          setSelectedAudioInputDeviceId(nextAudioDeviceId);
          console.info("[Meets] Selected microphone disappeared:", {
            previousDeviceId: selectedAudioInputDeviceId,
            nextDeviceId: nextAudioDeviceId ?? null,
          });
          if (nextAudioDeviceId) {
            recoveryTasks.push(handleAudioInputDeviceChange(nextAudioDeviceId));
          } else if (microphoneChosen() || audioProducerRef.current) {
            requestAudioProducerRecovery();
          }
        } else {
          const audioProducer = audioProducerRef.current;
          const shouldRecoverAudio =
            (microphoneChosen() ||
              Boolean(
                getFirstLiveTrack(
                  localStreamRef.current?.getAudioTracks() ?? [],
                ),
              )) &&
            (!audioProducer ||
              audioProducer.closed ||
              audioProducer.track?.readyState !== "live");
          if (shouldRecoverAudio) {
            requestAudioProducerRecovery();
          }
        }

        if (selectedVideoMissing) {
          setSelectedVideoInputDeviceId(nextVideoDeviceId);
          console.info("[Meets] Selected camera disappeared:", {
            previousDeviceId: selectedVideoInputDeviceId,
            nextDeviceId: nextVideoDeviceId ?? null,
          });
          if (!isCameraOff) {
            if (nextVideoDeviceId) {
              recoveryTasks.push(handleVideoInputDeviceChange(nextVideoDeviceId));
            } else {
              requestCameraProducerRecovery();
            }
          }
        } else if (!isCameraOff) {
          const videoProducer = videoProducerRef.current;
          if (
            !videoProducer ||
            videoProducer.closed ||
            videoProducer.track?.readyState !== "live"
          ) {
            requestCameraProducerRecovery();
          }
        }

        await Promise.allSettled(recoveryTasks);
      } catch (err) {
        console.warn("[Meets] Failed to handle media device change:", err);
      } finally {
        recoveryInFlight = false;
      }
    };

    const scheduleDeviceChangeRecovery = () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      timeoutId = window.setTimeout(() => {
        void requestRecoveryForChangedDevices();
      }, 350);
    };

    mediaDevices.addEventListener("devicechange", scheduleDeviceChangeRecovery);
    return () => {
      disposed = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      mediaDevices.removeEventListener(
        "devicechange",
        scheduleDeviceChangeRecovery,
      );
    };
  }, [
    isObserverMode,
    connectionState,
    isCameraOff,
    isMediaRecoveryBlocked,
    selectedAudioInputDeviceId,
    selectedVideoInputDeviceId,
    setSelectedAudioInputDeviceId,
    setSelectedVideoInputDeviceId,
    handleAudioInputDeviceChange,
    handleVideoInputDeviceChange,
    audioProducerRef,
    videoProducerRef,
    localStreamRef,
    requestAudioProducerRecovery,
    requestCameraProducerRecovery,
    microphoneChosen,
  ]);

  const performVideoQualityUpdate = useCallback(
    async (
      quality: VideoQuality,
      networkProfileOverride?: WebcamProducerNetworkProfile,
      forceCaptureRefresh = false,
      requestedIn = captureGeneration(),
    ) => {
      const topologyReplacement = cameraTopologyReplacementPromiseRef.current;
      if (topologyReplacement) {
        await topologyReplacement;
      }
      const claim = { ...claimDevice("video"), generation: requestedIn };
      if (!claimHolds(claim)) return;
      const currentStream = localStreamRef.current ?? localStream;
      if (!currentStream) return;

      let rollbackStream: MediaStream | null = null;
      let replacementTrack: MediaStreamTrack | null = null;
      let constrainedExistingTrack: MediaStreamTrack | null = null;
      let rollbackTrackConstraints: MediaTrackConstraints | null = null;
      let fencedPreviousProducer: Producer | null = null;

      try {
        const publishNetworkProfile =
          networkProfileOverride ?? getPublishNetworkProfile();
        const previousProducer = videoProducerRef.current;

        if (
          previousProducer &&
          !previousProducer.closed &&
          isVp9SvcWebcamProducer(previousProducer) &&
          !forceCaptureRefresh
        ) {
          await applyWebcamProducerNetworkProfile(
            previousProducer,
            quality,
            publishNetworkProfile,
            { publishSettings: getCameraPublishSettings() },
          );
          return;
        }

        const constraints = buildCameraVideoConstraints(
          quality,
          publishNetworkProfile,
          undefined,
          getCameraPublishSettings(),
        );

        console.info(
          `[Meets] Switching to ${quality} quality`,
          JSON.stringify(constraints)
        );

        const currentTrack = getFirstLiveTrack(currentStream.getVideoTracks());
        let shouldReopenVideoTrack = false;
        if (
          currentTrack &&
          currentTrack.readyState === "live"
        ) {
          attachLocalVideoTrackHandlers(currentTrack);
          currentTrack.onended = () => {
            handleLocalTrackEnded("video", currentTrack);
          };
          try {
            rollbackTrackConstraints = currentTrack.getConstraints();
            await currentTrack.applyConstraints(constraints);
            constrainedExistingTrack = currentTrack;
          } catch (err) {
            let currentSettings: MediaTrackSettings | null = null;
            try {
              currentSettings = currentTrack.getSettings();
            } catch {}
            shouldReopenVideoTrack =
              shouldReopenCameraAfterConstraintFailure({
                trackReadyState: currentTrack.readyState,
                currentSettings,
                targetConstraints: constraints,
              });
            console.warn(
              shouldReopenVideoTrack
                ? "[Meets] Camera constraints update failed during a capture upgrade; reopening the camera:"
                : "[Meets] Camera constraints update failed during a downshift; preserving the live track and enforcing sender caps:",
              err,
            );
          }
        }

        let nextVideoTrack = getFirstLiveTrack(currentStream.getVideoTracks());
        let publishStream = currentStream;
        let oldVideoTracksToStop: MediaStreamTrack[] = [];

        if (
          !nextVideoTrack ||
          nextVideoTrack.readyState !== "live" ||
          shouldReopenVideoTrack
        ) {
          const currentDeviceId =
            currentTrack?.readyState === "live"
              ? currentTrack.getSettings().deviceId
              : undefined;
          let newStream: MediaStream;
          const { generation } = claim;
          try {
            newStream = await getUserMediaWithTimeout(
              {
                video:
                  typeof currentDeviceId === "string" && currentDeviceId
                    ? {
                        ...constraints,
                        deviceId: { exact: currentDeviceId },
                      }
                    : constraints,
              },
              {
                label: "camera quality-switch reopen",
                timeoutMs: MEDIA_CAPTURE_RECOVERY_TIMEOUT_MS,
                generation,
              },
            );
          } catch (err) {
            if (!currentDeviceId || isCaptureReleased(err)) throw err;
            console.warn(
              "[Meets] Camera reopen with current device failed, retrying default device:",
              err,
            );
            newStream = await getUserMediaWithTimeout(
              { video: constraints },
              {
                label: "camera quality-switch fallback reopen",
                timeoutMs: MEDIA_CAPTURE_RECOVERY_TIMEOUT_MS,
                generation,
              },
            );
          }
          if (!claimHolds(claim)) {
            newStream.getTracks().forEach((track) => stopLocalTrack(track));
            return;
          }
          const newVideoTrack = newStream.getVideoTracks()[0] ?? null;
          if (!newVideoTrack) {
            throw new Error("No video track obtained");
          }
          applyCameraContentHint(newVideoTrack);
          attachLocalVideoTrackHandlers(newVideoTrack);
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

        if (!nextVideoTrack) {
          return;
        }

        applyCameraContentHint(nextVideoTrack);
        const publishTrack = await waitForPreferredVideoPublishTrack(
          publishStream,
          nextVideoTrack,
        );
        if (!claimHolds(claim)) {
          if (replacementTrack) stopLocalTrack(replacementTrack);
          return;
        }
        applyCameraContentHint(publishTrack);
        attachLocalVideoTrackHandlers(publishTrack);
        const preferredWebcamCodec = getPreferredWebcamCodec(
          deviceRef.current,
          webcamCodecPolicyRef.current,
        );
        const previousEncodingCount =
          previousProducer?.rtpSender?.getParameters().encodings?.length ??
          previousProducer?.rtpParameters.encodings?.length ??
          0;
        const needsEncodingTopologyRecreate =
          Boolean(previousProducer && !previousProducer.closed) &&
          shouldRecreateWebcamProducerForQuality(
            quality,
            shouldUseWebcamSimulcast(preferredWebcamCodec),
            previousEncodingCount,
          );

        if (
          previousProducer &&
          !previousProducer.closed &&
          !needsEncodingTopologyRecreate
        ) {
          if (previousProducer.track?.id !== publishTrack.id) {
            try {
              await replaceCameraProducerTrack(previousProducer, publishTrack);
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
              await replaceCameraProducerTrack(previousProducer, nextVideoTrack);
            }
          }
          if (!claimHolds(claim)) {
            if (replacementTrack) stopLocalTrack(replacementTrack);
            return;
          }
          await applyWebcamProducerNetworkProfile(
            previousProducer,
            quality,
            publishNetworkProfile,
            { publishSettings: getCameraPublishSettings() },
          );
          void requestVideoSenderKeyFrame(previousProducer.rtpSender);
          if (
            !previousProducer.closed &&
            videoProducerRef.current?.id === previousProducer.id
          ) {
            socketRef.current?.emit(
              "requestProducerKeyFrame",
              { producerId: previousProducer.id },
              (response?: { success?: true; error?: string }) => {
                if (response?.error) {
                  console.warn(
                    "[Meets] Receiver key-frame request failed:",
                    response.error,
                  );
                }
              },
            );
          }
          stopTracksExcept(oldVideoTracksToStop, [
            nextVideoTrack,
            previousProducer.track,
          ]);
          return;
        }

        const transport = await prepareCameraProducerTransport();

        if (!claimHolds(claim)) {
          if (replacementTrack) stopLocalTrack(replacementTrack);
          return;
        }
        if (
          previousProducer &&
          (previousProducer.closed ||
            videoProducerRef.current?.id !== previousProducer.id)
        ) {
          throw new Error(
            "Camera producer changed while the quality update was queued",
          );
        }
        if (previousProducer) {
          intentionalLocalProducerCloseIdsRef.current.add(previousProducer.id);
          fencedPreviousProducer = previousProducer;
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

        if (!claimHolds(claim)) {
          intentionalLocalProducerCloseIdsRef.current.add(nextProducer.id);
          socketRef.current?.emit(
            "closeProducer",
            { producerId: nextProducer.id },
            () => {},
          );
          try {
            nextProducer.close();
          } catch {}
          if (replacementTrack) stopLocalTrack(replacementTrack);
          return;
        }
        if (
          !installProducer(
            videoProducerRef,
            previousProducer,
            nextProducer,
            closeLocalVideoProducerForReplacement,
          )
        ) {
          if (previousProducer) {
            intentionalLocalProducerCloseIdsRef.current.delete(previousProducer.id);
          }
          return;
        }
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
        if (
          fencedPreviousProducer &&
          !fencedPreviousProducer.closed &&
          videoProducerRef.current?.id === fencedPreviousProducer.id
        ) {
          intentionalLocalProducerCloseIdsRef.current.delete(
            fencedPreviousProducer.id,
          );
        }
        if (!claimHolds(claim)) {
          if (replacementTrack) stopLocalTrack(replacementTrack);
          return;
        }
        console.error("[Meets] Failed to update video quality:", err);
        if (rollbackStream && replacementTrack) {
          localStreamRef.current = rollbackStream;
          setLocalStream(rollbackStream);
          stopLocalTrack(replacementTrack);
        }
        if (
          constrainedExistingTrack?.readyState === "live" &&
          rollbackTrackConstraints
        ) {
          try {
            await constrainedExistingTrack.applyConstraints(
              rollbackTrackConstraints,
            );
          } catch (rollbackError) {
            console.warn(
              "[Meets] Failed to restore camera constraints after quality-switch rollback:",
              rollbackError,
            );
          }
        }
        throw err;
      }
    },
    [
      cameraChosen,
      attachLocalVideoTrackHandlers,
      localStream,
      handleLocalTrackEnded,
      stopLocalTrack,
      stopTracksExcept,
      setLocalStream,
      socketRef,
      deviceRef,
      producerTransportRef,
      ensureProducerTransportRef,
      prepareCameraProducerTransport,
      videoProducerRef,
      intentionalLocalProducerCloseIdsRef,
      localStreamRef,
      waitForPreferredVideoPublishTrack,
      onPreferredVideoPublishTrackRejected,
      getPublishNetworkProfile,
      getCameraPublishSettings,
      applyCameraContentHint,
      produceCameraTrackWithRawFallback,
      requestCameraProducerRecovery,
      replaceCameraProducerTrack,
      claimDevice,
      claimHolds,
    ]
  );

  const updateVideoQuality = useCallback(
    (
      quality: VideoQuality,
      networkProfileOverride?: WebcamProducerNetworkProfile,
      forceCaptureRefresh = false,
    ): Promise<void> => {
      const requestedIn = captureGeneration();
      return runCameraTrackOperation(() =>
        performVideoQualityUpdate(
          quality,
          networkProfileOverride,
          forceCaptureRefresh,
          requestedIn,
        ),
      );
    },
    [performVideoQualityUpdate, runCameraTrackOperation],
  );

  useEffect(() => {
    updateVideoQualityRef.current = updateVideoQuality;
  }, [updateVideoQuality]);

  applyLatestCameraQualitySettingsRef.current = async () => {
    if (connectionState !== "joined" || isCameraOff) return;
    await updateVideoQuality(videoQualityRef.current, undefined, true);
  };

  applyLatestScreenShareQualitySettingsRef.current = async () => {
    const producer = screenProducerRef.current;
    if (
      connectionState !== "joined" ||
      !isScreenSharing ||
      !producer ||
      producer.closed
    ) {
      return;
    }
    const track = producer.track;
    const publishSettings = getScreenSharePublishSettings();
    if (track && "contentHint" in track) {
      track.contentHint = publishSettings.contentHint;
    }
    await applyScreenShareTrackNetworkProfile(
      track,
      "good",
      publishSettings,
    );
    await applyScreenShareProducerNetworkProfile(
      producer,
      getScreenSharePublishNetworkProfile(),
      publishSettings,
    );
  };

  useEffect(() => {
    const signature = JSON.stringify({
      settings: mediaQualitySettings.camera,
      effectsActive: activeVideoEffectsCount > 0,
    });
    if (signature === previousCameraQualitySettingsRef.current) return;
    previousCameraQualitySettingsRef.current = signature;
    if (connectionState !== "joined" || isCameraOff) return;
    void cameraQualitySettingsQueueRef.current?.request(signature);
  }, [
    activeVideoEffectsCount,
    connectionState,
    isCameraOff,
    mediaQualitySettings.camera,
  ]);

  useEffect(() => {
    const signature = getScreenShareLiveVideoSettingsSignature(
      mediaQualitySettings.screenShare,
    );
    if (signature === previousScreenShareQualitySettingsRef.current) return;
    previousScreenShareQualitySettingsRef.current = signature;
    if (
      connectionState !== "joined" ||
      !isScreenSharing
    ) {
      return;
    }
    void screenShareQualitySettingsQueueRef.current?.request(signature);
  }, [
    connectionState,
    isScreenSharing,
    mediaQualitySettings.screenShare,
  ]);

  useEffect(
    () => () => {
      cameraQualitySettingsQueueRef.current?.clearPending();
      screenShareQualitySettingsQueueRef.current?.clearPending();
    },
    [],
  );

  const applyWebcamProducerTopologyReplacement = useCallback(
    async (
      request: WebcamProducerTopologyReplacementRequest,
    ): Promise<WebcamTopologyReplacementResult> => {
      const claim = claimDevice("video");
      if (
        isObserverMode ||
        isMediaRecoveryBlocked() ||
        !claimHolds(claim) ||
        cameraRecoveryInFlightRef.current ||
        toggleCameraInFlightRef.current
      ) {
        return {
          status: "failed",
          producerId: videoProducerRef.current?.id ?? null,
          topology: getWebcamProducerTopology(videoProducerRef.current),
          retryable: true,
        };
      }

      const previousProducer = videoProducerRef.current;
      const previousTrack = previousProducer?.track ?? null;
      if (
        !previousProducer ||
        previousProducer.closed ||
        previousProducer.id !== request.expectedProducerId ||
        previousTrack?.readyState !== "live"
      ) {
        return {
          status: "failed",
          producerId: previousProducer?.id ?? null,
          topology: getWebcamProducerTopology(previousProducer),
          retryable: true,
        };
      }

      const expectedTopology: WebcamProducerTopology =
        request.target === "single-receiver"
          ? "vp8-single-layer"
          : "vp8-simulcast";
      if (getWebcamProducerTopology(previousProducer) === expectedTopology) {
        return {
          status: "noop",
          producerId: previousProducer.id,
          topology: expectedTopology,
        };
      }
      if (request.target === "single-receiver" && !request.transition) {
        return {
          status: "failed",
          producerId: previousProducer.id,
          topology: getWebcamProducerTopology(previousProducer),
          retryable: false,
          error: new Error("Missing server-issued receiver-capacity transition"),
        };
      }

      cameraTopologyReplacementInFlightRef.current = true;
      let nextProducer: Producer | null = null;
      try {
        const transport = await prepareCameraProducerTransport();
        if (
          !claimHolds(claim) ||
          videoProducerRef.current?.id !== previousProducer.id ||
          previousProducer.closed ||
          previousTrack.readyState !== "live"
        ) {
          return {
            status: "failed",
            producerId: videoProducerRef.current?.id ?? null,
            topology: getWebcamProducerTopology(videoProducerRef.current),
            retryable: true,
          };
        }

        const rawTrack =
          getFirstLiveTrack(
            localStreamRef.current?.getVideoTracks() ?? [],
          ) ?? previousTrack;
        const preferredCodec = getPreferredWebcamCodec(
          deviceRef.current,
          webcamCodecPolicyRef.current,
        );

        intentionalLocalProducerCloseIdsRef.current.add(previousProducer.id);
        nextProducer = await produceCameraTrackWithRawFallback({
          transport,
          publishTrack: previousTrack,
          rawTrack,
          quality: request.quality,
          networkProfile: request.networkProfile,
          paused: false,
          preferredCodec,
          forceSingleLayer: request.target === "single-receiver",
          forceSimulcast: request.target === "adaptive-layers",
          receiverCapacityTransition:
            request.target === "single-receiver"
              ? request.transition
              : undefined,
          context: `topology-${request.target}`,
        });

        if (
          !installProducer(
            videoProducerRef,
            previousProducer,
            nextProducer,
            closeLocalVideoProducerForReplacement,
          )
        ) {
          intentionalLocalProducerCloseIdsRef.current.delete(previousProducer.id);
          nextProducer = null;
          return {
            status: "failed",
            producerId: videoProducerRef.current?.id ?? null,
            topology: getWebcamProducerTopology(videoProducerRef.current),
            retryable: true,
          };
        }
        const nextProducerId = nextProducer.id;
        nextProducer.on("transportclose", () => {
          if (videoProducerRef.current?.id === nextProducerId) {
            videoProducerRef.current = null;
            requestCameraProducerRecovery();
          }
        });

        const actualTopology = getWebcamProducerTopology(nextProducer);
        if (actualTopology !== expectedTopology) {
          throw new Error(
            `Webcam topology replacement negotiated ${actualTopology}; expected ${expectedTopology}`,
          );
        }

        const abandonForCameraOff = (created: Producer) => {
          intentionalLocalProducerCloseIdsRef.current.add(created.id);
          socketRef.current?.emit(
            "closeProducer",
            { producerId: created.id },
            () => {},
          );
          try {
            created.close();
          } catch {}
          if (videoProducerRef.current?.id === created.id) {
            videoProducerRef.current = null;
          }
          return {
            status: "failed",
            producerId: null,
            topology: null,
            retryable: false,
            ambiguousOrPostCommit: true,
          } as const;
        };
        if (!claimHolds(claim)) {
          return abandonForCameraOff(nextProducer);
        }

        const currentStream = localStreamRef.current;
        const latestRawTrack = getFirstLiveTrack(
          currentStream?.getVideoTracks() ?? [],
        );
        const latestPreferredTrack =
          getVideoPublishTrackRef?.current?.(currentStream) ?? latestRawTrack;
        if (
          latestPreferredTrack?.readyState === "live" &&
          nextProducer.track?.id !== latestPreferredTrack.id
        ) {
          try {
            await replaceCameraProducerTrack(nextProducer, latestPreferredTrack);
          } catch (error) {
            if (
              !latestRawTrack ||
              latestRawTrack.readyState !== "live" ||
              latestRawTrack.id === latestPreferredTrack.id
            ) {
              throw error;
            }
            onPreferredVideoPublishTrackRejected?.(
              latestPreferredTrack,
              "topology-replacement-raw-replace-fallback",
            );
            await replaceCameraProducerTrack(nextProducer, latestRawTrack);
          }
        }
        if (!claimHolds(claim)) {
          return abandonForCameraOff(nextProducer);
        }

        socketRef.current?.emit(
          "closeProducer",
          { producerId: previousProducer.id },
          () => {},
        );
        try {
          previousProducer.close();
        } catch {}

        return {
          status: "applied",
          producerId: nextProducer.id,
          topology: actualTopology,
        };
      } catch (error) {
        const failureDisposition =
          getWebcamTopologyReplacementFailureDisposition({
            error,
            nextProducerCreated: nextProducer !== null,
            previousProducerClosed: previousProducer.closed,
            previousProducerStillCurrent:
              videoProducerRef.current?.id === previousProducer.id,
            cameraOff: !claimHolds(claim),
          });
        const { ambiguousOrPostCommit } = failureDisposition;

        if (nextProducer) {
          intentionalLocalProducerCloseIdsRef.current.add(nextProducer.id);
          socketRef.current?.emit(
            "closeProducer",
            { producerId: nextProducer.id },
            () => {},
          );
          try {
            nextProducer.close();
          } catch {}
          if (videoProducerRef.current?.id === nextProducer.id) {
            videoProducerRef.current = null;
          }
        }

        if (failureDisposition.shouldForceSimulcastCompensation) {
          const recoveryCodec = getPreferredWebcamCodec(
            deviceRef.current,
            webcamCodecPolicyRef.current,
          );
          cameraRecoveryPublishOverrideRef.current = {
            policyEpoch: webcamCodecPolicyRef.current.epoch,
            codec: recoveryCodec,
            forceSingleLayer: false,
            forceSimulcast: true,
          };
          if (
            videoProducerRef.current?.id === previousProducer.id &&
            !previousProducer.closed
          ) {
            closeLocalVideoProducerForReplacement(previousProducer);
          }
          requestCameraProducerRecovery();
        }
        if (
          !failureDisposition.shouldPreservePreviousProducerCloseFence
        ) {
          intentionalLocalProducerCloseIdsRef.current.delete(
            previousProducer.id,
          );
        }

        console.warn("[Meets] Webcam topology replacement failed:", {
          target: request.target,
          previousProducerId: previousProducer.id,
          ambiguousOrPostCommit,
          error,
        });
        return {
          status: "failed",
          producerId: videoProducerRef.current?.id ?? null,
          topology: getWebcamProducerTopology(videoProducerRef.current),
          retryable: failureDisposition.retryable,
          ambiguousOrPostCommit,
          error,
        };
      } finally {
        cameraTopologyReplacementInFlightRef.current = false;
        if (pendingCameraProducerRecoveryRef.current) {
          flushQueuedProducerRecoveries();
        }
      }
    },
    [
      claimDevice,
      claimHolds,
      closeLocalVideoProducerForReplacement,
      deviceRef,
      flushQueuedProducerRecoveries,
      getVideoPublishTrackRef,
      intentionalLocalProducerCloseIdsRef,
      isMediaRecoveryBlocked,
      isObserverMode,
      localStreamRef,
      onPreferredVideoPublishTrackRejected,
      prepareCameraProducerTransport,
      produceCameraTrackWithRawFallback,
      replaceCameraProducerTrack,
      requestCameraProducerRecovery,
      socketRef,
      videoProducerRef,
      webcamCodecPolicyRef,
    ],
  );

  const applyWebcamProducerTopologyReplacementRef = useRef(
    applyWebcamProducerTopologyReplacement,
  );
  useEffect(() => {
    applyWebcamProducerTopologyReplacementRef.current =
      applyWebcamProducerTopologyReplacement;
  }, [applyWebcamProducerTopologyReplacement]);

  const webcamTopologyReplacementQueueRef = useRef<
    LatestWinsTopologyReplacementQueue<
      WebcamProducerTopologyReplacementRequest,
      WebcamTopologyReplacementResult
    > | null
  >(null);
  if (!webcamTopologyReplacementQueueRef.current) {
    webcamTopologyReplacementQueueRef.current =
      createLatestWinsTopologyReplacementQueue((request) =>
        applyWebcamProducerTopologyReplacementRef.current(request),
      );
  }

  const replaceWebcamProducerTopology = useCallback(
    (
      request: WebcamProducerTopologyReplacementRequest,
    ): Promise<WebcamTopologyReplacementResult> => {
      const queued = webcamTopologyReplacementQueueRef.current!.request(
        request,
      );
      const normalized = queued.then((result) =>
        result.status === "superseded"
          ? ({
              status: "superseded",
              producerId: videoProducerRef.current?.id ?? null,
              topology: getWebcamProducerTopology(videoProducerRef.current),
              retryable: true,
            } satisfies WebcamTopologyReplacementResult)
          : result,
      );
      cameraTopologyReplacementPromiseRef.current = normalized;
      const clearTrackedPromise = () => {
        if (cameraTopologyReplacementPromiseRef.current === normalized) {
          cameraTopologyReplacementPromiseRef.current = null;
        }
      };
      void normalized.then(clearTrackedPromise, clearTrackedPromise);
      return normalized;
    },
    [videoProducerRef],
  );

  useEffect(
    () => () => {
      webcamTopologyReplacementQueueRef.current?.clearPending();
    },
    [],
  );

  const toggleMute = useCallback(async () => {
    if (isObserverMode) return;
    const unmuting = !deviceIntents.get().audio.chosen;
    if (unmuting && microphoneUnmuteDisabledRef.current) return;
    let producer = audioProducerRef.current;
    if (
      producer &&
      (producer.closed || producer.track?.readyState !== "live")
    ) {
      closeLocalAudioProducerForReplacement(producer);
      producer = null;
    }

    if (!unmuting) {
      setIsMuted(true);
      const muteClaim = claimDevice("audio");
      const liveAudioTracks = (localStreamRef.current?.getAudioTracks() ?? []).filter(
        (track) => track.readyState === "live",
      );
      liveAudioTracks.forEach((track) => {
        setNoiseCancellationTrackEnabled(track, false);
      });
      if (!producer) return;
      try {
        producer.pause();
      } catch {}
      const toggleResult = await emitToggleMute(producer.id, true, {
        timeoutMs: TOGGLE_MUTE_STRICT_ACK_TIMEOUT_MS,
      });
      if (toggleResult.ok) return;
      console.warn("[Meets] toggleMute failed, rolling back mute:", toggleResult.error);
      if (
        muteClaim.generation !== captureGeneration() ||
        deviceIntents.get().audio.request !== muteClaim.request
      ) {
        return;
      }
      liveAudioTracks.forEach((track) => {
        if (track.readyState === "live") setNoiseCancellationTrackEnabled(track, true);
      });
      try {
        producer.resume();
      } catch {}
      setIsMuted(false);
      setMeetError({
        code: "TRANSPORT_ERROR",
        message: toggleResult.error || "Failed to mute microphone",
        recoverable: true,
        device: "microphone",
      });
      return;
    }

    const claim = claimDevice("audio", true);
    toggleMuteInFlightRef.current = true;
    let createdTrack: MediaStreamTrack | null = null;
    const discardCreatedTrack = () => {
      if (!createdTrack) return;
      const track = createdTrack;
      createdTrack = null;
      stopLocalTrack(track);
      const currentStream = localStreamRef.current;
      if (currentStream?.getTracks().includes(track)) {
        commitLocalStream(
          new MediaStream(currentStream.getTracks().filter((candidate) => candidate !== track)),
        );
      }
    };
    await runMicTrackOperation(async () => {
      if (!claimHolds(claim)) {
        toggleMuteInFlightRef.current = false;
        return;
      }
      let producer = audioProducerRef.current;
      if (producer && (producer.closed || producer.track?.readyState !== "live")) {
        closeLocalAudioProducerForReplacement(producer);
        producer = null;
      }
      try {
        let audioTrack = getFirstLiveTrack(
          localStreamRef.current?.getAudioTracks() ?? [],
        );

        if (audioTrack && audioTrack.readyState !== "live") {
          stopLocalTrack(audioTrack);
          audioTrack = null;
        }

        if (!audioTrack) {
          const stream = await getUserMediaWithTimeout(
            { audio: buildAudioConstraints(selectedAudioInputDeviceId) },
            {
              label: "microphone unmute",
              timeoutMs: MEDIA_CAPTURE_RECOVERY_TIMEOUT_MS,
              generation: claim.generation,
            },
          );
          const rawAudioTrack = stream.getAudioTracks()[0];

          if (!rawAudioTrack) throw new Error("No audio track obtained");
          createdTrack = rawAudioTrack;
          const nextAudioTrack = await prepareAudioPublishTrack(rawAudioTrack, claim.generation);
          createdTrack = nextAudioTrack;
          if (!claimHolds(claim)) {
            if (nextAudioTrack !== rawAudioTrack) stopLocalTrack(rawAudioTrack);
            discardCreatedTrack();
            return;
          }

          const previousStream = localStreamRef.current;
          previousStream?.getAudioTracks().forEach((track) => {
            if (
              track.id !== nextAudioTrack.id &&
              track.id !== getNoiseCancellationSourceTrack(nextAudioTrack)?.id
            ) {
              stopLocalTrack(track);
            }
          });
          commitAudioTrackToLocalStream(nextAudioTrack, previousStream, {
            stopReplacedTracks: false,
          });

          audioTrack = nextAudioTrack;
        }

        if (producer) {
          if (!producer.track || producer.track.id !== audioTrack.id) {
            await producer.replaceTrack({ track: audioTrack });
          }
          if (!claimHolds(claim)) {
            createdTrack = null;
            return;
          }
          setNoiseCancellationTrackEnabled(audioTrack, true);
          try {
            producer.resume();
          } catch {}
          createdTrack = null;
          settleClaim(claim, true);
          setMediaError((current) => clearMediaDeviceError(current, "microphone"));
          confirmAudioProducerUnmuted(producer.id);
          return;
        }

        setNoiseCancellationTrackEnabled(audioTrack, true);
        createdTrack = null;
        settleClaim(claim, true);
        requestAudioProducerRecovery();
        return;
      } catch (err) {
        if (isCaptureReleased(err) || !claimHolds(claim)) {
          discardCreatedTrack();
          return;
        }
        console.error("[Meets] Failed to restart audio:", err);
        const meetErr = createMeetError(err, "MEDIA_ERROR", "microphone");
        const liveAudioTrackAfterFailure = getFirstLiveTrack(
          localStreamRef.current?.getAudioTracks() ?? [],
        );
        const shouldRetryAudioUnmute =
          liveAudioTrackAfterFailure !== null &&
          !shouldDisableMediaIntentAfterRecoveryFailure(err, meetErr);

        if (shouldRetryAudioUnmute) {
          setNoiseCancellationTrackEnabled(liveAudioTrackAfterFailure, true);
          if (
            producer &&
            !producer.closed &&
            audioProducerRef.current?.id === producer.id
          ) {
            closeLocalAudioProducerForReplacement(producer);
          }
          settleClaim(claim, true);
          requestAudioProducerRecovery();
          return;
        }

        discardCreatedTrack();
        settleClaim(claim, false);
        setMediaError((current) => mergeMediaDeviceError(current, meetErr));
      } finally {
        toggleMuteInFlightRef.current = false;
      }
    });
  }, [
    runMicTrackOperation,
    isObserverMode,
    deviceIntents,
    claimDevice,
    claimHolds,
    settleClaim,
    selectedAudioInputDeviceId,
    prepareAudioPublishTrack,
    stopLocalTrack,
    buildAudioConstraints,
    emitToggleMute,
    audioProducerRef,
    localStreamRef,
    commitLocalStream,
    commitAudioTrackToLocalStream,
    setMeetError,
    setMediaError,
    closeLocalAudioProducerForReplacement,
    confirmAudioProducerUnmuted,
    setIsMuted,
    requestAudioProducerRecovery,
    toggleMuteInFlightRef,
  ]);

  useEffect(() => {
    if (isObserverMode) return;
    if (connectionState !== "joined") return;
    const canWarmMutedAudio = isMuted && mediaState.hasAudioPermission;
    const getReusableAudioTrack = () =>
      getFirstLiveTrack(
        (localStreamRef.current ?? localStream)?.getAudioTracks() ?? [],
      );
    if (isMuted && !canWarmMutedAudio && !getReusableAudioTrack()) return;
    if (isMediaRecoveryBlocked()) return;

    let disposed = false;
    const requestRecovery = (reason: "initial" | "watchdog") => {
      if (disposed || audioRecoveryInFlightRef.current) return;
      if (isMediaRecoveryBlocked()) return;
      const liveAudioTrack = getReusableAudioTrack();
      if (
        !microphoneChosen() &&
        !liveAudioTrack &&
        !mediaState.hasAudioPermission
      ) {
        return;
      }

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
    isMuted,
    isObserverMode,
    mediaState.hasAudioPermission,
    isMediaRecoveryBlocked,
    audioProducerRef,
    localStream,
    localStreamRef,
    closeLocalAudioProducerForReplacement,
    requestAudioProducerRecovery,
    microphoneChosen,
  ]);

  useEffect(() => {
    if (isObserverMode) return;
    if (connectionState !== "joined") return;
    const reusableAudioTrack = getFirstLiveTrack(
      (localStreamRef.current ?? localStream)?.getAudioTracks() ?? [],
    );
    if (isMuted && !mediaState.hasAudioPermission && !reusableAudioTrack) {
      return;
    }
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
    if (microphoneUnmuteDisabledRef.current && microphoneChosen()) {
      (localStreamRef.current ?? localStream)
        ?.getAudioTracks()
        .forEach((track) => setNoiseCancellationTrackEnabled(track, false));
      setIsMuted(true);
      return;
    }
    if (audioRecoveryInFlightRef.current) return;

    let createdTrack: MediaStreamTrack | null = null;
    const removeCreatedTrackFromLocalStream = () => {
      if (!createdTrack) return;
      const sourceTrack = getNoiseCancellationSourceTrack(createdTrack);
      stopLocalTrack(createdTrack);
      const currentStream = localStreamRef.current;
      const tracksToRemove = new Set(
        [createdTrack.id, sourceTrack?.id].filter(
          (trackId): trackId is string => Boolean(trackId),
        ),
      );
      if (
        currentStream
          ?.getTracks()
          .some((track) => tracksToRemove.has(track.id))
      ) {
        const remaining = currentStream
          .getTracks()
          .filter((track) => !tracksToRemove.has(track.id));
        const nextStream = new MediaStream(remaining);
        localStreamRef.current = nextStream;
        setLocalStream(nextStream);
      }
      createdTrack = null;
    };
    audioRecoveryInFlightRef.current = true;

    const generation = captureGeneration();
    const recoveryHolds = () =>
      generation === captureGeneration() &&
      connectionStateRef.current === "joined" &&
      !mediaOperationsDisposedRef.current;
    const recoverAudioProducer = async () => {
      const existingProducer = audioProducerRef.current;
      if (
        !recoveryHolds() ||
        (existingProducer &&
          !existingProducer.closed &&
          existingProducer.track?.readyState === "live")
      ) {
        finishAudioTrackOperation();
        return;
      }
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

        let audioTrack = getFirstLiveTrack(
          (localStreamRef.current ?? localStream)?.getAudioTracks() ?? [],
        );
        const originalAudioTrack = audioTrack;

        if (!audioTrack || audioTrack.readyState !== "live") {
          const stream = await getUserMediaWithTimeout(
            { audio: buildAudioConstraints(selectedAudioInputDeviceId) },
            {
              label: "microphone producer recovery",
              timeoutMs: MEDIA_CAPTURE_RECOVERY_TIMEOUT_MS,
              generation,
            },
          );
          audioTrack = stream.getAudioTracks()[0] ?? null;
          createdTrack = audioTrack;
        }

        if (!audioTrack) {
          throw new Error("No audio track available for recovery");
        }
        const rawRecoveryTrack = audioTrack;
        audioTrack = await prepareAudioPublishTrack(audioTrack, generation);
        if (!originalAudioTrack || audioTrack.id !== originalAudioTrack.id) {
          createdTrack = audioTrack;
        }
        if (isMediaRecoveryBlocked() || !recoveryHolds()) {
          if (rawRecoveryTrack !== originalAudioTrack && rawRecoveryTrack !== audioTrack) {
            stopLocalTrack(rawRecoveryTrack);
          }
          removeCreatedTrackFromLocalStream();
          return;
        }

        const shouldStartPaused =
          !microphoneChosen() || microphoneUnmuteDisabledRef.current;
        if (shouldStartPaused && microphoneChosen()) {
          setIsMuted(true);
        }
        setNoiseCancellationTrackEnabled(audioTrack, !shouldStartPaused);

        if (createdTrack) {
          const previousStream = localStreamRef.current;
          commitAudioTrackToLocalStream(audioTrack, previousStream);
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

        if (!recoveryHolds()) {
          closeLocalAudioProducerForReplacement(audioProducer);
          removeCreatedTrackFromLocalStream();
          return;
        }

        const pausedNow = !microphoneChosen() || microphoneUnmuteDisabledRef.current;
        setNoiseCancellationTrackEnabled(audioTrack, !pausedNow);
        try {
          if (pausedNow) audioProducer.pause();
          else if (shouldStartPaused) audioProducer.resume();
        } catch {}
        if (pausedNow !== shouldStartPaused) {
          void emitToggleMute(audioProducer.id, pausedNow, {
            timeoutMs: TOGGLE_MUTE_BACKGROUND_ACK_TIMEOUT_MS,
          });
        }

        if (
          !installProducer(
            audioProducerRef,
            null,
            audioProducer,
            closeLocalAudioProducerForReplacement,
          )
        ) {
          removeCreatedTrackFromLocalStream();
          return;
        }
        createdTrack = null;
        setMediaError((current) => clearMediaDeviceError(current, "microphone"));
        audioProducer.on("transportclose", () => {
          if (audioProducerRef.current?.id === audioProducer.id) {
            audioProducerRef.current = null;
            requestAudioProducerRecovery();
          }
        });
      } catch (err) {
        removeCreatedTrackFromLocalStream();
        if (isCaptureReleased(err)) return;
        console.error("[Meets] Audio producer recovery failed:", err);
        if (recoveryHolds()) {
          if (microphoneUnmuteDisabledRef.current) {
            setIsMuted(true);
            return;
          }
          const meetErr = createMeetError(err, "MEDIA_ERROR", "microphone");
          const failedMutedWarmup = !microphoneChosen();
          if (
            !hadLiveAudioTrackBeforeRecovery &&
            shouldDisableMediaIntentAfterRecoveryFailure(err, meetErr)
          ) {
            setIsMuted(true);
            setMediaState((current) => ({
              ...current,
              hasAudioPermission: false,
            }));
          }
          if (!failedMutedWarmup) {
            setMediaError((current) => mergeMediaDeviceError(current, meetErr));
          }
        }
      } finally {
        finishAudioTrackOperation();
      }
    };

    void runMicTrackOperation(recoverAudioProducer);
  }, [
    isObserverMode,
    connectionState,
    audioProducerRecoveryPulse,
    isMuted,
    mediaState.hasAudioPermission,
    localStream,
    isMediaRecoveryBlocked,
    selectedAudioInputDeviceId,
    prepareAudioPublishTrack,
    stopLocalTrack,
    buildAudioConstraints,
    producerTransportRef,
    ensureProducerTransportRef,
    audioProducerRef,
    localStreamRef,
    commitAudioTrackToLocalStream,
    setLocalStream,
    setIsMuted,
    setMeetError,
    setMediaError,
    closeLocalAudioProducerForReplacement,
    finishAudioTrackOperation,
    getPublishNetworkProfile,
    requestAudioProducerRecovery,
    setIsMuted,
    microphoneChosen,
  ]);

  useEffect(() => {
    if (isObserverMode) return;
    if (connectionState !== "joined") return;
    if (isMediaRecoveryBlocked()) return;
    if (audioRecoveryInFlightRef.current) {
      pendingAudioProcessingSwitchRef.current = true;
      return;
    }

    const currentStream = localStreamRef.current ?? localStream;
    const currentAudioTrack = getFirstLiveTrack(
      currentStream?.getAudioTracks() ?? [],
    );
    if (!currentAudioTrack) {
      pendingAudioProcessingSwitchRef.current = false;
      return;
    }

    const isProcessed = isNoiseCancellationProcessedTrack(currentAudioTrack);
    if (isNoiseCancellationEnabled === isProcessed) {
      pendingAudioProcessingSwitchRef.current = false;
      return;
    }

    pendingAudioProcessingSwitchRef.current = false;

    const switchGeneration = captureGeneration();
    const switchHolds = () =>
      switchGeneration === captureGeneration() &&
      noiseCancellationChoiceRef.current === isNoiseCancellationEnabled &&
      connectionStateRef.current === "joined" &&
      !mediaOperationsDisposedRef.current;
    const switchAudioProcessing = async () => {
      if (!switchHolds()) return;
      const currentAudioTrack = getFirstLiveTrack(
        localStreamRef.current?.getAudioTracks() ?? [],
      );
      if (
        !currentAudioTrack ||
        isNoiseCancellationEnabled === isNoiseCancellationProcessedTrack(currentAudioTrack)
      ) {
        return;
      }
      audioRecoveryInFlightRef.current = true;
      const generation = switchGeneration;
      try {
        const producer = audioProducerRef.current;
        const nextTrack = isNoiseCancellationEnabled
          ? await prepareAudioPublishTrack(currentAudioTrack, generation)
          : getNoiseCancellationSourceTrack(currentAudioTrack);

        if (!switchHolds()) {
          if (
            nextTrack &&
            nextTrack.id !== currentAudioTrack.id &&
            isNoiseCancellationProcessedTrack(nextTrack)
          ) {
            detachNoiseCancellationSourceHandler(nextTrack);
            stopNoiseCancellationForTrack(nextTrack, {
              stopOutput: true,
              stopSource: false,
            });
          }
          return;
        }

        if (
          !nextTrack ||
          nextTrack.readyState !== "live" ||
          nextTrack.id === currentAudioTrack.id
        ) {
          return;
        }

        setNoiseCancellationTrackEnabled(nextTrack, microphoneChosen());
        if (producer && !producer.closed) {
          await producer.replaceTrack({ track: nextTrack });
        }
        if (generation !== captureGeneration() || mediaOperationsDisposedRef.current) {
          if (isNoiseCancellationProcessedTrack(nextTrack)) {
            stopNoiseCancellationForTrack(nextTrack, { stopOutput: true, stopSource: false });
          }
          return;
        }
        setNoiseCancellationTrackEnabled(nextTrack, microphoneChosen());

        if (!isNoiseCancellationEnabled) {
          detachNoiseCancellationSourceHandler(currentAudioTrack);
          stopNoiseCancellationForTrack(currentAudioTrack, {
            stopOutput: true,
            stopSource: false,
          });
          attachLocalAudioTrackHandlers(nextTrack);
        }

        commitAudioTrackToLocalStream(
          nextTrack,
          localStreamRef.current ?? currentStream,
          {
            stopReplacedTracks: isNoiseCancellationEnabled,
          },
        );

        if (!producer || producer.closed) {
          requestAudioProducerRecovery();
        }
      } catch (error) {
        if (isCaptureReleased(error)) return;
        console.warn("[Meets] Failed to switch microphone processing:", error);
        if (microphoneChosen()) {
          requestAudioProducerRecovery();
        }
      } finally {
        finishAudioTrackOperation();
      }
    };

    void runMicTrackOperation(switchAudioProcessing);
  }, [
    attachLocalAudioTrackHandlers,
    audioProcessingSwitchPulse,
    audioProducerRef,
    commitAudioTrackToLocalStream,
    connectionState,
    detachNoiseCancellationSourceHandler,
    finishAudioTrackOperation,
    isMediaRecoveryBlocked,
    isNoiseCancellationEnabled,
    isObserverMode,
    localStream,
    localStreamRef,
    prepareAudioPublishTrack,
    requestAudioProducerRecovery,
    microphoneChosen,
  ]);

  const toggleCamera = useCallback(async () => {
    if (isObserverMode) return;
    const turningOn = !deviceIntents.get().video.chosen;
    if (turningOn && cameraPublishingDisabledRef.current) return;

    const closeCameraProducer = (target: Producer) => {
      socketRef.current?.emit(
        "closeProducer",
        { producerId: target.id },
        (response: { success: boolean } | { error: string }) => {
          if ("error" in response) {
            console.error("[Meets] Failed to close video producer:", response);
          }
        }
      );
      try {
        target.close();
      } catch {}
      if (videoProducerRef.current === target) videoProducerRef.current = null;
    };
    const closeCamera = () => {
      setIsCameraOff(true);
      const producer = videoProducerRef.current;
      if (producer) closeCameraProducer(producer);
      const previousStream = localStreamRef.current;
      if (previousStream) {
        previousStream.getVideoTracks().forEach((track) => {
          stopLocalTrack(track);
        });
        commitLocalStream(
          new MediaStream(previousStream.getTracks().filter((track) => track.kind !== "video")),
        );
      }
    };

    if (!turningOn) {
      closeCamera();
      return;
    }

    const claim = claimDevice("video", true);
    toggleCameraInFlightRef.current = true;
    let createdTrack: MediaStreamTrack | null = null;
    const discardCreatedTrack = () => {
      if (!createdTrack) return;
      const track = createdTrack;
      createdTrack = null;
      stopLocalTrack(track);
      const currentStream = localStreamRef.current;
      if (currentStream?.getTracks().includes(track)) {
        commitLocalStream(
          new MediaStream(currentStream.getTracks().filter((candidate) => candidate !== track)),
        );
      }
    };
    const refuse = () => {
      discardCreatedTrack();
      settleClaim(claim, false);
    };

    await runCameraTrackOperation(async () => {
      if (!claimHolds(claim)) {
        toggleCameraInFlightRef.current = false;
        return;
      }
      try {
        const producer = videoProducerRef.current;
        if (producer) {
          if (producer.track?.readyState === "live") {
            const toggleResult = await resumeProducerWithServerConfirmation(
              producer,
              () => emitToggleCamera(producer.id, false),
            );
            if (!claimHolds(claim)) return;
            if (!toggleResult.ok) {
              console.warn(
                "[Meets] toggleCamera failed, rolling back camera resume:",
                toggleResult.error,
              );
              refuse();
              return;
            }
            if (cameraPublishingDisabledRef.current) {
              closeCamera();
              return;
            }
            settleClaim(claim, true);
            setMediaError((current) => clearMediaDeviceError(current, "camera"));
            return;
          }
          closeCameraProducer(producer);
        }

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

        await prepareCameraProducerTransport();
        if (!claimHolds(claim)) return;

        const stream = await getUserMediaWithTimeout(
          { video: buildVideoConstraints() },
          {
            label: "camera toggle",
            timeoutMs: MEDIA_CAPTURE_RECOVERY_TIMEOUT_MS,
            generation: claim.generation,
          },
        );
        const videoTrack = stream.getVideoTracks()[0];
        createdTrack = videoTrack ?? null;
        stream.getTracks().forEach((track) => {
          if (track !== videoTrack) stopLocalTrack(track);
        });
        if (!videoTrack) throw new Error("No video track obtained");
        if (!claimHolds(claim)) {
          discardCreatedTrack();
          return;
        }
        if (cameraPublishingDisabledRef.current) {
          refuse();
          return;
        }
        applyCameraContentHint(videoTrack);
        attachLocalVideoTrackHandlers(videoTrack);
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
        if (!claimHolds(claim)) {
          discardCreatedTrack();
          return;
        }
        attachLocalVideoTrackHandlers(publishTrack);
        if (cameraPublishingDisabledRef.current) {
          refuse();
          return;
        }

        const quality = videoQualityRef.current;
        const networkProfile = getPublishNetworkProfile();
        const preferredWebcamCodec = getPreferredWebcamCodec(
          deviceRef.current,
          webcamCodecPolicyRef.current,
        );
        const publishTransport = await prepareCameraProducerTransport();
        const videoProducer = await produceCameraTrackWithRawFallback({
          transport: publishTransport,
          publishTrack,
          rawTrack: videoTrack,
          quality,
          networkProfile,
          paused: false,
          preferredCodec: preferredWebcamCodec,
          context: "camera-toggle",
        });

        if (!claimHolds(claim) || cameraPublishingDisabledRef.current) {
          closeCameraProducer(videoProducer);
          if (cameraPublishingDisabledRef.current && claimHolds(claim)) {
            refuse();
          } else {
            discardCreatedTrack();
          }
          return;
        }

        if (
          !installProducer(
            videoProducerRef,
            null,
            videoProducer,
            closeLocalVideoProducerForReplacement,
          )
        ) {
          discardCreatedTrack();
          settleClaim(claim, true);
          return;
        }
        const videoProducerId = videoProducer.id;
        videoProducer.on("transportclose", () => {
          if (videoProducerRef.current?.id === videoProducerId) {
            videoProducerRef.current = null;
            requestCameraProducerRecovery();
          }
        });
        createdTrack = null;
        settleClaim(claim, true);
        setMediaError((current) => clearMediaDeviceError(current, "camera"));
      } catch (err) {
        if (isCaptureReleased(err) || !claimHolds(claim)) {
          discardCreatedTrack();
          return;
        }
        console.error("[Meets] Failed to restart video:", err);
        refuse();
        setMediaError((current) =>
          mergeMediaDeviceError(current, createMeetError(err, "MEDIA_ERROR", "camera")),
        );
      } finally {
        toggleCameraInFlightRef.current = false;
      }
    });
  }, [
    runCameraTrackOperation,
    isObserverMode,
    deviceIntents,
    claimDevice,
    claimHolds,
    settleClaim,
    activeVideoEffectsCount,
    attachLocalVideoTrackHandlers,
    handleLocalTrackEnded,
    stopLocalTrack,
    socketRef,
    deviceRef,
    videoProducerRef,
    prepareCameraProducerTransport,
    setLocalStream,
    commitLocalStream,
    localStreamRef,
    videoQualityRef,
    webcamCodecPolicyRef,
    setIsCameraOff,
    setMediaError,
    emitToggleCamera,
    waitForPreferredVideoPublishTrack,
    buildVideoConstraints,
    getPublishNetworkProfile,
    produceCameraTrackWithRawFallback,
    requestCameraProducerRecovery,
    resumeProducerWithServerConfirmation,
  ]);

  useEffect(() => {
    if (isObserverMode) return;
    if (connectionState !== "joined") return;
    if (cameraDisabled) return;
    if (cameraEnableDisabled) return;
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
        const claim = claimDevice("video");
        void (async () => {
          try {
            if (
              !claimHolds(claim) ||
              videoProducerRef.current?.id !== producer.id ||
              producer.closed ||
              isMediaRecoveryBlocked()
            ) {
              return;
            }
            applyCameraContentHint(rawCameraTrack);
            attachLocalVideoTrackHandlers(rawCameraTrack);
            rawCameraTrack.onended = () => {
              handleLocalTrackEnded("video", rawCameraTrack);
            };
            await replaceCameraProducerTrack(producer, rawCameraTrack);
            if (!claimHolds(claim)) return;
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
              { publishSettings: getCameraPublishSettings() },
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
    cameraDisabled,
    cameraEnableDisabled,
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
    attachLocalVideoTrackHandlers,
    replaceCameraProducerTrack,
    claimDevice,
    claimHolds,
  ]);

  useEffect(() => {
    if (isObserverMode) {
      cameraOutboundStallStateRef.current = createCameraOutboundStallState();
      cameraRecoveryPublishOverrideRef.current = null;
      vp9ZeroFrameProofRef.current = null;
      vp9ZeroFrameFailureReportedEpochRef.current = null;
      return;
    }
    if (
      connectionState !== "joined" ||
      isCameraOff ||
      isMediaRecoveryBlocked()
    ) {
      cameraOutboundStallStateRef.current = createCameraOutboundStallState();
      cameraRecoveryPublishOverrideRef.current = null;
      vp9ZeroFrameProofRef.current = null;
      vp9ZeroFrameFailureReportedEpochRef.current = null;
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

      if (!isDocumentVisibleForMediaRecovery()) {
        cameraOutboundStallStateRef.current = {
          ...state,
          lastRecoveryAtMs: now,
        };
        console.warn(
          "[Meets] Camera sender stalled in background; deferring track repair until foreground.",
          {
            producerId: producer.id,
            trackId: producerTrack.id,
            stalledSamples: state.stalledSamples,
            frames: sample.frames,
            bytes: sample.bytes,
          },
        );
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

      const claim = claimDevice("video");
      const repairHolds = () =>
        !disposed &&
        claimHolds(claim) &&
        videoProducerRef.current?.id === producer.id &&
        !producer.closed;
      cameraProducerTrackRepairInFlightRef.current = true;
      try {
        if (!repairHolds() || isMediaRecoveryBlocked()) {
          return;
        }

        const policy = webcamCodecPolicyRef.current;
        if (
          vp9ZeroFrameProofRef.current &&
          (policy.codec !== "vp9" ||
            vp9ZeroFrameProofRef.current.epoch !== policy.epoch)
        ) {
          vp9ZeroFrameProofRef.current = null;
        }
        if (
          vp9ZeroFrameFailureReportedEpochRef.current !== null &&
          vp9ZeroFrameFailureReportedEpochRef.current !== policy.epoch
        ) {
          vp9ZeroFrameFailureReportedEpochRef.current = null;
        }

        const provenZeroFrameStall = getProvenVp9ZeroFrameStall(
          vp9ZeroFrameProofRef.current,
          {
            epoch: policy.epoch,
            producerId: producer.id,
            frames: sample.frames,
          },
        );
        if (
          policy.codec === "vp9" &&
          provenZeroFrameStall &&
          vp9ZeroFrameFailureReportedEpochRef.current !== policy.epoch
        ) {
          vp9ZeroFrameProofRef.current = null;
          vp9ZeroFrameFailureReportedEpochRef.current = policy.epoch;
          const fallbackApplied = await reportCurrentWebcamCodecFailure(
            provenZeroFrameStall,
          );
          if (
            fallbackApplied ||
            webcamCodecPolicyRef.current.epoch !== policy.epoch ||
            !repairHolds()
          ) {
            return;
          }
        }

        const shouldTryPreferredRepair = !state.rawRepairAttempted;
        if (shouldTryPreferredRepair) {
          const publishStream =
            localStreamRef.current ?? new MediaStream([rawCameraTrack]);
          let diagnosticTrack: MediaStreamTrack | null = null;
          if (policy.codec === "vp9" && sample.frames === 0) {
            try {
              diagnosticTrack = holdClone(rawCameraTrack, claim.generation);
              applyCameraContentHint(diagnosticTrack);
            } catch (error) {
              if (isCaptureReleased(error)) return;
              diagnosticTrack = null;
            }
          }
          const publishTrack =
            diagnosticTrack ??
            (await waitForPreferredVideoPublishTrack(
              publishStream,
              rawCameraTrack,
            ));
          if (
            !publishTrack ||
            publishTrack.readyState !== "live" ||
            !repairHolds()
          ) {
            if (diagnosticTrack) stopLocalTrack(diagnosticTrack);
            return;
          }
          applyCameraContentHint(rawCameraTrack);
          attachLocalVideoTrackHandlers(rawCameraTrack);
          if (!diagnosticTrack) attachLocalVideoTrackHandlers(publishTrack);
          rawCameraTrack.onended = () => {
            handleLocalTrackEnded("video", rawCameraTrack);
          };
          try {
            await replaceCameraProducerTrack(producer, publishTrack);
          } catch (error) {
            if (diagnosticTrack) stopLocalTrack(diagnosticTrack);
            throw error;
          }
          if (!repairHolds()) {
            if (diagnosticTrack) stopLocalTrack(diagnosticTrack);
            return;
          }
          if (diagnosticTrack) {
            vp9DiagnosticTrackRef.current = diagnosticTrack;
            producer.observer.once("close", retireVp9DiagnosticTrack);
            vp9ZeroFrameProofRef.current = createVp9ZeroFrameProof({
              epoch: policy.epoch,
              initialProducerId: producer.id,
              freshTrackId: diagnosticTrack.id,
            });
          }
          if (
            (publishTrack.id === rawCameraTrack.id || diagnosticTrack) &&
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
            { publishSettings: getCameraPublishSettings() },
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
              usedFreshDiagnosticTrack: Boolean(diagnosticTrack),
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
          ) ?? getPreferredWebcamCodec(device, webcamCodecPolicyRef.current);
        const fallbackCodec = getFallbackWebcamCodec(
          device,
          currentCodec,
          webcamCodecPolicyRef.current,
        );
        cameraRecoveryPublishOverrideRef.current = {
          policyEpoch: webcamCodecPolicyRef.current.epoch,
          codec: fallbackCodec ?? currentCodec,
          forceSingleLayer: true,
        };
        console.warn("[Meets] Next camera recovery will use single-layer codec:", {
          currentCodec: currentCodec?.mimeType ?? currentCodecMimeType,
          fallbackCodec: fallbackCodec?.mimeType ?? null,
        });
        closeLocalVideoProducerForReplacement(producer);
        resetStallState();
        requestCameraProducerRecovery();
      } catch (err) {
        if (!repairHolds()) return;
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
          const allowProducerRecreate = isDocumentVisibleForMediaRecovery();
          const currentState = cameraOutboundStallStateRef.current;
          const previous =
            currentState.producerId === producer.id &&
            currentState.trackId === producerTrack.id
              ? currentState
              : createCameraOutboundStallState(producer.id, producerTrack.id);
          const hasBaseline =
            previous.frames !== null || previous.bytes !== null;
          const hasProgress = hasOutboundVideoProgress(previous, sample);
          const currentPolicy = webcamCodecPolicyRef.current;
          if (
            vp9ZeroFrameProofRef.current &&
            (currentPolicy.codec !== "vp9" ||
              vp9ZeroFrameProofRef.current.epoch !== currentPolicy.epoch ||
              hasProgress)
          ) {
            vp9ZeroFrameProofRef.current = null;
          }
          const stalledSamples =
            hasBaseline && !hasProgress
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
    isCameraOff,
    isObserverMode,
    isMediaRecoveryBlocked,
    videoProducerRef,
    deviceRef,
    localStreamRef,
    videoQualityRef,
    handleLocalTrackEnded,
    attachLocalVideoTrackHandlers,
    getPublishNetworkProfile,
    onPreferredVideoPublishTrackRejected,
    closeLocalVideoProducerForReplacement,
    reportCurrentWebcamCodecFailure,
    requestCameraProducerRecovery,
    stopLocalTrack,
    waitForPreferredVideoPublishTrack,
    webcamCodecPolicyRef,
    replaceCameraProducerTrack,
    claimDevice,
    claimHolds,
    retireVp9DiagnosticTrack,
  ]);

  useEffect(() => {
    if (isObserverMode) {
      screenOutboundStallStateRef.current = createCameraOutboundStallState();
      return;
    }
    if (
      connectionState !== "joined" ||
      !isScreenSharing ||
      isMediaRecoveryBlocked()
    ) {
      screenOutboundStallStateRef.current = createCameraOutboundStallState();
      return;
    }

    let disposed = false;

    const resetStallState = (
      producerId: string | null = null,
      trackId: string | null = null,
    ) => {
      screenOutboundStallStateRef.current =
        createCameraOutboundStallState(producerId, trackId);
    };

    const republishStalledScreenProducer = async (
      state: CameraOutboundStallState,
      reason: string,
    ) => {
      if (screenProducerTrackRepairInFlightRef.current) return;
      if (isMediaRecoveryBlocked()) return;

      const republishScreenShare = republishScreenShareRef?.current;
      const screenTrack = getFirstLiveTrack(
        screenShareStreamRef.current?.getVideoTracks() ?? [],
      );
      if (
        !republishScreenShare ||
        !screenTrack ||
        screenTrack.readyState !== "live" ||
        screenTrack.muted
      ) {
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

      screenProducerTrackRepairInFlightRef.current = true;
      screenOutboundStallStateRef.current = {
        ...state,
        trackRefreshAttemptsWithoutProgress: Math.max(
          state.trackRefreshAttemptsWithoutProgress,
          MAX_SCREEN_SHARE_TRACK_REFRESH_ATTEMPTS,
        ),
        lastRecoveryAtMs: now,
      };
      try {
        const recovered = await republishScreenShare(reason, {
          replaceCurrent: true,
        });
        if (!recovered) {
          throw new Error("No live screen-share capture available to republish");
        }
        const nextProducer = screenProducerRef.current;
        const nextTrack = nextProducer?.track ?? screenTrack;
        resetStallState(nextProducer?.id ?? null, nextTrack.id);
        console.warn("[Meets] Republished persistently stalled screen share:", {
          previousProducerId: state.producerId,
          producerId: nextProducer?.id ?? null,
          trackId: nextTrack.id,
          trackRefreshAttempts:
            state.trackRefreshAttemptsWithoutProgress,
        });
      } catch (error) {
        screenOutboundStallStateRef.current = {
          ...state,
          trackRefreshAttemptsWithoutProgress: Math.max(
            state.trackRefreshAttemptsWithoutProgress,
            MAX_SCREEN_SHARE_TRACK_REFRESH_ATTEMPTS,
          ),
          lastRecoveryAtMs: performance.now(),
        };
        console.warn(
          "[Meets] Stalled screen-share republish failed; retrying while capture remains live:",
          error,
        );
      } finally {
        screenProducerTrackRepairInFlightRef.current = false;
      }
    };

    const refreshStalledScreenProducer = async ({
      producer,
      producerTrack,
      sample,
      state,
    }: {
      producer: Producer;
      producerTrack: MediaStreamTrack;
      sample: OutboundVideoProgressSample;
      state: CameraOutboundStallState;
    }) => {
      if (disposed) return;
      if (screenProducerTrackRepairInFlightRef.current) return;
      if (isMediaRecoveryBlocked()) {
        screenOutboundStallStateRef.current = {
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

      const currentScreenTrack = producer.track ?? null;
      const currentScreenTrackLive =
        currentScreenTrack?.readyState === "live" &&
        currentScreenTrack.enabled &&
        !currentScreenTrack.muted;
      const liveScreenTrack =
        getFirstLiveTrack(
          (screenShareStreamRef.current?.getVideoTracks() ?? []).filter(
            (track) =>
              track.id !== currentScreenTrack?.id &&
              track.enabled &&
              !track.muted,
          ),
        ) ??
        (currentScreenTrackLive ? currentScreenTrack : null);
      if (
        !liveScreenTrack ||
        liveScreenTrack.readyState !== "live" ||
        liveScreenTrack.muted
      ) {
        return;
      }

      if (
        getScreenShareStallRecoveryAction(
          state.trackRefreshAttemptsWithoutProgress,
        ) === "republish"
      ) {
        await republishStalledScreenProducer(
          state,
          "persistent sender stall after bounded track refreshes",
        );
        return;
      }

      screenProducerTrackRepairInFlightRef.current = true;
      let detachedForRefresh = false;
      try {
        if (
          disposed ||
          screenProducerRef.current?.id !== producer.id ||
          producer.closed ||
          isMediaRecoveryBlocked()
        ) {
          return;
        }

        if ("contentHint" in liveScreenTrack) {
          liveScreenTrack.contentHint =
            getScreenSharePublishSettings().contentHint;
        }
        await producer.replaceTrack({ track: null });
        detachedForRefresh = true;
        await producer.replaceTrack({ track: liveScreenTrack });
        detachedForRefresh = false;
        await applyScreenShareProducerNetworkProfile(
          producer,
          getScreenSharePublishNetworkProfile(),
          getScreenSharePublishSettings(),
        );
        screenOutboundStallStateRef.current = {
          ...createCameraOutboundStallState(producer.id, liveScreenTrack.id),
          frames: sample.frames,
          bytes: sample.bytes,
          trackRefreshAttemptsWithoutProgress:
            advanceScreenShareTrackRefreshAttempts({
              currentAttempts: state.trackRefreshAttemptsWithoutProgress,
              refreshAttempted: true,
            }),
          lastRecoveryAtMs: now,
        };
        console.warn("[Meets] Refreshed stalled screen-share sender:", {
          producerId: producer.id,
          previousTrackId: producerTrack.id,
          screenTrackId: liveScreenTrack.id,
          stalledSamples: state.stalledSamples,
          frames: sample.frames,
          bytes: sample.bytes,
        });
      } catch (err) {
        if (
          detachedForRefresh &&
          !producer.closed &&
          liveScreenTrack.readyState === "live"
        ) {
          try {
            await producer.replaceTrack({ track: liveScreenTrack });
          } catch {}
        }
        screenOutboundStallStateRef.current = {
          ...state,
          trackRefreshAttemptsWithoutProgress:
            advanceScreenShareTrackRefreshAttempts({
              currentAttempts: state.trackRefreshAttemptsWithoutProgress,
              refreshAttempted: true,
            }),
          lastRecoveryAtMs: performance.now(),
        };
        console.warn(
          "[Meets] Stalled screen-share sender refresh failed; keeping producer open:",
          err,
        );
      } finally {
        screenProducerTrackRepairInFlightRef.current = false;
      }
    };

    const pollOutboundProgress = () => {
      if (disposed) return;
      if (isMediaRecoveryBlocked()) {
        resetStallState();
        return;
      }
      if (screenProducerTrackRepairInFlightRef.current) {
        return;
      }

      const producer = screenProducerRef.current;
      const producerTrack = producer?.track ?? null;
      if (!producer || producer.closed || !producerTrack) {
        const liveScreenTrack = getFirstLiveTrack(
          screenShareStreamRef.current?.getVideoTracks() ?? [],
        );
        const state = screenOutboundStallStateRef.current;
        if (liveScreenTrack && republishScreenShareRef?.current) {
          void republishStalledScreenProducer(
            state,
            state.trackRefreshAttemptsWithoutProgress >=
              MAX_SCREEN_SHARE_TRACK_REFRESH_ATTEMPTS
              ? "missing producer after persistent sender stall"
              : "missing producer with live screen-share capture",
          );
        } else {
          resetStallState();
        }
        return;
      }
      if (producer.paused) {
        resetStallState(producer.id, producerTrack.id);
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
            screenProducerRef.current?.id !== producer.id ||
            producer.closed ||
            producer.paused ||
            producer.track?.id !== producerTrack.id ||
            producerTrack.readyState !== "live" ||
            !producerTrack.enabled ||
            producerTrack.muted
          ) {
            resetStallState(
              screenProducerRef.current?.id ?? null,
              screenProducerRef.current?.track?.id ?? null,
            );
            return;
          }

          const sample = readOutboundVideoProgressSample(report);
          const currentState = screenOutboundStallStateRef.current;
          const previous =
            currentState.producerId === producer.id &&
            currentState.trackId === producerTrack.id
              ? currentState
              : createCameraOutboundStallState(producer.id, producerTrack.id);
          const hasBaseline =
            previous.frames !== null || previous.bytes !== null;
          const hasStallEvidence =
            hasBaseline && hasOutboundScreenShareStallEvidence(previous, sample);
          const hasProgress =
            hasBaseline && hasOutboundVideoProgress(previous, sample);
          const stalledSamples =
            hasStallEvidence
              ? previous.stalledSamples + 1
              : 0;
          const nextState: CameraOutboundStallState = {
            ...previous,
            producerId: producer.id,
            trackId: producerTrack.id,
            frames: sample.frames,
            bytes: sample.bytes,
            stalledSamples,
            trackRefreshAttemptsWithoutProgress:
              advanceScreenShareTrackRefreshAttempts({
                currentAttempts:
                  previous.trackRefreshAttemptsWithoutProgress,
                encodedFrameProgress: hasProgress,
              }),
          };
          screenOutboundStallStateRef.current = nextState;

          if (
            stalledSamples <
              SCREEN_SHARE_OUTBOUND_STALL_SAMPLES_BEFORE_REFRESH ||
            isEncoderLimitedOutboundSample(sample)
          ) {
            return;
          }

          void refreshStalledScreenProducer({
            producer,
            producerTrack,
            sample,
            state: nextState,
          });
        })
        .catch(() => {
          resetStallState(
            screenProducerRef.current?.id ?? null,
            screenProducerRef.current?.track?.id ?? null,
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
    isObserverMode,
    isMediaRecoveryBlocked,
    isScreenSharing,
    getScreenSharePublishNetworkProfile,
    republishScreenShareRef,
    screenProducerRef,
    screenShareStreamRef,
  ]);

  useEffect(() => {
    if (isObserverMode) return;
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
    if (cameraPublishingDisabledRef.current) {
      const currentStream = localStreamRef.current;
      currentStream?.getVideoTracks().forEach((track) => {
        stopLocalTrack(track);
      });
      const remainingTracks =
        currentStream?.getTracks().filter((track) => track.kind !== "video") ??
        [];
      commitLocalStream(new MediaStream(remainingTracks));
      setIsCameraOff(true);
      return;
    }
    if (cameraRecoveryInFlightRef.current) return;

    let createdTrack: MediaStreamTrack | null = null;
    const disableBlockedCameraIntent = () => {
      const currentStream = localStreamRef.current;
      currentStream?.getVideoTracks().forEach((track) => {
        stopLocalTrack(track);
      });
      const remainingTracks =
        currentStream?.getTracks().filter((track) => track.kind !== "video") ??
        [];
      commitLocalStream(new MediaStream(remainingTracks));
      createdTrack = null;
      setIsCameraOff(true);
    };
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

    const claim = claimDevice("video");
    const recoveryHolds = () =>
      claimHolds(claim) &&
      connectionStateRef.current === "joined" &&
      !mediaOperationsDisposedRef.current;
    const recoverCameraProducer = async () => {
      let consumedRecoveryPublishOverride: WebcamCodecRecoveryOverride<
        ReturnType<typeof getPreferredWebcamCodec>
      > | null = null;
      const hadLiveCameraTrackBeforeRecovery =
        localStreamRef.current
          ?.getVideoTracks()
          .some((track) => track.readyState === "live") === true;

      try {
        const existingProducer = videoProducerRef.current;
        if (
          isMediaRecoveryBlocked() ||
          !recoveryHolds() ||
          (existingProducer &&
            !existingProducer.closed &&
            existingProducer.track?.readyState === "live")
        ) {
          return;
        }
        try {
          await prepareCameraProducerTransport();
        } catch {
          console.warn(
            "[Meets] Camera producer recovery waiting for producer transport.",
          );
          return;
        }
        if (!recoveryHolds()) return;

        let videoTrack = getFirstLiveTrack(
          localStreamRef.current?.getVideoTracks() ?? [],
        );

        if (!videoTrack || videoTrack.readyState !== "live") {
          const stream = await getUserMediaWithTimeout(
            { video: buildVideoConstraints() },
            {
              label: "camera producer recovery",
              timeoutMs: MEDIA_CAPTURE_RECOVERY_TIMEOUT_MS,
              generation: claim.generation,
            },
          );
          videoTrack = stream.getVideoTracks()[0] ?? null;
          createdTrack = videoTrack;
        }

        if (!videoTrack) {
          throw new Error("No video track available for recovery");
        }
        if (isMediaRecoveryBlocked() || !recoveryHolds()) {
          removeCreatedTrackFromLocalStream();
          return;
        }

        applyCameraContentHint(videoTrack);
        attachLocalVideoTrackHandlers(videoTrack);
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
        if (!recoveryHolds()) {
          removeCreatedTrackFromLocalStream();
          return;
        }
        attachLocalVideoTrackHandlers(publishTrack);
        const quality = videoQualityRef.current;
        const networkProfile = getPublishNetworkProfile();
        const pendingRecoveryPublishOverride =
          cameraRecoveryPublishOverrideRef.current;
        const recoveryPublishOverride = resolveWebcamCodecRecoveryOverride(
          pendingRecoveryPublishOverride,
          webcamCodecPolicyRef.current,
        );
        if (
          pendingRecoveryPublishOverride &&
          !recoveryPublishOverride &&
          cameraRecoveryPublishOverrideRef.current ===
            pendingRecoveryPublishOverride
        ) {
          cameraRecoveryPublishOverrideRef.current = null;
        }
        consumedRecoveryPublishOverride = recoveryPublishOverride;
        const forceSingleLayer =
          recoveryPublishOverride?.forceSingleLayer ?? false;
        const forceSimulcast =
          recoveryPublishOverride?.forceSimulcast ?? false;
        const preferredWebcamCodec =
          recoveryPublishOverride?.codec ??
          getPreferredWebcamCodec(
            deviceRef.current,
            webcamCodecPolicyRef.current,
          );
        const transport = await prepareCameraProducerTransport();
        const recoveredProducer = await produceCameraTrackWithRawFallback({
          transport,
          publishTrack,
          rawTrack: videoTrack,
          quality,
          networkProfile,
          paused: false,
          preferredCodec: preferredWebcamCodec,
          forceSingleLayer,
          forceSimulcast,
          context: "camera-recovery",
        });

        if (cameraPublishingDisabledRef.current || !recoveryHolds()) {
          socketRef.current?.emit(
            "closeProducer",
            { producerId: recoveredProducer.id },
            () => {},
          );
          try {
            recoveredProducer.close();
          } catch {}
          if (cameraPublishingDisabledRef.current && claimHolds(claim)) {
            disableBlockedCameraIntent();
          } else {
            removeCreatedTrackFromLocalStream();
          }
          return;
        }

        if (
          !installProducer(
            videoProducerRef,
            null,
            recoveredProducer,
            closeLocalVideoProducerForReplacement,
          )
        ) {
          removeCreatedTrackFromLocalStream();
          return;
        }
        vp9ZeroFrameProofRef.current = attachVp9ZeroFrameReproducer(
          vp9ZeroFrameProofRef.current,
          {
            epoch: webcamCodecPolicyRef.current.epoch,
            producerId: recoveredProducer.id,
          },
        );
        createdTrack = null;
        recoveredProducer.on("transportclose", () => {
          if (videoProducerRef.current?.id === recoveredProducer.id) {
            videoProducerRef.current = null;
            requestCameraProducerRecovery();
          }
        });
        setMediaError((current) => clearMediaDeviceError(current, "camera"));
      } catch (err) {
        if (isCaptureReleased(err) || !claimHolds(claim)) {
          removeCreatedTrackFromLocalStream();
          return;
        }
        console.error("[Meets] Camera producer recovery failed:", err);
        if (cameraPublishingDisabledRef.current) {
          disableBlockedCameraIntent();
          return;
        }
        removeCreatedTrackFromLocalStream();
        if (recoveryHolds()) {
          const meetErr = createMeetError(err, "MEDIA_ERROR", "camera");
          if (
            !hadLiveCameraTrackBeforeRecovery &&
            shouldDisableMediaIntentAfterRecoveryFailure(err, meetErr)
          ) {
            setIsCameraOff(true);
          }
          setMediaError((current) => mergeMediaDeviceError(current, meetErr));
        }
      } finally {
        if (
          consumedRecoveryPublishOverride &&
          cameraRecoveryPublishOverrideRef.current ===
            consumedRecoveryPublishOverride
        ) {
          cameraRecoveryPublishOverrideRef.current = null;
        }
        finishCameraRecovery();
      }
    };

    void runCameraTrackOperation(recoverCameraProducer);
  }, [
    isObserverMode,
    connectionState,
    cameraDisabled,
    cameraEnableDisabled,
    cameraProducerRecoveryPulse,
    isCameraOff,
    isMediaRecoveryBlocked,
    attachLocalVideoTrackHandlers,
    handleLocalTrackEnded,
    stopLocalTrack,
    commitLocalStream,
    setLocalStream,
    setIsCameraOff,
    setMeetError,
    setMediaError,
    producerTransportRef,
    ensureProducerTransportRef,
    prepareCameraProducerTransport,
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
    finishCameraRecovery,
    claimDevice,
    claimHolds,
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

  const refreshScreenAudioProducerForNetworkProfile = useCallback(
    async (networkProfile: WebcamProducerNetworkProfile): Promise<boolean> => {
      if (isObserverMode) return false;
      if (screenAudioProducerRefreshInFlightRef.current) return false;
      if (isMediaRecoveryBlocked()) return false;

      const screenStream = screenShareStreamRef.current;
      const videoTrack = getFirstLiveTrack(screenStream?.getVideoTracks() ?? []);
      const audioTrack = getFirstLiveTrack(screenStream?.getAudioTracks() ?? []);
      const screenProducer = screenProducerRef.current;
      const previousProducer = screenAudioProducerRef.current;
      if (
        !screenStream ||
        !videoTrack ||
        !audioTrack ||
        !screenProducer ||
        screenProducer.closed ||
        screenProducer.track?.readyState !== "live" ||
        !previousProducer ||
        previousProducer.closed ||
        previousProducer.track?.readyState !== "live"
      ) {
        return false;
      }

      let transport = getUsableProducerTransport(producerTransportRef.current);
      if (!transport) {
        const transportReady =
          (await ensureProducerTransportRef?.current?.()) ?? false;
        transport = getUsableProducerTransport(producerTransportRef.current);
        if (!transportReady || !transport) {
          return false;
        }
      }

      screenAudioProducerRefreshInFlightRef.current = true;
      intentionalLocalProducerCloseIdsRef.current.add(previousProducer.id);
      let nextProducer: Producer | null = null;

      try {
        if ("contentHint" in audioTrack) {
          audioTrack.contentHint = "music";
        }

        nextProducer = await transport.produce({
          track: audioTrack,
          codecOptions: buildScreenShareAudioOpusCodecOptions(networkProfile),
          stopTracks: false,
          appData: {
            type: "screen" as ProducerType,
            networkProfile,
          } satisfies ScreenAudioProducerAppData,
        });

        try {
          await applyAudioProducerNetworkProfile(
            nextProducer,
            "screen",
            networkProfile,
          );
        } catch (profileErr) {
          console.warn(
            "[Meets] Failed to apply refreshed screen audio network profile:",
            profileErr,
          );
        }

        if (
          screenShareStreamRef.current !== screenStream ||
          screenProducerRef.current?.id !== screenProducer.id ||
          screenProducer.closed ||
          videoTrack.readyState !== "live" ||
          audioTrack.readyState !== "live"
        ) {
          intentionalLocalProducerCloseIdsRef.current.add(nextProducer.id);
          socketRef.current?.emit(
            "closeProducer",
            { producerId: nextProducer.id },
            () => {},
          );
          try {
            nextProducer.close();
          } catch {}
          return false;
        }

        const previousTrack = previousProducer.track;
        if (previousTrack) {
          previousTrack.onended = null;
        }
        screenAudioProducerRef.current = nextProducer;
        const nextProducerId = nextProducer.id;
        nextProducer.on("transportclose", () => {
          if (screenAudioProducerRef.current?.id === nextProducerId) {
            screenAudioProducerRef.current = null;
          }
        });
        audioTrack.onended = () => {
          socketRef.current?.emit(
            "closeProducer",
            { producerId: nextProducerId },
            () => {},
          );
          try {
            nextProducer?.close();
          } catch {}
          if (screenAudioProducerRef.current?.id === nextProducerId) {
            screenAudioProducerRef.current = null;
          }
        };

        if (previousProducer.id !== nextProducerId) {
          socketRef.current?.emit(
            "closeProducer",
            { producerId: previousProducer.id },
            () => {},
          );
          try {
            previousProducer.close();
          } catch {}
        }

        return true;
      } catch (err) {
        intentionalLocalProducerCloseIdsRef.current.delete(previousProducer.id);
        if (nextProducer) {
          intentionalLocalProducerCloseIdsRef.current.add(nextProducer.id);
          socketRef.current?.emit(
            "closeProducer",
            { producerId: nextProducer.id },
            () => {},
          );
          try {
            nextProducer.close();
          } catch {}
        }
        console.warn("[Meets] Failed to refresh screen audio producer:", err);
        return false;
      } finally {
        screenAudioProducerRefreshInFlightRef.current = false;
      }
    },
    [
      isObserverMode,
      isMediaRecoveryBlocked,
      producerTransportRef,
      ensureProducerTransportRef,
      intentionalLocalProducerCloseIdsRef,
      screenAudioProducerRef,
      screenProducerRef,
      screenShareStreamRef,
      socketRef,
    ],
  );

  const clearScreenShareMutedWarningTimer = useCallback((trackId: string) => {
    const timeoutId = screenShareMutedWarningTimeoutsRef.current.get(trackId);
    if (timeoutId === undefined) return;
    window.clearTimeout(timeoutId);
    screenShareMutedWarningTimeoutsRef.current.delete(trackId);
  }, []);

  const clearAllScreenShareMutedWarningTimers = useCallback(() => {
    screenShareMutedWarningTimeoutsRef.current.forEach((timeoutId) => {
      window.clearTimeout(timeoutId);
    });
    screenShareMutedWarningTimeoutsRef.current.clear();
  }, []);

  const clearScreenShareMutedWarningError = useCallback((trackId?: string) => {
    if (
      trackId &&
      screenShareMutedWarningErrorTrackIdRef.current !== trackId
    ) {
      return;
    }
    setMeetError((currentError) => {
      const isScreenShareWarning =
        currentError?.code === "MEDIA_ERROR" &&
        currentError.message === SCREEN_SHARE_SOURCE_STALLED_MESSAGE;
      if (isScreenShareWarning) {
        screenShareMutedWarningErrorTrackIdRef.current = null;
        return null;
      }
      return currentError;
    });
  }, [setMeetError]);

  const isCurrentScreenShareTrack = useCallback(
    (track: MediaStreamTrack): boolean => {
      const currentProducerTrack = screenProducerRef.current?.track ?? null;
      const producerUsesTrack =
        currentProducerTrack === track || currentProducerTrack?.id === track.id;
      const streamUsesTrack =
        screenShareStreamRef.current
          ?.getVideoTracks()
          .some(
            (currentTrack) =>
              currentTrack === track || currentTrack.id === track.id,
          ) === true;
      return producerUsesTrack || streamUsesTrack;
    },
    [screenProducerRef, screenShareStreamRef],
  );

  const reapplyScreenShareProfileAfterSourceResumes = useCallback(
    (track: MediaStreamTrack) => {
      const producer = screenProducerRef.current;
      const producerTrack = producer?.track ?? null;
      if (
        !producer ||
        producer.closed ||
        producerTrack?.readyState !== "live" ||
        (producerTrack !== track && producerTrack?.id !== track.id)
      ) {
        return;
      }

      const screenPublishSettings = getScreenSharePublishSettings();
      if ("contentHint" in track) {
        track.contentHint = screenPublishSettings.contentHint;
      }
      void applyScreenShareProducerNetworkProfile(
        producer,
        getScreenSharePublishNetworkProfile(),
        screenPublishSettings,
      ).catch((error) => {
        console.warn(
          "[Meets] Failed to reapply screen-share profile after source resumed:",
          error,
        );
      });
    },
    [getScreenSharePublishNetworkProfile, screenProducerRef],
  );

  const scheduleScreenShareMutedWarning = useCallback(
    (track: MediaStreamTrack) => {
      if (
        !isScreenSharingRef.current ||
        connectionStateRef.current !== "joined" ||
        isMediaRecoveryBlocked() ||
        track.readyState !== "live" ||
        !track.enabled ||
        !track.muted ||
        !isCurrentScreenShareTrack(track) ||
        screenShareMutedWarningTimeoutsRef.current.has(track.id)
      ) {
        return;
      }

      const timeoutId = window.setTimeout(() => {
        screenShareMutedWarningTimeoutsRef.current.delete(track.id);
        if (
          !isScreenSharingRef.current ||
          connectionStateRef.current !== "joined" ||
          isMediaRecoveryBlocked() ||
          track.readyState !== "live" ||
          !track.enabled ||
          !track.muted ||
          !isCurrentScreenShareTrack(track)
        ) {
          return;
        }

        console.warn(
          "[Meets] Local screen-share source stopped sending frames.",
          {
            producerId: screenProducerRef.current?.id ?? null,
            trackId: track.id,
          },
        );
        screenShareMutedWarningErrorTrackIdRef.current = track.id;
        setMeetError({
          code: "MEDIA_ERROR",
          message: SCREEN_SHARE_SOURCE_STALLED_MESSAGE,
          recoverable: true,
        });
      }, SCREEN_SHARE_MUTED_WARNING_DELAY_MS);

      screenShareMutedWarningTimeoutsRef.current.set(track.id, timeoutId);
    },
    [
      isCurrentScreenShareTrack,
      isMediaRecoveryBlocked,
      screenProducerRef,
      setMeetError,
    ],
  );

  const attachLocalScreenShareTrackHandlers = useCallback(
    (track: MediaStreamTrack) => {
      if (!screenShareTrackHandlersRef.current.has(track)) {
        screenShareTrackHandlersRef.current.add(track);
        track.addEventListener("mute", () => {
          scheduleScreenShareMutedWarning(track);
        });
        track.addEventListener("unmute", () => {
          clearScreenShareMutedWarningTimer(track.id);
          clearScreenShareMutedWarningError(track.id);
          reapplyScreenShareProfileAfterSourceResumes(track);
        });
        track.addEventListener("ended", () => {
          clearScreenShareMutedWarningTimer(track.id);
        });
      }

      if (track.muted) {
        scheduleScreenShareMutedWarning(track);
      }
    },
    [
      clearScreenShareMutedWarningTimer,
      clearScreenShareMutedWarningError,
      reapplyScreenShareProfileAfterSourceResumes,
      scheduleScreenShareMutedWarning,
    ],
  );

  useEffect(() => {
    if (isObserverMode) return;
    if (connectionState !== "joined") return;
    if (!isScreenSharing) return;

    const attachCurrentScreenShareTracks = () => {
      const seenTrackIds = new Set<string>();
      const tracks = [
        ...(screenShareStreamRef.current?.getVideoTracks() ?? []),
        screenProducerRef.current?.track ?? null,
      ];
      for (const track of tracks) {
        if (!track || seenTrackIds.has(track.id)) continue;
        seenTrackIds.add(track.id);
        attachLocalScreenShareTrackHandlers(track);
      }
    };

    attachCurrentScreenShareTracks();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        attachCurrentScreenShareTracks();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    attachLocalScreenShareTrackHandlers,
    connectionState,
    isObserverMode,
    isScreenSharing,
    screenProducerRef,
    screenShareStreamRef,
  ]);

  const toggleScreenShare = useCallback(async () => {
    if (isObserverMode) return;
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
      clearAllScreenShareMutedWarningTimers();
      clearScreenShareMutedWarningError();
      stopScreenShareStream(screenStream);
      screenShareStreamRef.current = null;
      setIsScreenSharing(false);
      setActiveScreenShareId(null);
      return;
    }

    if (screenSharePublishingDisabledRef.current) return;

    if (activeScreenShareId) {
      setMeetError({
        code: "UNKNOWN",
        message: "Someone else is already sharing their screen",
        recoverable: true,
      });
      return;
    }

    if (screenShareStartInFlightRef.current) return;
    screenShareStartInFlightRef.current = true;

    let acquiredScreenShareStream: MediaStream | null = null;
    let screenShareStarted = false;

    try {
      let transport = getUsableProducerTransport(producerTransportRef.current);
      if (!transport) {
        const transportReady =
          (await ensureProducerTransportRef?.current?.()) ?? false;
        if (screenSharePublishingDisabledRef.current) return;
        transport = getUsableProducerTransport(producerTransportRef.current);
        if (!transportReady || !transport) {
          throw new Error("Screen share transport unavailable");
        }
      }

      const screenNetworkProfile = getScreenSharePublishNetworkProfile();
      const screenPublishSettings = getScreenSharePublishSettings();

      let captureController = createCaptureController();
      const generation = captureGeneration();
      const displayVideoConstraints: DisplayMediaVideoConstraints = {
        cursor: screenPublishSettings.cursor,
      };
      const getDisplayMedia = (
        video: DisplayMediaVideoConstraints,
        controller: CaptureControllerLike | null,
      ): Promise<MediaStream> => {
        const options: ExtendedDisplayMediaStreamOptions = {
          video,
          audio: screenPublishSettings.includeAudio,
          monitorTypeSurfaces: "include",
          selfBrowserSurface: "exclude",
          surfaceSwitching: "include",
          ...(screenPublishSettings.includeAudio
            ? { systemAudio: "include" as const }
            : {}),
          ...(controller ? { controller } : {}),
        };
        return captureDisplayMedia(options, generation);
      };

      let stream: MediaStream;
      try {
        stream = await getDisplayMedia(
          displayVideoConstraints,
          captureController,
        );
      } catch (err) {
        if (isCaptureReleased(err) || !isDisplayMediaConstraintRetryableError(err)) {
          throw err;
        }
        captureController = null;
        stream = await getDisplayMedia(displayVideoConstraints, null);
      }
      acquiredScreenShareStream = stream;
      if (screenSharePublishingDisabledRef.current) {
        stopScreenShareStream(stream);
        resetScreenShareControlState();
        return;
      }
      const track = stream.getVideoTracks()[0];
      if (!track) {
        throw new Error("Screen share did not include a video track");
      }
      const displaySurface = getCapturedDisplaySurface(track);
      screenShareCaptureControllerRef.current = captureController;
      setScreenShareControlState(
        createCapturedSurfaceControlState(captureController, displaySurface),
      );
      if (captureController?.setFocusBehavior) {
        try {
          captureController.setFocusBehavior("focus-capturing-application");
        } catch {}
      }
      if (track && "contentHint" in track) {
        track.contentHint = screenPublishSettings.contentHint;
      }
      attachLocalScreenShareTrackHandlers(track);
      await applyScreenShareTrackNetworkProfile(
        track,
        "good",
        screenPublishSettings,
      );
      if (screenSharePublishingDisabledRef.current) {
        stopScreenShareStream(stream);
        resetScreenShareControlState();
        return;
      }

      const preferredScreenShareCodec = getPreferredScreenShareCodec(
        deviceRef.current,
        displaySurface,
      );
      const producer = await produceScreenShareTrack({
        transport,
        track,
        networkProfile: screenNetworkProfile,
        preferredCodec: preferredScreenShareCodec,
        publishSettings: screenPublishSettings,
      });

      if (screenSharePublishingDisabledRef.current) {
        socketRef.current?.emit(
          "closeProducer",
          { producerId: producer.id },
          () => {},
        );
        try {
          producer.close();
        } catch {}
        stopScreenShareStream(stream);
        resetScreenShareControlState();
        return;
      }

      screenShareStreamRef.current = stream;
      screenProducerRef.current = producer;
      setIsScreenSharing(true);
      setActiveScreenShareId(producer.id);
      screenShareStarted = true;
      producer.on("transportclose", () => {
        if (screenProducerRef.current?.id === producer.id) {
          screenProducerRef.current = null;
        }
      });

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
        clearAllScreenShareMutedWarningTimers();
        stopScreenShareStream(screenShareStreamRef.current);
        screenShareStreamRef.current = null;
        clearScreenShareMutedWarningError();
        setIsScreenSharing(false);
        setActiveScreenShareId(null);
      };
      track.onended = finishScreenShare;

      try {
        await applyScreenShareProducerNetworkProfile(
          producer,
          screenNetworkProfile,
          screenPublishSettings,
        );
      } catch (profileErr) {
        console.warn(
          "[Meets] Failed to apply screen video network profile:",
          profileErr,
        );
      }

      if (screenSharePublishingDisabledRef.current) {
        finishScreenShare();
        return;
      }

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack && audioTrack.readyState === "live") {
        try {
          if ("contentHint" in audioTrack) {
            audioTrack.contentHint = "music";
          }
          const audioProducer = await transport.produce({
            track: audioTrack,
            codecOptions: buildScreenShareAudioOpusCodecOptions(
              screenNetworkProfile,
            ),
            stopTracks: false,
            appData: {
              type: "screen" as ProducerType,
              networkProfile: screenNetworkProfile,
            } satisfies ScreenAudioProducerAppData,
          });
          try {
            await applyAudioProducerNetworkProfile(
              audioProducer,
              "screen",
              screenNetworkProfile,
            );
          } catch (profileErr) {
            console.warn(
              "[Meets] Failed to apply screen audio network profile:",
              profileErr,
            );
          }

          if (
            screenSharePublishingDisabledRef.current ||
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
      if (acquiredScreenShareStream && !screenShareStarted) {
        if (screenShareStreamRef.current === acquiredScreenShareStream) {
          screenShareStreamRef.current = null;
        }
        stopScreenShareStream(acquiredScreenShareStream);
        resetScreenShareControlState();
      }
      if ((err as Error).name === "NotAllowedError") {
        console.info("[Meets] Screen share cancelled by user");
      } else {
        console.error("[Meets] Error starting screen share:", err);
        setMeetError(createMeetError(err, "MEDIA_ERROR"));
      }
    } finally {
      screenShareStartInFlightRef.current = false;
    }
  }, [
    isObserverMode,
    isScreenSharing,
    activeScreenShareId,
    setIsScreenSharing,
    setActiveScreenShareId,
    producerTransportRef,
    screenProducerRef,
    screenAudioProducerRef,
    screenShareStreamRef,
    screenShareCaptureControllerRef,
    socketRef,
    setMeetError,
    ensureProducerTransportRef,
    getScreenSharePublishNetworkProfile,
    resetScreenShareControlState,
    attachLocalScreenShareTrackHandlers,
    clearAllScreenShareMutedWarningTimers,
    clearScreenShareMutedWarningError,
    stopScreenShareStream,
    stopLocalTrack,
  ]);

  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream, localStreamRef]);

  return {
    mediaState,
    showPermissionHint,
    screenShareControlState,
    requestMediaPermissions,
    handleAudioInputDeviceChange,
    handleVideoInputDeviceChange,
    handleAudioOutputDeviceChange,
    updateVideoQuality,
    updateVideoQualityRef,
    replaceWebcamProducerTopology,
    requestAudioProducerRecovery,
    requestCameraProducerRecovery,
    prepareAudioPublishTrack,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    stopLocalTrack,
    handleLocalTrackEnded,
    primeAudioOutput,
    playNotificationSound,
    refreshScreenAudioProducerForNetworkProfile,
  };
}
