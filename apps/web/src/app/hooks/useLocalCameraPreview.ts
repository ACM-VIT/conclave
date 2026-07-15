"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ResolvedCameraPublishSettings } from "../lib/media-quality-settings";

export interface LocalCameraPreviewController {
  /** Private preview stream. Never handed to a producer, so never broadcast. */
  stream: MediaStream | null;
  isStarting: boolean;
  error: string | null;
  start: () => void;
  stop: () => void;
}

const PREVIEW_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
};

const describeCameraPreviewError = (err: unknown): string => {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError" || err.name === "SecurityError") {
      return "Camera access is blocked. Allow camera access in your browser to preview.";
    }
    if (err.name === "NotFoundError" || err.name === "OverconstrainedError") {
      return "No camera found to preview.";
    }
    if (err.name === "NotReadableError" || err.name === "AbortError") {
      return "The camera is in use by another app.";
    }
  }
  return "Camera preview failed to start.";
};

/**
 * Camera preview that stays on this machine. The stream comes from a plain
 * getUserMedia call and is never attached to a mediasoup producer, so nothing
 * reaches the SFU or other participants. Used by the in-meeting Settings panel
 * and the effects panel to test the camera / preview effects while the real
 * camera stays off for the room.
 */
export function useLocalCameraPreview({
  deviceId,
  publishSettings,
}: {
  /** Preferred camera; preview restarts when this changes while running. */
  deviceId?: string;
  /** The same local quality ceiling used by the meeting publisher. */
  publishSettings?: ResolvedCameraPublishSettings;
}): LocalCameraPreviewController {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wanted, setWanted] = useState(false);
  // Monotonic token: any stop/restart invalidates in-flight getUserMedia
  // results so a late resolve can't resurrect a preview the caller ended.
  const requestIdRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);

  const releaseStream = useCallback(() => {
    const current = streamRef.current;
    streamRef.current = null;
    if (current) {
      current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {}
      });
    }
    setStream(null);
  }, []);

  const stop = useCallback(() => {
    requestIdRef.current += 1;
    setWanted(false);
    setIsStarting(false);
    setError(null);
    releaseStream();
  }, [releaseStream]);

  const start = useCallback(() => {
    setError(null);
    setWanted(true);
  }, []);

  useEffect(() => {
    if (!wanted) return;
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      setError("Camera preview is not available in this browser.");
      setWanted(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    let cancelled = false;
    setIsStarting(true);

    void navigator.mediaDevices
      .getUserMedia({
        video: {
          ...(publishSettings
            ? {
                width: {
                  ideal: publishSettings.width,
                  max: publishSettings.width,
                },
                height: {
                  ideal: publishSettings.height,
                  max: publishSettings.height,
                },
                frameRate: {
                  ideal: publishSettings.frameRate,
                  max: publishSettings.frameRate,
                },
              }
            : PREVIEW_VIDEO_CONSTRAINTS),
          // "ideal" (not "exact") so a stale device id falls back to any
          // camera instead of failing the preview outright.
          ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
        },
      })
      .then((nextStream) => {
        if (cancelled || requestId !== requestIdRef.current) {
          nextStream.getTracks().forEach((track) => track.stop());
          return;
        }
        releaseStream();
        streamRef.current = nextStream;
        setStream(nextStream);
        setError(null);
        nextStream.getVideoTracks().forEach((track) => {
          track.addEventListener(
            "ended",
            () => {
              // Device unplugged / revoked: fold back to the idle state so the
              // UI offers the start button again instead of a black tile.
              if (streamRef.current === nextStream) {
                requestIdRef.current += 1;
                setWanted(false);
                setIsStarting(false);
                releaseStream();
              }
            },
            { once: true },
          );
        });
      })
      .catch((err: unknown) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        // A failed (re)start ends the whole preview: releasing the previous
        // capture keeps the UI state ("preview off" + error) truthful — no
        // orphaned camera light while an error is showing.
        releaseStream();
        setError(describeCameraPreviewError(err));
        setWanted(false);
      })
      .finally(() => {
        if (!cancelled && requestId === requestIdRef.current) {
          setIsStarting(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    wanted,
    deviceId,
    publishSettings?.width,
    publishSettings?.height,
    publishSettings?.frameRate,
    releaseStream,
  ]);

  // Release the camera when the owner unmounts.
  useEffect(
    () => () => {
      requestIdRef.current += 1;
      releaseStream();
    },
    [releaseStream],
  );

  return { stream, isStarting, error, start, stop };
}
