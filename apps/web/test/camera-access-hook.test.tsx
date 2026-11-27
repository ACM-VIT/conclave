// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCameraAccessBlocked } from "../src/app/hooks/useCameraAccessBlocked";
import { createMeetError } from "../src/app/lib/utils";
import type { MeetError } from "../src/app/lib/types";

const deniedCamera = createMeetError(
  new DOMException("Permission denied", "NotAllowedError"),
  "PERMISSION_DENIED",
  "camera",
);

class FakePermissionStatus extends EventTarget {
  constructor(public state: PermissionState) {
    super();
  }
  set(next: PermissionState) {
    this.state = next;
    this.dispatchEvent(new Event("change"));
  }
}

let container: HTMLDivElement;
let root: Root;
let blocked: boolean | null = null;
let status: FakePermissionStatus;

function Probe({ hasLiveCamera, mediaError }: { hasLiveCamera: boolean; mediaError: MeetError | null }) {
  blocked = useCameraAccessBlocked({ hasLiveCamera, mediaError });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  status = new FakePermissionStatus("denied");
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: { query: vi.fn(async () => status) },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("unblocks the camera when the live permission turns granted after a failed capture", async () => {
  await act(async () => root.render(<Probe hasLiveCamera={false} mediaError={deniedCamera} />));
  expect(blocked).toBe(true);

  await act(async () => status.set("granted"));
  expect(blocked).toBe(false);

  await act(async () => status.set("denied"));
  expect(blocked).toBe(true);
});

it("trusts the saved failure only while the browser cannot report the permission", async () => {
  Object.defineProperty(navigator, "permissions", { configurable: true, value: undefined });
  await act(async () => root.render(<Probe hasLiveCamera={false} mediaError={deniedCamera} />));
  expect(blocked).toBe(true);

  await act(async () => root.render(<Probe hasLiveCamera mediaError={deniedCamera} />));
  expect(blocked).toBe(false);
});
