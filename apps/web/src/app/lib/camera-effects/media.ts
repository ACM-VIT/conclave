"use client";

import {
  LOW_QUALITY_CONSTRAINTS,
  STANDARD_QUALITY_CONSTRAINTS,
} from "../constants";
import type { VideoQuality } from "../types";

const VIDEO_READY_TIMEOUT_MS = 2500;

export const getVideoConstraints = (
  quality: VideoQuality,
): MediaTrackConstraints => {
  return quality === "low"
    ? { ...LOW_QUALITY_CONSTRAINTS }
    : { ...STANDARD_QUALITY_CONSTRAINTS };
};

export const stopMediaStream = (stream: MediaStream) => {
  stream.getTracks().forEach((track) => {
    track.onended = null;
    try {
      track.stop();
    } catch {}
  });
};

export const waitForVideoReady = async (
  video: HTMLVideoElement,
): Promise<void> => {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Camera preview timed out"));
    }, VIDEO_READY_TIMEOUT_MS);
    const handleLoadedData = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Camera preview failed to start"));
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadeddata", handleLoadedData);
      video.removeEventListener("error", handleError);
    };

    video.addEventListener("loadeddata", handleLoadedData, { once: true });
    video.addEventListener("error", handleError, { once: true });
  });
};
