import type { MeetMediaDevice } from "./types";

type RetryDevice = Exclude<MeetMediaDevice, "both">;

interface RetryFailedMediaDevicesOptions {
  device: MeetMediaDevice;
  isOn: (device: RetryDevice) => boolean;
  turnOn: (device: RetryDevice) => Promise<void>;
  markRecovered: (device: RetryDevice) => void;
}

export async function retryFailedMediaDevices({
  device,
  isOn,
  turnOn,
  markRecovered,
}: RetryFailedMediaDevicesOptions): Promise<void> {
  const devices: RetryDevice[] =
    device === "both" ? ["microphone", "camera"] : [device];
  for (const next of devices) {
    if (isOn(next)) markRecovered(next);
    else await turnOn(next);
  }
}
