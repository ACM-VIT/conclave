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
} from "../lib/types";
import { getOrCreateSessionId } from "../lib/utils";

export function useMeetRefs() {
  const socketRef = useRef<Socket | null>(null);
  const deviceRef = useRef<Device | null>(null);
  const producerTransportRef = useRef<Transport | null>(null);
  const consumerTransportRef = useRef<Transport | null>(null);
  const audioProducerRef = useRef<Producer | null>(null);
  const videoProducerRef = useRef<Producer | null>(null);
  const screenProducerRef = useRef<Producer | null>(null);
  const consumersRef = useRef<Map<string, Consumer>>(new Map());
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
  const currentRoomIdRef = useRef<string | null>(null);
  const handleRedirectRef = useRef<(roomId: string) => Promise<void>>(
    async () => {}
  );
  const handleReconnectRef = useRef<() => void>(async () => {});
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioAnalyserMapRef = useRef<Map<string, AudioAnalyserEntry>>(
    new Map()
  );
  const lastActiveSpeakerRef = useRef<{ id: string; ts: number } | null>(null);
  const shouldAutoJoinRef = useRef(false);
  const joinOptionsRef = useRef<{
    displayName?: string;
    isGhost: boolean;
    joinMode: JoinMode;
    webinarInviteCode?: string;
  }>({
    displayName: undefined,
    isGhost: false,
    joinMode: "meeting",
  });
  const isChatOpenRef = useRef(false);
  const localStreamRef = useRef<MediaStream | null>(null);
  const sessionIdRef = useRef<string>(getOrCreateSessionId());
  const isHandRaisedRef = useRef(false);
  const producerTransportDisconnectTimeoutRef = useRef<number | null>(null);
  const consumerTransportDisconnectTimeoutRef = useRef<number | null>(null);
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
    consumersRef,
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
