import {
  FaceLandmarker,
  FilesetResolver,
  type Matrix,
} from "@mediapipe/tasks-vision";

type MediaPipeDelegate = "GPU" | "CPU";
type ModelWorkerInputSource = "video-frame" | "image-bitmap";
type WorkerVideoFrame = CanvasImageSource & {
  close?: () => void;
};
type WorkerModelFrameSource = ImageBitmap | WorkerVideoFrame;
type WorkerFaceLandmark = {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
};
type FacePoseCandidate = {
  basis: "row-major" | "column-major";
  roll: number;
  yaw: number;
  pitch: number;
  scale: number;
};
type FacePoseTransform = {
  rows: number;
  columns: number;
  candidates: FacePoseCandidate[];
};
type FaceProcessorRequest =
  | { type: "INIT" }
  | {
      type: "FACE";
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
const TASKS_FACE_LANDMARKER_MODEL_LOCAL_PATH =
  "/mediapipe/models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
const TASKS_FACE_LANDMARKER_MODEL_CDN =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
const TASKS_FACE_LANDMARKER_MODELS = [
  { source: "same-origin", url: TASKS_FACE_LANDMARKER_MODEL_LOCAL_PATH },
  { source: "google-storage", url: TASKS_FACE_LANDMARKER_MODEL_CDN },
] as const;

let faceLandmarker: FaceLandmarker | null = null;
let faceLandmarkerDelegate: MediaPipeDelegate | null = null;
let faceLandmarkerPromise: Promise<FaceLandmarker | null> | null = null;
let gpuCanvas: OffscreenCanvas | null = null;
let closed = false;
const activeSources = new Set<WorkerModelFrameSource>();

const workerScope = self as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent<FaceProcessorRequest>) => void) | null;
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

const roundPoseNumber = (value: number) => Number(value.toFixed(4));

const getMatrixValue = (data: number[], columns: number, row: number, col: number) =>
  data[row * columns + col] ?? 0;

const createFacePoseCandidate = (
  basis: FacePoseCandidate["basis"],
  xAxis: { x: number; y: number; z: number },
  yAxis: { x: number; y: number; z: number },
) => {
  const xScale = Math.hypot(xAxis.x, xAxis.y, xAxis.z);
  const yScale = Math.hypot(yAxis.x, yAxis.y, yAxis.z);
  const scale = (xScale + yScale) / 2;
  if (!Number.isFinite(scale) || scale <= 0.0001) return null;

  return {
    basis,
    roll: roundPoseNumber(Math.atan2(xAxis.y, xAxis.x)),
    yaw: roundPoseNumber(Math.asin(clamp(-xAxis.z / xScale, -1, 1))),
    pitch: roundPoseNumber(Math.asin(clamp(yAxis.z / yScale, -1, 1))),
    scale: roundPoseNumber(scale),
  };
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const extractFacePoseTransform = (matrix: Matrix | undefined) => {
  if (!matrix || matrix.rows < 3 || matrix.columns < 3) return null;
  const data = Array.isArray(matrix.data) ? matrix.data : [];
  if (data.length < matrix.rows * matrix.columns) return null;

  const rowMajor = createFacePoseCandidate(
    "row-major",
    {
      x: getMatrixValue(data, matrix.columns, 0, 0),
      y: getMatrixValue(data, matrix.columns, 0, 1),
      z: getMatrixValue(data, matrix.columns, 0, 2),
    },
    {
      x: getMatrixValue(data, matrix.columns, 1, 0),
      y: getMatrixValue(data, matrix.columns, 1, 1),
      z: getMatrixValue(data, matrix.columns, 1, 2),
    },
  );
  const columnMajor = createFacePoseCandidate(
    "column-major",
    {
      x: getMatrixValue(data, matrix.columns, 0, 0),
      y: getMatrixValue(data, matrix.columns, 1, 0),
      z: getMatrixValue(data, matrix.columns, 2, 0),
    },
    {
      x: getMatrixValue(data, matrix.columns, 0, 1),
      y: getMatrixValue(data, matrix.columns, 1, 1),
      z: getMatrixValue(data, matrix.columns, 2, 1),
    },
  );
  const candidates = [rowMajor, columnMajor].filter(
    (candidate): candidate is FacePoseCandidate => Boolean(candidate),
  );
  if (candidates.length <= 0) return null;

  return {
    rows: matrix.rows,
    columns: matrix.columns,
    candidates,
  } satisfies FacePoseTransform;
};

const createFaceLandmarker = async (delegate: MediaPipeDelegate) => {
  const fileset = await FilesetResolver.forVisionTasks(
    TASKS_VISION_WASM_LOCAL_PATH,
  );
  let lastError: unknown = null;

  for (const model of TASKS_FACE_LANDMARKER_MODELS) {
    try {
      if (delegate === "GPU" && typeof OffscreenCanvas !== "undefined") {
        gpuCanvas ??= new OffscreenCanvas(1, 1);
      }
      return await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: model.url,
          delegate,
        },
        canvas: delegate === "GPU" ? gpuCanvas ?? undefined : undefined,
        runningMode: "VIDEO",
        numFaces: 1,
        minFaceDetectionConfidence: 0.55,
        minFacePresenceConfidence: 0.55,
        minTrackingConfidence: 0.55,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: true,
      });
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to create worker FaceLandmarker");
};

const ensureFaceLandmarker = async () => {
  if (faceLandmarker || closed) return faceLandmarker;
  if (faceLandmarkerPromise) return faceLandmarkerPromise;

  faceLandmarkerPromise = (async () => {
    try {
      faceLandmarker = await createFaceLandmarker("GPU");
      faceLandmarkerDelegate = "GPU";
    } catch {
      faceLandmarker = await createFaceLandmarker("CPU");
      faceLandmarkerDelegate = "CPU";
    }
    return faceLandmarker;
  })();

  void faceLandmarkerPromise
    .catch(() => undefined)
    .finally(() => {
      faceLandmarkerPromise = null;
    });
  return faceLandmarkerPromise;
};

const closeFaceLandmarker = () => {
  closed = true;
  for (const source of activeSources) {
    try {
      source.close?.();
    } catch {}
  }
  activeSources.clear();
  try {
    faceLandmarker?.close();
  } catch {}
  faceLandmarker = null;
  faceLandmarkerDelegate = null;
  faceLandmarkerPromise = null;
  gpuCanvas = null;
};

workerScope.onmessage = (event) => {
  const message = event.data;
  void (async () => {
    try {
      switch (message.type) {
        case "INIT": {
          closed = false;
          const model = await ensureFaceLandmarker();
          if (!model || !faceLandmarkerDelegate) {
            throw new Error("Worker FaceLandmarker did not initialize.");
          }
          workerScope.postMessage({
            type: "READY",
            delegate: faceLandmarkerDelegate,
          });
          break;
        }
        case "FACE": {
          const source = message.source;
          activeSources.add(source);
          try {
            const model = await ensureFaceLandmarker();
            if (!model || !faceLandmarkerDelegate) {
              throw new Error("Worker FaceLandmarker is unavailable.");
            }
            const startedAt = performance.now();
            const result = model.detectForVideo(
              source as ImageBitmap,
              message.timestamp,
            );
            const landmarks =
              (result.faceLandmarks?.[0] as WorkerFaceLandmark[] | undefined) ??
              null;
            const payload = {
              type: "FACE_RESULT",
              sequence: message.sequence,
              processingConfigId: message.processingConfigId,
              landmarks,
              faceCount: result.faceLandmarks?.length ?? 0,
              blendshapeCount: result.faceBlendshapes?.length ?? 0,
              matrixCount: result.facialTransformationMatrixes?.length ?? 0,
              pose: extractFacePoseTransform(
                result.facialTransformationMatrixes?.[0],
              ),
              width: message.width,
              height: message.height,
              timestamp: message.timestamp,
              delegate: faceLandmarkerDelegate,
              inputSource: message.sourceKind,
              processingMs: performance.now() - startedAt,
            };
            workerScope.postMessage(payload);
          } finally {
            activeSources.delete(source);
            try {
              source.close?.();
            } catch {}
          }
          break;
        }
        case "CLOSE":
          closeFaceLandmarker();
          workerScope.postMessage({ type: "CLOSED" });
          break;
        default:
          throw new Error("Unknown face processor worker message.");
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
