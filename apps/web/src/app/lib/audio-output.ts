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

export async function applyAudioOutputDevice(
  audio: HTMLMediaElement,
  deviceId = "",
): Promise<void> {
  if (typeof audio.setSinkId !== "function") return;
  try {
    await audio.setSinkId(deviceId);
  } catch (error) {
    // A disconnected headset must not leave the meeting routed to a dead sink.
    if (!deviceId || errorName(error) !== "NotFoundError") throw error;
    await audio.setSinkId("");
  }
}
