"use client";

import { useEffect } from "react";
import {
  useVideoEffects,
  type VideoEffectsDebugStats,
  type VideoEffectsRuntimeStatus,
} from "../hooks/useVideoEffects";
import type { VideoEffectsState } from "../lib/video-effects";

export type VideoEffectsBridgeState = {
  effectiveStream: MediaStream | null;
  processedTrackVersion: number;
  processedTrackReady: boolean;
  status: VideoEffectsRuntimeStatus;
  error: string | null;
  debugStats: VideoEffectsDebugStats | null;
};

export const VIDEO_EFFECTS_BRIDGE_OFF_STATE: VideoEffectsBridgeState = {
  effectiveStream: null,
  processedTrackVersion: 0,
  processedTrackReady: false,
  status: "off",
  error: null,
  debugStats: null,
};

type VideoEffectsBridgeProps = {
  sourceStream: MediaStream | null;
  effects: VideoEffectsState;
  processedVideoTrackRef: React.MutableRefObject<MediaStreamTrack | null>;
  framingRecenterToken?: number;
  mirrorOutput?: boolean;
  onStateChange: (state: VideoEffectsBridgeState) => void;
};

export default function VideoEffectsBridge({
  sourceStream,
  effects,
  processedVideoTrackRef,
  framingRecenterToken = 0,
  mirrorOutput = false,
  onStateChange,
}: VideoEffectsBridgeProps) {
  const state = useVideoEffects({
    sourceStream,
    effects,
    processedVideoTrackRef,
    framingRecenterToken,
    mirrorOutput,
  });

  useEffect(() => {
    onStateChange({
      effectiveStream: state.effectiveStream,
      processedTrackVersion: state.processedTrackVersion,
      processedTrackReady: state.processedTrackReady,
      status: state.status,
      error: state.error,
      debugStats: state.debugStats,
    });
  }, [
    onStateChange,
    state.debugStats,
    state.effectiveStream,
    state.error,
    state.processedTrackReady,
    state.processedTrackVersion,
    state.status,
  ]);

  useEffect(() => {
    return () => {
      processedVideoTrackRef.current = null;
      onStateChange(VIDEO_EFFECTS_BRIDGE_OFF_STATE);
    };
  }, [onStateChange, processedVideoTrackRef]);

  return null;
}
