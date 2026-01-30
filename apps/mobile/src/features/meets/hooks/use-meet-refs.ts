import { useRef } from "react";
import type { Socket } from "socket.io-client";
import type { Device } from "mediasoup-client";
import type {
  AudioAnalyserEntry,
  Consumer,
  Producer,
  ProducerInfo,
  ProducerMapEntry,
  Transport,
  VideoQuality,
} from "../types";
import { generateSessionId } from "../utils";

export function useMeetRefs() {
  const socketRef = useRef<Socket | null>(null);
  const deviceRef = useRef<Device | null>(null);
  const producerTransportRef = useRef<Transport | null>(null);
  const consumerTransportRef = useRef<Transport | null>(null);
  const audioProducerRef = useRef<Producer | null>(null);
  const videoProducerRef = useRef<Producer | null>(null);
  const screenProducerRef = useRef<Producer | null>(null);
  const screenShareStreamRef = useRef<MediaStream | null>(null);
  const consumersRef = useRef<Map<string, Consumer>>(new Map());
  const producerMapRef = useRef<Map<string, ProducerMapEntry>>(new Map());
  const pendingProducersRef = useRef<Map<string, ProducerInfo>>(new Map());
  const leaveTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );
  const intentionalTrackStopsRef = useRef<WeakSet<MediaStreamTrack>>(
    new WeakSet()
  );
  const permissionHintTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const abortControllerRef = useRef<AbortController | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectInFlightRef = useRef(false);
  const intentionalDisconnectRef = useRef(false);
  const lastAuthIsHostRef = useRef<boolean | null>(null);
  const videoQualityRef = useRef<VideoQuality>("standard");
  const currentRoomIdRef = useRef<string | null>(null);
  const handleRedirectRef = useRef<(roomId: string) => Promise<void>>(
    async () => {}
  );
  const handleReconnectRef = useRef<
    (options?: { immediate?: boolean }) => void
  >(async () => {});
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioAnalyserMapRef = useRef<Map<string, AudioAnalyserEntry>>(
    new Map()
  );
  const lastActiveSpeakerRef = useRef<{ id: string; ts: number } | null>(null);
  const shouldAutoJoinRef = useRef(false);
  const joinOptionsRef = useRef<{ displayName?: string; isGhost: boolean }>({
    displayName: undefined,
    isGhost: false,
  });
  const isChatOpenRef = useRef(false);
  const localStreamRef = useRef<MediaStream | null>(null);
  const sessionIdRef = useRef<string>(generateSessionId());
  const isHandRaisedRef = useRef(false);
  const producerTransportDisconnectTimeoutRef = useRef<
    ReturnType<typeof setTimeout> | null
  >(null);
  const consumerTransportDisconnectTimeoutRef = useRef<
    ReturnType<typeof setTimeout> | null
  >(null);
  const iceRestartInFlightRef = useRef({
    producer: false,
    consumer: false,
  });
  const producerSyncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  );

  return {
    socketRef,
    deviceRef,
    producerTransportRef,
    consumerTransportRef,
    audioProducerRef,
    videoProducerRef,
    screenProducerRef,
    screenShareStreamRef,
    consumersRef,
    producerMapRef,
    pendingProducersRef,
    leaveTimeoutsRef,
    intentionalTrackStopsRef,
    permissionHintTimeoutRef,
    abortControllerRef,
    reconnectAttemptsRef,
    reconnectInFlightRef,
    intentionalDisconnectRef,
    lastAuthIsHostRef,
    videoQualityRef,
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
    sessionIdRef,
    isHandRaisedRef,
    producerTransportDisconnectTimeoutRef,
    consumerTransportDisconnectTimeoutRef,
    iceRestartInFlightRef,
    producerSyncIntervalRef,
  };
}

export type MeetRefs = ReturnType<typeof useMeetRefs>;
