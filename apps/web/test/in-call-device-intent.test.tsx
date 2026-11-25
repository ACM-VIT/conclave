// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseAllCaptures } from "../src/app/lib/media-captures";
import {
  createInCallRig,
  installMediaWorld,
  leftAfterEnd,
  notLive,
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

const liveMicrophoneSource = () =>
  world.tracks.find((track) => track.kind === "audio" && track.source === "device" && track.readyState === "live");

const WATCHDOG_MS = 1500;
const LIVENESS_TICKS = 3;

const sendingWithin = async (rig: InCallRig, ticks = LIVENESS_TICKS) => {
  for (let tick = 0; tick < ticks && notLive(world, rig.rig()).length > 0; tick += 1) {
    await rig.tick(WATCHDOG_MS);
  }
  return notLive(world, rig.rig());
};

const opened = (kind: "audio" | "video") =>
  world.tracks.filter((track) => track.kind === kind && track.source === "device").length;

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

describe("a chosen device ends up sending", () => {
  it.each([false, true])(
    "a microphone lost mid-call is reopened once and sends again (noise cancellation %s)",
    async (noiseCancellation) => {
      const rig = await join({ camera: false, noiseCancellation });
      expect(notLive(world, rig.rig())).toEqual([]);
      await act(async () => liveMicrophoneSource()?.lose());
      await rig.settle();

      expect(await sendingWithin(rig)).toEqual([]);
      expect(rig.rig().state.isMuted).toBe(false);
      expect(opened("audio")).toBe(2);
      expect(unwanted(world, rig.rig())).toEqual([]);
    },
  );

  it("muting while a microphone recovery is publishing leaves one paused producer and no live microphone", async () => {
    const rig = await join({ camera: false });
    world.holds.add("produce");
    await act(async () => liveMicrophoneSource()?.lose());
    await until("the recovery publish", () => pendingOf("produce") === 1);

    await act(async () => {
      await rig.rig().media.toggleMute();
    });
    await releaseAll(rig);

    expect(rig.rig().state.isMuted).toBe(true);
    expect(world.producers.filter((producer) => !producer.closed && producer.kind === "audio").map((producer) => producer.paused)).toEqual([true]);
    expect(unwanted(world, rig.rig())).toEqual([]);
  });

  it("muting while a microphone recovery publishes keeps the client and the SFU agreeing when the SFU refuses the mute", async () => {
    const rig = await join({ camera: false });
    world.holds.add("produce");
    await act(async () => liveMicrophoneSource()?.lose());
    await until("the recovery publish", () => pendingOf("produce") === 1);

    world.refusals.set("toggleMute", 1);
    await act(async () => {
      await rig.rig().media.toggleMute();
    });
    await releaseAll(rig);

    const [producer] = world.producers.filter((candidate) => !candidate.closed && candidate.kind === "audio");
    expect([producer?.paused, world.sfu.get(producer?.id ?? "")?.paused]).toEqual([false, false]);
    expect(rig.rig().state.isMuted).toBe(false);
    expect(unwanted(world, rig.rig())).toEqual([]);
  });

  it("unmuting while a muted microphone recovery is publishing sends the microphone", async () => {
    const rig = await join({ camera: false });
    await act(async () => {
      await rig.rig().media.toggleMute();
    });
    world.holds.add("produce");
    await act(async () => liveMicrophoneSource()?.lose());
    await rig.tick(WATCHDOG_MS);
    await until("the recovery publish", () => pendingOf("produce") === 1);

    let unmuting: Promise<unknown> = Promise.resolve();
    await act(async () => {
      unmuting = rig.rig().media.toggleMute();
    });
    await releaseAll(rig, unmuting);

    expect(await sendingWithin(rig)).toEqual([]);
    expect(unwanted(world, rig.rig())).toEqual([]);
  });

  it("a microphone lost again while its recovery publishes sends again without waiting for the watchdog", async () => {
    const rig = await join({ camera: false });
    world.holds.add("produce");
    await act(async () => liveMicrophoneSource()?.lose());
    await until("the recovery publish", () => pendingOf("produce") === 1);

    await act(async () => liveMicrophoneSource()?.lose());
    await releaseAll(rig);

    expect(notLive(world, rig.rig())).toEqual([]);
    expect(unwanted(world, rig.rig())).toEqual([]);
  });

  it("finishing a microphone recovery never starts camera recovery while a camera topology replacement publishes", async () => {
    const rig = await join();
    const camera = world.producers.find((producer) => !producer.closed && producer.kind === "video")!;
    world.holds.add("produce");
    let replacing: Promise<unknown> = Promise.resolve();
    await act(async () => {
      replacing = rig.rig().media.replaceWebcamProducerTopology({
        target: "single-receiver",
        expectedProducerId: camera.id,
        quality: "standard",
        networkProfile: "good",
        transition: { fromProducerId: camera.id, nonce: "rig" },
      });
    });
    await until("the topology publish", () => pendingOf("produce") === 1);
    await act(async () => liveCameraTrack(rig).lose());
    await act(async () => liveMicrophoneSource()?.lose());
    await until("the microphone recovery publish", () => pendingOf("produce") === 2);
    await act(async () => liveMicrophoneSource()?.lose());
    const camerasOpened = opened("video");

    await act(async () => world.releaseOne(1));
    await rig.settle();
    expect(opened("video")).toBe(camerasOpened);

    await releaseAll(rig, replacing);
    expect(await sendingWithin(rig)).toEqual([]);
    expect(unwanted(world, rig.rig())).toEqual([]);
  });

  it("a microphone request queued while reconnecting is kept for a recovery that is still publishing", async () => {
    const rig = await join({ camera: false });
    world.holds.add("produce");
    await act(async () => liveMicrophoneSource()?.lose());
    await until("the microphone recovery publish", () => pendingOf("produce") === 1);

    rig.rig().refs.reconnectInFlightRef.current = true;
    await act(async () => liveMicrophoneSource()?.lose());
    rig.rig().refs.reconnectInFlightRef.current = false;
    await rig.tick(250);
    await releaseAll(rig);

    expect(notLive(world, rig.rig())).toEqual([]);
    expect(unwanted(world, rig.rig())).toEqual([]);
  });

  it("a camera request queued during a topology replacement is kept for a camera recovery still publishing", async () => {
    const rig = await join({ mic: false });
    const camera = world.producers.find((producer) => !producer.closed && producer.kind === "video")!;
    world.holds.add("produce");
    let replacing: Promise<unknown> = Promise.resolve();
    await act(async () => {
      replacing = rig.rig().media.replaceWebcamProducerTopology({
        target: "single-receiver",
        expectedProducerId: camera.id,
        quality: "standard",
        networkProfile: "good",
        transition: { fromProducerId: camera.id, nonce: "rig" },
      });
    });
    await until("the topology publish", () => pendingOf("produce") === 1);
    await act(async () => liveCameraTrack(rig).lose());
    await act(async () => rig.rig().setVideoEffects(1));
    await until("the camera recovery publish", () => pendingOf("produce") === 2);

    await act(async () => liveCameraTrack(rig).lose());
    await act(async () => world.releaseOne(0));
    await rig.settle();
    await releaseAll(rig, replacing);

    await until("the camera sending again", () => notLive(world, rig.rig()).length === 0);
    expect(unwanted(world, rig.rig())).toEqual([]);
  });

  it("captures released while a microphone recovery publishes leave its producer closed", async () => {
    const rig = await join({ camera: false });
    world.holds.add("produce");
    await act(async () => liveMicrophoneSource()?.lose());
    await until("the recovery publish", () => pendingOf("produce") === 1);
    const publishedBefore = world.producers.length;

    await act(async () => releaseAllCaptures());
    const recovered: Array<[boolean, boolean | undefined]> = [];
    await act(async () => {
      world.releaseAll();
      for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      world.producers
        .slice(publishedBefore)
        .forEach((producer) => recovered.push([producer.closed, world.sfu.get(producer.id)?.closed]));
    });

    expect(recovered).toEqual([[true, true]]);
  });

  it("leaving the meeting page while a microphone recovery publishes leaves no producer open", async () => {
    const rig = await join({ camera: false });
    world.holds.add("produce");
    await act(async () => liveMicrophoneSource()?.lose());
    await until("the recovery publish", () => pendingOf("produce") === 1);

    const publishedBefore = world.producers.length;
    rig.unmount();
    current = null;
    world.releaseAll();
    await until("the recovery publish answer", () => world.producers.length > publishedBefore && world.roundTripsInFlight === 0);
    await act(async () => {
      for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(world.producers.filter((producer) => !producer.closed).map((producer) => producer.id)).toEqual([]);
  });

  it("leaving the meeting page while a camera recovery publishes leaves no camera producer open", async () => {
    const rig = await join({ mic: false });
    world.holds.add("produce");
    await act(async () => liveCameraTrack(rig).lose());
    await until("the recovery publish", () => pendingOf("produce") === 1);

    const publishedBefore = world.producers.length;
    rig.unmount();
    current = null;
    world.releaseAll();
    await until("the recovery publish answer", () => world.producers.length > publishedBefore && world.roundTripsInFlight === 0);
    await act(async () => {
      for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(world.producers.filter((producer) => !producer.closed && producer.kind === "video").map((producer) => producer.id)).toEqual([]);
  });

  it("a microphone recovery whose publish answers after the call stopped being joined closes what it published", async () => {
    const rig = await join({ camera: false });
    world.holds.add("produce");
    await act(async () => liveMicrophoneSource()?.lose());
    await until("the recovery publish", () => pendingOf("produce") === 1);
    const publishedBefore = world.producers.length;

    await act(async () => rig.rig().state.setConnectionState("reconnecting"));
    const recovered: Array<[boolean, boolean | undefined]> = [];
    await act(async () => {
      world.releaseAll();
      for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      world.producers
        .slice(publishedBefore)
        .forEach((producer) => recovered.push([producer.closed, world.sfu.get(producer.id)?.closed]));
    });

    expect(recovered).toEqual([[true, true]]);
  });

  it("turning noise cancellation on and straight back off never sends the noise-cancelled microphone", async () => {
    const rig = await join({ camera: false });
    world.holds.add("noiseSetup");
    await act(async () => rig.rig().setNoiseCancellation(true));
    await until("the noise cancellation setup", () => pendingOf("noiseSetup") >= 1);

    await act(async () => rig.rig().setNoiseCancellation(false));
    await releaseAll(rig);

    expect(world.sent.filter((entry) => entry.source === "web-audio")).toEqual([]);
    expect(notLive(world, rig.rig())).toEqual([]);
    expect(unwanted(world, rig.rig())).toEqual([]);
  });

  it("a camera lost mid-call sends again without waiting for the watchdog when video effects change during the publish", async () => {
    const rig = await join({ mic: false });
    world.holds.add("produce");
    await act(async () => liveCameraTrack(rig).lose());
    await until("the recovery publish", () => pendingOf("produce") === 1);

    await act(async () => rig.rig().setVideoEffects(1));
    await releaseAll(rig);

    expect(notLive(world, rig.rig())).toEqual([]);
    expect(opened("video")).toBe(2);
    expect(unwanted(world, rig.rig())).toEqual([]);
  });

  it("camera recovery whose publish finishes after Turn off camera closes what it published", async () => {
    const rig = await join({ mic: false });
    world.holds.add("produce");
    await act(async () => liveCameraTrack(rig).lose());
    await until("the recovery publish", () => pendingOf("produce") === 1);

    await act(async () => {
      await rig.rig().media.toggleCamera();
    });
    await releaseAll(rig);

    expect(rig.rig().state.isCameraOff).toBe(true);
    expect(unwanted(world, rig.rig())).toEqual([]);
  });
});

describe("presses and publishes that race each other", () => {
  const openAudio = () => world.producers.filter((producer) => !producer.closed && producer.kind === "audio");

  it("a mute the SFU refuses after newer presses keeps the newest press", async () => {
    const rig = await join({ camera: false });
    world.holds.add("toggleMute");
    world.refusals.set("toggleMute", 1);
    let first: Promise<unknown> = Promise.resolve();
    await act(async () => {
      first = rig.rig().media.toggleMute();
    });
    await act(async () => {
      await rig.rig().media.toggleMute();
    });
    let third: Promise<unknown> = Promise.resolve();
    await act(async () => {
      third = rig.rig().media.toggleMute();
    });
    await releaseAll(rig, first, third);

    expect(rig.rig().state.isMuted).toBe(true);
    expect(openAudio().map((producer) => producer.paused)).toEqual([true]);
    expect(unwanted(world, rig.rig())).toEqual([]);
  });

  it("turning the camera on opens it once although camera recovery also wants it", async () => {
    const rig = await join({ mic: false, camera: false });
    world.holds.add("capture");
    let turningOn: Promise<unknown> = Promise.resolve();
    await act(async () => {
      turningOn = rig.rig().media.toggleCamera();
    });
    await until("the camera capture", () => pendingOf("capture") === 1);
    await rig.settle();
    await releaseAll(rig, turningOn);

    expect(opened("video")).toBe(1);
    expect(notLive(world, rig.rig())).toEqual([]);
    expect(unwanted(world, rig.rig())).toEqual([]);
  });

  it.each(["replaceTrack"] as const)(
    "turning the camera off while a quality reopen waits on %s stops the old and the new camera at once",
    async (held) => {
      const rig = await join({ mic: false });
      world.cameraRefusesConstraints = true;
      world.holds.add(held);
      let updating: Promise<unknown> = Promise.resolve();
      await act(async () => {
        updating = rig.rig().media.updateVideoQualityRef.current?.("low") ?? Promise.resolve();
      });
      await until(`the reopen waiting on ${held}`, () => pendingOf(held) === 1);
      const liveCameras = () =>
        world.tracks.filter((track) => track.kind === "video" && track.source === "device" && track.readyState === "live").map((track) => track.id);
      const openCameraProducers = () =>
        world.producers.filter((producer) => !producer.closed && producer.kind === "video").map((producer) => producer.id);
      expect(liveCameras()).toHaveLength(2);

      await act(async () => {
        await rig.rig().media.toggleCamera();
      });
      expect(liveCameras()).toEqual([]);
      expect(openCameraProducers()).toEqual([]);

      await releaseAll(rig, updating);
      expect(rig.rig().state.isCameraOff).toBe(true);
      expect(liveCameras()).toEqual([]);
      expect(openCameraProducers()).toEqual([]);
      expect(unwanted(world, rig.rig())).toEqual([]);
    },
  );

  const streamMicrophoneMatchesProducer = (rig: InCallRig) => {
    const streamMicrophones = (rig.rig().refs.localStreamRef.current?.getAudioTracks() ?? []).map((track) => track.id);
    const producerMicrophone = world.producers.find((producer) => !producer.closed && producer.kind === "audio")?.track?.id;
    return [streamMicrophones, producerMicrophone ? [producerMicrophone] : []];
  };

  it("a microphone switch that lands while a camera switch swaps keeps the new microphone in the local stream", async () => {
    const rig = await join();
    world.holds.add("replaceTrack");
    let switchingMicrophone: Promise<unknown> = Promise.resolve();
    let switchingCamera: Promise<unknown> = Promise.resolve();
    await act(async () => {
      switchingMicrophone = rig.rig().media.handleAudioInputDeviceChange("mic-2");
    });
    await until("the microphone swap", () => pendingOf("replaceTrack") === 1);
    await act(async () => {
      switchingCamera = rig.rig().media.handleVideoInputDeviceChange("cam-2");
    });
    await until("the camera swap", () => pendingOf("replaceTrack") === 2);

    await releaseAll(rig, switchingMicrophone, switchingCamera);

    const [streamMicrophones, producerMicrophone] = streamMicrophoneMatchesProducer(rig);
    expect(streamMicrophones).toEqual(producerMicrophone);
    expect(unwanted(world, rig.rig())).toEqual([]);
  });

  it("a quality reopen that rolls back after a microphone switch landed keeps the new microphone in the local stream", async () => {
    const rig = await join();
    world.cameraRefusesConstraints = true;
    world.holds.add("replaceTrack");
    let updating: Promise<unknown> = Promise.resolve();
    let switchingMicrophone: Promise<unknown> = Promise.resolve();
    await act(async () => {
      updating = rig.rig().media.updateVideoQualityRef.current?.("low").catch(() => {}) ?? Promise.resolve();
    });
    await until("the reopen swap", () => pendingOf("replaceTrack") === 1);
    await act(async () => {
      switchingMicrophone = rig.rig().media.handleAudioInputDeviceChange("mic-2");
    });
    await until("the microphone swap", () => pendingOf("replaceTrack") === 2);

    await act(async () => world.releaseOne(1));
    await rig.settle();
    world.refusals.set("replaceTrack", 1);
    await releaseAll(rig, updating, switchingMicrophone);

    const [streamMicrophones, producerMicrophone] = streamMicrophoneMatchesProducer(rig);
    expect(streamMicrophones).toEqual(producerMicrophone);
    expect(unwanted(world, rig.rig())).toEqual([]);
  });

  it("a quality reopen whose camera swap fails keeps sending the previous camera and stops the new one", async () => {
    const rig = await join({ mic: false });
    const previous = liveCameraTrack(rig);
    world.cameraRefusesConstraints = true;
    world.refusals.set("replaceTrack", 1);

    await act(async () => {
      await rig.rig().media.updateVideoQualityRef.current?.("low").catch(() => {});
    });
    await rig.settle();

    expect(world.tracks.filter((track) => track.kind === "video" && track.source === "device" && track.readyState === "live")).toEqual([previous]);
    expect(notLive(world, rig.rig())).toEqual([]);
    expect(unwanted(world, rig.rig())).toEqual([]);
  });

  it("a quality change still reopening the camera when the camera is turned off leaves no camera in the call", async () => {
    const rig = await join({ mic: false });
    world.cameraRefusesConstraints = true;
    world.holds.add("capture");
    let updating: Promise<unknown> = Promise.resolve();
    await act(async () => {
      updating = rig.rig().media.updateVideoQualityRef.current?.("low") ?? Promise.resolve();
    });
    await until("the camera reopen", () => pendingOf("capture") === 1);

    await act(async () => {
      await rig.rig().media.toggleCamera();
    });
    await releaseAll(rig, updating);

    expect(rig.rig().state.isCameraOff).toBe(true);
    expect(rig.rig().refs.localStreamRef.current?.getVideoTracks() ?? []).toEqual([]);
    expect(unwanted(world, rig.rig())).toEqual([]);
  });

  it("captures released while the join's microphone publish is in flight install no microphone producer", async () => {
    current = await createInCallRig(world);
    await setIntents(current, true, false);
    world.holds.add("produce");
    let joining: Promise<unknown> = Promise.resolve();
    await act(async () => {
      joining = current!.rig().socket.joinRoom();
    });
    await until("the join's microphone publish", () => pendingOf("produce") === 1);

    await act(async () => releaseAllCaptures());
    const joinsOwn: Array<[boolean, boolean | undefined]> = [];
    await act(async () => {
      world.releaseAll();
      await joining;
      world.producers
        .filter((producer) => producer.kind === "audio")
        .forEach((producer) => joinsOwn.push([producer.closed, world.sfu.get(producer.id)?.closed]));
    });

    expect(joinsOwn).toEqual([[true, true]]);
  });

  it("a microphone unmuted after a muted join sends again at once when its transport closes", async () => {
    const rig = await join({ mic: false, camera: false });
    await act(async () => {
      await rig.rig().media.toggleMute();
    });
    await rig.settle();
    expect(notLive(world, rig.rig())).toEqual([]);

    await act(async () => openAudio()[0]?.closeTransport());
    await rig.settle();

    expect(notLive(world, rig.rig())).toEqual([]);
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
    "the camera starts or stops refusing new constraints",
    () => {
      world.cameraRefusesConstraints = !world.cameraRefusesConstraints;
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
    stableTurns = snapshot === last && model.running.size === 0 && world.roundTripsInFlight === 0 ? stableTurns + 1 : 0;
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
          .join(" ")} stream ${(current.rig().refs.localStreamRef.current?.getTracks() ?? []).map((track) => track.id).join(",")}`,
      );
    }
    if (settled) {
      const problems = unwanted(world, current.rig());
      if (problems.length > 0) fail(seed, model, `after step ${index}`, problems);
    }
    if (settled && world.holds.size === 0) {
      for (let tick = 0; tick < LIVENESS_TICKS && notLive(world, current.rig()).length > 0; tick += 1) {
        await current.tick(WATCHDOG_MS);
        await quiesce(model);
      }
      const silent = notLive(world, current.rig());
      if (silent.length > 0) fail(seed, model, `after step ${index}, ${LIVENESS_TICKS} watchdog ticks later`, silent);
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

describe("seeded in-call model: nothing live the current choice does not call for, and every chosen device sending", () => {
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
