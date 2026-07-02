import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";

/** Normalize an unknown thrown value into an Error for promise rejections. */
const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

type MediaPipeDelegate = "GPU" | "CPU";
type ModelWorkerInputSource = "video-frame" | "image-bitmap";
type WorkerVideoFrame = CanvasImageSource & {
  close?: () => void;
};
type WorkerModelFrameSource = ImageBitmap | WorkerVideoFrame;
type SegmentationProcessorRequest =
  | { type: "INIT" }
  | {
      type: "SEGMENT";
      sequence: number;
      processingConfigId: number;
      source: WorkerModelFrameSource;
      sourceKind: ModelWorkerInputSource;
      width: number;
      height: number;
      timestamp: number;
    }
  | { type: "CLOSE" };

const TASKS_VISION_VERSION = "0.10.35";
const TASKS_VISION_WASM_LOCAL_PATH = `/mediapipe/tasks-vision/${TASKS_VISION_VERSION}/wasm`;
const TASKS_SELFIE_SEGMENTER_SQUARE_MODEL_LOCAL_PATH =
  "/mediapipe/models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";
const TASKS_SELFIE_SEGMENTER_SQUARE_MODEL_CDN =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";
const TASKS_SELFIE_SEGMENTER_LANDSCAPE_MODEL_LOCAL_PATH =
  "/mediapipe/models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite";
const TASKS_SELFIE_SEGMENTER_LANDSCAPE_MODEL_CDN =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite";
const TASKS_SELFIE_SEGMENTER_MODELS = [
  {
    source: "same-origin-square",
    url: TASKS_SELFIE_SEGMENTER_SQUARE_MODEL_LOCAL_PATH,
  },
  {
    source: "google-storage-square",
    url: TASKS_SELFIE_SEGMENTER_SQUARE_MODEL_CDN,
  },
  {
    source: "same-origin-landscape",
    url: TASKS_SELFIE_SEGMENTER_LANDSCAPE_MODEL_LOCAL_PATH,
  },
  {
    source: "google-storage-landscape",
    url: TASKS_SELFIE_SEGMENTER_LANDSCAPE_MODEL_CDN,
  },
] as const;

let imageSegmenter: ImageSegmenter | null = null;
let imageSegmenterDelegate: MediaPipeDelegate | null = null;
let imageSegmenterPromise: Promise<ImageSegmenter | null> | null = null;
let gpuCanvas: OffscreenCanvas | null = null;
let closed = false;
const activeSources = new Set<WorkerModelFrameSource>();

const workerScope = self as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  onmessage:
    | ((event: MessageEvent<SegmentationProcessorRequest>) => void)
    | null;
};

const getErrorDebugSnapshot = (err: unknown) => {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return err;
};

const createImageSegmenter = async (delegate: MediaPipeDelegate) => {
  const fileset = await FilesetResolver.forVisionTasks(
    TASKS_VISION_WASM_LOCAL_PATH,
  );
  let lastError: unknown = null;

  for (const model of TASKS_SELFIE_SEGMENTER_MODELS) {
    try {
      if (delegate === "GPU" && typeof OffscreenCanvas !== "undefined") {
        gpuCanvas ??= new OffscreenCanvas(1, 1);
      }
      return await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: model.url,
          delegate,
        },
        canvas: delegate === "GPU" ? gpuCanvas ?? undefined : undefined,
        runningMode: "VIDEO",
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      });
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to create worker ImageSegmenter");
};

const ensureImageSegmenter = async () => {
  if (imageSegmenter || closed) return imageSegmenter;
  if (imageSegmenterPromise) return imageSegmenterPromise;

  imageSegmenterPromise = (async () => {
    try {
      imageSegmenter = await createImageSegmenter("GPU");
      imageSegmenterDelegate = "GPU";
    } catch {
      imageSegmenter = await createImageSegmenter("CPU");
      imageSegmenterDelegate = "CPU";
    }
    return imageSegmenter;
  })();

  void imageSegmenterPromise
    .catch(() => undefined)
    .finally(() => {
      imageSegmenterPromise = null;
    });
  return imageSegmenterPromise;
};

const closeImageSegmenter = () => {
  closed = true;
  for (const source of activeSources) {
    try {
      source.close?.();
    } catch {}
  }
  activeSources.clear();
  try {
    imageSegmenter?.close();
  } catch {}
  imageSegmenter = null;
  imageSegmenterDelegate = null;
  imageSegmenterPromise = null;
  gpuCanvas = null;
};

workerScope.onmessage = (event) => {
  const message = event.data;
  void (async () => {
    try {
      switch (message.type) {
        case "INIT": {
          closed = false;
          const model = await ensureImageSegmenter();
          if (!model || !imageSegmenterDelegate) {
            throw new Error("Worker ImageSegmenter did not initialize.");
          }
          workerScope.postMessage({
            type: "READY",
            delegate: imageSegmenterDelegate,
          });
          break;
        }
        case "SEGMENT": {
          const source = message.source;
          activeSources.add(source);
          try {
            const model = await ensureImageSegmenter();
            if (!model || !imageSegmenterDelegate) {
              throw new Error("Worker ImageSegmenter is unavailable.");
            }
            const delegate = imageSegmenterDelegate;
            const startedAt = performance.now();
            await new Promise<void>((resolve, reject) => {
              try {
                model.segmentForVideo(
                  source as ImageBitmap,
                  message.timestamp,
                  (result) => {
                    try {
                      const confidenceMask =
                        result.confidenceMasks?.[1] ??
                        result.confidenceMasks?.[0] ??
                        null;
                      const categoryMask = confidenceMask
                        ? null
                        : (result.categoryMask ?? null);
                      const transfer: Transferable[] = [];
                      const payload: {
                        type: "SEGMENTATION_RESULT";
                        sequence: number;
                        processingConfigId: number;
                        width: number;
                        height: number;
                        timestamp: number;
                        delegate: MediaPipeDelegate;
                        inputSource: ModelWorkerInputSource;
                        processingMs: number;
                        confidence?: Float32Array;
                        category?: Uint8Array;
                        qualityScores: number[];
                        confidenceMaskCount: number;
                        hasCategoryMask: boolean;
                      } = {
                        type: "SEGMENTATION_RESULT",
                        sequence: message.sequence,
                        processingConfigId: message.processingConfigId,
                        width:
                          confidenceMask?.width ?? categoryMask?.width ?? 0,
                        height:
                          confidenceMask?.height ?? categoryMask?.height ?? 0,
                        timestamp: message.timestamp,
                        delegate,
                        inputSource: message.sourceKind,
                        processingMs: performance.now() - startedAt,
                        qualityScores: Array.from(result.qualityScores ?? []),
                        confidenceMaskCount:
                          result.confidenceMasks?.length ?? 0,
                        hasCategoryMask: Boolean(result.categoryMask),
                      };

                      if (confidenceMask) {
                        payload.confidence = new Float32Array(
                          confidenceMask.getAsFloat32Array(),
                        );
                        transfer.push(payload.confidence.buffer);
                      } else if (categoryMask) {
                        payload.category = new Uint8Array(
                          categoryMask.getAsUint8Array(),
                        );
                        transfer.push(payload.category.buffer);
                      }

                      try {
                        result.close();
                      } catch {}
                      workerScope.postMessage(payload, transfer);
                      resolve();
                    } catch (err) {
                      try {
                        result.close();
                      } catch {}
                      reject(toError(err));
                    }
                  },
                );
              } catch (err) {
                reject(toError(err));
              }
            });
          } finally {
            activeSources.delete(source);
            try {
              source.close?.();
            } catch {}
          }
          break;
        }
        case "CLOSE":
          closeImageSegmenter();
          workerScope.postMessage({ type: "CLOSED" });
          break;
        default:
          throw new Error("Unknown segmentation processor worker message.");
      }
    } catch (err) {
      workerScope.postMessage({
        type: "ERROR",
        sequence:
          "sequence" in message && typeof message.sequence === "number"
            ? message.sequence
            : undefined,
        error: getErrorDebugSnapshot(err),
      });
    }
  })();
};
