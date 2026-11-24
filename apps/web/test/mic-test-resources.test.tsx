// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playSpeakerTestSound, useMicTest } from "../src/app/hooks/useMicTest";
import { releaseAllCaptures } from "../src/app/lib/media-captures";
import { installMediaWorld, World } from "./in-call-rig";

const pipelineFailure = vi.hoisted(() => ({ next: null as Error | null }));

vi.mock("../src/app/lib/noise-cancellation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app/lib/noise-cancellation")>();
  return {
    ...actual,
    createNoiseCancellationPipeline: async (...args: Parameters<typeof actual.createNoiseCancellationPipeline>) => {
      const failure = pipelineFailure.next;
      if (!failure) return actual.createNoiseCancellationPipeline(...args);
      pipelineFailure.next = null;
      await world.wait("noiseSetup");
      throw failure;
    },
  };
});

let world: World;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let latest: ReturnType<typeof useMicTest> | null = null;

beforeEach(() => {
  world = new World();
  installMediaWorld(world);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  pipelineFailure.next = null;
});

afterEach(() => {
  world.releaseAll();
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  latest = null;
  vi.unstubAllGlobals();
});

function MicTest({ noiseCancellation }: { noiseCancellation: boolean }) {
  latest = useMicTest({ active: true, noiseCancellation });
  return null;
}

const flush = async () => {
  for (let turn = 0; turn < 8; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const mount = async (noiseCancellation: boolean) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(MicTest, { noiseCancellation })));
  await flush();
};

const closeSettings = () => {
  act(() => root!.unmount());
  root = null;
};

const leftOpen = () => [
  ...world.tracks.filter((track) => track.readyState === "live").map((track) => `live ${track.id}`),
  ...world.contexts.filter((context) => context.state !== "closed").map((_context, index) => `open context ${index}`),
];

const waitForNoiseSetup = () =>
  vi.waitFor(() => {
    if (!world.pending.some((entry) => entry.hold === "noiseSetup")) throw new Error("noise cancellation is not starting yet");
  });

describe("the Settings microphone test owns everything one run opens", () => {
  it("leaves nothing open when the call ends while noise cancellation is starting", async () => {
    world.holds.add("noiseSetup");
    await mount(true);
    await waitForNoiseSetup();

    await act(async () => releaseAllCaptures());
    closeSettings();
    world.releaseAll();
    await flush();

    expect(leftOpen()).toEqual([]);
  });

  it("leaves nothing open when Settings closes while noise cancellation is starting and the setup then fails", async () => {
    world.holds.add("noiseSetup");
    pipelineFailure.next = new Error("the noise cancellation worklet failed to load");
    await mount(true);
    await waitForNoiseSetup();

    closeSettings();
    world.releaseAll();
    await flush();

    expect(leftOpen()).toEqual([]);
  });

  it("falls back to the raw microphone when noise cancellation fails, and closing Settings releases it", async () => {
    pipelineFailure.next = new Error("the noise cancellation worklet failed to load");
    await mount(true);

    expect(latest?.isRunning).toBe(true);
    expect(latest?.usingNoiseCancellation).toBe(false);
    expect(world.contexts.filter((context) => context.state !== "closed")).toHaveLength(1);

    closeSettings();
    await flush();
    expect(leftOpen()).toEqual([]);
  });

  it("ends a speaker test quietly and closes its context when the call ends while the context resumes", async () => {
    world.contextsStartSuspended = true;
    world.holds.add("resume");
    const playing = playSpeakerTestSound();
    await vi.waitFor(() => {
      if (!world.pending.some((entry) => entry.hold === "resume")) throw new Error("the speaker test is not resuming yet");
    });

    releaseAllCaptures();
    world.releaseAll();

    await expect(playing).resolves.toBeUndefined();
    expect(leftOpen()).toEqual([]);
  });

  it("does not hide a speaker test failure that is not a call ending", async () => {
    world.contextsStartSuspended = true;
    const failure = new Error("no oscillator");
    vi.spyOn(world, "track").mockImplementationOnce(() => {
      throw failure;
    });

    await expect(playSpeakerTestSound()).rejects.toBe(failure);
    expect(world.contexts.filter((context) => context.state !== "closed")).toEqual([]);
  });
});
