import type { MeetMediaDevice } from "./types";

interface RetryFailedMediaDevicesOptions {
  device: MeetMediaDevice;
  isMuted: boolean;
  isCameraOff: boolean;
  unmute: () => Promise<void>;
  turnOnCamera: () => Promise<void>;
}

export async function retryFailedMediaDevices({
  device,
  isMuted,
  isCameraOff,
  unmute,
  turnOnCamera,
}: RetryFailedMediaDevicesOptions): Promise<void> {
  if (device !== "camera" && isMuted) await unmute();
  if (device !== "microphone" && isCameraOff) await turnOnCamera();
}
