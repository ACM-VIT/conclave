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

interface UseMeetMediaSettingsOptions {
  videoQualityRef: React.MutableRefObject<VideoQuality>;
  networkManagedVideoQualityRef?: React.MutableRefObject<boolean>;
  allowNetworkAutoDowngrade: boolean;
}

const getInitialVideoQuality = (): VideoQuality => {
  return shouldStartLowBandwidthVideo() ? "low" : "standard";
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
  const [initialVideoQuality] = useState<VideoQuality>(getInitialVideoQuality);
  const networkManagedQualityRef = useRef(initialVideoQuality === "low");
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
      if (getInitialVideoQuality() !== "low") return;
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
