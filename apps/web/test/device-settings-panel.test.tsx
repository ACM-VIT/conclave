// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DeviceSettingsPanel from "../src/app/components/DeviceSettingsPanel";
import {
  applyCameraQualityPreset,
  DEFAULT_MEDIA_QUALITY_SETTINGS,
  type MediaQualitySettings,
} from "../src/app/lib/media-quality-settings";

let container: HTMLDivElement;
let root: Root;
let latest: MediaQualitySettings;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: vi.fn(async () => []),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
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

function Harness({
  initial,
  effectsCount = 0,
  onOpenEffects,
}: {
  initial: MediaQualitySettings;
  effectsCount?: number;
  onOpenEffects?: () => void;
}) {
  const [settings, setSettings] = useState(initial);
  latest = settings;
  return (
    <DeviceSettingsPanel
      localStream={null}
      isLocalVideoLive={false}
      isPreviewOnly={false}
      mirrorLocalPreview={false}
      activeVideoEffectsCount={effectsCount}
      mediaQualitySettings={settings}
      onMediaQualitySettingsChange={setSettings}
      onOpenEffects={onOpenEffects}
      onClose={() => {}}
    />
  );
}

const render = async (props: Parameters<typeof Harness>[0]) => {
  await act(async () => root.render(<Harness {...props} />));
};

const click = async (element: Element | null | undefined) => {
  if (!(element instanceof HTMLElement)) throw new Error("missing element");
  await act(async () => element.click());
};

const buttonNamed = (name: string) =>
  Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === name,
  );

const sectionText = (label: string) =>
  Array.from(container.querySelectorAll("section")).find(
    (section) => section.querySelector("h3")?.textContent === label,
  )?.textContent ?? "";

it("labels custom quality as plain text and drops it once a preset is chosen", async () => {
  const custom: MediaQualitySettings = {
    ...DEFAULT_MEDIA_QUALITY_SETTINGS,
    camera: { ...DEFAULT_MEDIA_QUALITY_SETTINGS.camera, preset: "custom" },
  };
  await render({ initial: custom });

  expect(sectionText("Camera quality")).toContain("Custom");
  const hd = container.querySelector('[data-testid="camera-quality-preset-high-definition"]');
  await click(hd);

  expect(latest.camera.preset).toBe("high-definition");
  expect(hd?.getAttribute("aria-pressed")).toBe("true");
  expect(sectionText("Camera quality")).not.toContain("Custom");
  expect(sectionText("Camera quality")).toContain("Can drop lower on a weak connection or busy device.");
});

it("says when effects cap the camera quality", async () => {
  await render({
    initial: {
      ...DEFAULT_MEDIA_QUALITY_SETTINGS,
      camera: applyCameraQualityPreset(DEFAULT_MEDIA_QUALITY_SETTINGS.camera, "studio"),
    },
    effectsCount: 1,
  });

  expect(sectionText("Camera quality")).toContain("Effects cap video at 720p, 30 fps while they're on.");
});

it("resets screen share and camera quality from the short reset button", async () => {
  await render({
    initial: {
      camera: applyCameraQualityPreset(DEFAULT_MEDIA_QUALITY_SETTINGS.camera, "studio"),
      screenShare: { ...DEFAULT_MEDIA_QUALITY_SETTINGS.screenShare, preset: "custom" },
    },
  });

  const screenShare = sectionText("Screen share");
  expect(screenShare).toContain("Custom");
  expect(screenShare).toContain("Quality applies right away. Audio and cursor apply on your next share.");
  expect(screenShare).toContain("Include system audio");

  await click(buttonNamed("Reset to defaults"));

  expect(latest).toEqual(DEFAULT_MEDIA_QUALITY_SETTINGS);
  expect(sectionText("Screen share")).not.toContain("Custom");
  expect(
    container
      .querySelector('[data-testid="camera-quality-preset-auto"]')
      ?.getAttribute("aria-pressed"),
  ).toBe("true");
});

it("opens backgrounds and effects from its row", async () => {
  const onOpenEffects = vi.fn();
  await render({ initial: DEFAULT_MEDIA_QUALITY_SETTINGS, onOpenEffects });

  await click(container.querySelector('[data-testid="device-settings-open-effects"]'));

  expect(onOpenEffects).toHaveBeenCalledTimes(1);
});
