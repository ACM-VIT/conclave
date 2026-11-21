// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BlockedMediaDialog from "../src/app/components/BlockedMediaDialog";
import {
  blockedDevicesNowGranted,
  detectBrowserFamily,
  isCaptureBlocked,
} from "../src/app/lib/blocked-media";

const UA = {
  chrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  edge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  safari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
  firefox:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
};

let root: Root;
let host: HTMLDivElement;

const text = () => host.textContent ?? "";
const button = (label: string) => {
  const match = Array.from(host.querySelectorAll("button")).find(
    (candidate) =>
      candidate.textContent === label ||
      candidate.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`No button "${label}"`);
  return match;
};

const renderDialog = async (
  props: Partial<Parameters<typeof BlockedMediaDialog>[0]> = {},
) => {
  const onRetry = vi.fn();
  const onClose = vi.fn();
  await act(async () =>
    root.render(
      <BlockedMediaDialog
        devices={["camera"]}
        isRetrying={false}
        onRetry={onRetry}
        onClose={onClose}
        {...props}
      />,
    ),
  );
  return { onRetry, onClose };
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("blocked camera or microphone dialog", () => {
  it("opens on the visitor's own browser with its steps", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(UA.firefox);
    await renderDialog({ devices: ["camera", "microphone"] });

    expect(text()).toContain("Your browser is blocking your camera and microphone");
    expect(text()).toContain("Allow them so people can see and hear you.");
    expect(button("Firefox").getAttribute("aria-pressed")).toBe("true");
    expect(text()).toContain("Click the X next to Blocked.");
  });

  it("switches to another browser's steps", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(UA.chrome);
    await renderDialog();
    expect(text()).toContain("Your browser is blocking your camera");
    expect(text()).toContain("Allow it so people can see you.");
    expect(text()).toContain("Click the icon to the left of the web address.");
    expect(text()).toContain("Turn on Camera.");
    expect(text()).toContain("Come back and click Try again.");

    await act(async () => button("Safari").click());
    expect(button("Safari").getAttribute("aria-pressed")).toBe("true");
    expect(text()).toContain("In the menu bar, click Safari, then Settings for This Website.");
  });

  it("says what to check when the browser is not the one blocking", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(UA.chrome);
    await renderDialog({ devices: ["microphone"] });

    expect(text()).toContain("Your browser is blocking your microphone");
    expect(text()).toContain("Allow it so people can hear you.");
    expect(text()).toContain("Turn on Microphone.");
    expect(text()).toContain(
      "Still not working? In your computer's privacy settings, allow your browser to use your microphone.",
    );
  });

  it("gives phone steps to someone on a phone", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(UA.iphoneChrome);
    await renderDialog({ devices: ["camera", "microphone"] });

    expect(button("Safari").getAttribute("aria-pressed")).toBe("true");
    expect(text()).toContain("Tap the button at the left of the address bar, then Website Settings.");
    expect(text()).toContain("Set Camera and Microphone to Allow.");
    expect(text()).toContain("Come back and tap Try again.");
    expect(text()).toContain("In your device's settings, allow your browser to use your camera and microphone.");
    expect(text()).not.toContain("Click");

    await act(async () => button("Chrome").click());
    expect(text()).toContain("Tap the icon to the left of the web address.");
    expect(text()).toContain("Tap Permissions, then turn on Camera and Microphone.");
  });

  it("shows no icon beside the title", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(UA.chrome);
    await renderDialog();

    const icons = Array.from(host.querySelectorAll('[role="dialog"] svg'));
    expect(icons.every((icon) => icon.closest("button"))).toBe(true);
  });

  it("retries from the focused primary button and closes on Escape", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(UA.chrome);
    const { onRetry, onClose } = await renderDialog({ devices: ["microphone"] });

    expect(document.activeElement).toBe(button("Try again"));
    await act(async () => button("Try again").click());
    expect(onRetry).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("matches each browser to the right steps", () => {
    expect(detectBrowserFamily(UA.chrome)).toBe("chrome");
    expect(detectBrowserFamily(UA.edge)).toBe("chrome");
    expect(detectBrowserFamily(UA.safari)).toBe("safari");
    expect(detectBrowserFamily(UA.iphoneChrome)).toBe("safari");
    expect(detectBrowserFamily(UA.firefox)).toBe("firefox");
  });
});

describe("telling a blocked device from a dismissed prompt", () => {
  const permissionsReturning = (state: PermissionState) => ({
    query: vi.fn(async () => ({ state })),
  });
  const notAllowed = new DOMException("Permission denied", "NotAllowedError");

  it("treats a denied permission as blocked", async () => {
    vi.stubGlobal("navigator", { permissions: permissionsReturning("denied") });
    await expect(isCaptureBlocked("camera", notAllowed)).resolves.toBe(true);
  });

  it("treats a granted permission that still fails as an OS block", async () => {
    vi.stubGlobal("navigator", { permissions: permissionsReturning("granted") });
    await expect(isCaptureBlocked("microphone", notAllowed)).resolves.toBe(true);
  });

  it("lets a dismissed prompt ask again", async () => {
    vi.stubGlobal("navigator", { permissions: permissionsReturning("prompt") });
    await expect(isCaptureBlocked("camera", notAllowed)).resolves.toBe(false);
  });

  it("ignores a missing device", async () => {
    vi.stubGlobal("navigator", { permissions: permissionsReturning("denied") });
    const missing = new DOMException("Requested device not found", "NotFoundError");
    await expect(isCaptureBlocked("camera", missing)).resolves.toBe(false);
  });

  it("assumes blocked when the browser cannot say", async () => {
    vi.stubGlobal("navigator", {});
    await expect(isCaptureBlocked("camera", notAllowed)).resolves.toBe(true);
  });
});

describe("recovering once a blocked device is allowed", () => {
  it("retries the microphone as soon as it is allowed, with the camera still blocked", () => {
    expect(
      blockedDevicesNowGranted(["camera", "microphone"], {
        camera: "denied",
        microphone: "granted",
      }),
    ).toEqual(["microphone"]);
  });

  it("retries both when both are allowed", () => {
    expect(
      blockedDevicesNowGranted(["camera", "microphone"], {
        camera: "granted",
        microphone: "granted",
      }),
    ).toEqual(["camera", "microphone"]);
  });

  it("leaves a device that was never blocked alone", () => {
    expect(
      blockedDevicesNowGranted(["camera"], {
        camera: "denied",
        microphone: "granted",
      }),
    ).toEqual([]);
  });
});
