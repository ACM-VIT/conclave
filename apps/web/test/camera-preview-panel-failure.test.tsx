// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CameraPreviewPanelBoundary from "../src/app/components/CameraPreviewPanelBoundary";
import DeviceSettingsPanel from "../src/app/components/DeviceSettingsPanel";
import VideoEffectsPanel from "../src/app/components/VideoEffectsPanel";
import {
  useLocalCameraPreview,
  type LocalCameraPreviewController,
} from "../src/app/hooks/useLocalCameraPreview";
import { DEFAULT_MEDIA_QUALITY_SETTINGS } from "../src/app/lib/media-quality-settings";
import { DEFAULT_VIDEO_EFFECTS } from "../src/app/lib/video-effects";

type FakeTrack = MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };

function fakeCamera(id: string) {
  const track = {
    kind: "video",
    id,
    label: id,
    enabled: true,
    muted: false,
    readyState: "live" as MediaStreamTrackState,
    getSettings: () => ({ deviceId: id, width: 1280, height: 720 }),
    getConstraints: () => ({}),
    getCapabilities: () => ({}),
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as FakeTrack;
  track.stop = vi.fn(() => {
    (track as { readyState: MediaStreamTrackState }).readyState = "ended";
  });
  const stream = Object.assign(new MediaStream(), {
    getTracks: () => [track],
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
  });
  return { track, stream };
}

const brokenEffects = new Proxy(DEFAULT_VIDEO_EFFECTS, {
  get() {
    throw new Error("Effects panel crashed");
  },
});
const brokenQuality = new Proxy(DEFAULT_MEDIA_QUALITY_SETTINGS, {
  get() {
    throw new Error("Settings panel crashed");
  },
});

let container: HTMLDivElement;
let root: Root;
let preview: LocalCameraPreviewController;
let caught: string[] = [];
let captures: Array<{ resolve: (stream: MediaStream) => void; camera: ReturnType<typeof fakeCamera> }>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  captures = [];
  caught = [];
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(
        () =>
          new Promise<MediaStream>((resolve) => {
            captures.push({ resolve, camera: fakeCamera(`preview-${captures.length}`) });
          }),
      ),
      enumerateDevices: vi.fn(async () => []),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container, {
    onCaughtError: (error) => {
      caught.push(error instanceof Error ? error.message : String(error));
    },
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const noop = () => {};

function Meeting({
  panel,
  broken,
  callCamera,
}: {
  panel: "effects" | "settings";
  broken: boolean;
  callCamera: MediaStream | null;
}) {
  preview = useLocalCameraPreview({});
  const shown = callCamera ?? preview.stream;
  return panel === "effects" ? (
    <CameraPreviewPanelBoundary
      name="Backgrounds and effects"
      onClose={noop}
      onStopCameraPreview={preview.stop}
    >
      <VideoEffectsPanel
        effects={broken ? brokenEffects : DEFAULT_VIDEO_EFFECTS}
        onEffectsChange={noop}
        localStream={shown}
        isCameraOff={!shown}
        status="off"
        error={null}
        activeCount={0}
        isCameraPreviewActive={!callCamera && Boolean(preview.stream)}
        isCameraPreviewStarting={preview.isStarting}
        cameraPreviewError={preview.error}
        onStartCameraPreview={preview.start}
        onStopCameraPreview={preview.stop}
        onClose={noop}
        deferPreload
      />
    </CameraPreviewPanelBoundary>
  ) : (
    <CameraPreviewPanelBoundary
      name="Settings"
      onClose={noop}
      onStopCameraPreview={preview.stop}
    >
      <DeviceSettingsPanel
        localStream={shown}
        isLocalVideoLive={Boolean(callCamera)}
        isPreviewOnly={!callCamera && Boolean(preview.stream)}
        mirrorLocalPreview={false}
        mediaQualitySettings={broken ? brokenQuality : DEFAULT_MEDIA_QUALITY_SETTINGS}
        onMediaQualitySettingsChange={noop}
        isCameraPreviewStarting={preview.isStarting}
        cameraPreviewError={preview.error}
        onStartCameraPreview={preview.start}
        onStopCameraPreview={preview.stop}
        onClose={noop}
      />
    </CameraPreviewPanelBoundary>
  );
}

const render = (props: Parameters<typeof Meeting>[0]) =>
  act(async () => root.render(<Meeting {...props} />));

const failedPanel = () => container.querySelector('aside [role="alert"]');

it.each(["effects", "settings"] as const)(
  "stops a running camera preview when the %s panel fails",
  async (panel) => {
    await render({ panel, broken: false, callCamera: null });
    await act(async () => preview.start());
    expect(captures).toHaveLength(1);
    await act(async () => captures[0].resolve(captures[0].camera.stream));
    expect(caught).toEqual([]);
    expect(failedPanel()).toBeNull();
    expect(preview.stream).toBe(captures[0].camera.stream);

    await render({ panel, broken: true, callCamera: null });

    expect(failedPanel()).not.toBeNull();
    expect(caught.at(-1)).toMatch(/panel crashed/);
    expect(captures[0].camera.track.stop).toHaveBeenCalled();
    expect(captures[0].camera.track.readyState).toBe("ended");
    expect(preview.stream).toBeNull();
  },
);

it.each(["effects", "settings"] as const)(
  "stops a preview capture that finishes after the %s panel failed",
  async (panel) => {
    await render({ panel, broken: false, callCamera: null });
    await act(async () => preview.start());
    expect(captures).toHaveLength(1);
    expect(caught).toEqual([]);
    expect(failedPanel()).toBeNull();

    await render({ panel, broken: true, callCamera: null });
    expect(failedPanel()).not.toBeNull();
    expect(caught.at(-1)).toMatch(/panel crashed/);
    await act(async () => captures[0].resolve(captures[0].camera.stream));

    expect(captures[0].camera.track.stop).toHaveBeenCalled();
    expect(preview.stream).toBeNull();
  },
);

it.each(["effects", "settings"] as const)(
  "keeps the call's own camera running when the %s panel fails",
  async (panel) => {
    const call = fakeCamera("call");
    await render({ panel, broken: false, callCamera: call.stream });
    expect(caught).toEqual([]);
    expect(failedPanel()).toBeNull();
    await render({ panel, broken: true, callCamera: call.stream });

    expect(failedPanel()).not.toBeNull();
    expect(caught.at(-1)).toMatch(/panel crashed/);
    expect(call.track.stop).not.toHaveBeenCalled();
    expect(call.track.readyState).toBe("live");
    expect(captures.every(({ camera }) => camera.track.readyState !== "live")).toBe(true);
  },
);
