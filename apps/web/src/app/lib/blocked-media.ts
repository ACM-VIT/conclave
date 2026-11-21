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

// Phones and tablets: their browsers have no menu bar and are tapped.
export const isTouchDevice = (userAgent: string): boolean =>
  /iPhone|iPad|iPod|Android/.test(userAgent);

const devicesInWords = (devices: readonly BlockedDevice[]): string =>
  devices.length > 1 ? "camera and microphone" : devices[0];

// The name on the browser's own switch.
const settingName = (devices: readonly BlockedDevice[]): string =>
  devices.length > 1
    ? "Camera and Microphone"
    : devices[0] === "camera"
      ? "Camera"
      : "Microphone";

export const blockedTitle = (devices: readonly BlockedDevice[]): string =>
  `Your browser is blocking your ${devicesInWords(devices)}`;

export const blockedLead = (devices: readonly BlockedDevice[]): string =>
  devices.length > 1
    ? "Allow them so people can see and hear you."
    : devices[0] === "camera"
      ? "Allow it so people can see you."
      : "Allow it so people can hear you.";

// When the browser's own setting is already on, the device is blocked one
// level up, by the computer or the phone.
export const blockedFooter = (
  devices: readonly BlockedDevice[],
  touch: boolean,
): string =>
  `Still not working? In your ${
    touch ? "device's settings" : "computer's privacy settings"
  }, allow your browser to use your ${devicesInWords(devices)}.`;

export const unblockSteps = (
  browser: BrowserFamily,
  devices: readonly BlockedDevice[],
  touch: boolean,
): string[] => {
  const setting = settingName(devices);
  const [press, pressLower] = touch ? ["Tap", "tap"] : ["Click", "click"];
  switch (browser) {
    case "chrome":
      return [
        `${press} the icon to the left of the web address.`,
        touch
          ? `Tap Permissions, then turn on ${setting}.`
          : `Turn on ${setting}.`,
        `Come back and ${pressLower} Try again.`,
      ];
    case "safari":
      return touch
        ? [
            "Tap the button at the left of the address bar, then Website Settings.",
            `Set ${setting} to Allow.`,
            "Come back and tap Try again.",
          ]
        : [
            "In the menu bar, click Safari, then Settings for This Website.",
            `Next to ${setting}, choose Allow.`,
            "Come back and click Try again.",
          ];
    case "firefox":
      return [
        `${press} the crossed-out icon to the left of the web address.`,
        `${press} the X next to Blocked.`,
        `${press} Try again, then Allow.`,
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
