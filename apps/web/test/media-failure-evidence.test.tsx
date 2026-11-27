// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { startRig, stopRig, type CallRig, type FakeTransport } from "./call-rig";

let rig: CallRig | null = null;
afterEach(async (context) => {
  if (process.env.RIG_LOG && rig) process.stdout.write(`${context.task.name}\n${rig.log.join("\n")}\n`);
  await stopRig(rig);
  rig = null;
});

const waitFor = async (target: CallRig, condition: () => boolean, limitMs: number) => {
  for (let waited = 0; waited < limitMs && !condition(); waited += 250) await target.advance(250);
  return condition();
};

const sendTransports = (target: CallRig) =>
  target.transports.filter((transport) => transport.direction === "send");

const liveKinds = (transport: FakeTransport) =>
  transport.sending
    .filter(({ producer }) => !producer.closed)
    .map(({ producer }) => producer.kind)
    .sort();

const callWithDroppedCamera = async () => {
  const target = await startRig({ publish: true, camera: true });
  rig = target;
  await target.join();
  await target.advance(5_000);
  target.droppedSendKinds.add("video");
  return target;
};

const rebuiltOnceWithCameraStillDropped = async () => {
  const target = await callWithDroppedCamera();
  const first = target.send!;
  expect(await waitFor(target, () => target.send !== first, 45_000)).toBe(true);
  const second = target.send!;
  expect(await waitFor(target, () => liveKinds(second).length === 2, 5_000)).toBe(true);
  return { target, second };
};

const blockedOnTheRebuiltTransport = async () => {
  const { target, second } = await rebuiltOnceWithCameraStillDropped();
  expect(await waitFor(target, () => target.health.producer === "blocked", 40_000)).toBe(true);
  expect(target.send).toBe(second);
  return { target, second };
};

const healthSeenOver = async (target: CallRig, ms: number) => {
  const seen = new Set<string>();
  for (let waited = 0; waited < ms; waited += 250) {
    await target.advance(250);
    seen.add(target.health.producer);
  }
  return [...seen].sort();
};

describe("the rig after a send rebuild", () => {
  it("publishes the microphone and the camera again on the new transport", async () => {
    const target = await startRig({ publish: true, camera: true });
    rig = target;
    await target.join();
    await target.advance(5_000);
    const first = target.send!;
    expect(liveKinds(first)).toEqual(["audio", "video"]);

    target.outgoingDropped = true;
    expect(await waitFor(target, () => target.send !== first, 45_000)).toBe(true);
    const second = target.send!;
    expect(await waitFor(target, () => liveKinds(second).length === 2, 5_000)).toBe(true);

    expect(liveKinds(first)).toEqual([]);
    expect(liveKinds(second)).toEqual(["audio", "video"]);
    expect(target.refs.audioProducerRef.current?.closed).toBe(false);
    expect(target.refs.videoProducerRef.current?.closed).toBe(false);
  });
});

describe("a camera that still fails after its one rebuild", () => {
  it("is reported blocked on the rebuilt transport when one count reply goes missing", async () => {
    const { target, second } = await rebuiltOnceWithCameraStillDropped();

    target.answersSenderCounts = false;
    await target.advance(2_600);
    target.answersSenderCounts = true;
    await target.advance(3_000);
    expect(target.health.producer).not.toBe("healthy");

    await target.advance(30_000);
    expect(target.send).toBe(second);
    expect(sendTransports(target)).toHaveLength(2);
    expect(target.health.producer).toBe("blocked");
  });

  it("is reported blocked when the camera is published a while after the microphone", async () => {
    const target = await callWithDroppedCamera();
    target.republishDelayMs.video = 8_000;
    const first = target.send!;
    expect(await waitFor(target, () => target.send !== first, 45_000)).toBe(true);
    const second = target.send!;

    await target.advance(7_000);
    expect(liveKinds(second)).toEqual(["audio"]);
    expect(target.health.producer).not.toBe("healthy");

    expect(await waitFor(target, () => target.health.producer === "blocked", 60_000)).toBe(true);
    expect(target.send).toBe(second);
    expect(sendTransports(target)).toHaveLength(2);
  });

  it("goes back to healthy once the camera is seen arriving", async () => {
    const { target, second } = await rebuiltOnceWithCameraStillDropped();

    target.droppedSendKinds.clear();

    expect(await waitFor(target, () => target.health.producer === "healthy", 10_000)).toBe(true);
    expect(target.send).toBe(second);
  });
});

describe("a send path reported blocked", () => {
  it("stays blocked on the same transport while count replies go missing", async () => {
    const { target, second } = await blockedOnTheRebuiltTransport();

    target.dropEveryOtherOwnCountAnswer = true;

    expect(await healthSeenOver(target, 45_000)).toEqual(["blocked"]);
    expect(target.send).toBe(second);
    expect(sendTransports(target)).toHaveLength(2);
  });

  it("stays blocked on the same transport while the camera sends nothing for a while", async () => {
    const { target, second } = await blockedOnTheRebuiltTransport();

    target.videoQuiet = true;
    expect(await healthSeenOver(target, 6_000)).toEqual(["blocked"]);
    target.videoQuiet = false;

    expect(await healthSeenOver(target, 30_000)).toEqual(["blocked"]);
    expect(target.send).toBe(second);
    expect(sendTransports(target)).toHaveLength(2);
  });

  it("stays blocked while the camera sends in bursts", async () => {
    const { target, second } = await blockedOnTheRebuiltTransport();

    target.burstyVideo = true;

    expect(await healthSeenOver(target, 90_000)).toEqual(["blocked"]);
    expect(target.send).toBe(second);
  });

  it("clears once the camera is seen arriving", async () => {
    const { target, second } = await blockedOnTheRebuiltTransport();

    target.droppedSendKinds.clear();

    expect(await waitFor(target, () => target.health.producer === "healthy", 10_000)).toBe(true);
    expect(target.send).toBe(second);
  });
});

describe("a send rebuild held behind a receive rebuild", () => {
  const heldBehindReceiveRebuild = async () => {
    const target = await callWithDroppedCamera();
    const send = target.send!;
    expect(await waitFor(target, () => send.restartIceCalls === 1, 30_000)).toBe(true);
    target.refuseIceRestart = true;
    target.route = "hold";
    target.failRecv();
    await target.advance(500);
    expect(target.heldRoutes.length).toBeGreaterThan(0);
    await target.advance(4_000);
    expect(target.send).toBe(send);
    expect(target.health.producer).toBe("recovering");
    return { target, send };
  };

  const answerTheRoute = async (target: CallRig) => {
    target.route = "up";
    target.releaseHeldRoutes("answer");
    await target.advance(15_000);
  };

  it("is still run when the camera goes quiet while it waits", async () => {
    const { target, send } = await heldBehindReceiveRebuild();

    target.videoQuiet = true;
    expect(await healthSeenOver(target, 6_000)).toEqual(["recovering"]);

    await answerTheRoute(target);
    expect(target.send).not.toBe(send);
  });

  it("is still run when one count reply goes missing while it waits", async () => {
    const { target, send } = await heldBehindReceiveRebuild();

    target.answersSenderCounts = false;
    await target.advance(3_000);
    target.answersSenderCounts = true;
    expect(await healthSeenOver(target, 3_000)).toEqual(["recovering"]);

    await answerTheRoute(target);
    expect(target.send).not.toBe(send);
  });

  it("is dropped when the camera is seen arriving while it waits", async () => {
    const { target, send } = await heldBehindReceiveRebuild();

    target.droppedSendKinds.clear();
    await target.advance(6_000);
    expect(target.health.producer).toBe("healthy");

    await answerTheRoute(target);
    expect(target.send).toBe(send);
  });
});

describe("Try again pressed while an automatic rejoin is connecting", () => {
  it("still runs as a full Try again once that rejoin finishes", async () => {
    const target = await startRig({ directWorks: true, ttlSeconds: 60 });
    rig = target;
    await target.join();
    await target.advance(5_000);
    target.mediaFlows = false;
    expect(await waitFor(target, () => target.health.consumer === "blocked", 80_000)).toBe(true);
    expect(target.recv?.policy).toBe("relay");

    await target.advance(10_000);
    target.route = "hold";
    await target.dropSocket();
    expect(await waitFor(target, () => target.heldRoutes.length > 0, 15_000)).toBe(true);

    target.mediaFlows = true;
    target.relayWorks = false;
    await target.retry();
    target.route = "up";
    target.releaseHeldRoutes("answer");
    await target.advance(10_000);

    expect(target.recv?.policy).toBe("all");
    expect(target.health.consumer).toBe("healthy");
  });
});
