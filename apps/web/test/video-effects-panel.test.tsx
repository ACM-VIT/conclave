// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import VideoEffectsPanel from "../src/app/components/VideoEffectsPanel";
import {
  DEFAULT_VIDEO_EFFECTS,
  type VideoEffectsState,
} from "../src/app/lib/video-effects";

let container: HTMLDivElement;
let root: Root;
let latest: VideoEffectsState;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function Harness({ blocked = false }: { blocked?: boolean }) {
  const [effects, setEffects] = useState(DEFAULT_VIDEO_EFFECTS);
  latest = effects;
  return (
    <VideoEffectsPanel
      effects={effects}
      onEffectsChange={setEffects}
      localStream={null}
      isCameraOff
      status="off"
      error={null}
      activeCount={0}
      cameraPermissionBlocked={blocked}
      onRecenterFraming={() => {}}
      onClose={() => {}}
      initialTab="appearance"
      deferPreload
    />
  );
}

const render = async (props: Parameters<typeof Harness>[0] = {}) => {
  await act(async () => root.render(<Harness {...props} />));
};

const switchNamed = (name: string) =>
  Array.from(container.querySelectorAll('[role="switch"]')).find((element) =>
    element.textContent?.startsWith(name),
  ) as HTMLButtonElement | undefined;

const headings = () =>
  Array.from(container.querySelectorAll("#video-effects-tabpanel-appearance h3")).map(
    (heading) => heading.textContent,
  );

it("groups the appearance switches under one heading with short descriptions", async () => {
  await render();

  expect(headings()[0]).toBe("Lighting and framing");
  expect(headings()).not.toContain("Studio lighting");
  expect(headings()).not.toContain("Framing");
  expect(switchNamed("Studio lighting")?.textContent).toContain("Helps when the light is behind you.");
  expect(switchNamed("Studio look")?.textContent).toContain("Sharpens your features when needed.");
  expect(switchNamed("Framing")?.textContent).toContain("Keeps you centered.");
});

it("keeps each appearance switch wired to its own effect", async () => {
  await render();

  const framing = switchNamed("Framing");
  expect(framing?.getAttribute("aria-checked")).toBe("false");
  await act(async () => framing?.click());

  expect(latest.framing).toBe(true);
  expect(latest.studioLighting).toBe(false);
  expect(switchNamed("Framing")?.getAttribute("aria-checked")).toBe("true");

  await act(async () => switchNamed("Studio lighting")?.click());
  expect(latest.studioLighting).toBe(true);
});

it("hides studio look when the camera is blocked", async () => {
  await render({ blocked: true });

  expect(headings()[0]).toBe("Lighting and framing");
  expect(switchNamed("Studio look")).toBeUndefined();
  expect(switchNamed("Studio lighting")).toBeDefined();
  expect(switchNamed("Framing")).toBeDefined();
});
