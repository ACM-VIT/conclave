"use client";

import { useEffect, useState } from "react";
import type { BackgroundEffect } from "../lib/background-blur";
import type { VideoQuality } from "../lib/types";

interface UseMeetMediaSettingsOptions {
  videoQualityRef: React.MutableRefObject<VideoQuality>;
}

export function useMeetMediaSettings({
  videoQualityRef,
}: UseMeetMediaSettingsOptions) {
  const [videoQuality, setVideoQuality] = useState<VideoQuality>("standard");
  const [isMirrorCamera, setIsMirrorCamera] = useState(true);
  const [backgroundEffect, setBackgroundEffect] =
    useState<BackgroundEffect>("none");
  const [isVideoSettingsOpen, setIsVideoSettingsOpen] = useState(false);
  const [selectedAudioInputDeviceId, setSelectedAudioInputDeviceId] =
    useState<string>();
  const [selectedAudioOutputDeviceId, setSelectedAudioOutputDeviceId] =
    useState<string>();

  useEffect(() => {
    videoQualityRef.current = videoQuality;
  }, [videoQuality, videoQualityRef]);

  return {
    videoQuality,
    setVideoQuality,
    isMirrorCamera,
    setIsMirrorCamera,
    backgroundEffect,
    setBackgroundEffect,
    isVideoSettingsOpen,
    setIsVideoSettingsOpen,
    selectedAudioInputDeviceId,
    setSelectedAudioInputDeviceId,
    selectedAudioOutputDeviceId,
    setSelectedAudioOutputDeviceId,
  };
}
