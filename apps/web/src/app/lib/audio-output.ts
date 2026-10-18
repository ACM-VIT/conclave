import { errorName } from "./utils";

export const SYSTEM_AUDIO_OUTPUT = {
  deviceId: "",
  label: "System default speaker",
};

export const SYSTEM_AUDIO_OUTPUT_HINT =
  "Sound uses your device's current speaker or headphones. Change the output in your device's sound controls.";

export function getAudioOutputOptions(
  devices: readonly Pick<MediaDeviceInfo, "kind" | "deviceId" | "label">[],
  canSelectOutput: boolean,
) {
  const outputs = devices
    .filter((device) => device.kind === "audiooutput" && device.deviceId)
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Speaker ${index + 1}`,
    }));
  return canSelectOutput && outputs.length > 0
    ? outputs
    : [SYSTEM_AUDIO_OUTPUT];
}

type OutputRequest = { completion: Promise<boolean> };
const outputRequests = new WeakMap<HTMLMediaElement, OutputRequest>();

export function applyAudioOutputDevice(
  audio: HTMLMediaElement,
  deviceId = "",
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  const previous = outputRequests.get(audio);
  const request: OutputRequest = { completion: Promise.resolve(false) };
  const isLatest = () => outputRequests.get(audio) === request && isCurrent();
  // Serializing native changes also prevents a late successful switch from
  // overtaking the most recent selection. Superseded work skips its fallback.
  request.completion = Promise.resolve(previous?.completion)
    .catch(() => {})
    .then(async () => {
      if (!isLatest()) return false;
      if (typeof audio.setSinkId !== "function") return true;
      let nextDeviceId = deviceId;
      if (deviceId && typeof navigator !== "undefined" && navigator.mediaDevices?.enumerateDevices) {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          // setSinkId(currentSinkId) can succeed without checking availability.
          if (!devices.some((device) => device.kind === "audiooutput" && device.deviceId === deviceId)) {
            nextDeviceId = "";
          }
        } catch {
          // An enumeration failure is not evidence that a device disappeared.
        }
      }
      if (!isLatest()) return false;
      try {
        await audio.setSinkId(nextDeviceId);
      } catch (error) {
        if (!isLatest()) return false;
        if (!nextDeviceId || errorName(error) !== "NotFoundError") throw error;
        await audio.setSinkId("");
      }
      return isLatest();
    });
  outputRequests.set(audio, request);
  return request.completion;
}
