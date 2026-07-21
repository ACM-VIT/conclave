"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  applyAudioProducerNetworkProfile,
  applyScreenShareProducerNetworkProfile,
  applyWebcamTrackNetworkProfile,
  applyWebcamProducerNetworkProfile,
  getWebcamCaptureFrameRateForNetworkProfile,
  getWebcamProducerTopology,
  type WebcamProducerNetworkProfile,
} from "../lib/webcam-codec";
import {
  getMostConstrainedWebcamProducerNetworkProfile,
  getScreenSharePublishNetworkProfileForAvailableOutgoingBitrate,
} from "../lib/screen-share-network-profile";
import type { Producer, VideoQuality } from "../lib/types";
import {
  selectActiveWebcamReceiverCapacityProof,
  selectStagedWebcamReceiverCapacitySuccessor,
  selectWebcamReceiverCapacityRevocation,
  type ActiveWebcamReceiverCapacityProof,
  type WebcamReceiverCapacityProofCache,
} from "../lib/webcam-receiver-capacity-proof";
import {
  advanceWebcamTopologyTransition,
  createWebcamTopologyTransitionState,
  settleWebcamTopologyTransition,
  type WebcamTopologyReplacementCommand,
  type WebcamTopologyTransitionInput,
} from "../lib/webcam-topology-transition";
import type { ConnectionQuality } from "./useConnectionQuality";
import {
  resolveEffectiveCameraPublishSettings,
  resolveScreenSharePublishSettings,
  type MediaQualitySettings,
  type ResolvedCameraPublishSettings,
} from "../lib/media-quality-settings";
import type {
  WebcamProducerTopologyReplacementRequest,
} from "./useMeetMedia";
import type { WebcamTopologyReplacementResult } from "../lib/webcam-topology-transition";
import {
  createLatestWinsAsyncQueue,
  type LatestWinsAsyncQueue,
} from "../lib/latest-wins-async-queue";

export {
  createLatestWinsAsyncQueue,
  type LatestWinsAsyncQueue,
} from "../lib/latest-wins-async-queue";

interface UseAdaptivePublishQualityOptions {
  enabled: boolean;
  connectionQuality: ConnectionQuality;
  capRecoveryQuality: ConnectionQuality;
  emergencyMode: boolean;
  availableOutgoingBitrateBps?: number | null;
  publishCpuLimited?: boolean;
  dataSaverMode?: boolean;
  /**
   * True only after the sole remote receiver has explicitly reported sustained
   * capacity for the full VP8 layer. Publisher-side health is not sufficient:
   * an asymmetric call can have a healthy uplink and a constrained downlink.
   */
  soleReceiverCapacityProof?: ActiveWebcamReceiverCapacityProof | null;
  receiverCapacityProofCache?: WebcamReceiverCapacityProofCache;
  roomId?: string | null;
  isCameraOff: boolean;
  participantCount: number;
  audioProducerRef: React.MutableRefObject<Producer | null>;
  videoProducerRef: React.MutableRefObject<Producer | null>;
  screenProducerRef: React.MutableRefObject<Producer | null>;
  screenAudioProducerRef: React.MutableRefObject<Producer | null>;
  videoQualityRef: React.MutableRefObject<VideoQuality>;
  localStreamRef?: React.MutableRefObject<MediaStream | null>;
  mediaQualitySettingsRef: React.MutableRefObject<MediaQualitySettings>;
  activeVideoEffectsCount?: number;
  networkManagedVideoQualityRef?: React.MutableRefObject<boolean>;
  setVideoQuality: (value: VideoQuality) => void;
  updateVideoQualityRef: React.MutableRefObject<
    (
      quality: VideoQuality,
      networkProfileOverride?: WebcamProducerNetworkProfile,
      forceCaptureRefresh?: boolean,
    ) => Promise<void>
  >;
  replaceWebcamProducerTopology?: (
    request: WebcamProducerTopologyReplacementRequest,
  ) => Promise<WebcamTopologyReplacementResult>;
  refreshScreenAudioProducerForNetworkProfile?: (
    profile: WebcamProducerNetworkProfile,
  ) => Promise<boolean>;
  producerTransportId?: string | null;
  setProducerTransportNetworkProfile?: (
    profile: WebcamProducerNetworkProfile,
  ) => Promise<ProducerTransportNetworkProfileApplication>;
  requestWebcamProducerKeyFrame?: (producerId: string) => Promise<void>;
  debugStateRef?: React.MutableRefObject<
    AdaptivePublishQualityDebugSnapshot | null
  >;
}

export type ProducerTransportNetworkProfileApplication = {
  transportId: string;
  profile: WebcamProducerNetworkProfile;
  maxIncomingBitrate: number;
};

export type WebcamNetworkProfileAuthority =
  | "producer-transport"
  | "rtp-sender";

export const shouldUseProducerTransportNetworkProfile = ({
  producerTopology,
  screenShareVideoActive,
  publishCpuLimited,
  transportControlAvailable,
  transportControlUnsupported,
  senderParametersPreviouslyMutated,
}: {
  producerTopology: string;
  screenShareVideoActive: boolean;
  publishCpuLimited: boolean;
  transportControlAvailable: boolean;
  transportControlUnsupported: boolean;
  senderParametersPreviouslyMutated: boolean;
}): boolean =>
  producerTopology === "vp8-simulcast" &&
  !screenShareVideoActive &&
  !publishCpuLimited &&
  transportControlAvailable &&
  !transportControlUnsupported &&
  !senderParametersPreviouslyMutated;

const CHECK_INTERVAL_MS = 1000;
const FAIR_DOWNGRADE_AFTER_MS = 12000;
const POOR_DOWNGRADE_AFTER_MS = 4500;
const GOOD_UPGRADE_AFTER_MS = 45000;
const BIDIRECTIONAL_GOOD_UPGRADE_AFTER_MS = 8000;
const CAP_RECOVERY_UPGRADE_AFTER_MS = 2000;
const FAIR_LIVE_CAP_AFTER_MS = 5000;
const POOR_LIVE_CAP_AFTER_MS = 2500;
const GOOD_LIVE_RESTORE_AFTER_MS = 5000;
const CPU_LIVE_CAP_AFTER_MS = 6000;
const CPU_SCREEN_SHARE_POOR_CAP_AFTER_MS = 20000;
const CPU_LIVE_RESTORE_AFTER_MS = 15000;
const MAX_AUTO_UPGRADE_PARTICIPANTS = 4;
const STANDARD_CAPTURE_RESTORE_RETRY_MS = 1000;
const STANDARD_CAPTURE_RESTORE_FAILURE_RETRY_MS = 15000;
const STANDARD_CAPTURE_RESTORE_COOLDOWN_MS = 120000;
const STANDARD_CAPTURE_MIN_WIDTH = 960;
const STANDARD_CAPTURE_MIN_HEIGHT = 540;
const STANDARD_CAPTURE_MIN_FRAMERATE = 24;
const SCREEN_AUDIO_CODEC_REFRESH_RETRY_MS = 15000;
const SINGLE_RECEIVER_TOPOLOGY_STABLE_MS = 1500;

const networkProfileRank: Record<WebcamProducerNetworkProfile, number> = {
  good: 1,
  fair: 2,
  poor: 3,
  emergency: 4,
};

type QualityWindow = {
  quality: ConnectionQuality;
  since: number;
};

type BooleanWindow = {
  value: boolean;
  since: number;
};

type TopologyWindow = {
  signature: string;
  since: number;
};

type StandardCaptureRestoreAttempt = {
  signature: string;
  retryAfter: number;
};

export const hasStableBidirectionalPublishRecovery = ({
  connectionQuality,
  connectionElapsedMs,
  capRecoveryQuality,
  capRecoveryElapsedMs,
}: {
  connectionQuality: ConnectionQuality;
  connectionElapsedMs: number;
  capRecoveryQuality: ConnectionQuality;
  capRecoveryElapsedMs: number;
}): boolean =>
  connectionQuality === "good" &&
  capRecoveryQuality === "good" &&
  connectionElapsedMs >= BIDIRECTIONAL_GOOD_UPGRADE_AFTER_MS &&
  capRecoveryElapsedMs >= BIDIRECTIONAL_GOOD_UPGRADE_AFTER_MS;

export const hasStablePublishCapRecovery = ({
  connectionQuality,
  capRecoveryQuality,
  capRecoveryElapsedMs,
}: {
  connectionQuality: ConnectionQuality;
  capRecoveryQuality: ConnectionQuality;
  capRecoveryElapsedMs: number;
}): boolean =>
  (connectionQuality === "good" || connectionQuality === "fair") &&
  capRecoveryQuality === "good" &&
  capRecoveryElapsedMs >= CAP_RECOVERY_UPGRADE_AFTER_MS;

export const shouldDowngradeStandardPublishQuality = ({
  connectionQuality,
  connectionElapsedMs,
  capRecoveryQuality,
  capRecoveryElapsedMs,
}: {
  connectionQuality: ConnectionQuality;
  connectionElapsedMs: number;
  capRecoveryQuality: ConnectionQuality;
  capRecoveryElapsedMs: number;
}): boolean => {
  if (connectionQuality === "poor") {
    return connectionElapsedMs >= POOR_DOWNGRADE_AFTER_MS;
  }
  if (connectionQuality !== "fair") return false;
  if (
    hasStablePublishCapRecovery({
      connectionQuality,
      capRecoveryQuality,
      capRecoveryElapsedMs,
    })
  ) {
    // A fair score can be self-induced by the active low sender cap. Do not
    // immediately undo a separately proven recovery and create a quality loop.
    return false;
  }
  return connectionElapsedMs >= FAIR_DOWNGRADE_AFTER_MS;
};

export const getAuthoritativeLiveProducerProfile = (
  profiles: readonly (WebcamProducerNetworkProfile | null | undefined)[],
): WebcamProducerNetworkProfile | null =>
  getMostConstrainedWebcamProducerNetworkProfile(
    profiles.map((profile) => profile ?? null),
  );

export const getStandardCaptureRestoreRetryAfter = (
  now: number,
  failed: boolean,
): number =>
  now +
  (failed
    ? STANDARD_CAPTURE_RESTORE_FAILURE_RETRY_MS
    : STANDARD_CAPTURE_RESTORE_COOLDOWN_MS);

export const isStandardCaptureRestoreRetryDue = (
  attempt: StandardCaptureRestoreAttempt | null,
  signature: string,
  now: number,
): boolean =>
  attempt === null ||
  attempt.signature !== signature ||
  now >= attempt.retryAfter;

export const shouldOptimizeVp8ForSingleReceiver = (options: {
  participantCount: number;
  quality: VideoQuality;
  profile: WebcamProducerNetworkProfile;
  dataSaverMode: boolean;
  publishCpuLimited: boolean;
  screenShareVideoActive: boolean;
  soleReceiverFullLayerCapacityProven: boolean;
}): boolean =>
  options.soleReceiverFullLayerCapacityProven &&
  options.participantCount > 0 &&
  options.participantCount <= 2 &&
  options.quality === "standard" &&
  options.profile === "good" &&
  !options.dataSaverMode &&
  !options.publishCpuLimited &&
  !options.screenShareVideoActive;

export const isVp8SingleReceiverTopologyApplied = (
  signature: string | null,
  producerId: string,
): boolean =>
  signature?.startsWith(`${producerId}:`) === true &&
  signature.endsWith(":single-receiver");

export const getImmediateVp8TopologyReversionProfile = (options: {
  appliedSignature: string | null;
  producerId: string;
  optimizeForSingleReceiver: boolean;
  observedProfile: WebcamProducerNetworkProfile | null;
}): WebcamProducerNetworkProfile | null =>
  isVp8SingleReceiverTopologyApplied(
    options.appliedSignature,
    options.producerId,
  ) && !options.optimizeForSingleReceiver
    ? options.observedProfile ?? "good"
    : null;

export const isReceiverCapacityProofUsableForProducer = (
  proof: ActiveWebcamReceiverCapacityProof | null | undefined,
  producerId: string,
  nowMonotonicMs: number,
): boolean =>
  proof?.producerId === producerId &&
  nowMonotonicMs < proof.expiresAtMonotonicMs;

export const hasUsableWebcamSingleLayerReplacementOffer = (
  proof: ActiveWebcamReceiverCapacityProof | null | undefined,
  producerId: string,
  nowMonotonicMs: number,
): boolean =>
  proof?.basis === "simulcast-full-layer" &&
  proof.producerId === producerId &&
  proof.replacementOffer?.target === "vp8-single-layer" &&
  nowMonotonicMs < proof.expiresAtMonotonicMs &&
  nowMonotonicMs < proof.replacementOffer.expiresAtMonotonicMs;

type PublishProducerDebugSnapshot = {
  id: string;
  kind: Producer["kind"];
  closed: boolean;
  paused: boolean;
  trackId: string | null;
  trackReadyState: MediaStreamTrackState | null;
  trackSettings: Record<string, unknown> | null;
  degradationPreference: RTCDegradationPreference | null;
  codecs: PublishProducerCodecDebugSnapshot[];
  encodings: PublishProducerEncodingDebugSnapshot[];
};

type PublishProducerCodecDebugSnapshot = {
  mimeType: string;
  clockRate: number;
  channels: number | null;
  parameters: Record<string, unknown>;
  rtcpFeedback: { type: string; parameter: string | null }[];
};

export type PublishProducerEncodingDebugSnapshot = {
  rid: string | null;
  active: boolean | null;
  maxBitrate: number | null;
  maxFramerate: number | null;
  scaleResolutionDownBy: number | null;
  scalabilityMode: string | null;
  priority: RTCPriorityType | null;
  networkPriority: RTCPriorityType | null;
};

export const getPublishProducerEncodingDebugSnapshot = (
  encoding: RTCRtpEncodingParameters,
): PublishProducerEncodingDebugSnapshot => ({
  rid: encoding.rid ?? null,
  active: encoding.active ?? null,
  maxBitrate: encoding.maxBitrate ?? null,
  maxFramerate: encoding.maxFramerate ?? null,
  scaleResolutionDownBy: encoding.scaleResolutionDownBy ?? null,
  scalabilityMode:
    (
      encoding as RTCRtpEncodingParameters & {
        scalabilityMode?: string;
      }
    ).scalabilityMode ?? null,
  priority: encoding.priority ?? null,
  networkPriority: encoding.networkPriority ?? null,
});

export const getCameraCaptureRestoreMinimums = (
  publishSettings: ResolvedCameraPublishSettings,
) => ({
  width: Math.min(STANDARD_CAPTURE_MIN_WIDTH, publishSettings.width),
  height: Math.min(STANDARD_CAPTURE_MIN_HEIGHT, publishSettings.height),
  frameRate: Math.min(
    STANDARD_CAPTURE_MIN_FRAMERATE,
    publishSettings.frameRate,
  ),
});

export const needsConfiguredCameraCaptureRestore = (
  settings: Pick<MediaTrackSettings, "width" | "height" | "frameRate">,
  publishSettings: ResolvedCameraPublishSettings,
): boolean => {
  const minimums = getCameraCaptureRestoreMinimums(publishSettings);
  return (
    (typeof settings.width === "number" &&
      settings.width < minimums.width) ||
    (typeof settings.height === "number" &&
      settings.height < minimums.height) ||
    (typeof settings.frameRate === "number" &&
      settings.frameRate < minimums.frameRate)
  );
};

const getConfiguredCaptureRestoreSignature = (
  track: MediaStreamTrack,
  quality: VideoQuality,
  publishSettings: ResolvedCameraPublishSettings,
): string => {
  const settings = track.getSettings();
  return [
    quality,
    "good",
    publishSettings.width,
    publishSettings.height,
    publishSettings.frameRate,
    settings.width ?? "unknown-width",
    settings.height ?? "unknown-height",
    settings.frameRate ?? "unknown-fps",
  ].join(":");
};

const getRoundedTrackSetting = (
  value: number | undefined,
  fallback: string,
): number | string =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : fallback;

const getScreenShareProducerProfileSignature = (
  producer: Producer,
  profile: WebcamProducerNetworkProfile,
): string => {
  const track = producer.track ?? null;
  const settings = track?.getSettings();
  return [
    producer.id,
    profile,
    track?.id ?? "no-track",
    track?.readyState ?? "unknown-state",
    getRoundedTrackSetting(settings?.width, "unknown-width"),
    getRoundedTrackSetting(settings?.height, "unknown-height"),
    getRoundedTrackSetting(settings?.frameRate, "unknown-fps"),
  ].join(":");
};

export type AdaptivePublishQualityDebugSnapshot = {
  enabled: boolean;
  timestamp: number;
  connectionQuality: ConnectionQuality;
  capRecoveryQuality: ConnectionQuality;
  emergencyMode: boolean;
  availableOutgoingBitrateBps: number | null;
  publishCpuLimited: boolean;
  dataSaverMode: boolean;
  isCameraOff: boolean;
  participantCount: number;
  receiverCapacityProofProducerId: string | null;
  receiverCapacityProofExpiresAtMonotonicMs: number | null;
  receiverCapacityProofBasis: string | null;
  receiverCapacityHandoffOffered: boolean;
  webcamProducerTopology: string;
  webcamTopologyTransitionPhase: string;
  appliedWebcamNetworkProfile: WebcamProducerNetworkProfile | null;
  webcamNetworkProfileAuthority: WebcamNetworkProfileAuthority | null;
  producerTransportId: string | null;
  producerTransportNetworkProfile: WebcamProducerNetworkProfile | null;
  producerTransportMaxIncomingBitrateBps: number | null;
  videoQuality: VideoQuality;
  networkManagedVideoQuality: boolean;
  autoDowngraded: boolean;
  updateInFlight: boolean;
  qualityWindow: {
    quality: ConnectionQuality;
    since: number;
    elapsedMs: number;
  };
  capRecoveryWindow: {
    quality: ConnectionQuality;
    since: number;
    elapsedMs: number;
  };
  cpuLimitedWindow: {
    value: boolean;
    since: number;
    elapsedMs: number;
  };
  lastAppliedProfiles: {
    audio: string | null;
    webcam: string | null;
    screen: string | null;
    screenAudio: string | null;
  };
  producers: {
    audio: PublishProducerDebugSnapshot | null;
    webcam: PublishProducerDebugSnapshot | null;
    screen: PublishProducerDebugSnapshot | null;
    screenAudio: PublishProducerDebugSnapshot | null;
  };
  thresholdsMs: {
    fairDowngrade: number;
    poorDowngrade: number;
    goodUpgrade: number;
    bidirectionalGoodUpgrade: number;
    capRecoveryUpgrade: number;
    fairLiveCap: number;
    poorLiveCap: number;
    goodLiveRestore: number;
    cpuLiveCap: number;
    cpuScreenSharePoorCap: number;
    cpuLiveRestore: number;
  };
};

const getPublishProducerDebugSnapshot = (
  producer: Producer | null,
): PublishProducerDebugSnapshot | null => {
  if (!producer) return null;
  const parameters = producer.rtpSender?.getParameters();
  let trackSettings: Record<string, unknown> | null = null;
  if (producer.track) {
    try {
      trackSettings = { ...producer.track.getSettings() };
    } catch {
      trackSettings = null;
    }
  }
  return {
    id: producer.id,
    kind: producer.kind,
    closed: producer.closed,
    paused: producer.paused,
    trackId: producer.track?.id ?? null,
    trackReadyState: producer.track?.readyState ?? null,
    trackSettings,
    degradationPreference: parameters?.degradationPreference ?? null,
    codecs:
      producer.rtpParameters.codecs?.map((codec) => ({
        mimeType: codec.mimeType,
        clockRate: codec.clockRate,
        channels: codec.channels ?? null,
        parameters: { ...(codec.parameters ?? {}) },
        rtcpFeedback:
          codec.rtcpFeedback?.map((feedback) => ({
            type: feedback.type,
            parameter: feedback.parameter ?? null,
          })) ?? [],
      })) ?? [],
    encodings:
      parameters?.encodings?.map(getPublishProducerEncodingDebugSnapshot) ?? [],
  };
};

const getScreenShareAwareWebcamProfile = (
  profile: WebcamProducerNetworkProfile,
): WebcamProducerNetworkProfile => {
  if (profile === "good") return "fair";
  if (profile === "fair") return "poor";
  return profile;
};

const isWebcamProducerNetworkProfile = (
  value: unknown,
): value is WebcamProducerNetworkProfile =>
  value === "good" ||
  value === "fair" ||
  value === "poor" ||
  value === "emergency";

const getProducerCreationNetworkProfile = (
  producer: Producer,
): WebcamProducerNetworkProfile | null => {
  const profile = (producer.appData as { networkProfile?: unknown } | undefined)
    ?.networkProfile;
  return isWebcamProducerNetworkProfile(profile) ? profile : null;
};

const isLessConstrainedNetworkProfile = (
  nextProfile: WebcamProducerNetworkProfile,
  previousProfile: WebcamProducerNetworkProfile,
): boolean => networkProfileRank[nextProfile] < networkProfileRank[previousProfile];

export const shouldRequestProducerTransportRecoveryKeyFrame = ({
  previous,
  next,
}: {
  previous: ProducerTransportNetworkProfileApplication | null | undefined;
  next: ProducerTransportNetworkProfileApplication;
}): boolean =>
  previous?.transportId === next.transportId &&
  isLessConstrainedNetworkProfile(next.profile, previous.profile);

export const shouldReleaseProducerTransportProfileBeforeSenderFallback = ({
  applied,
  transportId,
  useTransportAuthority,
}: {
  applied: ProducerTransportNetworkProfileApplication | null | undefined;
  transportId: string | null | undefined;
  useTransportAuthority: boolean;
}): boolean =>
  !useTransportAuthority &&
  Boolean(transportId) &&
  applied?.transportId === transportId &&
  applied?.profile !== "good";

const getLiveProfileForObservedQuality = (
  quality: ConnectionQuality,
  emergencyMode: boolean,
): WebcamProducerNetworkProfile | null => {
  if (quality === "poor") return emergencyMode ? "emergency" : "poor";
  if (quality === "fair") return "fair";
  if (quality === "good") return "good";
  return null;
};

const getCpuLimitedLiveProfile = (
  cpuLimited: boolean,
  elapsedMs: number,
  screenShareVideoActive: boolean,
): WebcamProducerNetworkProfile | null => {
  if (!cpuLimited) {
    return elapsedMs >= CPU_LIVE_RESTORE_AFTER_MS ? "good" : null;
  }
  if (elapsedMs < CPU_LIVE_CAP_AFTER_MS) return null;
  if (
    screenShareVideoActive &&
    elapsedMs >= CPU_SCREEN_SHARE_POOR_CAP_AFTER_MS
  ) {
    return "poor";
  }
  return "fair";
};

export function useAdaptivePublishQuality({
  enabled,
  connectionQuality,
  capRecoveryQuality,
  emergencyMode,
  availableOutgoingBitrateBps = null,
  publishCpuLimited = false,
  dataSaverMode = false,
  soleReceiverCapacityProof = null,
  receiverCapacityProofCache,
  roomId = null,
  isCameraOff,
  participantCount,
  audioProducerRef,
  videoProducerRef,
  screenProducerRef,
  screenAudioProducerRef,
  videoQualityRef,
  localStreamRef,
  mediaQualitySettingsRef,
  activeVideoEffectsCount = 0,
  networkManagedVideoQualityRef,
  setVideoQuality,
  updateVideoQualityRef,
  replaceWebcamProducerTopology,
  refreshScreenAudioProducerForNetworkProfile,
  producerTransportId = null,
  setProducerTransportNetworkProfile,
  requestWebcamProducerKeyFrame,
  debugStateRef,
}: UseAdaptivePublishQualityOptions) {
  const qualityWindowRef = useRef<QualityWindow>({
    quality: "unknown",
    since: Date.now(),
  });
  const capRecoveryWindowRef = useRef<QualityWindow>({
    quality: "unknown",
    since: Date.now(),
  });
  const cpuLimitedWindowRef = useRef<BooleanWindow>({
    value: false,
    since: Date.now(),
  });
  const topologyWindowRef = useRef<TopologyWindow>({
    signature: "none",
    since: Date.now(),
  });
  const topologyTransitionStateRef = useRef(
    createWebcamTopologyTransitionState(
      typeof performance === "undefined" ? 0 : performance.now(),
    ),
  );
  const autoDowngradedRef = useRef(false);
  const updateInFlightRef = useRef(false);
  const lastAppliedProfilesRef = useRef<{
    audio: string | null;
    webcam: string | null;
    screen: string | null;
    screenAudio: string | null;
  }>({ audio: null, webcam: null, screen: null, screenAudio: null });
  const lastAppliedWebcamProfileRef = useRef<{
    producerId: string;
    profile: WebcamProducerNetworkProfile;
  } | null>(null);
  const webcamNetworkProfileAuthorityRef =
    useRef<WebcamNetworkProfileAuthority | null>(null);
  const producerTransportProfileSupportRef = useRef<{
    transportId: string;
    status: "supported" | "unsupported";
  } | null>(null);
  const appliedProducerTransportProfileRef =
    useRef<ProducerTransportNetworkProfileApplication | null>(null);
  const senderParametersMutatedProducerIdRef = useRef<string | null>(null);
  const lastStandardCaptureRestoreAttemptRef =
    useRef<StandardCaptureRestoreAttempt | null>(null);
  const lastScreenAudioCodecRefreshAttemptRef = useRef<{
    signature: string;
    at: number;
  } | null>(null);
  const standardCaptureRestoreRetryTimeoutRef = useRef<number | null>(null);
  const cameraCaptureCadenceApplicationRef = useRef<{
    signature: string;
    retryAfter: number;
  } | null>(null);

  const writeDebugSnapshot = useCallback(
    (now = Date.now()) => {
      if (!debugStateRef) return;
      const qualityWindow = qualityWindowRef.current;
      const capRecoveryWindow = capRecoveryWindowRef.current;
      const cpuLimitedWindow = cpuLimitedWindowRef.current;
      debugStateRef.current = {
        enabled,
        timestamp: now,
        connectionQuality,
        capRecoveryQuality,
        emergencyMode,
        availableOutgoingBitrateBps,
        publishCpuLimited,
        dataSaverMode,
        isCameraOff,
        participantCount,
        receiverCapacityProofProducerId:
          soleReceiverCapacityProof?.producerId ?? null,
        receiverCapacityProofExpiresAtMonotonicMs:
          soleReceiverCapacityProof?.expiresAtMonotonicMs ?? null,
        receiverCapacityProofBasis:
          soleReceiverCapacityProof?.basis ?? null,
        receiverCapacityHandoffOffered: Boolean(
          soleReceiverCapacityProof?.replacementOffer,
        ),
        webcamProducerTopology: getWebcamProducerTopology(
          videoProducerRef.current,
        ),
        webcamTopologyTransitionPhase:
          topologyTransitionStateRef.current.phase.kind,
        appliedWebcamNetworkProfile:
          lastAppliedWebcamProfileRef.current?.producerId ===
          videoProducerRef.current?.id
            ? (lastAppliedWebcamProfileRef.current?.profile ?? null)
            : null,
        webcamNetworkProfileAuthority:
          lastAppliedWebcamProfileRef.current?.producerId ===
          videoProducerRef.current?.id
            ? webcamNetworkProfileAuthorityRef.current
            : null,
        producerTransportId,
        producerTransportNetworkProfile:
          appliedProducerTransportProfileRef.current?.transportId ===
          producerTransportId
            ? appliedProducerTransportProfileRef.current.profile
            : null,
        producerTransportMaxIncomingBitrateBps:
          appliedProducerTransportProfileRef.current?.transportId ===
          producerTransportId
            ? appliedProducerTransportProfileRef.current.maxIncomingBitrate
            : null,
        videoQuality: videoQualityRef.current,
        networkManagedVideoQuality:
          networkManagedVideoQualityRef?.current === true,
        autoDowngraded: autoDowngradedRef.current,
        updateInFlight: updateInFlightRef.current,
        qualityWindow: {
          ...qualityWindow,
          elapsedMs: Math.max(0, now - qualityWindow.since),
        },
        capRecoveryWindow: {
          ...capRecoveryWindow,
          elapsedMs: Math.max(0, now - capRecoveryWindow.since),
        },
        cpuLimitedWindow: {
          ...cpuLimitedWindow,
          elapsedMs: Math.max(0, now - cpuLimitedWindow.since),
        },
        lastAppliedProfiles: { ...lastAppliedProfilesRef.current },
        producers: {
          audio: getPublishProducerDebugSnapshot(audioProducerRef.current),
          webcam: getPublishProducerDebugSnapshot(videoProducerRef.current),
          screen: getPublishProducerDebugSnapshot(screenProducerRef.current),
          screenAudio: getPublishProducerDebugSnapshot(
            screenAudioProducerRef.current,
          ),
        },
        thresholdsMs: {
          fairDowngrade: FAIR_DOWNGRADE_AFTER_MS,
          poorDowngrade: POOR_DOWNGRADE_AFTER_MS,
          goodUpgrade: GOOD_UPGRADE_AFTER_MS,
          bidirectionalGoodUpgrade: BIDIRECTIONAL_GOOD_UPGRADE_AFTER_MS,
          capRecoveryUpgrade: CAP_RECOVERY_UPGRADE_AFTER_MS,
          fairLiveCap: FAIR_LIVE_CAP_AFTER_MS,
          poorLiveCap: POOR_LIVE_CAP_AFTER_MS,
          goodLiveRestore: GOOD_LIVE_RESTORE_AFTER_MS,
          cpuLiveCap: CPU_LIVE_CAP_AFTER_MS,
          cpuScreenSharePoorCap: CPU_SCREEN_SHARE_POOR_CAP_AFTER_MS,
          cpuLiveRestore: CPU_LIVE_RESTORE_AFTER_MS,
        },
      };
    },
    [
      connectionQuality,
      capRecoveryQuality,
      availableOutgoingBitrateBps,
      dataSaverMode,
      publishCpuLimited,
      debugStateRef,
      enabled,
      emergencyMode,
      isCameraOff,
      participantCount,
      producerTransportId,
      soleReceiverCapacityProof,
      networkManagedVideoQualityRef,
      audioProducerRef,
      screenProducerRef,
      screenAudioProducerRef,
      videoProducerRef,
      videoQualityRef,
    ],
  );

  const canUseProducerTransportProfile = useCallback(
    (webcamProducer: Producer, screenShareVideoActive: boolean): boolean => {
      const support = producerTransportProfileSupportRef.current;
      return shouldUseProducerTransportNetworkProfile({
        producerTopology: getWebcamProducerTopology(webcamProducer),
        screenShareVideoActive,
        publishCpuLimited,
        transportControlAvailable: Boolean(
          producerTransportId && setProducerTransportNetworkProfile,
        ),
        transportControlUnsupported:
          support?.transportId === producerTransportId &&
          support.status === "unsupported",
        senderParametersPreviouslyMutated:
          senderParametersMutatedProducerIdRef.current === webcamProducer.id,
      });
    },
    [
      producerTransportId,
      publishCpuLimited,
      setProducerTransportNetworkProfile,
    ],
  );

  const applyLiveProducerProfile = useCallback(
    async (profile: WebcamProducerNetworkProfile) => {
      const screenShareVideoActive = Boolean(
        screenProducerRef.current && !screenProducerRef.current.closed,
      );
      const webcamProducer = videoProducerRef.current;
      const webcamQuality = videoQualityRef.current;
      const webcamProfile = screenShareVideoActive
        ? getScreenShareAwareWebcamProfile(profile)
        : profile;
      const cameraPublishSettings = resolveEffectiveCameraPublishSettings(
        mediaQualitySettingsRef.current.camera,
        activeVideoEffectsCount > 0,
      );
      const rawCameraTrack =
        localStreamRef?.current
          ?.getVideoTracks()
          .find((track) => track.readyState === "live") ??
        webcamProducer?.track ??
        null;
      if (webcamProducer && !webcamProducer.closed && rawCameraTrack) {
        const targetFrameRate = getWebcamCaptureFrameRateForNetworkProfile(
          webcamProfile,
          cameraPublishSettings,
        );
        const cadenceSignature = `${rawCameraTrack.id}:${webcamProfile}:${targetFrameRate}`;
        const previousCadenceApplication =
          cameraCaptureCadenceApplicationRef.current;
        if (
          previousCadenceApplication?.signature !== cadenceSignature ||
          Date.now() >= previousCadenceApplication.retryAfter
        ) {
          try {
            await applyWebcamTrackNetworkProfile(
              rawCameraTrack,
              webcamProfile,
              cameraPublishSettings,
            );
            cameraCaptureCadenceApplicationRef.current = {
              signature: cadenceSignature,
              retryAfter: Number.POSITIVE_INFINITY,
            };
          } catch (error) {
            cameraCaptureCadenceApplicationRef.current = {
              signature: cadenceSignature,
              retryAfter: Date.now() + STANDARD_CAPTURE_RESTORE_FAILURE_RETRY_MS,
            };
            console.debug(
              "[Meets] Adaptive camera capture cadence cap was not applied:",
              error,
            );
          }
        }
      }
      const useProducerTransportAuthority = Boolean(
        webcamProducer &&
          !webcamProducer.closed &&
          canUseProducerTransportProfile(
            webcamProducer,
            screenShareVideoActive,
          ) &&
          producerTransportId &&
          setProducerTransportNetworkProfile,
      );
      if (
        useProducerTransportAuthority &&
        webcamProducer &&
        producerTransportId &&
        setProducerTransportNetworkProfile
      ) {
        const existingSupport = producerTransportProfileSupportRef.current;
        const wasSupported =
          existingSupport?.transportId === producerTransportId &&
          existingSupport.status === "supported";
        try {
          const previousAppliedTransportProfile =
            appliedProducerTransportProfileRef.current;
          const applied =
            await setProducerTransportNetworkProfile(profile);
          if (
            applied.transportId !== producerTransportId ||
            applied.profile !== profile ||
            !Number.isFinite(applied.maxIncomingBitrate) ||
            applied.maxIncomingBitrate <= 0
          ) {
            throw new Error("Invalid producer transport profile acknowledgement");
          }
          producerTransportProfileSupportRef.current = {
            transportId: producerTransportId,
            status: "supported",
          };
          appliedProducerTransportProfileRef.current = applied;
          webcamNetworkProfileAuthorityRef.current = "producer-transport";
          lastAppliedProfilesRef.current.webcam =
            `${webcamProducer.id}:${webcamQuality}:${webcamProfile}:adaptive-layers:${cameraPublishSettings.maxBitrate}:${cameraPublishSettings.frameRate}:${cameraPublishSettings.degradationPreference}`;
          lastAppliedWebcamProfileRef.current = {
            producerId: webcamProducer.id,
            profile: webcamProfile,
          };
          const audioProducer = audioProducerRef.current;
          if (audioProducer && !audioProducer.closed) {
            lastAppliedProfilesRef.current.audio =
              `${audioProducer.id}:${profile}:producer-transport`;
          }
          writeDebugSnapshot();
          if (
            requestWebcamProducerKeyFrame &&
            shouldRequestProducerTransportRecoveryKeyFrame({
              previous: previousAppliedTransportProfile,
              next: applied,
            })
          ) {
            void requestWebcamProducerKeyFrame(webcamProducer.id).catch(
              (error) => {
                console.warn(
                  "[Meets] Producer transport recovery key-frame request failed:",
                  error,
                );
              },
            );
          }
          return;
        } catch (error) {
          console.warn(
            "[Meets] Adaptive producer transport bitrate budget failed:",
            error,
          );
          if (wasSupported) {
            // A server that already acknowledged this protocol remains the
            // authority. Preserve its last safe ceiling and retry later rather
            // than freezing every RID with an emergency sender mutation.
            lastAppliedProfilesRef.current.webcam = null;
            writeDebugSnapshot();
            return;
          }
          producerTransportProfileSupportRef.current = {
            transportId: producerTransportId,
            status: "unsupported",
          };
        }
      }

      const previousAppliedTransportProfile =
        appliedProducerTransportProfileRef.current;
      const existingTransportSupport =
        producerTransportProfileSupportRef.current;
      if (
        producerTransportId &&
        setProducerTransportNetworkProfile &&
        existingTransportSupport?.transportId === producerTransportId &&
        existingTransportSupport.status === "supported" &&
        shouldReleaseProducerTransportProfileBeforeSenderFallback({
          applied: previousAppliedTransportProfile,
          transportId: producerTransportId,
          useTransportAuthority: useProducerTransportAuthority,
        })
      ) {
        try {
          const released =
            await setProducerTransportNetworkProfile("good");
          if (
            released.transportId !== producerTransportId ||
            released.profile !== "good" ||
            !Number.isFinite(released.maxIncomingBitrate) ||
            released.maxIncomingBitrate <= 0
          ) {
            throw new Error(
              "Invalid producer transport release acknowledgement",
            );
          }
          appliedProducerTransportProfileRef.current = released;
          // The sender-specific path below now owns the media allocation. Its
          // signature must be reapplied even when the requested profile string
          // matches the former aggregate transport profile.
          lastAppliedProfilesRef.current.webcam = null;
          writeDebugSnapshot();
          if (
            webcamProducer &&
            requestWebcamProducerKeyFrame &&
            shouldRequestProducerTransportRecoveryKeyFrame({
              previous: previousAppliedTransportProfile,
              next: released,
            })
          ) {
            void requestWebcamProducerKeyFrame(webcamProducer.id).catch(
              (error) => {
                console.warn(
                  "[Meets] Producer transport release key-frame request failed:",
                  error,
                );
              },
            );
          }
        } catch (error) {
          // A previously acknowledged SFU remains authoritative. Do not claim
          // sender ownership while a stale aggregate ceiling may still be in
          // force; retain the safe ceiling and retry on the next evaluation.
          console.warn(
            "[Meets] Producer transport release before sender fallback failed:",
            error,
          );
          lastAppliedProfilesRef.current.webcam = null;
          writeDebugSnapshot();
          return;
        }
      }

      const audioProducer = audioProducerRef.current;
      if (audioProducer && !audioProducer.closed) {
        const signature = `${audioProducer.id}:${profile}`;
        if (lastAppliedProfilesRef.current.audio !== signature) {
          try {
            await applyAudioProducerNetworkProfile(
              audioProducer,
              "webcam",
              profile,
            );
            lastAppliedProfilesRef.current.audio = signature;
            writeDebugSnapshot();
          } catch (error) {
            console.warn("[Meets] Adaptive mic bitrate cap failed:", error);
          }
        }
      }

      if (webcamProducer && !webcamProducer.closed) {
        const nowMonotonicMs = performance.now();
        const hasNegotiatedReplacementOffer =
          hasUsableWebcamSingleLayerReplacementOffer(
            soleReceiverCapacityProof,
            webcamProducer.id,
            nowMonotonicMs,
          );
        const optimizeForSingleReceiver =
          !hasNegotiatedReplacementOffer &&
          shouldOptimizeVp8ForSingleReceiver({
            participantCount,
            quality: webcamQuality,
            profile: webcamProfile,
            dataSaverMode,
            publishCpuLimited,
            screenShareVideoActive,
            soleReceiverFullLayerCapacityProven:
              soleReceiverCapacityProof?.basis ===
                "simulcast-full-layer" &&
              isReceiverCapacityProofUsableForProducer(
                soleReceiverCapacityProof,
                webcamProducer.id,
                nowMonotonicMs,
              ),
          });
        const topologyMode = optimizeForSingleReceiver
          ? "single-receiver"
          : "adaptive-layers";
        const signature = `${webcamProducer.id}:${webcamQuality}:${webcamProfile}:${topologyMode}:${cameraPublishSettings.maxBitrate}:${cameraPublishSettings.frameRate}:${cameraPublishSettings.degradationPreference}`;
        if (lastAppliedProfilesRef.current.webcam !== signature) {
          try {
            await applyWebcamProducerNetworkProfile(
              webcamProducer,
              webcamQuality,
              webcamProfile,
              {
                optimizeForSingleReceiver,
                publishSettings: cameraPublishSettings,
              },
            );
            lastAppliedProfilesRef.current.webcam = signature;
            lastAppliedWebcamProfileRef.current = {
              producerId: webcamProducer.id,
              profile: webcamProfile,
            };
            webcamNetworkProfileAuthorityRef.current = "rtp-sender";
            senderParametersMutatedProducerIdRef.current = webcamProducer.id;
            writeDebugSnapshot();
          } catch (error) {
            console.warn(
              "[Meets] Adaptive webcam bitrate cap failed:",
              error,
            );
          }
        }
      }

      const screenProducer = screenProducerRef.current;
      if (screenProducer && !screenProducer.closed) {
        const screenPublishSettings = resolveScreenSharePublishSettings(
          mediaQualitySettingsRef.current.screenShare,
        );
        const profileSignature = getScreenShareProducerProfileSignature(
          screenProducer,
          profile,
        );
        const signature = `${profileSignature}:${screenPublishSettings.maxBitrate}:${screenPublishSettings.frameRate}:${screenPublishSettings.maxWidth}x${screenPublishSettings.maxHeight}:${screenPublishSettings.degradationPreference}`;
        if (lastAppliedProfilesRef.current.screen !== signature) {
          try {
            await applyScreenShareProducerNetworkProfile(
              screenProducer,
              profile,
              screenPublishSettings,
            );
            lastAppliedProfilesRef.current.screen = signature;
            writeDebugSnapshot();
          } catch (error) {
            console.warn(
              "[Meets] Adaptive screen-share bitrate cap failed:",
              error,
            );
          }
        }
      }

      const screenAudioProducer = screenAudioProducerRef.current;
      if (screenAudioProducer && !screenAudioProducer.closed) {
        const signature = `${screenAudioProducer.id}:${profile}`;
        const creationProfile =
          getProducerCreationNetworkProfile(screenAudioProducer);
        const codecRefreshSignature = creationProfile
          ? `${screenAudioProducer.id}:${creationProfile}->${profile}`
          : null;
        const now = Date.now();
        const lastCodecRefreshAttempt =
          lastScreenAudioCodecRefreshAttemptRef.current;
        const shouldRefreshCodecProfile =
          Boolean(refreshScreenAudioProducerForNetworkProfile) &&
          Boolean(codecRefreshSignature) &&
          creationProfile !== null &&
          isLessConstrainedNetworkProfile(profile, creationProfile) &&
          (!lastCodecRefreshAttempt ||
            lastCodecRefreshAttempt.signature !== codecRefreshSignature ||
            now - lastCodecRefreshAttempt.at >=
              SCREEN_AUDIO_CODEC_REFRESH_RETRY_MS);
        if (
          lastAppliedProfilesRef.current.screenAudio !== signature ||
          shouldRefreshCodecProfile
        ) {
          try {
            if (lastAppliedProfilesRef.current.screenAudio !== signature) {
              await applyAudioProducerNetworkProfile(
                screenAudioProducer,
                "screen",
                profile,
              );
              lastAppliedProfilesRef.current.screenAudio = signature;
            }
            if (
              shouldRefreshCodecProfile &&
              codecRefreshSignature &&
              refreshScreenAudioProducerForNetworkProfile
            ) {
              lastScreenAudioCodecRefreshAttemptRef.current = {
                signature: codecRefreshSignature,
                at: now,
              };
              const refreshed =
                await refreshScreenAudioProducerForNetworkProfile(profile);
              const refreshedProducer = screenAudioProducerRef.current;
              if (refreshed && refreshedProducer && !refreshedProducer.closed) {
                lastAppliedProfilesRef.current.screenAudio =
                  `${refreshedProducer.id}:${profile}`;
                lastScreenAudioCodecRefreshAttemptRef.current = null;
              }
            }
            writeDebugSnapshot();
          } catch (error) {
            console.warn(
              "[Meets] Adaptive screen-audio bitrate cap failed:",
              error,
            );
          }
        }
      }
    },
    [
      activeVideoEffectsCount,
      audioProducerRef,
      canUseProducerTransportProfile,
      producerTransportId,
      refreshScreenAudioProducerForNetworkProfile,
      requestWebcamProducerKeyFrame,
      screenAudioProducerRef,
      screenProducerRef,
      videoProducerRef,
      videoQualityRef,
      mediaQualitySettingsRef,
      writeDebugSnapshot,
      dataSaverMode,
      localStreamRef,
      participantCount,
      publishCpuLimited,
      soleReceiverCapacityProof,
      setProducerTransportNetworkProfile,
    ],
  );

  const applyLiveProducerProfileRef = useRef(applyLiveProducerProfile);
  const liveProducerProfileQueueRef =
    useRef<LatestWinsAsyncQueue<WebcamProducerNetworkProfile> | null>(null);

  useEffect(() => {
    applyLiveProducerProfileRef.current = applyLiveProducerProfile;
  }, [applyLiveProducerProfile]);

  useEffect(() => {
    const queue = createLatestWinsAsyncQueue(
      (profile: WebcamProducerNetworkProfile) =>
        applyLiveProducerProfileRef.current(profile),
      (error) => {
        console.warn("[Meets] Adaptive producer profile queue failed:", error);
      },
    );
    liveProducerProfileQueueRef.current = queue;
    return () => {
      queue.clearPending();
      if (liveProducerProfileQueueRef.current === queue) {
        liveProducerProfileQueueRef.current = null;
      }
    };
  }, []);

  const requestLiveProducerProfile = useCallback(
    (profile: WebcamProducerNetworkProfile) => {
      void liveProducerProfileQueueRef.current?.request(profile);
    },
    [],
  );

  const restoreConfiguredCaptureIfNeeded = useCallback(async () => {
    const scheduleRestoreRetry = (
      delayMs = STANDARD_CAPTURE_RESTORE_RETRY_MS,
    ) => {
      if (
        typeof window === "undefined" ||
        standardCaptureRestoreRetryTimeoutRef.current !== null
      ) {
        return;
      }
      standardCaptureRestoreRetryTimeoutRef.current = window.setTimeout(() => {
        standardCaptureRestoreRetryTimeoutRef.current = null;
        void restoreConfiguredCaptureIfNeeded();
      }, delayMs);
    };

    if (isCameraOff) return;
    if (
      typeof document !== "undefined" &&
      document.visibilityState !== "visible"
    ) {
      return;
    }
    if (updateInFlightRef.current) {
      scheduleRestoreRetry();
      return;
    }
    const webcamProducer = videoProducerRef.current;
    const producerTrack = webcamProducer?.track ?? null;
    const rawCaptureTrack =
      localStreamRef?.current
        ?.getVideoTracks()
        .find((track) => track.readyState === "live") ?? null;
    const captureTrack = rawCaptureTrack ?? producerTrack;
    if (
      !webcamProducer ||
      webcamProducer.closed ||
      captureTrack?.readyState !== "live"
    ) {
      return;
    }

    const currentQuality = videoQualityRef.current;
    const publishSettings = resolveEffectiveCameraPublishSettings(
      mediaQualitySettingsRef.current.camera,
      activeVideoEffectsCount > 0,
    );
    const signature = getConfiguredCaptureRestoreSignature(
      captureTrack,
      currentQuality,
      publishSettings,
    );
    const needsCaptureRestore = needsConfiguredCameraCaptureRestore(
      captureTrack.getSettings(),
      publishSettings,
    );
    if (!needsCaptureRestore) return;
    const now = Date.now();
    if (
      !isStandardCaptureRestoreRetryDue(
        lastStandardCaptureRestoreAttemptRef.current,
        signature,
        now,
      )
    ) {
      return;
    }

    if (standardCaptureRestoreRetryTimeoutRef.current !== null) {
      window.clearTimeout(standardCaptureRestoreRetryTimeoutRef.current);
      standardCaptureRestoreRetryTimeoutRef.current = null;
    }
    updateInFlightRef.current = true;
    try {
      lastStandardCaptureRestoreAttemptRef.current = {
        signature,
        retryAfter: getStandardCaptureRestoreRetryAfter(now, false),
      };
      await updateVideoQualityRef.current(currentQuality, "good", true);
      const activeProducer = videoProducerRef.current;
      const activeRawTrack =
        localStreamRef?.current
          ?.getVideoTracks()
          .find((track) => track.readyState === "live") ?? null;
      const activeTrack = activeRawTrack ?? activeProducer?.track ?? null;
      if (activeTrack?.readyState === "live") {
        const activeQuality = videoQualityRef.current;
        const activePublishSettings = resolveEffectiveCameraPublishSettings(
          mediaQualitySettingsRef.current.camera,
          activeVideoEffectsCount > 0,
        );
        lastStandardCaptureRestoreAttemptRef.current = {
          signature: getConfiguredCaptureRestoreSignature(
            activeTrack,
            activeQuality,
            activePublishSettings,
          ),
          retryAfter: getStandardCaptureRestoreRetryAfter(Date.now(), false),
        };
      }
      if (activeProducer && !activeProducer.closed) {
        // The topology suffix depends on live participant and pressure state;
        // let the next evaluation write the authoritative signature.
        lastAppliedProfilesRef.current.webcam = null;
        lastAppliedWebcamProfileRef.current = null;
      }
      writeDebugSnapshot();
    } catch (error) {
      lastStandardCaptureRestoreAttemptRef.current = {
        signature,
        retryAfter: getStandardCaptureRestoreRetryAfter(Date.now(), true),
      };
      console.warn(
        "[Meets] Adaptive configured camera capture restore failed:",
        error,
      );
      scheduleRestoreRetry(STANDARD_CAPTURE_RESTORE_FAILURE_RETRY_MS);
    } finally {
      updateInFlightRef.current = false;
      writeDebugSnapshot();
    }
  }, [
    activeVideoEffectsCount,
    isCameraOff,
    localStreamRef,
    mediaQualitySettingsRef,
    updateVideoQualityRef,
    videoProducerRef,
    videoQualityRef,
    writeDebugSnapshot,
  ]);

  const switchQuality = useCallback(
    async (
      quality: VideoQuality,
      networkProfileOverride?: WebcamProducerNetworkProfile,
    ): Promise<boolean> => {
      if (updateInFlightRef.current) return false;
      const previousQuality = videoQualityRef.current;
      if (previousQuality === quality) return true;

      updateInFlightRef.current = true;
      try {
        await updateVideoQualityRef.current(quality, networkProfileOverride);
        videoQualityRef.current = quality;
        setVideoQuality(quality);
        if (networkManagedVideoQualityRef) {
          networkManagedVideoQualityRef.current = quality === "low";
        }
        lastAppliedProfilesRef.current.webcam = null;
        lastAppliedWebcamProfileRef.current = null;
        writeDebugSnapshot();
        return true;
      } catch (error) {
        console.warn("[Meets] Adaptive publish quality update failed:", error);
        videoQualityRef.current = previousQuality;
        setVideoQuality(previousQuality);
        if (networkManagedVideoQualityRef) {
          networkManagedVideoQualityRef.current = previousQuality === "low";
        }
        return false;
      } finally {
        updateInFlightRef.current = false;
        writeDebugSnapshot();
      }
    },
    [
      setVideoQuality,
      updateVideoQualityRef,
      networkManagedVideoQualityRef,
      videoQualityRef,
      writeDebugSnapshot,
    ],
  );

  const getStableLiveProfile = useCallback(
    (
      quality: ConnectionQuality,
      elapsedMs: number,
    ): WebcamProducerNetworkProfile | null => {
      const profile = getLiveProfileForObservedQuality(quality, emergencyMode);
      if (profile === "poor" || profile === "emergency") {
        if (elapsedMs < POOR_LIVE_CAP_AFTER_MS) return null;
        return profile;
      }
      if (profile === "fair") {
        return elapsedMs >= FAIR_LIVE_CAP_AFTER_MS ? "fair" : null;
      }
      if (profile === "good") {
        return elapsedMs >= GOOD_LIVE_RESTORE_AFTER_MS ? "good" : null;
      }
      return null;
    },
    [emergencyMode],
  );

  const getWebcamTopologyTransitionInput = useCallback(
    (): WebcamTopologyTransitionInput => {
      const nowMonotonicMs = performance.now();
      const producer = videoProducerRef.current;
      const producerId = producer?.id ?? null;
      const phase = topologyTransitionStateRef.current.phase;
      const sourceProducerId =
        phase.kind === "entering" || phase.kind === "awaiting-proof"
          ? phase.fromProducerId
          : producerId;
      const transitionNonce =
        phase.kind === "entering" || phase.kind === "awaiting-proof"
          ? phase.nonce
          : null;
      const currentProof = receiverCapacityProofCache
        ? selectActiveWebcamReceiverCapacityProof(
            receiverCapacityProofCache,
            { roomId, producerId },
            nowMonotonicMs,
          )
        : soleReceiverCapacityProof?.producerId === producerId
          ? soleReceiverCapacityProof
          : null;
      const sourceProof = receiverCapacityProofCache
        ? selectActiveWebcamReceiverCapacityProof(
            receiverCapacityProofCache,
            { roomId, producerId: sourceProducerId },
            nowMonotonicMs,
          )
        : soleReceiverCapacityProof?.producerId === sourceProducerId
          ? soleReceiverCapacityProof
          : null;
      const successorProof =
        receiverCapacityProofCache && sourceProducerId && transitionNonce
          ? selectStagedWebcamReceiverCapacitySuccessor(
              receiverCapacityProofCache,
              {
                roomId,
                replacesProducerId: sourceProducerId,
                transitionNonce,
                nowMonotonicMs,
              },
            )
          : null;
      const sourceRevocation = receiverCapacityProofCache
        ? selectWebcamReceiverCapacityRevocation(
            receiverCapacityProofCache,
            roomId,
            sourceProducerId,
          )
        : null;
      const currentRevocation = receiverCapacityProofCache
        ? selectWebcamReceiverCapacityRevocation(
            receiverCapacityProofCache,
            roomId,
            producerId,
          )
        : null;
      const screenShareVideoActive = Boolean(
        screenProducerRef.current && !screenProducerRef.current.closed,
      );
      const observedProfile = getLiveProfileForObservedQuality(
        connectionQuality,
        emergencyMode,
      );
      const hardSingleReceiverConditionsMet =
        enabled &&
        !isCameraOff &&
        participantCount === 2 &&
        videoQualityRef.current === "standard" &&
        observedProfile === "good" &&
        capRecoveryQuality !== "poor" &&
        !dataSaverMode &&
        !publishCpuLimited &&
        !screenShareVideoActive;

      return {
        now: nowMonotonicMs,
        producerId,
        producerTopology: getWebcamProducerTopology(producer),
        hardSingleReceiverConditionsMet,
        sourceProofActive:
          sourceProof?.basis === "simulcast-full-layer" &&
          nowMonotonicMs < sourceProof.expiresAtMonotonicMs,
        sourceRevocationReason: sourceRevocation?.reason ?? null,
        replacementOffer:
          sourceProof?.basis === "simulcast-full-layer" &&
          sourceProof.replacementOffer?.target === "vp8-single-layer" &&
          nowMonotonicMs <
            sourceProof.replacementOffer.expiresAtMonotonicMs
            ? {
                nonce: sourceProof.replacementOffer.nonce,
                expiresAtMonotonicMs:
                  sourceProof.replacementOffer.expiresAtMonotonicMs,
              }
            : null,
        successorProof:
          successorProof &&
          (successorProof.basis === "single-layer-transition" ||
            successorProof.basis === "single-layer")
            ? {
                producerId: successorProof.producerId,
                expiresAtMonotonicMs: successorProof.expiresAtMonotonicMs,
              }
            : null,
        currentSingleProofActive:
          currentProof !== null &&
          (currentProof.basis === "single-layer-transition" ||
            currentProof.basis === "single-layer") &&
          nowMonotonicMs < currentProof.expiresAtMonotonicMs,
        currentSingleProofRevocationReason:
          currentRevocation?.reason ?? null,
      };
    },
    [
      capRecoveryQuality,
      connectionQuality,
      dataSaverMode,
      emergencyMode,
      enabled,
      isCameraOff,
      participantCount,
      publishCpuLimited,
      receiverCapacityProofCache,
      roomId,
      screenProducerRef,
      soleReceiverCapacityProof,
      videoProducerRef,
      videoQualityRef,
    ],
  );

  const getWebcamTopologyTransitionInputRef = useRef(
    getWebcamTopologyTransitionInput,
  );
  useEffect(() => {
    getWebcamTopologyTransitionInputRef.current =
      getWebcamTopologyTransitionInput;
  }, [getWebcamTopologyTransitionInput]);

  const executeWebcamTopologyCommandRef = useRef<
    (command: WebcamTopologyReplacementCommand) => void
  >(() => {});
  const executeWebcamTopologyCommand = useCallback(
    (command: WebcamTopologyReplacementCommand) => {
      const replace = replaceWebcamProducerTopology;
      const observedProfile = getLiveProfileForObservedQuality(
        connectionQuality,
        emergencyMode,
      );
      const screenShareVideoActive = Boolean(
        screenProducerRef.current && !screenProducerRef.current.closed,
      );
      const baseProfile = observedProfile ?? "good";
      const networkProfile = screenShareVideoActive
        ? getScreenShareAwareWebcamProfile(baseProfile)
        : baseProfile;
      const request: WebcamProducerTopologyReplacementRequest = {
        target: command.target,
        expectedProducerId: command.expectedProducerId,
        quality: videoQualityRef.current,
        networkProfile,
        ...(command.transition
          ? { transition: { ...command.transition } }
          : {}),
      };
      const operation = replace
        ? replace(request)
        : Promise.resolve<WebcamTopologyReplacementResult>({
            status: "failed",
            producerId: videoProducerRef.current?.id ?? null,
            topology: getWebcamProducerTopology(videoProducerRef.current),
            retryable: false,
            error: new Error("Webcam topology replacement is unavailable"),
          });
      void operation
        .catch(
          (error): WebcamTopologyReplacementResult => ({
            status: "failed",
            producerId: videoProducerRef.current?.id ?? null,
            topology: getWebcamProducerTopology(videoProducerRef.current),
            retryable: true,
            error,
          }),
        )
        .then((result) => {
          const input = getWebcamTopologyTransitionInputRef.current();
          const step = settleWebcamTopologyTransition(
            topologyTransitionStateRef.current,
            command,
            result,
            input,
          );
          topologyTransitionStateRef.current = step.state;
          writeDebugSnapshot();
          if (step.command) {
            executeWebcamTopologyCommandRef.current(step.command);
          }
        });
    },
    [
      connectionQuality,
      emergencyMode,
      replaceWebcamProducerTopology,
      screenProducerRef,
      videoProducerRef,
      videoQualityRef,
      writeDebugSnapshot,
    ],
  );
  useEffect(() => {
    executeWebcamTopologyCommandRef.current = executeWebcamTopologyCommand;
  }, [executeWebcamTopologyCommand]);

  const evaluateWebcamTopologyTransition = useCallback(() => {
    const input = getWebcamTopologyTransitionInput();
    const step = advanceWebcamTopologyTransition(
      topologyTransitionStateRef.current,
      input,
    );
    topologyTransitionStateRef.current = step.state;
    if (step.command) {
      executeWebcamTopologyCommandRef.current(step.command);
    }
  }, [getWebcamTopologyTransitionInput]);

  useEffect(() => {
    if (!enabled) {
      const now = Date.now();
      qualityWindowRef.current = {
        quality: connectionQuality,
        since: now,
      };
      capRecoveryWindowRef.current = {
        quality: capRecoveryQuality,
        since: now,
      };
      cpuLimitedWindowRef.current = {
        value: publishCpuLimited,
        since: now,
      };
      updateInFlightRef.current = false;
      topologyTransitionStateRef.current =
        createWebcamTopologyTransitionState(
          typeof performance === "undefined" ? 0 : performance.now(),
        );
      lastAppliedProfilesRef.current = {
        audio: null,
        webcam: null,
        screen: null,
        screenAudio: null,
      };
      lastAppliedWebcamProfileRef.current = null;
      webcamNetworkProfileAuthorityRef.current = null;
      producerTransportProfileSupportRef.current = null;
      appliedProducerTransportProfileRef.current = null;
      senderParametersMutatedProducerIdRef.current = null;
      liveProducerProfileQueueRef.current?.clearPending();
      lastStandardCaptureRestoreAttemptRef.current = null;
      if (standardCaptureRestoreRetryTimeoutRef.current !== null) {
        window.clearTimeout(standardCaptureRestoreRetryTimeoutRef.current);
        standardCaptureRestoreRetryTimeoutRef.current = null;
      }
      writeDebugSnapshot();
      return;
    }

    const evaluate = () => {
      const now = Date.now();
      evaluateWebcamTopologyTransition();
      const previous = qualityWindowRef.current;
      const previousRecovery = capRecoveryWindowRef.current;
      const previousCpuLimited = cpuLimitedWindowRef.current;
      if (previousRecovery.quality !== capRecoveryQuality) {
        capRecoveryWindowRef.current = {
          quality: capRecoveryQuality,
          since: now,
        };
      }
      if (previousCpuLimited.value !== publishCpuLimited) {
        cpuLimitedWindowRef.current = {
          value: publishCpuLimited,
          since: now,
        };
      }
      if (previous.quality !== connectionQuality) {
        qualityWindowRef.current = { quality: connectionQuality, since: now };
        writeDebugSnapshot(now);
      }

      const elapsedMs = now - qualityWindowRef.current.since;
      const capRecoveryElapsedMs = now - capRecoveryWindowRef.current.since;
      const cpuLimitedElapsedMs = now - cpuLimitedWindowRef.current.since;
      const currentPublishQuality = videoQualityRef.current;
      const screenShareVideoActive = Boolean(
        screenProducerRef.current && !screenProducerRef.current.closed,
      );
      const topologyProfile = getLiveProfileForObservedQuality(
        connectionQuality,
        emergencyMode,
      );
      let topologyProfileToApply: WebcamProducerNetworkProfile | null = null;
      const webcamProducer = videoProducerRef.current;
      if (webcamProducer && !webcamProducer.closed) {
        const quality = videoQualityRef.current;
        const safeTopologyProfile = topologyProfile ?? "good";
        const webcamProfile = screenShareVideoActive
          ? getScreenShareAwareWebcamProfile(safeTopologyProfile)
          : safeTopologyProfile;
        const nowMonotonicMs = performance.now();
        const hasNegotiatedReplacementOffer =
          hasUsableWebcamSingleLayerReplacementOffer(
            soleReceiverCapacityProof,
            webcamProducer.id,
            nowMonotonicMs,
          );
        const optimizeForSingleReceiver =
          topologyProfile !== null &&
          !hasNegotiatedReplacementOffer &&
          !canUseProducerTransportProfile(
            webcamProducer,
            screenShareVideoActive,
          ) &&
          shouldOptimizeVp8ForSingleReceiver({
            participantCount,
            quality,
            profile: webcamProfile,
            dataSaverMode,
            publishCpuLimited,
            screenShareVideoActive,
            soleReceiverFullLayerCapacityProven:
              soleReceiverCapacityProof?.basis ===
                "simulcast-full-layer" &&
              isReceiverCapacityProofUsableForProducer(
                soleReceiverCapacityProof,
                webcamProducer.id,
                nowMonotonicMs,
              ),
          });
        const immediateTopologyReversionProfile =
          getImmediateVp8TopologyReversionProfile({
            appliedSignature: lastAppliedProfilesRef.current.webcam,
            producerId: webcamProducer.id,
            optimizeForSingleReceiver,
            observedProfile: topologyProfile,
          });
        const topologySignature = [
          webcamProducer.id,
          quality,
          webcamProfile,
          optimizeForSingleReceiver ? "single-receiver" : "adaptive-layers",
        ].join(":");
        if (immediateTopologyReversionProfile) {
          // Proof expiry, a new participant, screen sharing, or pressure must
          // restore receiver-adaptive layers immediately. Entry is hysteretic;
          // exit is fail-safe and still works before RTC quality is known.
          topologyWindowRef.current = {
            signature: topologySignature,
            since: now,
          };
          topologyProfileToApply = immediateTopologyReversionProfile;
        } else if (topologyWindowRef.current.signature !== topologySignature) {
          topologyWindowRef.current = {
            signature: topologySignature,
            since: now,
          };
        } else if (
          now - topologyWindowRef.current.since >=
            SINGLE_RECEIVER_TOPOLOGY_STABLE_MS &&
          lastAppliedProfilesRef.current.webcam !== topologySignature
        ) {
          topologyProfileToApply = safeTopologyProfile;
        }
      }
      if (dataSaverMode) {
        const dataSaverProfile: WebcamProducerNetworkProfile = emergencyMode
          ? "emergency"
          : "poor";
        autoDowngradedRef.current = true;
        // Data saver is a transport policy, not a user-facing capture-quality
        // choice. Preserve the live track, producer, and simulcast topology;
        // only constrain the existing sender encoders.
        requestLiveProducerProfile(dataSaverProfile);
        writeDebugSnapshot(now);
        return;
      }
      const connectionLiveProfile =
        getStableLiveProfile(capRecoveryQuality, capRecoveryElapsedMs) ??
        getStableLiveProfile(connectionQuality, elapsedMs);
      const cpuLimitedProfile = getCpuLimitedLiveProfile(
        publishCpuLimited,
        cpuLimitedElapsedMs,
        screenShareVideoActive,
      );
      const liveProfile = getMostConstrainedWebcamProducerNetworkProfile([
        connectionLiveProfile,
        cpuLimitedProfile,
      ]);
      const screenShareTargetProfile = screenShareVideoActive
        ? getMostConstrainedWebcamProducerNetworkProfile([
            liveProfile,
            !liveProfile
              ? getLiveProfileForObservedQuality(
                  connectionQuality,
                  emergencyMode,
                )
              : null,
            !liveProfile
              ? getLiveProfileForObservedQuality(
                  capRecoveryQuality,
                  emergencyMode,
                )
              : null,
            getScreenSharePublishNetworkProfileForAvailableOutgoingBitrate(
              availableOutgoingBitrateBps,
              emergencyMode,
            ),
          ]) ?? (!liveProfile ? "good" : null)
        : null;
      const effectiveLiveProfile = screenShareVideoActive
        ? screenShareTargetProfile
        : liveProfile;
      const screenShareImmediateProfile =
        screenShareVideoActive && !liveProfile
          ? screenShareTargetProfile ?? "good"
          : null;
      const authoritativeLiveProfile = getAuthoritativeLiveProducerProfile([
        effectiveLiveProfile ?? screenShareImmediateProfile,
        topologyProfileToApply,
      ]);
      const applyAuthoritativeLiveProfile = () => {
        if (authoritativeLiveProfile && !updateInFlightRef.current) {
          requestLiveProducerProfile(authoritativeLiveProfile);
        }
      };
      const shouldRestoreStableConfiguredCapture =
        capRecoveryQuality === "good" &&
        capRecoveryElapsedMs >= GOOD_LIVE_RESTORE_AFTER_MS &&
        connectionQuality !== "poor";
      if (isCameraOff) {
        applyAuthoritativeLiveProfile();
        writeDebugSnapshot(now);
        return;
      }

      if (
        currentPublishQuality === "standard" &&
        shouldDowngradeStandardPublishQuality({
          connectionQuality,
          connectionElapsedMs: elapsedMs,
          capRecoveryQuality,
          capRecoveryElapsedMs,
        })
      ) {
        autoDowngradedRef.current = true;
        // Automatic network adaptation must not replace the capture track or
        // change a three-RID sender into the two-RID low-quality topology. The
        // authoritative live profile already contains the survival caps.
        applyAuthoritativeLiveProfile();
        writeDebugSnapshot(now);
        return;
      }

      const hasFastRecoveryProof =
        hasStableBidirectionalPublishRecovery({
          connectionQuality,
          connectionElapsedMs: elapsedMs,
          capRecoveryQuality,
          capRecoveryElapsedMs,
        }) ||
        hasStablePublishCapRecovery({
          connectionQuality,
          capRecoveryQuality,
          capRecoveryElapsedMs,
        });
      const canRecoverAutomaticPressure =
        (hasFastRecoveryProof ||
          (connectionQuality === "good" && elapsedMs >= GOOD_UPGRADE_AFTER_MS) ||
          (capRecoveryQuality === "good" &&
            capRecoveryElapsedMs >= GOOD_UPGRADE_AFTER_MS)) &&
        participantCount <= MAX_AUTO_UPGRADE_PARTICIPANTS &&
        capRecoveryQuality !== "poor";
      if (
        networkManagedVideoQualityRef?.current === true &&
        currentPublishQuality === "low" &&
        canRecoverAutomaticPressure
      ) {
        // A low capture selected during startup predates the live producer and
        // genuinely needs one restore. This is distinct from live adaptation,
        // which is profile-only and never enters this branch.
        void switchQuality(
          "standard",
          hasFastRecoveryProof ||
            (capRecoveryQuality === "good" &&
              capRecoveryElapsedMs >= GOOD_UPGRADE_AFTER_MS)
            ? "good"
            : undefined,
        ).then((switched) => {
          if (!switched) return;
          autoDowngradedRef.current = false;
          if (networkManagedVideoQualityRef) {
            networkManagedVideoQualityRef.current = false;
          }
          if (authoritativeLiveProfile) {
            requestLiveProducerProfile(authoritativeLiveProfile);
          }
          writeDebugSnapshot();
        });
        writeDebugSnapshot(now);
        return;
      }
      if (autoDowngradedRef.current && canRecoverAutomaticPressure) {
        autoDowngradedRef.current = false;
        requestLiveProducerProfile(authoritativeLiveProfile ?? "good");
        writeDebugSnapshot(now);
        return;
      }
      if (shouldRestoreStableConfiguredCapture) {
        void restoreConfiguredCaptureIfNeeded().finally(() => {
          if (!updateInFlightRef.current) {
            requestLiveProducerProfile(authoritativeLiveProfile ?? "good");
          }
        });
      } else {
        applyAuthoritativeLiveProfile();
      }
      writeDebugSnapshot(now);
    };

    evaluate();
    const interval = window.setInterval(evaluate, CHECK_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
      liveProducerProfileQueueRef.current?.clearPending();
      if (standardCaptureRestoreRetryTimeoutRef.current !== null) {
        window.clearTimeout(standardCaptureRestoreRetryTimeoutRef.current);
        standardCaptureRestoreRetryTimeoutRef.current = null;
      }
    };
  }, [
    availableOutgoingBitrateBps,
    capRecoveryQuality,
    canUseProducerTransportProfile,
    connectionQuality,
    dataSaverMode,
    enabled,
    emergencyMode,
    evaluateWebcamTopologyTransition,
    getStableLiveProfile,
    isCameraOff,
    networkManagedVideoQualityRef,
    participantCount,
    publishCpuLimited,
    requestLiveProducerProfile,
    restoreConfiguredCaptureIfNeeded,
    soleReceiverCapacityProof,
    switchQuality,
    videoQualityRef,
    writeDebugSnapshot,
  ]);
}
