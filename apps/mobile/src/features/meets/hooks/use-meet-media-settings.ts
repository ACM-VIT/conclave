import { useEffect, useState } from "react";
import type { VideoQuality } from "../types";

interface UseMeetMediaSettingsOptions {
  videoQualityRef: React.MutableRefObject<VideoQuality>;
}

export function useMeetMediaSettings({
  videoQualityRef,
}: UseMeetMediaSettingsOptions) {
  const [videoQuality, setVideoQuality] = useState<VideoQuality>("low");
  const [isMirrorCamera, setIsMirrorCamera] = useState(true);
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
    selectedAudioInputDeviceId,
    setSelectedAudioInputDeviceId,
    selectedAudioOutputDeviceId,
    setSelectedAudioOutputDeviceId,
  };
}
