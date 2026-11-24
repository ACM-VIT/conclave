// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseAllCaptures } from "../src/app/lib/media-captures";
import {
  createInCallRig,
  installMediaWorld,
  leftAfterEnd,
  unwanted,
  World,
  type FakeTrack,
  type Hold,
  type InCallRig,
} from "./in-call-rig";

let world: World;
let current: InCallRig | null = null;

beforeEach(() => {
  world = new World();
  installMediaWorld(world);
});

afterEach(() => {
  world.releaseAll();
  current?.unmount();
  current = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const setIntents = async (rig: InCallRig, mic: boolean, camera: boolean) => {
  await act(async () => {
    rig.rig().refs.deviceIntents.dispatch({ type: "set", audio: mic, video: camera });
  });
};

const join = async ({ mic = true, camera = true, noiseCancellation = false } = {}) => {
  current = await createInCallRig(world, { noiseCancellation });
  await setIntents(current, mic, camera);
  await act(async () => {
    await current!.rig().socket.joinRoom();
  });
  await current.settle();
  expect(current.rig().state.connectionState).toBe("joined");
  return current;
};

const pendingOf = (hold: Hold) => world.pending.filter((entry) => entry.hold === hold).length;

const until = async (label: string, condition: () => boolean) => {
  await vi.waitFor(
    () => {
      if (!condition()) throw new Error(`still waiting for ${label}`);
    },
    { timeout: 3000, interval: 5 },
  );
};

const releaseAll = async (rig: InCallRig, ...running: Array<Promise<unknown>>) => {
  await act(async () => {
    world.releaseAll();
    await Promise.allSettled(running);
  });
  await rig.settle();
};

const endCall = async (rig: InCallRig) => {
  await act(async () => {
    rig.rig().socket.cleanup();
  });
};

const liveCameraTrack = (rig: InCallRig) =>
  rig.rig().refs.localStreamRef.current?.getVideoTracks()[0] as unknown as FakeTrack;

describe("in-call rig", () => {
  it("joins with the microphone and camera on, publishes both, and leaves nothing behind", async () => {
    const rig = await join();
    expect(world.producers.filter((producer) => !producer.closed).map((producer) => [producer.kind, producer.paused])).toEqual([
      ["audio", false],
      ["video", false],
    ]);
    expect(unwanted(world, rig.rig())).toEqual([]);
    await endCall(rig);
    await rig.settle();
    expect(leftAfterEnd(world)).toEqual([]);
  });
});

describe("an in-call capture that completes after the choice changed", () => {
  it("camera recovery that reopens the camera after Turn off camera publishes nothing and stops what it opened", async () => {
    const rig = await join();
    world.holds.add("capture");
    await act(async () => liveCameraTrack(rig).lose());
    await until("the recovery capture", () => pendingOf("capture") === 1);

    await act(async () => {
      await rig.rig().media.toggleCamera();
    });
    expect(rig.rig().state.isCameraOff).toBe(true);
    await releaseAll(rig);

    expect(rig.rig().state.isCameraOff).toBe(true);
    expect(unwanted(world, rig.rig())).toEqual([]);
  });

  it("a camera switch still opening when the camera is turned off stops the new camera", async () => {
    const rig = await join();
    world.holds.add("capture");
    let switching: Promise<unknown> = Promise.resolve();
    await act(async () => {
      switching = rig.rig().media.handleVideoInputDeviceChange("cam-2");
    });
    await until("the switch capture", () => pendingOf("capture") === 1);

    await act(async () => {
      await rig.rig().media.toggleCamera();
    });
    await releaseAll(rig, switching);

    expect(rig.rig().state.isCameraOff).toBe(true);
    expect(unwanted(world, rig.rig())).toEqual([]);
  });

  it("a microphone switch whose noise cancellation is still loading at hang-up creates no Web Audio output", async () => {
    const rig = await join({ noiseCancellation: true });
    expect(world.contexts.filter((context) => context.state !== "closed")).toHaveLength(1);
    world.holds.add("noiseSetup");
    let switching: Promise<unknown> = Promise.resolve();
    await act(async () => {
      switching = rig.rig().media.handleAudioInputDeviceChange("mic-2");
    });
    await until("the noise cancellation setup", () => pendingOf("noiseSetup") >= 1);

    await endCall(rig);
    await releaseAll(rig, switching);
    await releaseAll(rig);

    expect(leftAfterEnd(world)).toEqual([]);
  });

  it.each([
    ["while the clone is still being swapped in", true],
    ["after the clone went out", false],
  ])("a VP9 stall repair clone is stopped by hang-up %s", async (_name, holdSwap) => {
    const rig = await join();
    rig.rig().refs.webcamCodecPolicyRef.current = {
      ...rig.rig().refs.webcamCodecPolicyRef.current,
      codec: "vp9",
    };
    if (holdSwap) world.holds.add("replaceTrack");
    const cloned = () => world.tracks.some((track) => track.source === "clone");
    const swapped = () =>
      world.producers.some((producer) => !producer.closed && producer.track?.source === "clone");
    for (let sample = 0; sample < 6 && !(holdSwap ? pendingOf("replaceTrack") === 1 : swapped()); sample += 1) {
      await rig.tick(2000);
    }
    expect(cloned()).toBe(true);
    expect(holdSwap ? pendingOf("replaceTrack") === 1 : swapped()).toBe(true);

    await endCall(rig);
    await releaseAll(rig);

    expect(leftAfterEnd(world)).toEqual([]);
  });

  it("the capture ledger alone stops every capture and derived track and closes every noise cancellation context", async () => {
    const rig = await join({ noiseCancellation: true });
    rig.rig().refs.webcamCodecPolicyRef.current = {
      ...rig.rig().refs.webcamCodecPolicyRef.current,
      codec: "vp9",
    };
    await act(async () => rig.rig().setVideoEffects(1));
    await rig.settle();
    for (let sample = 0; sample < 6 && !world.tracks.some((track) => track.source === "clone"); sample += 1) {
      await rig.tick(2000);
    }
    expect(new Set(world.tracks.filter((track) => track.readyState === "live").map((track) => track.source))).toEqual(
      new Set(["device", "web-audio", "effects", "clone"]),
    );

    await act(async () => releaseAllCaptures());

    expect(world.tracks.filter((track) => track.readyState === "live").map((track) => track.id)).toEqual([]);
    expect(world.contexts.filter((context) => context.state !== "closed")).toHaveLength(0);
  });

  it("muting while the join is still publishing leaves the microphone producer paused", async () => {
    current = await createInCallRig(world);
    await setIntents(current, true, true);
    world.holds.add("produce");
    let joining: Promise<unknown> = Promise.resolve();
    await act(async () => {
      joining = current!.rig().socket.joinRoom();
    });
    await until("the microphone publish", () => pendingOf("produce") === 1);

    await act(async () => {
      await current!.rig().media.toggleMute();
    });
    await releaseAll(current, joining);

    expect(current.rig().state.connectionState).toBe("joined");
    expect(current.rig().state.isMuted).toBe(true);
    expect(unwanted(world, current.rig())).toEqual([]);
  });

  it("turning the camera off while the join is still publishing leaves no camera producer or camera", async () => {
    current = await createInCallRig(world);
    await setIntents(current, true, true);
    world.holds.add("produce");
    let joining: Promise<unknown> = Promise.resolve();
    await act(async () => {
      joining = current!.rig().socket.joinRoom();
    });
    await until("the microphone publish", () => pendingOf("produce") === 1);

    await act(async () => {
      await current!.rig().media.toggleCamera();
    });
    await releaseAll(current, joining);

    expect(current.rig().state.connectionState).toBe("joined");
    expect(current.rig().state.isCameraOff).toBe(true);
    expect(unwanted(world, current.rig())).toEqual([]);
  });

  it("turning the camera on just before the join publishes leaves the camera on and published once", async () => {
    current = await createInCallRig(world);
    await setIntents(current, true, false);
    world.holds.add("consumerTransport");
    let joining: Promise<unknown> = Promise.resolve();
    await act(async () => {
      joining = current!.rig().socket.joinRoom();
    });
    await until("the consumer transport", () => pendingOf("consumerTransport") === 1);
    await current.settle();
    world.holds.add("capture");
    let turningOn: Promise<unknown> = Promise.resolve();
    await act(async () => {
      turningOn = current!.rig().media.toggleCamera();
    });
    await until("the camera capture", () => pendingOf("capture") === 1);

    await act(async () => world.releaseOne(world.pending.findIndex((entry) => entry.hold === "consumerTransport")));
    await current.settle();
    await releaseAll(current, joining, turningOn);

    expect(current.rig().state.connectionState).toBe("joined");
    expect(current.rig().state.isCameraOff).toBe(false);
    expect(world.producers.filter((producer) => !producer.closed && producer.kind === "video")).toHaveLength(1);
    expect(unwanted(world, current.rig())).toEqual([]);
  });

  it("a first join refused, then tried again, publishes the microphone paused and no camera", async () => {
    current = await createInCallRig(world);
    await setIntents(current, true, true);
    world.joinRefusal = "Connection timeout";
    await act(async () => {
      await current!.rig().socket.joinRoom().catch(() => {});
    });
    await current.settle();
    world.joinRefusal = null;
    await act(async () => {
      await current!.rig().socket.joinRoom();
    });
    await current.settle();

    expect(current.rig().state.connectionState).toBe("joined");
    expect(world.producers.filter((producer) => !producer.closed).map((producer) => [producer.kind, producer.paused])).toEqual([
      ["audio", true],
    ]);
    expect(unwanted(world, current.rig())).toEqual([]);
  });
});

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};

type Model = {
  rig: InCallRig;
  random: () => number;
  running: Set<Promise<unknown>>;
  noiseCancellation: boolean;
  effects: boolean;
  log: string[];
};

const pick = <T,>(model: Model, values: readonly T[]): T => values[Math.floor(model.random() * values.length)]!;

const start = (model: Model, operation: Promise<unknown> | undefined) => {
  if (!operation) return;
  const tracked = operation.catch(() => {}).finally(() => model.running.delete(tracked));
  model.running.add(tracked);
};

const loseLive = (model: Model, kind: "audio" | "video") => {
  const tracks = (model.rig.rig().refs.localStreamRef.current?.getTracks() ?? []) as unknown as FakeTrack[];
  const raw = tracks.find((track) => track.kind === kind && track.readyState === "live" && track.source === "device");
  const source = world.tracks.find((track) => track.kind === kind && track.readyState === "live" && track.source === "device");
  (raw ?? source)?.lose();
};

const HOLDS: Hold[] = ["capture", "noiseSetup", "replaceTrack", "produce"];

const STEPS: Array<[string, (model: Model) => void | Promise<void>]> = [
  ["toggle the microphone", (model) => start(model, model.rig.rig().media.toggleMute())],
  ["toggle the camera", (model) => start(model, model.rig.rig().media.toggleCamera())],
  ["lose the microphone", (model) => loseLive(model, "audio")],
  ["lose the camera", (model) => loseLive(model, "video")],
  ["switch the microphone", (model) => start(model, model.rig.rig().media.handleAudioInputDeviceChange(pick(model, ["default", "mic-2"])))],
  ["switch the camera", (model) => start(model, model.rig.rig().media.handleVideoInputDeviceChange(pick(model, ["default", "cam-2"])))],
  ["the device list changes", () => world.deviceListeners.forEach((listener) => listener())],
  [
    "toggle noise cancellation",
    (model) => {
      model.noiseCancellation = !model.noiseCancellation;
      model.rig.rig().setNoiseCancellation(model.noiseCancellation);
    },
  ],
  [
    "toggle video effects",
    (model) => {
      model.effects = !model.effects;
      model.rig.rig().setVideoEffects(model.effects ? 1 : 0);
    },
  ],
  [
    "the camera sender stalls",
    async (model) => {
      const refs = model.rig.rig().refs;
      refs.webcamCodecPolicyRef.current = {
        ...refs.webcamCodecPolicyRef.current,
        codec: pick(model, ["vp8", "vp9"] as const),
      };
      for (let sample = 0; sample < 4; sample += 1) await model.rig.tick(2000);
    },
  ],
  [
    "change the video quality",
    (model) => start(model, model.rig.rig().media.updateVideoQualityRef.current?.(pick(model, ["low", "standard"] as const))),
  ],
  ["hold the next step", (model) => void world.holds.add(pick(model, HOLDS))],
  ["release the oldest held step", () => world.releaseOne(0)],
  ["release everything held", () => world.releaseAll()],
];

const quiesce = async (model: Model) => {
  let stableTurns = 0;
  let last = "";
  for (let turn = 0; turn < 300; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, turn < 20 ? 0 : 10));
    });
    if (world.pending.length > 0) return false;
    const snapshot = [
      world.tracks.map((track) => track.readyState).join(""),
      world.producers.map((producer) => `${producer.closed}${producer.paused}${producer.track?.id}`).join(""),
      world.socketEvents.length,
      world.contexts.map((context) => context.state).join(""),
    ].join("|");
    stableTurns = snapshot === last && model.running.size === 0 ? stableTurns + 1 : 0;
    last = snapshot;
    if (stableTurns >= 4) return true;
  }
  throw new Error(`the rig never settled\n${model.log.join("\n")}`);
};

const fail = (seed: number, model: Model, when: string, problems: string[]) => {
  throw new Error(`seed ${seed}: ${when}\n${problems.join("\n")}\nsteps:\n${model.log.join("\n")}`);
};

const runSeed = async (seed: number, steps: number) => {
  const random = mulberry32(seed);
  const noiseCancellation = random() < 0.5;
  current = await createInCallRig(world, { noiseCancellation });
  const model: Model = { rig: current, random, running: new Set(), noiseCancellation, effects: false, log: [] };
  const mic = random() < 0.6;
  const camera = random() < 0.6;
  model.log.push(`join with microphone ${mic ? "on" : "off"}, camera ${camera ? "on" : "off"}, noise cancellation ${noiseCancellation ? "on" : "off"}`);
  await setIntents(current, mic, camera);
  if (random() < 0.4) {
    const hold = pick(model, HOLDS);
    world.holds.add(hold);
    model.log.push(`hold ${hold} during the join`);
  }
  await act(async () => {
    start(model, current!.rig().socket.joinRoom());
  });
  const endAt = Math.floor(random() * steps);
  for (let index = 0; index < steps; index += 1) {
    if (index === endAt) break;
    const [name, run] = pick(model, STEPS);
    model.log.push(`${index}: ${name}`);
    await act(async () => {
      await run(model);
    });
    const settled = await quiesce(model);
    if (process.env.IN_CALL_MODEL_TRACE) {
      const intents = current.rig().refs.deviceIntents.get();
      model.log.push(
        `   mic ${intents.audio.chosen}/${intents.audio.request} cam ${intents.video.chosen}/${intents.video.request} held ${world.pending.map((entry) => entry.hold).join(",")} producers ${world.producers
          .filter((producer) => !producer.closed)
          .map((producer) => `${producer.id}:${producer.kind}:${producer.paused ? "paused" : "live"}:${producer.track?.id}`)
          .join(" ")}`,
      );
    }
    if (settled) {
      const problems = unwanted(world, current.rig());
      if (problems.length > 0) fail(seed, model, `after step ${index}`, problems);
    }
  }
  model.log.push(`end the call with ${world.pending.length} step(s) held`);
  await endCall(current);
  await act(async () => {
    world.releaseAll();
  });
  await quiesce(model);
  await act(async () => {
    world.releaseAll();
  });
  await quiesce(model);
  const left = leftAfterEnd(world);
  if (left.length > 0) fail(seed, model, "after the call ended", left);
  current.unmount();
  current = null;
};

const SEED_FROM = Number(process.env.IN_CALL_MODEL_SEED_FROM ?? 1);
const SEED_COUNT = Number(process.env.IN_CALL_MODEL_SEEDS ?? 30);
const MODEL_STEPS = Number(process.env.IN_CALL_MODEL_STEPS ?? 24);

describe("seeded in-call model: no live track, node or producer the current choice does not call for", () => {
  it(
    `seeds ${SEED_FROM} to ${SEED_FROM + SEED_COUNT - 1}`,
    async () => {
      for (let seed = SEED_FROM; seed < SEED_FROM + SEED_COUNT; seed += 1) {
        world = new World();
        installMediaWorld(world);
        await runSeed(seed, MODEL_STEPS);
      }
    },
    600_000,
  );
});
