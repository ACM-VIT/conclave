import { describe, expect, it } from "vitest";
import { acquireLocalTracks } from "../src/app/lib/media-acquisition";
import {
  clearMediaDeviceError,
  createMediaDeviceError,
  createMeetError,
  mediaErrorAdvice,
  mergeMediaDeviceError,
} from "../src/app/lib/utils";

type Device = "microphone" | "camera";
type State = "ok" | "blocked" | "missing" | "busy" | "unresponsive";

const FAILURES: Record<Exclude<State, "ok">, () => Error> = {
  blocked: () => new DOMException("Permission denied", "NotAllowedError"),
  missing: () => new DOMException("Requested device not found", "NotFoundError"),
  busy: () => new DOMException("Could not start video source", "NotReadableError"),
  unresponsive: () => new DOMException("Timed out", "TimeoutError"),
};

const MESSAGE: Record<Exclude<State, "ok">, Record<Device | "both", string>> = {
  blocked: { microphone: "Microphone is blocked", camera: "Camera is blocked", both: "Camera and microphone are blocked" },
  missing: { microphone: "No microphone found", camera: "No camera found", both: "No camera or microphone found" },
  busy: { microphone: "Microphone is in use", camera: "Camera is in use", both: "Camera and microphone are in use" },
  unresponsive: { microphone: "Microphone didn’t respond", camera: "Camera didn’t respond", both: "Camera and microphone didn’t respond" },
};

const ADVICE: Record<Exclude<State, "ok">, Record<Device | "both", string>> = {
  blocked: {
    microphone: "allow microphone access in your browser",
    camera: "allow camera access in your browser",
    both: "allow camera and microphone access in your browser",
  },
  missing: {
    microphone: "connect or select a microphone",
    camera: "connect or select a camera",
    both: "connect or select a camera and microphone",
  },
  busy: {
    microphone: "close other apps that are using your microphone",
    camera: "close other apps that are using your camera",
    both: "close other apps that are using your camera and microphone",
  },
  unresponsive: {
    microphone: "check that your microphone isn’t in use by another app",
    camera: "check that your camera isn’t in use by another app",
    both: "check that your camera and microphone aren’t in use by another app",
  },
};

const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}, then try again.`;
const lowerFirst = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

function expected(mic: State, camera: State) {
  if (mic === "ok" && camera === "ok") return null;
  if (camera === "ok") return { device: "microphone", message: MESSAGE[mic as Exclude<State, "ok">].microphone, advice: sentence(ADVICE[mic as Exclude<State, "ok">].microphone) };
  if (mic === "ok") return { device: "camera", message: MESSAGE[camera].camera, advice: sentence(ADVICE[camera].camera) };
  if (mic === camera) return { device: "both", message: MESSAGE[mic].both, advice: sentence(ADVICE[mic].both) };
  return {
    device: "both",
    message: `${MESSAGE[mic].microphone} and ${lowerFirst(MESSAGE[camera].camera)}`,
    advice: sentence(`${ADVICE[mic].microphone}, and ${ADVICE[camera].camera}`),
  };
}

const observe = (error: ReturnType<typeof createMediaDeviceError>) =>
  error && { device: error.device, message: error.message, advice: mediaErrorAdvice(error) };

async function joinWith(mic: State, camera: State) {
  const fails = (device: Device) => (device === "microphone" ? mic : camera) !== "ok";
  const { failures } = await acquireLocalTracks({
    audio: true,
    video: true,
    request: async (audio, video) => {
      const failing = [audio && "microphone", video && "camera"].find(
        (device): device is Device => Boolean(device) && fails(device as Device),
      );
      if (failing) throw FAILURES[(failing === "microphone" ? mic : camera) as Exclude<State, "ok">]();
      return {} as MediaStream;
    },
  });
  return createMediaDeviceError(failures, "PERMISSION_DENIED");
}

const STATES: State[] = ["ok", "blocked", "missing", "busy", "unresponsive"];
const COMBINATIONS = STATES.flatMap((mic) => STATES.map((camera) => [mic, camera] as const));

describe("media device errors for every microphone and camera state", () => {
  it.each(COMBINATIONS)("joining with the microphone %s and the camera %s", async (mic, camera) => {
    expect(observe(await joinWith(mic, camera))).toEqual(expected(mic, camera));
  });

  it.each(COMBINATIONS)("toggling the microphone %s, then the camera %s", (mic, camera) => {
    let error = null as ReturnType<typeof createMediaDeviceError>;
    if (mic !== "ok") error = mergeMediaDeviceError(error, createMeetError(FAILURES[mic](), "MEDIA_ERROR", "microphone"));
    if (camera !== "ok") error = mergeMediaDeviceError(error, createMeetError(FAILURES[camera](), "MEDIA_ERROR", "camera"));
    expect(observe(error)).toEqual(expected(mic, camera));
  });

  it.each(COMBINATIONS)("recovering the microphone %s and the camera %s in either order", async (mic, camera) => {
    const error = await joinWith(mic, camera);
    const afterMic = clearMediaDeviceError(error, "microphone");
    expect(observe(afterMic)).toEqual(expected("ok", camera));
    expect(clearMediaDeviceError(afterMic, "camera")).toBeNull();
    const afterCamera = clearMediaDeviceError(error, "camera");
    expect(observe(afterCamera)).toEqual(expected(mic, "ok"));
    expect(clearMediaDeviceError(afterCamera, "microphone")).toBeNull();
  });
});
