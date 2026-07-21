"use client";

import { useRef } from "react";
import type { Socket } from "socket.io-client";
import type { Device } from "mediasoup-client";
import type {
  AudioAnalyserEntry,
  Consumer,
  JoinMode,
  Producer,
  ProducerInfo,
  ProducerMapEntry,
  Transport,
  VideoQuality,
  WebcamCodecPolicy,
} from "../lib/types";
import { BASELINE_WEBCAM_CODEC_POLICY } from "../lib/webcam-codec-policy";
import type { CaptureControllerLike } from "../lib/captured-surface-control";
import { getOrCreateSessionId } from "../lib/utils";

type ConsumerTelemetryLayerPreference = {
  spatialLayer: number;
  temporalLayer?: number;
};

export type ConsumerTelemetrySnapshot = {
  event: string;
  roomId?: string;
  userId?: string;
  consumerId: string;
  producerId: string;
  kind: "audio" | "video";
  score: unknown;
  paused: boolean;
  producerPaused: boolean;
  priority: number;
  preferredLayers?: ConsumerTelemetryLayerPreference;
  currentLayers?: ConsumerTelemetryLayerPreference;
  timestamp?: number;
  receivedAt: number;
};

export type ConsumerGenerationResetDebugRecord = {
  producerId: string;
  previousConsumerId: string;
  replacementConsumerId: string | null;
  reason: "startup-simulcast-jitter-reset";
  status:
    | "waiting-for-high-layer"
    | "queued"
    | "replacing"
    | "verifying"
    | "retry-wait"
    | "completed"
    | "failed"
    | "cancelled";
  startedAt: number;
  replacementStartedAt: number | null;
  completedAt: number | null;
  attempt: number;
  maximumSpatialLayer: number;
  observedSpatialLayer: number | null;
  failureReason: string | null;
};

export type AdaptiveVideoReceiverLifecycleEvent =
  | {
      type: "added";
      producerId: string;
      consumer: Consumer;
      info: ProducerMapEntry;
    }
  | {
      type: "removing";
      producerId: string;
      consumer: Consumer;
    };

export function useMeetRefs() {
  const socketRef = useRef<Socket | null>(null);
  const deviceRef = useRef<Device | null>(null);
  const producerTransportRef = useRef<Transport | null>(null);
  const consumerTransportRef = useRef<Transport | null>(null);
  const audioProducerRef = useRef<Producer | null>(null);
  const videoProducerRef = useRef<Producer | null>(null);
  const screenProducerRef = useRef<Producer | null>(null);
  const screenAudioProducerRef = useRef<Producer | null>(null);
  const screenShareStreamRef = useRef<MediaStream | null>(null);
  const screenShareCaptureControllerRef =
    useRef<CaptureControllerLike | null>(null);
  const intentionalLocalProducerCloseIdsRef = useRef<Set<string>>(new Set());
  const consumersRef = useRef<Map<string, Consumer>>(new Map());
  const adaptivelyPausedConsumerProducerIdsRef = useRef<Set<string>>(
    new Set(),
  );
  const consumerTelemetryRef = useRef<Map<string, ConsumerTelemetrySnapshot>>(
    new Map(),
  );
  const consumerGenerationResetDebugRef = useRef<
    ConsumerGenerationResetDebugRecord[]
  >([]);
  const adaptiveVideoReceiverLifecycleRef = useRef<
    (event: AdaptiveVideoReceiverLifecycleEvent) => void
  >(() => {});
  const producerMapRef = useRef<Map<string, ProducerMapEntry>>(new Map());
  const pendingProducersRef = useRef<Map<string, ProducerInfo>>(new Map());
  const leaveTimeoutsRef = useRef<Map<string, number>>(new Map());
  const intentionalTrackStopsRef = useRef<WeakSet<MediaStreamTrack>>(
    new WeakSet()
  );
  const permissionHintTimeoutRef = useRef<number | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectInFlightRef = useRef(false);
  const intentionalDisconnectRef = useRef(false);
  const videoQualityRef = useRef<VideoQuality>("standard");
  const webcamCodecPolicyRef = useRef<WebcamCodecPolicy>({
    ...BASELINE_WEBCAM_CODEC_POLICY,
  });
  const currentRoomIdRef = useRef<string | null>(null);
  const handleRedirectRef = useRef<(roomId: string) => Promise<void>>(
    async () => {}
  );
  const handleReconnectRef = useRef<() => void | Promise<void>>(
    async () => {},
  );
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioAnalyserMapRef = useRef<Map<string, AudioAnalyserEntry>>(
    new Map()
  );
  const lastActiveSpeakerRef = useRef<{ id: string; ts: number } | null>(null);
  const shouldAutoJoinRef = useRef(false);
  const joinOptionsRef = useRef<{
    displayName?: string;
    isRecorder?: boolean;
    joinMode: JoinMode;
    webinarInviteCode?: string;
    meetingInviteCode?: string;
  }>({
    displayName: undefined,
    joinMode: "meeting",
  });
  const isChatOpenRef = useRef(false);
  const localStreamRef = useRef<MediaStream | null>(null);
  const prejoinMediaIntentRef = useRef<{
    streamId: string | null;
    trackIds: Set<string>;
    isCameraOn: boolean;
    isMicOn: boolean;
  } | null>(null);
  const processedVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const sessionIdRef = useRef<string>(getOrCreateSessionId());
  const isHandRaisedRef = useRef(false);
  const producerTransportDisconnectTimeoutRef = useRef<number | null>(null);
  const consumerTransportDisconnectTimeoutRef = useRef<number | null>(null);
  const pendingProducerRetryTimeoutRef = useRef<number | null>(null);
  const iceRestartInFlightRef = useRef({
    producer: false,
    consumer: false,
  });
  const producerSyncIntervalRef = useRef<number | null>(null);

  return {
    socketRef,
    deviceRef,
    producerTransportRef,
    consumerTransportRef,
    audioProducerRef,
    videoProducerRef,
    screenProducerRef,
    screenAudioProducerRef,
    screenShareStreamRef,
    screenShareCaptureControllerRef,
    intentionalLocalProducerCloseIdsRef,
    consumersRef,
    adaptivelyPausedConsumerProducerIdsRef,
    consumerTelemetryRef,
    consumerGenerationResetDebugRef,
    adaptiveVideoReceiverLifecycleRef,
    producerMapRef,
    pendingProducersRef,
    leaveTimeoutsRef,
    intentionalTrackStopsRef,
    permissionHintTimeoutRef,
    localVideoRef,
    abortControllerRef,
    reconnectAttemptsRef,
    reconnectInFlightRef,
    intentionalDisconnectRef,
    videoQualityRef,
    webcamCodecPolicyRef,
    currentRoomIdRef,
    handleRedirectRef,
    handleReconnectRef,
    audioContextRef,
    audioAnalyserMapRef,
    lastActiveSpeakerRef,
    shouldAutoJoinRef,
    joinOptionsRef,
    isChatOpenRef,
    localStreamRef,
    prejoinMediaIntentRef,
    processedVideoTrackRef,
    sessionIdRef,
    isHandRaisedRef,
    producerTransportDisconnectTimeoutRef,
    consumerTransportDisconnectTimeoutRef,
    pendingProducerRetryTimeoutRef,
    iceRestartInFlightRef,
    producerSyncIntervalRef,
  };
}

export type MeetRefs = ReturnType<typeof useMeetRefs>;
