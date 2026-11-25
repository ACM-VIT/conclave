import { expect, it } from "vitest";
import {
  createMeetError,
  isCameraAccessBlocked,
} from "../src/app/lib/utils";

const deniedCamera = createMeetError(
  new DOMException("Permission denied", "NotAllowedError"),
  "PERMISSION_DENIED",
  "camera",
);
const deniedMicrophone = createMeetError(
  new DOMException("Permission denied", "NotAllowedError"),
  "PERMISSION_DENIED",
  "microphone",
);

it.each([
  [true, "granted", deniedCamera, false],
  [true, "denied", deniedCamera, false],
  [true, "prompt", null, false],
  [true, "unknown", deniedCamera, false],
  [false, "granted", deniedCamera, false],
  [false, "denied", deniedCamera, true],
  [false, "prompt", deniedCamera, true],
  [false, "unknown", deniedCamera, true],
  [false, "denied", null, true],
  [false, "prompt", null, true],
  [false, "granted", null, false],
  [false, "unknown", null, false],
  [false, "granted", deniedMicrophone, false],
  [false, "unknown", deniedMicrophone, false],
] as const)(
  "live camera %s, permission %s, saved error %o: blocked is %s",
  (hasLiveCamera, permissionState, mediaError, blocked) => {
    expect(
      isCameraAccessBlocked({ hasLiveCamera, permissionState, mediaError }),
    ).toBe(blocked);
  },
);
