"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  applyAudioProducerNetworkProfile,
  applyScreenShareProducerNetworkProfile,
  applyWebcamProducerNetworkProfile,
  type WebcamProducerNetworkProfile,
} from "../lib/webcam-codec";
import type { Producer, VideoQuality } from "../lib/types";
import type { ConnectionQuality } from "./useConnectionQuality";

interface UseAdaptivePublishQualityOptions {
  enabled: boolean;
  connectionQuality: ConnectionQuality;
  capRecoveryQuality: ConnectionQuality;
  emergencyMode: boolean;
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

export type AdaptivePublishQualityDebugSnapshot = {
  enabled: boolean;
  timestamp: number;
  connectionQuality: ConnectionQuality;
  capRecoveryQuality: ConnectionQuality;
  emergencyMode: boolean;
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
  return {
    id: producer.id,
    kind: producer.kind,
    closed: producer.closed,
    paused: producer.paused,
    trackId: producer.track?.id ?? null,
    trackReadyState: producer.track?.readyState ?? null,
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

export function useAdaptivePublishQuality({
  enabled,
  connectionQuality,
  capRecoveryQuality,
  emergencyMode,
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
  const lastStandardCaptureRestoreSignatureRef = useRef<string | null>(null);

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
        const signature = `${webcamProducer.id}:${quality}:${profile}`;
        if (lastAppliedProfilesRef.current.webcam !== signature) {
          try {
            await applyWebcamProducerNetworkProfile(
              webcamProducer,
              quality,
              profile,
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
        const signature = `${screenProducer.id}:${profile}`;
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
        if (lastAppliedProfilesRef.current.screenAudio !== signature) {
          try {
            await applyAudioProducerNetworkProfile(
              screenAudioProducer,
              "screen",
              profile,
            );
            lastAppliedProfilesRef.current.screenAudio = signature;
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
      screenAudioProducerRef,
      screenProducerRef,
      videoProducerRef,
      videoQualityRef,
      writeDebugSnapshot,
    ],
  );

  const restoreStandardCaptureIfNeeded = useCallback(async () => {
    if (isCameraOff || updateInFlightRef.current) return;
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

    const signature = `${webcamProducer.id}:standard:good`;
    if (lastStandardCaptureRestoreSignatureRef.current === signature) {
      return;
    }

    updateInFlightRef.current = true;
    try {
      await updateVideoQualityRef.current("standard", "good");
      lastStandardCaptureRestoreSignatureRef.current = signature;
      lastAppliedProfilesRef.current.webcam = signature;
      writeDebugSnapshot();
    } catch (error) {
      console.warn(
        "[Meets] Adaptive standard camera capture restore failed:",
        error,
      );
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
      if (quality === "poor") {
        if (elapsedMs < POOR_LIVE_CAP_AFTER_MS) return null;
        return emergencyMode ? "emergency" : "poor";
      }
      if (quality === "fair") {
        return elapsedMs >= FAIR_LIVE_CAP_AFTER_MS ? "fair" : null;
      }
      if (quality === "good") {
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
      lastStandardCaptureRestoreSignatureRef.current = null;
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
      const applyStableLiveProfile = () => {
        if (liveProfile && !updateInFlightRef.current) {
          void applyLiveProducerProfile(liveProfile);
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
            void applyLiveProducerProfile("good");
          }
        });
      } else {
        applyStableLiveProfile();
      }
      writeDebugSnapshot(now);
    };

    evaluate();
    const interval = window.setInterval(evaluate, CHECK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [
    applyLiveProducerProfile,
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
