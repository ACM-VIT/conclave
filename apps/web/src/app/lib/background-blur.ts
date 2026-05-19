"use client";

import {
  LOW_QUALITY_CONSTRAINTS,
  STANDARD_QUALITY_CONSTRAINTS,
} from "./constants";
import type { VideoQuality } from "./types";
import type * as ThreeNamespace from "three";
import type { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export type CameraEffect =
  | "none"
  | "blur"
  | "party-hat"
  | "cat-ears"
  | "3d-glasses";

export type BackgroundEffect = CameraEffect;

export interface CameraEffectOption {
  id: CameraEffect;
  label: string;
  description: string;
  category: "background" | "face";
  experimental?: boolean;
}

export type BackgroundEffectOption = CameraEffectOption;

export const CAMERA_EFFECT_OPTIONS: CameraEffectOption[] = [
  {
    id: "none",
    label: "Original",
    description: "Raw camera feed",
    category: "background",
  },
  {
    id: "blur",
    label: "Blur",
    description: "Soft background blur",
    category: "background",
  },
  {
    id: "party-hat",
    label: "Party Hat",
    description: "Tiny celebration hat",
    category: "face",
  },
  {
    id: "cat-ears",
    label: "Cat Ears",
    description: "Pointed ears above your head",
    category: "face",
  },
  {
    id: "3d-glasses",
    label: "3D Glasses",
    description: "Model-tracked glasses",
    category: "face",
    experimental: true,
  },
];

export const BACKGROUND_EFFECT_OPTIONS = CAMERA_EFFECT_OPTIONS;

export const getCameraEffectOption = (effect: CameraEffect) =>
  CAMERA_EFFECT_OPTIONS.find((option) => option.id === effect);

export const getBackgroundEffectOption = getCameraEffectOption;

export interface ManagedCameraTrack {
  stream: MediaStream;
  track: MediaStreamTrack;
  stop: () => void;
}

interface CreateManagedCameraTrackOptions {
  effect: CameraEffect;
  quality: VideoQuality;
}

interface CreateManagedCameraTrackFromTrackOptions {
  effect: CameraEffect;
  sourceTrack: MediaStreamTrack;
}

const MEDIAPIPE_WASM_ROOT =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm";
const MEDIAPIPE_SELFIE_SEGMENTER_MODEL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";
const MEDIAPIPE_FACE_LANDMARKER_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
const BACKGROUND_BLUR_RADIUS_PX = 18;
const MASK_SOFTEN_RADIUS_PX = 4;
const PERSON_MASK_THRESHOLD = 0.5;
const BLUR_SETUP_TIMEOUT_MS = 2500;
const FACE_FILTER_SETUP_TIMEOUT_MS = 2500;

type SegmenterModule = typeof import("@mediapipe/tasks-vision");
type VisionModule = typeof import("@mediapipe/tasks-vision");
type FaceLandmarker = import("@mediapipe/tasks-vision").FaceLandmarker;
type Landmark = { x: number; y: number; z?: number };
type ThreeModule = {
  THREE: typeof ThreeNamespace;
  GLTFLoader: typeof GLTFLoader;
};
type ThreeFaceEffect = Extract<CameraEffect, "3d-glasses">;

interface ThreeFaceFilterConfig {
  id: ThreeFaceEffect;
  assetPath: string;
  placement: "eyewear";
  scale: number;
}

const THREE_FACE_FILTERS: Record<ThreeFaceEffect, ThreeFaceFilterConfig> = {
  "3d-glasses": {
    id: "3d-glasses",
    assetPath: "/face-filters/3d/glasses/scene.gltf",
    placement: "eyewear",
    scale: 1.18,
  },
};

let visionModulePromise: Promise<VisionModule> | null = null;
let segmenterPromise: Promise<import("@mediapipe/tasks-vision").ImageSegmenter> | null =
  null;
let faceLandmarkerPromise: Promise<FaceLandmarker> | null = null;
let threeModulePromise: Promise<ThreeModule> | null = null;
const threeModelPromises = new Map<string, Promise<ThreeNamespace.Object3D>>();

const getVideoConstraints = (
  quality: VideoQuality,
): MediaTrackConstraints => {
  return quality === "low"
    ? { ...LOW_QUALITY_CONSTRAINTS }
    : { ...STANDARD_QUALITY_CONSTRAINTS };
};

const loadSegmenterModule = async (): Promise<SegmenterModule> => {
  if (!visionModulePromise) {
    visionModulePromise = import("@mediapipe/tasks-vision");
  }

  return visionModulePromise;
};

const loadVisionModule = loadSegmenterModule;

const loadThreeModule = async (): Promise<ThreeModule> => {
  if (!threeModulePromise) {
    threeModulePromise = Promise.all([
      import("three"),
      import("three/examples/jsm/loaders/GLTFLoader.js"),
    ]).then(([THREE, { GLTFLoader }]) => ({ THREE, GLTFLoader }));
  }

  return threeModulePromise;
};

const loadThreeModel = async (assetPath: string) => {
  if (!threeModelPromises.has(assetPath)) {
    threeModelPromises.set(
      assetPath,
      loadThreeModule().then(
        ({ GLTFLoader }) =>
          new Promise<ThreeNamespace.Object3D>((resolve, reject) => {
            const loader = new GLTFLoader();
            loader.load(
              assetPath,
              (gltf) => resolve(gltf.scene),
              undefined,
              reject,
            );
          }),
      ),
    );
  }

  return threeModelPromises.get(assetPath)!;
};

const isThreeFaceEffect = (effect: CameraEffect): effect is ThreeFaceEffect =>
  effect in THREE_FACE_FILTERS;

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

const getFaceLandmarker = async () => {
  if (!faceLandmarkerPromise) {
    faceLandmarkerPromise = (async () => {
      const { FaceLandmarker, FilesetResolver } = await loadVisionModule();
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_ROOT);

      return FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MEDIAPIPE_FACE_LANDMARKER_MODEL,
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numFaces: 1,
      });
    })();

    faceLandmarkerPromise = faceLandmarkerPromise.catch((error) => {
      faceLandmarkerPromise = null;
      throw error;
    });
  }

  return faceLandmarkerPromise;
};

const getFaceLandmarkerWithTimeout = async () => {
  return Promise.race([
    getFaceLandmarker(),
    new Promise<never>((_, reject) => {
      window.setTimeout(() => {
        reject(new Error("Face filter setup timed out"));
      }, FACE_FILTER_SETUP_TIMEOUT_MS);
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

const getLandmarkPoint = (
  landmarks: Landmark[],
  index: number,
  width: number,
  height: number,
) => {
  const landmark = landmarks[index];
  return {
    x: (landmark?.x ?? 0) * width,
    y: (landmark?.y ?? 0) * height,
  };
};

const getAngle = (
  start: { x: number; y: number },
  end: { x: number; y: number },
) => Math.atan2(end.y - start.y, end.x - start.x);

const getDistance = (
  start: { x: number; y: number },
  end: { x: number; y: number },
) => Math.hypot(end.x - start.x, end.y - start.y);

const withFaceTransform = (
  context: CanvasRenderingContext2D,
  center: { x: number; y: number },
  angle: number,
  draw: () => void,
) => {
  context.save();
  context.translate(center.x, center.y);
  context.rotate(angle);
  draw();
  context.restore();
};

const drawPartyHat = (
  context: CanvasRenderingContext2D,
  center: { x: number; y: number },
  faceWidth: number,
  angle: number,
) => {
  withFaceTransform(context, center, angle, () => {
    const width = faceWidth * 0.34;
    const height = faceWidth * 0.5;

    context.fillStyle = "#F95F4A";
    context.strokeStyle = "rgba(255,255,255,0.85)";
    context.lineWidth = Math.max(3, faceWidth * 0.018);

    context.beginPath();
    context.moveTo(0, -height);
    context.lineTo(-width * 0.5, 0);
    context.lineTo(width * 0.5, 0);
    context.closePath();
    context.fill();
    context.stroke();

    context.fillStyle = "#FEFCD9";
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column <= row; column += 1) {
        const x = (column - row / 2) * width * 0.22;
        const y = -height * (0.25 + row * 0.18);
        context.beginPath();
        context.arc(x, y, Math.max(3, faceWidth * 0.018), 0, Math.PI * 2);
        context.fill();
      }
    }
  });
};

const drawCatEars = (
  context: CanvasRenderingContext2D,
  center: { x: number; y: number },
  faceWidth: number,
  angle: number,
) => {
  withFaceTransform(context, center, angle, () => {
    const earWidth = faceWidth * 0.2;
    const earHeight = faceWidth * 0.27;

    for (const direction of [-1, 1]) {
      const x = direction * faceWidth * 0.22;
      context.fillStyle = "#1d1d1d";
      context.strokeStyle = "rgba(255,255,255,0.32)";
      context.lineWidth = Math.max(3, faceWidth * 0.016);
      context.beginPath();
      context.moveTo(x, -earHeight);
      context.lineTo(x - direction * earWidth * 0.55, 0);
      context.lineTo(x + direction * earWidth * 0.55, 0);
      context.closePath();
      context.fill();
      context.stroke();

      context.fillStyle = "#f6a7b7";
      context.beginPath();
      context.moveTo(x, -earHeight * 0.6);
      context.lineTo(x - direction * earWidth * 0.25, -earHeight * 0.08);
      context.lineTo(x + direction * earWidth * 0.25, -earHeight * 0.08);
      context.closePath();
      context.fill();
    }
  });
};

const drawFaceOverlay = (
  context: CanvasRenderingContext2D,
  effect: CameraEffect,
  landmarks: Landmark[],
  width: number,
  height: number,
) => {
  const forehead = getLandmarkPoint(landmarks, 10, width, height);
  const chin = getLandmarkPoint(landmarks, 152, width, height);
  const leftEyeOuter = getLandmarkPoint(landmarks, 33, width, height);
  const rightEyeOuter = getLandmarkPoint(landmarks, 263, width, height);
  const faceAngle = getAngle(leftEyeOuter, rightEyeOuter);
  const faceWidth = Math.max(80, getDistance(leftEyeOuter, rightEyeOuter) * 2.25);
  const headTop = {
    x: forehead.x,
    y: forehead.y - getDistance(forehead, chin) * 0.22,
  };

  if (effect === "party-hat") {
    drawPartyHat(context, headTop, faceWidth, faceAngle);
  }
  if (effect === "cat-ears") {
    drawCatEars(context, headTop, faceWidth, faceAngle);
  }
};

const getLandmarkPoint3D = (
  landmarks: Landmark[],
  index: number,
  width: number,
  height: number,
) => {
  const landmark = landmarks[index];
  return {
    x: (landmark?.x ?? 0) * width,
    y: (landmark?.y ?? 0) * height,
    z: (landmark?.z ?? 0) * width,
  };
};

const transformLandmarksForThree = (landmarks: Landmark[]): Landmark[] => {
  const minZ = Math.max(-(landmarks[234]?.z ?? 0), -(landmarks[454]?.z ?? 0));

  return landmarks.map((landmark) => ({
    x: -0.5 + landmark.x,
    y: 0.5 - landmark.y,
    z: -(landmark.z ?? 0) - minZ,
  }));
};

const resizeThreeRenderer = (
  THREE: typeof ThreeNamespace,
  renderer: ThreeNamespace.WebGLRenderer,
  camera: ThreeNamespace.OrthographicCamera,
  width: number,
  height: number,
) => {
  const canvas = renderer.domElement;
  if (canvas.width === width && canvas.height === height) return;

  renderer.setSize(width, height, false);
  camera.left = -width / 2;
  camera.right = width / 2;
  camera.top = height / 2;
  camera.bottom = -height / 2;
  camera.near = -2000;
  camera.far = 2000;
  camera.position.set(0, 0, 1);
  camera.lookAt(new THREE.Vector3(0, 0, 0));
  camera.updateProjectionMatrix();
};

const applyEyewearPlacement = (
  THREE: typeof ThreeNamespace,
  model: ThreeNamespace.Object3D,
  landmarks: Landmark[],
  width: number,
  height: number,
  scaleFactor: number,
  config: ThreeFaceFilterConfig,
) => {
  const transformedLandmarks = transformLandmarksForThree(landmarks);
  const midEyes = getLandmarkPoint3D(transformedLandmarks, 168, width, height);
  const leftEyeInnerCorner = getLandmarkPoint3D(
    transformedLandmarks,
    463,
    width,
    height,
  );
  const rightEyeInnerCorner = getLandmarkPoint3D(
    transformedLandmarks,
    243,
    width,
    height,
  );
  const noseBottom = getLandmarkPoint3D(transformedLandmarks, 2, width, height);
  const leftEyeUpper = getLandmarkPoint3D(transformedLandmarks, 264, width, height);
  const rightEyeUpper = getLandmarkPoint3D(transformedLandmarks, 34, width, height);
  const eyeDistance = Math.hypot(
    leftEyeUpper.x - rightEyeUpper.x,
    leftEyeUpper.y - rightEyeUpper.y,
    leftEyeUpper.z - rightEyeUpper.z,
  );
  const scale = (eyeDistance / Math.max(scaleFactor, 0.0001)) * config.scale;
  const upVector = new THREE.Vector3(
    midEyes.x - noseBottom.x,
    midEyes.y - noseBottom.y,
    midEyes.z - noseBottom.z,
  ).normalize();
  const sideVector = new THREE.Vector3(
    leftEyeInnerCorner.x - rightEyeInnerCorner.x,
    leftEyeInnerCorner.y - rightEyeInnerCorner.y,
    leftEyeInnerCorner.z - rightEyeInnerCorner.z,
  ).normalize();
  const zRot =
    new THREE.Vector3(1, 0, 0).angleTo(
      upVector.clone().projectOnPlane(new THREE.Vector3(0, 0, 1)),
    ) -
    Math.PI / 2;
  const xRot =
    Math.PI / 2 -
    new THREE.Vector3(0, 0, 1).angleTo(
      upVector.clone().projectOnPlane(new THREE.Vector3(1, 0, 0)),
    );
  const yRot =
    new THREE.Vector3(sideVector.x, 0, sideVector.z).angleTo(
      new THREE.Vector3(0, 0, 1),
    ) -
    Math.PI / 2;

  model.visible = true;
  model.position.set(midEyes.x, midEyes.y, midEyes.z);
  model.scale.set(scale, scale, scale);
  model.rotation.set(xRot, yRot, zRot);
};

const drawVideoMirroredForThree = (
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number,
) => {
  context.save();
  context.scale(-1, 1);
  context.drawImage(video, -width, 0, width, height);
  context.restore();
};

const drawThreeCanvasUnmirrored = (
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
) => {
  context.save();
  context.scale(-1, 1);
  context.drawImage(canvas, -width, 0, width, height);
  context.restore();
};

const cloneThreeModel = (
  model: ThreeNamespace.Object3D,
  THREE: typeof ThreeNamespace,
) => {
  const clone = model.clone(true);
  clone.traverse((object) => {
    const mesh = object as ThreeNamespace.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry = mesh.geometry.clone();
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((material) => material.clone());
    } else {
      mesh.material = mesh.material.clone();
    }
    mesh.frustumCulled = false;
  });
  const box = new THREE.Box3().setFromObject(clone);
  const center = box.getCenter(new THREE.Vector3());
  clone.position.sub(center);
  return clone;
};

const primeGlassesMaterial = (model: ThreeNamespace.Object3D) => {
  model.traverse((object) => {
    const mesh = object as ThreeNamespace.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      material.transparent = true;
      material.opacity = 1;
      material.depthTest = true;
      material.depthWrite = true;
      material.needsUpdate = true;
    }
  });
};

const createThreeCamera = (
  THREE: typeof ThreeNamespace,
  width: number,
  height: number,
) => {
  const camera = new THREE.OrthographicCamera(
    -width / 2,
    width / 2,
    height / 2,
    -height / 2,
    -2000,
    2000,
  );
  camera.position.z = 1;
  camera.updateProjectionMatrix();
  return camera;
};

const createThreeFaceOverlayTrack = async (
  sourceStream: MediaStream,
  sourceTrack: MediaStreamTrack,
  effect: ThreeFaceEffect,
): Promise<ManagedCameraTrack> => {
  const [faceLandmarker, { THREE }] = await Promise.all([
    getFaceLandmarkerWithTimeout(),
    loadThreeModule(),
  ]);
  const config = THREE_FACE_FILTERS[effect];
  const sourceModel = await loadThreeModel(config.assetPath);
  const model = cloneThreeModel(sourceModel, THREE);
  primeGlassesMaterial(model);
  const modelBounds = new THREE.Box3().setFromObject(model);
  const modelSize = modelBounds.getSize(new THREE.Vector3());
  const scaleFactor = modelSize.x || 1;
  const video = document.createElement("video");
  const outputCanvas = document.createElement("canvas");
  const threeCanvas = document.createElement("canvas");
  const outputContext = outputCanvas.getContext("2d", {
    alpha: true,
    desynchronized: true,
  });

  if (!outputContext) {
    stopMediaStream(sourceStream);
    throw new Error("Canvas processing is unavailable in this browser");
  }

  const renderer = new THREE.WebGLRenderer({
    canvas: threeCanvas,
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = createThreeCamera(THREE, 1, 1);
  const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1.4);
  directionalLight.position.set(0, 1, 2);
  model.visible = false;
  scene.add(ambientLight);
  scene.add(directionalLight);
  scene.add(model);

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
    renderer.dispose();
    stopMediaStream(capturedStream);
    stopMediaStream(sourceStream);
    throw new Error("Unable to capture processed video stream");
  }

  if ("contentHint" in processedTrack) {
    processedTrack.contentHint = "motion";
  }

  let rafId = 0;
  let stopped = false;

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
    scene.remove(model);
    renderer.dispose();
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
      resizeThreeRenderer(THREE, renderer, camera, width, height);
    }

    outputContext.clearRect(0, 0, width, height);
    drawVideoMirroredForThree(outputContext, video, width, height);

    try {
      const result = faceLandmarker.detectForVideo(video, performance.now());
      const landmarks = result.faceLandmarks?.[0] as Landmark[] | undefined;

      if (landmarks?.length) {
        applyEyewearPlacement(
          THREE,
          model,
          landmarks,
          width,
          height,
          scaleFactor,
          config,
        );
      } else {
        model.visible = false;
      }

      renderer.clear();
      renderer.render(scene, camera);
      drawThreeCanvasUnmirrored(outputContext, threeCanvas, width, height);
    } catch (error) {
      model.visible = false;
      console.warn("[Meets] 3D face filter frame failed:", error);
    }

    rafId = window.requestAnimationFrame(renderFrame);
  };

  renderFrame();

  return {
    stream: new MediaStream([processedTrack]),
    track: processedTrack,
    stop,
  };
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

const createFaceOverlayTrack = async (
  sourceStream: MediaStream,
  sourceTrack: MediaStreamTrack,
  effect: CameraEffect,
): Promise<ManagedCameraTrack> => {
  const faceLandmarker = await getFaceLandmarkerWithTimeout();
  const video = document.createElement("video");
  const outputCanvas = document.createElement("canvas");
  const outputContext = outputCanvas.getContext("2d", {
    alpha: true,
    desynchronized: true,
  });

  if (!outputContext) {
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
    }

    outputContext.clearRect(0, 0, width, height);
    outputContext.drawImage(video, 0, 0, width, height);

    try {
      const result = faceLandmarker.detectForVideo(video, performance.now());
      const landmarks = result.faceLandmarks?.[0] as Landmark[] | undefined;

      if (landmarks?.length) {
        drawFaceOverlay(outputContext, effect, landmarks, width, height);
      }
    } catch (error) {
      console.warn("[Meets] Face filter frame failed:", error);
    }

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
    if (effect === "blur") {
      return await createBlurredTrack(sourceStream, sourceTrack);
    }
    if (isThreeFaceEffect(effect)) {
      return await createThreeFaceOverlayTrack(sourceStream, sourceTrack, effect);
    }

    return await createFaceOverlayTrack(sourceStream, sourceTrack, effect);
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
    if (effect === "blur") {
      return await createBlurredTrack(sourceStream, clonedTrack);
    }
    if (isThreeFaceEffect(effect)) {
      return await createThreeFaceOverlayTrack(sourceStream, clonedTrack, effect);
    }

    return await createFaceOverlayTrack(sourceStream, clonedTrack, effect);
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
