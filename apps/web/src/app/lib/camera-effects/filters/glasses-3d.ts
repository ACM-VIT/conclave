"use client";

import type * as ThreeNamespace from "three";
import type { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  getLandmarkPoint3D,
  transformLandmarksForThree,
} from "../landmarks";
import { getFaceLandmarkerWithTimeout } from "../mediapipe";
import { stopMediaStream, waitForVideoReady } from "../media";
import type { CameraEffect, Landmark, ManagedCameraTrack } from "../types";

type ThreeModule = {
  THREE: typeof ThreeNamespace;
  GLTFLoader: typeof GLTFLoader;
  MeshoptDecoder: typeof MeshoptDecoder;
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
    assetPath: "/face-filters/3d/glasses/glasses.glb",
    placement: "eyewear",
    scale: 1.18,
  },
};

let threeModulePromise: Promise<ThreeModule> | null = null;
const threeModelPromises = new Map<string, Promise<ThreeNamespace.Object3D>>();

const loadThreeModule = async (): Promise<ThreeModule> => {
  if (!threeModulePromise) {
    threeModulePromise = Promise.all([
      import("three"),
      import("three/examples/jsm/loaders/GLTFLoader.js"),
      import("three/examples/jsm/libs/meshopt_decoder.module.js"),
    ]).then(([THREE, { GLTFLoader }, { MeshoptDecoder }]) => ({
      THREE,
      GLTFLoader,
      MeshoptDecoder,
    }));
  }

  return threeModulePromise;
};

const loadThreeModel = async (assetPath: string) => {
  if (!threeModelPromises.has(assetPath)) {
    threeModelPromises.set(
      assetPath,
      loadThreeModule().then(
        ({ GLTFLoader, MeshoptDecoder }) =>
          new Promise<ThreeNamespace.Object3D>((resolve, reject) => {
            const loader = new GLTFLoader();
            loader.setMeshoptDecoder(MeshoptDecoder);
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

export const isThreeFaceEffect = (
  effect: CameraEffect,
): effect is ThreeFaceEffect => effect in THREE_FACE_FILTERS;

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
  const leftEyeUpper = getLandmarkPoint3D(
    transformedLandmarks,
    264,
    width,
    height,
  );
  const rightEyeUpper = getLandmarkPoint3D(
    transformedLandmarks,
    34,
    width,
    height,
  );
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
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];
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

export const createThreeFaceOverlayTrack = async (
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
    outputContext.drawImage(video, 0, 0, width, height);

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
      outputContext.drawImage(threeCanvas, 0, 0, width, height);
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
