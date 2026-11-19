"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ResolvedCameraPublishSettings } from "../lib/media-quality-settings";

export interface LocalCameraPreviewController {
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

export function useLocalCameraPreview({
  deviceId,
  publishSettings,
}: {
  deviceId?: string;
  publishSettings?: ResolvedCameraPublishSettings;
}): LocalCameraPreviewController {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wanted, setWanted] = useState(false);
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

  useEffect(
    () => () => {
      requestIdRef.current += 1;
      releaseStream();
    },
    [releaseStream],
  );

  return { stream, isStarting, error, start, stop };
}
