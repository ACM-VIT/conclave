"use client";

import {
  LOW_QUALITY_CONSTRAINTS,
  STANDARD_QUALITY_CONSTRAINTS,
} from "./constants";
import type { VideoQuality } from "./types";

export type BackgroundEffect = "none" | "blur";

export interface BackgroundEffectOption {
  id: BackgroundEffect;
  label: string;
  description: string;
  experimental?: boolean;
}

export const BACKGROUND_EFFECT_OPTIONS: BackgroundEffectOption[] = [
  {
    id: "none",
    label: "Original",
    description: "Raw camera feed",
  },
  {
    id: "blur",
    label: "Blur",
    description: "Soft background blur",
  },
];

export const getBackgroundEffectOption = (effect: BackgroundEffect) =>
  BACKGROUND_EFFECT_OPTIONS.find((option) => option.id === effect);

export interface ManagedCameraTrack {
  stream: MediaStream;
  track: MediaStreamTrack;
  stop: () => void;
}

interface CreateManagedCameraTrackOptions {
  effect: BackgroundEffect;
  quality: VideoQuality;
}

interface CreateManagedCameraTrackFromTrackOptions {
  effect: BackgroundEffect;
  sourceTrack: MediaStreamTrack;
}

const MEDIAPIPE_WASM_ROOT =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm";
const MEDIAPIPE_SELFIE_SEGMENTER_MODEL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";
const BACKGROUND_BLUR_RADIUS_PX = 18;
const MASK_SOFTEN_RADIUS_PX = 4;
const PERSON_MASK_THRESHOLD = 0.5;
const BLUR_SETUP_TIMEOUT_MS = 2500;

type SegmenterModule = typeof import("@mediapipe/tasks-vision");

let segmenterModulePromise: Promise<SegmenterModule> | null = null;
let segmenterPromise: Promise<import("@mediapipe/tasks-vision").ImageSegmenter> | null =
  null;

const getVideoConstraints = (
  quality: VideoQuality,
): MediaTrackConstraints => {
  return quality === "low"
    ? { ...LOW_QUALITY_CONSTRAINTS }
    : { ...STANDARD_QUALITY_CONSTRAINTS };
};

const loadSegmenterModule = async (): Promise<SegmenterModule> => {
  if (!segmenterModulePromise) {
    segmenterModulePromise = import("@mediapipe/tasks-vision");
  }

  return segmenterModulePromise;
};

const getImageSegmenter = async () => {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const { FilesetResolver, ImageSegmenter } = await loadSegmenterModule();
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_ROOT);

      return ImageSegmenter.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MEDIAPIPE_SELFIE_SEGMENTER_MODEL,
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        outputCategoryMask: true,
        outputConfidenceMasks: true,
      });
    })();

    segmenterPromise = segmenterPromise.catch((error) => {
      segmenterPromise = null;
      throw error;
    });
  }

  return segmenterPromise;
};

const getImageSegmenterWithTimeout = async () => {
  return Promise.race([
    getImageSegmenter(),
    new Promise<never>((_, reject) => {
      window.setTimeout(() => {
        reject(new Error("Background blur setup timed out"));
      }, BLUR_SETUP_TIMEOUT_MS);
    }),
  ]);
};

const stopMediaStream = (stream: MediaStream) => {
  stream.getTracks().forEach((track) => {
    track.onended = null;
    try {
      track.stop();
    } catch {}
  });
};

const waitForVideoReady = async (video: HTMLVideoElement): Promise<void> => {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const handleLoadedData = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Camera preview failed to start"));
    };
    const cleanup = () => {
      video.removeEventListener("loadeddata", handleLoadedData);
      video.removeEventListener("error", handleError);
    };

    video.addEventListener("loadeddata", handleLoadedData, { once: true });
    video.addEventListener("error", handleError, { once: true });
  });
};

const createBlurredTrack = async (
  sourceStream: MediaStream,
  sourceTrack: MediaStreamTrack,
): Promise<ManagedCameraTrack> => {
  const segmenter = await getImageSegmenterWithTimeout();
  const labels = segmenter.getLabels().map((label) => label.toLowerCase());
  const personLabelIndex = labels.findIndex(
    (label) =>
      label.includes("person") ||
      label.includes("human") ||
      label.includes("selfie") ||
      label.includes("foreground"),
  );
  const video = document.createElement("video");
  const outputCanvas = document.createElement("canvas");
  const foregroundCanvas = document.createElement("canvas");
  const maskCanvas = document.createElement("canvas");
  const outputContext = outputCanvas.getContext("2d", {
    alpha: true,
    desynchronized: true,
  });
  const foregroundContext = foregroundCanvas.getContext("2d", {
    alpha: true,
    desynchronized: true,
  });
  const maskContext = maskCanvas.getContext("2d", { alpha: true });

  if (!outputContext || !foregroundContext || !maskContext) {
    stopMediaStream(sourceStream);
    throw new Error("Canvas processing is unavailable in this browser");
  }

  const sourceSettings = sourceTrack.getSettings();
  const frameRate =
    typeof sourceSettings.frameRate === "number" && sourceSettings.frameRate > 0
      ? sourceSettings.frameRate
      : 30;

  video.playsInline = true;
  video.autoplay = true;
  video.muted = true;
  video.srcObject = sourceStream;

  try {
    await video.play();
  } catch {}
  await waitForVideoReady(video);

  const capturedStream = outputCanvas.captureStream(frameRate);
  const processedTrack = capturedStream.getVideoTracks()[0];

  if (!processedTrack) {
    stopMediaStream(capturedStream);
    stopMediaStream(sourceStream);
    throw new Error("Unable to capture processed video stream");
  }

  if ("contentHint" in processedTrack) {
    processedTrack.contentHint = "motion";
  }

  let rafId = 0;
  let stopped = false;
  let maskImageData: ImageData | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (rafId) {
      window.cancelAnimationFrame(rafId);
    }
    sourceTrack.onended = null;
    processedTrack.onended = null;
    video.pause();
    video.srcObject = null;
    stopMediaStream(capturedStream);
    stopMediaStream(sourceStream);
  };

  sourceTrack.onended = stop;
  processedTrack.onended = stop;

  const renderFrame = () => {
    if (stopped) return;
    if (
      sourceTrack.readyState !== "live" ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      rafId = window.requestAnimationFrame(renderFrame);
      return;
    }

    const width = video.videoWidth || sourceSettings.width || 1280;
    const height = video.videoHeight || sourceSettings.height || 720;

    if (outputCanvas.width !== width || outputCanvas.height !== height) {
      outputCanvas.width = width;
      outputCanvas.height = height;
      foregroundCanvas.width = width;
      foregroundCanvas.height = height;
    }

    segmenter.segmentForVideo(video, performance.now(), (result) => {
      try {
        const confidenceMasks = result.confidenceMasks;
        const categoryMask = result.categoryMask;
        const mask =
          confidenceMasks && confidenceMasks.length > 0
            ? confidenceMasks[
                personLabelIndex >= 0
                  ? Math.min(personLabelIndex, confidenceMasks.length - 1)
                  : confidenceMasks.length > 1
                    ? 1
                    : 0
              ]
            : categoryMask;

        if (!mask) {
          outputContext.clearRect(0, 0, width, height);
          outputContext.drawImage(video, 0, 0, width, height);
          return;
        }

        const maskData = confidenceMasks?.length
          ? mask.getAsFloat32Array()
          : mask.getAsUint8Array();

        if (
          maskCanvas.width !== mask.width ||
          maskCanvas.height !== mask.height
        ) {
          maskCanvas.width = mask.width;
          maskCanvas.height = mask.height;
        }

        if (
          !maskImageData ||
          maskImageData.width !== mask.width ||
          maskImageData.height !== mask.height
        ) {
          maskImageData = new ImageData(mask.width, mask.height);
        }
        const alphaData = maskImageData.data;

        for (let index = 0; index < maskData.length; index += 1) {
          const offset = index * 4;
          const alpha =
            confidenceMasks?.length
              ? Math.max(
                  0,
                  Math.min(
                    255,
                    ((maskData[index] as number) - PERSON_MASK_THRESHOLD) *
                      (255 / (1 - PERSON_MASK_THRESHOLD)),
                  ),
                )
              : (maskData[index] as number) > 0
                ? 255
                : 0;
          alphaData[offset] = 255;
          alphaData[offset + 1] = 255;
          alphaData[offset + 2] = 255;
          alphaData[offset + 3] = alpha;
        }

        maskContext.putImageData(maskImageData, 0, 0);

        outputContext.clearRect(0, 0, width, height);
        outputContext.filter = `blur(${BACKGROUND_BLUR_RADIUS_PX}px)`;
        outputContext.drawImage(video, 0, 0, width, height);
        outputContext.filter = "none";

        foregroundContext.clearRect(0, 0, width, height);
        foregroundContext.globalCompositeOperation = "source-over";
        foregroundContext.drawImage(video, 0, 0, width, height);
        foregroundContext.globalCompositeOperation = "destination-in";
        foregroundContext.filter = `blur(${MASK_SOFTEN_RADIUS_PX}px)`;
        foregroundContext.drawImage(maskCanvas, 0, 0, width, height);
        foregroundContext.filter = "none";
        foregroundContext.globalCompositeOperation = "source-over";

        outputContext.drawImage(foregroundCanvas, 0, 0, width, height);
      } finally {
        result.close();
      }
    });

    rafId = window.requestAnimationFrame(renderFrame);
  };

  renderFrame();

  return {
    stream: new MediaStream([processedTrack]),
    track: processedTrack,
    stop,
  };
};

export const createManagedCameraTrack = async ({
  effect,
  quality,
}: CreateManagedCameraTrackOptions): Promise<ManagedCameraTrack> => {
  const sourceStream = await navigator.mediaDevices.getUserMedia({
    video: getVideoConstraints(quality),
  });
  const sourceTrack = sourceStream.getVideoTracks()[0];

  if (!sourceTrack) {
    stopMediaStream(sourceStream);
    throw new Error("No video track obtained");
  }

  if ("contentHint" in sourceTrack) {
    sourceTrack.contentHint = "motion";
  }

  if (effect === "none") {
    return {
      stream: new MediaStream([sourceTrack]),
      track: sourceTrack,
      stop: () => {
        stopMediaStream(sourceStream);
      },
    };
  }

  try {
    return await createBlurredTrack(sourceStream, sourceTrack);
  } catch (error) {
    console.warn(
      `[Meets] ${effect} camera effect setup failed, falling back to raw camera:`,
      error,
    );

    return {
      stream: new MediaStream([sourceTrack]),
      track: sourceTrack,
      stop: () => {
        stopMediaStream(sourceStream);
      },
    };
  }
};

export const createManagedCameraTrackFromTrack = async ({
  effect,
  sourceTrack,
}: CreateManagedCameraTrackFromTrackOptions): Promise<ManagedCameraTrack> => {
  const clonedTrack = sourceTrack.clone();
  const sourceStream = new MediaStream([clonedTrack]);

  if ("contentHint" in clonedTrack) {
    clonedTrack.contentHint = "motion";
  }

  if (effect === "none") {
    return {
      stream: new MediaStream([clonedTrack]),
      track: clonedTrack,
      stop: () => {
        stopMediaStream(sourceStream);
      },
    };
  }

  try {
    return await createBlurredTrack(sourceStream, clonedTrack);
  } catch (error) {
    console.warn(
      `[Meets] ${effect} camera effect preview setup failed, falling back to cloned camera:`,
      error,
    );

    return {
      stream: new MediaStream([clonedTrack]),
      track: clonedTrack,
      stop: () => {
        stopMediaStream(sourceStream);
      },
    };
  }
};
