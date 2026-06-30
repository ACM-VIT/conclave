"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  applyAudioProducerNetworkProfile,
  applyScreenShareProducerNetworkProfile,
  applyWebcamProducerNetworkProfile,
  type WebcamProducerNetworkProfile,
} from "../lib/webcam-codec";
import {
  getMostConstrainedWebcamProducerNetworkProfile,
  getScreenSharePublishNetworkProfileForAvailableOutgoingBitrate,
} from "../lib/screen-share-network-profile";
import type { Producer, VideoQuality } from "../lib/types";
import type { ConnectionQuality } from "./useConnectionQuality";

interface UseAdaptivePublishQualityOptions {
  enabled: boolean;
  connectionQuality: ConnectionQuality;
  capRecoveryQuality: ConnectionQuality;
  emergencyMode: boolean;
  availableOutgoingBitrateBps?: number | null;
  isCameraOff: boolean;
  participantCount: number;
  audioProducerRef: React.MutableRefObject<Producer | null>;
  videoProducerRef: React.MutableRefObject<Producer | null>;
  screenProducerRef: React.MutableRefObject<Producer | null>;
  screenAudioProducerRef: React.MutableRefObject<Producer | null>;
  videoQualityRef: React.MutableRefObject<VideoQuality>;
  networkManagedVideoQualityRef?: React.MutableRefObject<boolean>;
  setVideoQuality: (value: VideoQuality) => void;
  updateVideoQualityRef: React.MutableRefObject<
    (
      quality: VideoQuality,
      networkProfileOverride?: WebcamProducerNetworkProfile,
    ) => Promise<void>
  >;
  refreshScreenAudioProducerForNetworkProfile?: (
    profile: WebcamProducerNetworkProfile,
  ) => Promise<boolean>;
  debugStateRef?: React.MutableRefObject<
    AdaptivePublishQualityDebugSnapshot | null
  >;
}

const CHECK_INTERVAL_MS = 1000;
const FAIR_DOWNGRADE_AFTER_MS = 12000;
const POOR_DOWNGRADE_AFTER_MS = 4500;
const GOOD_UPGRADE_AFTER_MS = 45000;
const FAIR_LIVE_CAP_AFTER_MS = 5000;
const POOR_LIVE_CAP_AFTER_MS = 2500;
const GOOD_LIVE_RESTORE_AFTER_MS = 15000;
const MAX_AUTO_UPGRADE_PARTICIPANTS = 4;
const STANDARD_CAPTURE_RESTORE_RETRY_MS = 1000;
const STANDARD_CAPTURE_RESTORE_FAILURE_RETRY_MS = 15000;
const STANDARD_CAPTURE_RESTORE_COOLDOWN_MS = 120000;
const STANDARD_CAPTURE_MIN_WIDTH = 960;
const STANDARD_CAPTURE_MIN_HEIGHT = 540;
const STANDARD_CAPTURE_MIN_FRAMERATE = 24;
const SCREEN_AUDIO_CODEC_REFRESH_RETRY_MS = 15000;

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
};

type PublishProducerEncodingDebugSnapshot = {
  rid: string | null;
  active: boolean | null;
  maxBitrate: number | null;
  maxFramerate: number | null;
  scaleResolutionDownBy: number | null;
  priority: RTCPriorityType | null;
  networkPriority: RTCPriorityType | null;
};

const needsStandardCaptureRestore = (track: MediaStreamTrack): boolean => {
  const settings = track.getSettings();
  return (
    (typeof settings.width === "number" &&
      settings.width < STANDARD_CAPTURE_MIN_WIDTH) ||
    (typeof settings.height === "number" &&
      settings.height < STANDARD_CAPTURE_MIN_HEIGHT) ||
    (typeof settings.frameRate === "number" &&
      settings.frameRate < STANDARD_CAPTURE_MIN_FRAMERATE)
  );
};

const getStandardCaptureRestoreSignature = (track: MediaStreamTrack): string => {
  const settings = track.getSettings();
  return [
    "standard",
    "good",
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
  isCameraOff: boolean;
  participantCount: number;
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
    fairLiveCap: number;
    poorLiveCap: number;
    goodLiveRestore: number;
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
      })) ?? [],
    encodings:
      parameters?.encodings?.map((encoding) => ({
        rid: encoding.rid ?? null,
        active: encoding.active ?? null,
        maxBitrate: encoding.maxBitrate ?? null,
        maxFramerate: encoding.maxFramerate ?? null,
        scaleResolutionDownBy: encoding.scaleResolutionDownBy ?? null,
        priority: encoding.priority ?? null,
        networkPriority: encoding.networkPriority ?? null,
      })) ?? [],
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

const getLiveProfileForObservedQuality = (
  quality: ConnectionQuality,
  emergencyMode: boolean,
): WebcamProducerNetworkProfile | null => {
  if (quality === "poor") return emergencyMode ? "emergency" : "poor";
  if (quality === "fair") return "fair";
  if (quality === "good") return "good";
  return null;
};

export function useAdaptivePublishQuality({
  enabled,
  connectionQuality,
  capRecoveryQuality,
  emergencyMode,
  availableOutgoingBitrateBps = null,
  isCameraOff,
  participantCount,
  audioProducerRef,
  videoProducerRef,
  screenProducerRef,
  screenAudioProducerRef,
  videoQualityRef,
  networkManagedVideoQualityRef,
  setVideoQuality,
  updateVideoQualityRef,
  refreshScreenAudioProducerForNetworkProfile,
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
  const autoDowngradedRef = useRef(false);
  const updateInFlightRef = useRef(false);
  const lastAppliedProfilesRef = useRef<{
    audio: string | null;
    webcam: string | null;
    screen: string | null;
    screenAudio: string | null;
  }>({ audio: null, webcam: null, screen: null, screenAudio: null });
  const lastStandardCaptureRestoreAttemptRef = useRef<{
    signature: string;
    at: number;
  } | null>(null);
  const lastScreenAudioCodecRefreshAttemptRef = useRef<{
    signature: string;
    at: number;
  } | null>(null);
  const standardCaptureRestoreRetryTimeoutRef = useRef<number | null>(null);

  const writeDebugSnapshot = useCallback(
    (now = Date.now()) => {
      if (!debugStateRef) return;
      const qualityWindow = qualityWindowRef.current;
      const capRecoveryWindow = capRecoveryWindowRef.current;
      debugStateRef.current = {
        enabled,
        timestamp: now,
        connectionQuality,
        capRecoveryQuality,
        emergencyMode,
        availableOutgoingBitrateBps,
        isCameraOff,
        participantCount,
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
          fairLiveCap: FAIR_LIVE_CAP_AFTER_MS,
          poorLiveCap: POOR_LIVE_CAP_AFTER_MS,
          goodLiveRestore: GOOD_LIVE_RESTORE_AFTER_MS,
        },
      };
    },
    [
      connectionQuality,
      capRecoveryQuality,
      availableOutgoingBitrateBps,
      debugStateRef,
      enabled,
      emergencyMode,
      isCameraOff,
      participantCount,
      networkManagedVideoQualityRef,
      audioProducerRef,
      screenProducerRef,
      screenAudioProducerRef,
      videoProducerRef,
      videoQualityRef,
    ],
  );

  const applyLiveProducerProfile = useCallback(
    async (profile: WebcamProducerNetworkProfile) => {
      const screenShareVideoActive = Boolean(
        screenProducerRef.current && !screenProducerRef.current.closed,
      );
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

      const webcamProducer = videoProducerRef.current;
      if (webcamProducer && !webcamProducer.closed) {
        const quality = videoQualityRef.current;
        const webcamProfile = screenShareVideoActive
          ? getScreenShareAwareWebcamProfile(profile)
          : profile;
        const signature = `${webcamProducer.id}:${quality}:${webcamProfile}`;
        if (lastAppliedProfilesRef.current.webcam !== signature) {
          try {
            await applyWebcamProducerNetworkProfile(
              webcamProducer,
              quality,
              webcamProfile,
            );
            lastAppliedProfilesRef.current.webcam = signature;
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
        const signature = getScreenShareProducerProfileSignature(
          screenProducer,
          profile,
        );
        if (lastAppliedProfilesRef.current.screen !== signature) {
          try {
            await applyScreenShareProducerNetworkProfile(
              screenProducer,
              profile,
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
      audioProducerRef,
      refreshScreenAudioProducerForNetworkProfile,
      screenAudioProducerRef,
      screenProducerRef,
      videoProducerRef,
      videoQualityRef,
      writeDebugSnapshot,
    ],
  );

  const restoreStandardCaptureIfNeeded = useCallback(async () => {
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
        void restoreStandardCaptureIfNeeded();
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
    if (videoQualityRef.current !== "standard") return;

    const webcamProducer = videoProducerRef.current;
    const webcamTrack = webcamProducer?.track ?? null;
    if (
      !webcamProducer ||
      webcamProducer.closed ||
      webcamTrack?.readyState !== "live"
    ) {
      return;
    }

    const signature = getStandardCaptureRestoreSignature(webcamTrack);
    const needsCaptureRestore = needsStandardCaptureRestore(webcamTrack);
    const lastAttempt = lastStandardCaptureRestoreAttemptRef.current;
    if (
      needsCaptureRestore &&
      lastAttempt?.signature === signature &&
      Date.now() - lastAttempt.at < STANDARD_CAPTURE_RESTORE_COOLDOWN_MS
    ) {
      return;
    }

    updateInFlightRef.current = true;
    try {
      if (needsCaptureRestore) {
        lastStandardCaptureRestoreAttemptRef.current = {
          signature,
          at: Date.now(),
        };
        await updateVideoQualityRef.current("standard", "good");
      } else {
        await applyWebcamProducerNetworkProfile(
          webcamProducer,
          "standard",
          "good",
        );
      }
      const activeProducer = videoProducerRef.current;
      const activeTrack = activeProducer?.track ?? null;
      if (activeTrack?.readyState === "live") {
        lastStandardCaptureRestoreAttemptRef.current = {
          signature: getStandardCaptureRestoreSignature(activeTrack),
          at: Date.now(),
        };
      }
      if (activeProducer && !activeProducer.closed) {
        lastAppliedProfilesRef.current.webcam = `${activeProducer.id}:standard:good`;
      }
      writeDebugSnapshot();
    } catch (error) {
      console.warn(
        "[Meets] Adaptive standard camera capture restore failed:",
        error,
      );
      scheduleRestoreRetry(STANDARD_CAPTURE_RESTORE_FAILURE_RETRY_MS);
    } finally {
      updateInFlightRef.current = false;
      writeDebugSnapshot();
    }
  }, [
    isCameraOff,
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

  useEffect(() => {
    if (!enabled) {
      qualityWindowRef.current = {
        quality: connectionQuality,
        since: Date.now(),
      };
      capRecoveryWindowRef.current = {
        quality: capRecoveryQuality,
        since: Date.now(),
      };
      updateInFlightRef.current = false;
      lastAppliedProfilesRef.current = {
        audio: null,
        webcam: null,
        screen: null,
        screenAudio: null,
      };
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
      const previous = qualityWindowRef.current;
      const previousRecovery = capRecoveryWindowRef.current;
      if (previousRecovery.quality !== capRecoveryQuality) {
        capRecoveryWindowRef.current = {
          quality: capRecoveryQuality,
          since: now,
        };
      }
      if (previous.quality !== connectionQuality) {
        qualityWindowRef.current = { quality: connectionQuality, since: now };
        writeDebugSnapshot(now);
        return;
      }

      const elapsedMs = now - previous.since;
      const capRecoveryElapsedMs = now - capRecoveryWindowRef.current.since;
      const currentPublishQuality = videoQualityRef.current;
      const liveProfile =
        getStableLiveProfile(capRecoveryQuality, capRecoveryElapsedMs) ??
        getStableLiveProfile(connectionQuality, elapsedMs);
      const screenShareVideoActive = Boolean(
        screenProducerRef.current && !screenProducerRef.current.closed,
      );
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
      const applyStableLiveProfile = () => {
        const profile = effectiveLiveProfile ?? screenShareImmediateProfile;
        if (profile && !updateInFlightRef.current) {
          void applyLiveProducerProfile(profile);
        }
      };
      const shouldRestoreStableStandardCapture =
        capRecoveryQuality === "good" &&
        capRecoveryElapsedMs >= GOOD_LIVE_RESTORE_AFTER_MS &&
        connectionQuality !== "poor" &&
        currentPublishQuality === "standard";
      if (isCameraOff) {
        applyStableLiveProfile();
        writeDebugSnapshot(now);
        return;
      }

      if (
        currentPublishQuality === "standard" &&
        (connectionQuality === "poor" || connectionQuality === "fair")
      ) {
        const downgradeAfterMs =
          connectionQuality === "poor"
            ? POOR_DOWNGRADE_AFTER_MS
            : FAIR_DOWNGRADE_AFTER_MS;
        if (elapsedMs >= downgradeAfterMs) {
          autoDowngradedRef.current = true;
          void switchQuality("low");
          writeDebugSnapshot(now);
          return;
        }
      }

      if (
        (autoDowngradedRef.current ||
          networkManagedVideoQualityRef?.current === true) &&
        currentPublishQuality === "low" &&
        ((connectionQuality === "good" && elapsedMs >= GOOD_UPGRADE_AFTER_MS) ||
          (capRecoveryQuality === "good" &&
            capRecoveryElapsedMs >= GOOD_UPGRADE_AFTER_MS)) &&
        participantCount <= MAX_AUTO_UPGRADE_PARTICIPANTS &&
        capRecoveryQuality !== "poor"
      ) {
        void switchQuality(
          "standard",
          capRecoveryQuality === "good" &&
            capRecoveryElapsedMs >= GOOD_UPGRADE_AFTER_MS
            ? "good"
            : undefined,
        ).then((switched) => {
          if (!switched) return;
          autoDowngradedRef.current = false;
          if (networkManagedVideoQualityRef) {
            networkManagedVideoQualityRef.current = false;
          }
          writeDebugSnapshot();
        });
        writeDebugSnapshot(now);
        return;
      }
      if (shouldRestoreStableStandardCapture) {
        void restoreStandardCaptureIfNeeded().finally(() => {
          if (!updateInFlightRef.current) {
            void applyLiveProducerProfile(effectiveLiveProfile ?? "good");
          }
        });
      } else {
        applyStableLiveProfile();
      }
      writeDebugSnapshot(now);
    };

    evaluate();
    const interval = window.setInterval(evaluate, CHECK_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
      if (standardCaptureRestoreRetryTimeoutRef.current !== null) {
        window.clearTimeout(standardCaptureRestoreRetryTimeoutRef.current);
        standardCaptureRestoreRetryTimeoutRef.current = null;
      }
    };
  }, [
    applyLiveProducerProfile,
    availableOutgoingBitrateBps,
    capRecoveryQuality,
    connectionQuality,
    enabled,
    emergencyMode,
    getStableLiveProfile,
    isCameraOff,
    networkManagedVideoQualityRef,
    participantCount,
    restoreStandardCaptureIfNeeded,
    switchQuality,
    videoQualityRef,
    writeDebugSnapshot,
  ]);
}
