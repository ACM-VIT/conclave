import { errorName } from "./utils";

export type BlockedDevice = "camera" | "microphone";
export type BrowserFamily = "chrome" | "safari" | "firefox";

export const BROWSER_FAMILIES: readonly BrowserFamily[] = [
  "chrome",
  "safari",
  "firefox",
];

export const BROWSER_LABELS: Record<BrowserFamily, string> = {
  chrome: "Chrome",
  safari: "Safari",
  firefox: "Firefox",
};

// iPhone and iPad browsers all use Safari's permission settings.
export const detectBrowserFamily = (userAgent: string): BrowserFamily => {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "safari";
  if (/Firefox\//.test(userAgent)) return "firefox";
  if (
    /Safari\//.test(userAgent) &&
    !/Chrome|Chromium|Edg|OPR|SamsungBrowser/.test(userAgent)
  ) {
    return "safari";
  }
  return "chrome";
};

const deviceNoun = (devices: readonly BlockedDevice[]): string =>
  devices.length > 1
    ? "Camera and Microphone"
    : devices[0] === "camera"
      ? "Camera"
      : "Microphone";

export const blockedTitle = (devices: readonly BlockedDevice[]): string =>
  devices.length > 1
    ? "Camera and microphone are blocked"
    : devices[0] === "camera"
      ? "Camera is blocked"
      : "Microphone is blocked";

export const unblockSteps = (
  browser: BrowserFamily,
  devices: readonly BlockedDevice[],
): string[] => {
  const noun = deviceNoun(devices);
  switch (browser) {
    case "chrome":
      return [
        "Select the site settings icon to the left of the web address.",
        `Turn on ${noun}.`,
        "Come back here and select Try again.",
      ];
    case "safari":
      return [
        "Choose Safari > Settings for This Website. On iPhone or iPad, tap aA in the address bar, then Website Settings.",
        `Set ${noun} to Allow.`,
        "Come back here and select Try again.",
      ];
    case "firefox":
      return [
        "Select the crossed-out icon to the left of the web address.",
        "Select the X next to Blocked to clear it.",
        "Select Try again, then choose Allow.",
      ];
  }
};

// The blocked devices the visitor has since allowed in the browser. Each is
// worth trying again by itself, whatever the other one's state.
export const blockedDevicesNowGranted = (
  blocked: readonly BlockedDevice[],
  permissionStates: Record<BlockedDevice, string>,
): BlockedDevice[] =>
  blocked.filter((device) => permissionStates[device] === "granted");

/**
 * Whether a failed capture means the browser or the OS blocks the device, as
 * opposed to a dismissed prompt (state stays "prompt", so asking again
 * works) or a missing or busy device.
 */
export const isCaptureBlocked = async (
  device: BlockedDevice,
  error: unknown,
): Promise<boolean> => {
  const name = errorName(error);
  if (name !== "NotAllowedError" && name !== "SecurityError") return false;
  try {
    const status = await navigator.permissions.query({ name: device });
    return status.state !== "prompt";
  } catch {
    return true;
  }
};
