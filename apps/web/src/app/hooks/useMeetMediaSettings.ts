"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  getBrowserNetworkInformation,
  shouldStartLowBandwidthVideo,
} from "../lib/network-information";
import type { VideoQuality } from "../lib/types";
import {
  getCameraBaseVideoQuality,
  normalizeMediaQualitySettings,
  readStoredMediaQualitySettings,
  writeStoredMediaQualitySettings,
  type MediaQualitySettings,
} from "../lib/media-quality-settings";

interface UseMeetMediaSettingsOptions {
  videoQualityRef: React.MutableRefObject<VideoQuality>;
  networkManagedVideoQualityRef?: React.MutableRefObject<boolean>;
  allowNetworkAutoDowngrade: boolean;
}

const getInitialVideoQuality = (
  mediaQualitySettings: MediaQualitySettings,
): VideoQuality => {
  return shouldStartLowBandwidthVideo()
    ? "low"
    : getCameraBaseVideoQuality(mediaQualitySettings.camera);
};

const NOISE_CANCELLATION_STORAGE_KEY = "conclave:noise-cancellation";

const getInitialNoiseCancellationEnabled = (): boolean => {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(NOISE_CANCELLATION_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
};

export function useMeetMediaSettings({
  videoQualityRef,
  networkManagedVideoQualityRef,
  allowNetworkAutoDowngrade,
}: UseMeetMediaSettingsOptions) {
  const [mediaQualitySettings, setMediaQualitySettingsState] =
    useState<MediaQualitySettings>(readStoredMediaQualitySettings);
  const mediaQualitySettingsRef = useRef(mediaQualitySettings);
  const [initialVideoQuality] = useState<VideoQuality>(() =>
    getInitialVideoQuality(mediaQualitySettings),
  );
  const networkManagedQualityRef = useRef(
    initialVideoQuality === "low" &&
      getCameraBaseVideoQuality(mediaQualitySettings.camera) !== "low",
  );
  const [videoQuality, setVideoQualityState] =
    useState<VideoQuality>(initialVideoQuality);
  const [isMirrorCamera, setIsMirrorCamera] = useState(true);
  const [isVideoSettingsOpen, setIsVideoSettingsOpen] = useState(false);
  const [isNoiseCancellationEnabled, setIsNoiseCancellationEnabled] = useState(
    getInitialNoiseCancellationEnabled,
  );
  const [selectedAudioInputDeviceId, setSelectedAudioInputDeviceId] =
    useState<string>();
  const [selectedAudioOutputDeviceId, setSelectedAudioOutputDeviceId] =
    useState<string>();
  const [selectedVideoInputDeviceId, setSelectedVideoInputDeviceId] =
    useState<string>();

  if (mediaQualitySettingsRef.current !== mediaQualitySettings) {
    mediaQualitySettingsRef.current = mediaQualitySettings;
  }

  if (videoQualityRef.current !== videoQuality) {
    videoQualityRef.current = videoQuality;
  }
  if (
    networkManagedVideoQualityRef &&
    networkManagedVideoQualityRef.current !== networkManagedQualityRef.current
  ) {
    networkManagedVideoQualityRef.current = networkManagedQualityRef.current;
  }

  const setNetworkManagedQuality = useCallback(
    (isNetworkManaged: boolean) => {
      networkManagedQualityRef.current = isNetworkManaged;
      if (networkManagedVideoQualityRef) {
        networkManagedVideoQualityRef.current = isNetworkManaged;
      }
    },
    [networkManagedVideoQualityRef],
  );

  const setVideoQuality: Dispatch<SetStateAction<VideoQuality>> = useCallback(
    (action) => {
      setVideoQualityState((previous) => {
        const next =
          typeof action === "function"
            ? (action)(previous)
            : action;
        setNetworkManagedQuality(false);
        return next;
      });
    },
    [setNetworkManagedQuality],
  );

  const setNetworkManagedVideoQuality: Dispatch<
    SetStateAction<VideoQuality>
  > = useCallback(
    (action) => {
      setVideoQualityState((previous) => {
        const next =
          typeof action === "function"
            ? (action)(previous)
            : action;
        setNetworkManagedQuality(next === "low");
        return next;
      });
    },
    [setNetworkManagedQuality],
  );

  const setMediaQualitySettings: Dispatch<
    SetStateAction<MediaQualitySettings>
  > = useCallback((action) => {
    setMediaQualitySettingsState((previous) =>
      normalizeMediaQualitySettings(
        typeof action === "function" ? action(previous) : action,
      ),
    );
  }, []);

  useEffect(() => {
    videoQualityRef.current = videoQuality;
  }, [videoQuality, videoQualityRef]);

  useEffect(() => {
    if (!networkManagedVideoQualityRef) return;
    networkManagedVideoQualityRef.current = networkManagedQualityRef.current;
  }, [networkManagedVideoQualityRef]);

  useEffect(() => {
    if (!allowNetworkAutoDowngrade) return;

    const connection = getBrowserNetworkInformation();
    if (!connection?.addEventListener || !connection.removeEventListener) {
      return;
    }

    const handleNetworkChange = () => {
      if (!shouldStartLowBandwidthVideo()) return;
      if (videoQualityRef.current === "low") return;
      videoQualityRef.current = "low";
      setNetworkManagedVideoQuality("low");
    };

    connection.addEventListener("change", handleNetworkChange);
    handleNetworkChange();

    return () => {
      connection.removeEventListener?.("change", handleNetworkChange);
    };
  }, [
    allowNetworkAutoDowngrade,
    setNetworkManagedVideoQuality,
    videoQualityRef,
  ]);

  useEffect(() => {
    const cameraBaseQuality = getCameraBaseVideoQuality(
      mediaQualitySettings.camera,
    );
    const shouldUseNetworkManagedLowQuality =
      cameraBaseQuality !== "low" && shouldStartLowBandwidthVideo();
    const nextQuality = shouldUseNetworkManagedLowQuality
      ? "low"
      : cameraBaseQuality;
    setNetworkManagedQuality(shouldUseNetworkManagedLowQuality);
    videoQualityRef.current = nextQuality;
    setVideoQualityState(nextQuality);
  }, [
    mediaQualitySettings.camera,
    setNetworkManagedQuality,
    videoQualityRef,
  ]);

  useEffect(() => {
    writeStoredMediaQualitySettings(mediaQualitySettings);
  }, [mediaQualitySettings]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        NOISE_CANCELLATION_STORAGE_KEY,
        isNoiseCancellationEnabled ? "on" : "off",
      );
    } catch {}
  }, [isNoiseCancellationEnabled]);

  return {
    videoQuality,
    setVideoQuality,
    setNetworkManagedVideoQuality,
    mediaQualitySettings,
    mediaQualitySettingsRef,
    setMediaQualitySettings,
    isMirrorCamera,
    setIsMirrorCamera,
    isVideoSettingsOpen,
    setIsVideoSettingsOpen,
    isNoiseCancellationEnabled,
    setIsNoiseCancellationEnabled,
    selectedAudioInputDeviceId,
    setSelectedAudioInputDeviceId,
    selectedAudioOutputDeviceId,
    setSelectedAudioOutputDeviceId,
    selectedVideoInputDeviceId,
    setSelectedVideoInputDeviceId,
  };
}
