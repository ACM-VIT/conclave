// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { startRig, stopRig, type CallRig } from "./call-rig";

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

const rebuilds = (target: CallRig) => target.log.filter((line) => line.includes("Rebuilding the")).length;
const blockedReports = (target: CallRig) =>
  target.log.filter((line) => line.includes("Media cannot get through")).length;

const stallUntilCredentialsAreHeld = async (target: CallRig) => {
  target.route = "hold";
  target.mediaFlows = false;
  expect(await waitFor(target, () => target.heldRoutes.length > 0, 40_000)).toBe(true);
};

const resumeMediaAndAnswer = async (target: CallRig) => {
  target.mediaFlows = true;
  target.route = "up";
  target.releaseHeldRoutes("answer");
  await target.advance(2_000);
};

describe("a rebuild that turns out not to be needed", () => {
  it("counts the proof that skipped it, so the next stall is rebuilt and then reported", async () => {
    rig = await startRig();
    await rig.join();
    await rig.advance(5_000);
    const recv = rig.recv!;
    await stallUntilCredentialsAreHeld(rig);
    expect(recv.restartIceCalls).toBe(1);

    await resumeMediaAndAnswer(rig);
    expect(rig.recvTransports).toEqual([recv]);
    expect(rig.health.consumer).toBe("healthy");

    rig.mediaFlows = false;
    expect(await waitFor(rig, () => rig!.recvTransports.length > 1, 40_000)).toBe(true);
    expect(recv.restartIceCalls).toBe(2);
    expect(await waitFor(rig, () => rig!.health.consumer === "blocked", 40_000)).toBe(true);
    expect(blockedReports(rig)).toBe(1);
  });

  it("leaves the first rebuild untried, so a later failure moves onto TURN before any warning", async () => {
    rig = await startRig({ directWorks: false });
    await rig.join();
    await rig.advance(5_000);
    const recv = rig.recv!;
    rig.refuseIceRestart = true;
    await stallUntilCredentialsAreHeld(rig);

    await resumeMediaAndAnswer(rig);
    expect(rig.recvTransports).toEqual([recv]);

    rig.mediaFlows = false;
    recv.setState("disconnected");
    recv.setState("connected");
    rig.failRecv();
    expect(await waitFor(rig, () => rig!.recvTransports.length > 1, 10_000)).toBe(true);

    expect(rig.recv!.policy).toBe("relay");
    expect(blockedReports(rig)).toBe(0);
    expect(rig.health.consumer).not.toBe("blocked");
  });

  it("leaves the first rebuild untried when the failed transport is replaced before the rebuild starts", async () => {
    rig = await startRig({ publish: true });
    await rig.join();
    await rig.advance(5_000);
    const first = rig.send!;
    rig.refuseIceRestart = true;
    rig.route = "hold";
    first.setState("failed");
    expect(await waitFor(rig, () => rig!.heldRoutes.length > 0, 5_000)).toBe(true);

    const target = rig;
    await act(async () => {
      await target.api.ensureProducerTransport();
    });
    const second = rig.send!;
    expect(second).not.toBe(first);
    rig.route = "up";
    rig.releaseHeldRoutes("answer");
    await rig.advance(2_000);
    expect(rig.send).toBe(second);

    second.setState("failed");
    expect(await waitFor(rig, () => rig!.send !== second, 10_000)).toBe(true);
    expect(blockedReports(rig)).toBe(0);
    expect(rig.health.producer).not.toBe("blocked");
  });
});

describe("a rebuild held behind another direction's rebuild", () => {
  it("still requires the camera that failed to reach the SFU when it is replayed", async () => {
    rig = await startRig({ publish: true, camera: true });
    await rig.join();
    await rig.advance(5_000);
    const send = rig.send!;
    rig.droppedSendKinds.add("video");
    expect(await waitFor(rig, () => send.restartIceCalls === 1, 30_000)).toBe(true);

    rig.refuseIceRestart = true;
    rig.route = "hold";
    rig.failRecv();
    await rig.advance(500);
    expect(rig.heldRoutes.length).toBeGreaterThan(0);
    await rig.advance(5_000);
    expect(rig.send).toBe(send);

    rig.videoQuiet = true;
    rig.route = "up";
    rig.releaseHeldRoutes("answer");

    expect(await waitFor(rig, () => rig!.send !== send, 10_000)).toBe(true);
    expect(rig.log.some((line) => line.includes("Rebuilding the producer transport"))).toBe(true);
  });
});

describe("each direction's own watch", () => {
  it("notices a receive stall on time while the send path's ICE restart hangs", async () => {
    rig = await startRig({ publish: true });
    await rig.join();
    await rig.advance(5_000);
    const send = rig.send!;
    const recv = rig.recv!;
    let sendRestartStarted = false;
    send.restartIce = () => {
      sendRestartStarted = true;
      return new Promise<void>(() => {});
    };
    rig.outgoingDropped = true;
    expect(await waitFor(rig, () => sendRestartStarted, 25_000)).toBe(true);

    rig.mediaFlows = false;
    const stalledAt = Date.now();
    expect(await waitFor(rig, () => recv.restartIceCalls > 0, 30_000)).toBe(true);
    expect(Date.now() - stalledAt).toBeLessThanOrEqual(20_000);
  });
});

describe("a check after an ICE restart", () => {
  it.each([
    ["first", 0],
    ["second", 1],
  ])(
    "does not take a missing %s sender count for a recovered screen share",
    async (_which, answeredFirst) => {
      rig = await startRig({ remoteMedia: "screen" });
      await rig.join();
      await rig.advance(5_000);
      const transport = rig.recv!;
      rig.mediaFlows = false;
      expect(await waitFor(rig, () => transport.restartIceCalls > 0, 30_000)).toBe(true);
      const asked = rig.senderCountQueries;
      expect(await waitFor(rig, () => rig!.senderCountQueries >= asked + answeredFirst, 5_000)).toBe(true);
      rig.dropSenderCountAnswers = 1;

      expect(await waitFor(rig, () => rig!.recvTransports.length > 1, 15_000)).toBe(true);
      expect(rig.dropSenderCountAnswers).toBe(0);
    },
  );

  it("marks the direction healthy as soon as the check sees media arrive again", async () => {
    rig = await startRig();
    await rig.join();
    await rig.advance(5_000);
    const recv = rig.recv!;
    rig.mediaFlows = false;
    expect(await waitFor(rig, () => recv.restartIceCalls > 0, 30_000)).toBe(true);
    expect(rig.health.consumer).toBe("recovering");

    rig.mediaFlows = true;
    await rig.advance(5_000);

    expect(rig.health.consumer).toBe("healthy");
    expect(rig.recvTransports).toEqual([recv]);
  });
});

const mulberry32 = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};

const NEVER = () => new Promise<void>(() => {});
const PAUSES = [250, 1_500, 2_000, 2_500, 4_000, 6_000, 20_000, 25_000];
const ACTIONS = [
  "stall-recv", "stall-recv", "stall-recv", "stall-recv", "resume-recv", "resume-recv", "resume-recv",
  "hold-route", "hold-route", "hold-route", "answer-route", "answer-route", "answer-route", "fail-route",
  "drop-send", "heal-send", "drop-camera", "quiet-camera", "refuse-ice", "fail-recv", "fail-send",
  "blip-recv", "lose-counts", "hang-restart", "hold-stats", "drop-socket", "ensure-send", "retry",
] as const;

const playSeed = async (seed: number): Promise<string | null> => {
  const random = mulberry32(seed);
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)];
  const target = await startRig({ publish: true, camera: random() < 0.5, directWorks: random() < 0.7 });
  rig = target;
  const trace: string[] = [];
  const releases: Array<() => void> = [];
  try {
    await target.join();
    await target.advance(5_000);
    for (let step = 0; step < 24; step++) {
      const action = pick(ACTIONS);
      trace.push(action);
      const recv = target.recv;
      const send = target.send;
      if (action === "stall-recv") target.mediaFlows = false;
      else if (action === "resume-recv") target.mediaFlows = true;
      else if (action === "drop-send") target.outgoingDropped = true;
      else if (action === "heal-send") {
        target.outgoingDropped = false;
        target.droppedSendKinds.clear();
        target.videoQuiet = false;
      } else if (action === "drop-camera") target.droppedSendKinds.add("video");
      else if (action === "quiet-camera") target.videoQuiet = !target.videoQuiet;
      else if (action === "hold-route") target.route = "hold";
      else if (action === "answer-route") {
        target.route = "up";
        target.releaseHeldRoutes("answer");
      } else if (action === "fail-route") target.releaseHeldRoutes("fail");
      else if (action === "refuse-ice") target.refuseIceRestart = !target.refuseIceRestart;
      else if (action === "fail-recv") recv?.setState("failed");
      else if (action === "fail-send") send?.setState("failed");
      else if (action === "blip-recv") {
        recv?.setState("disconnected");
        recv?.setState("connected");
      } else if (action === "lose-counts") target.answersSenderCounts = !target.answersSenderCounts;
      else if (action === "hang-restart") {
        const transport = pick([recv, send]);
        if (transport) transport.restartIce = NEVER;
      } else if (action === "hold-stats") {
        const transport = pick([recv, send]);
        if (transport && !transport.closed) releases.push(transport.holdNextStats());
      } else if (action === "drop-socket") {
        if (target.socket?.connected) await target.dropSocket();
      } else if (action === "ensure-send") {
        await act(async () => {
          await target.api.ensureProducerTransport();
        });
      } else await target.retry();
      await target.advance(pick(PAUSES));
    }

    releases.forEach((release) => release());
    target.route = "up";
    target.releaseHeldRoutes("answer");
    target.refuseIceRestart = false;
    target.answersSenderCounts = true;
    target.outgoingDropped = false;
    target.droppedSendKinds.clear();
    target.videoQuiet = false;
    target.mediaFlows = random() < 0.5;
    await target.advance(30_000);
    if (!target.socket?.connected) await target.retry();

    const describeEnd = (wanted: string) =>
      `seed ${seed}: wanted ${wanted}, got ${JSON.stringify(target.health)} | ${trace.join(" ")} | ${target.log.slice(-6).join(" | ")}`;
    const reaches = (direction: "producer" | "consumer", state: string) =>
      waitFor(target, () => target.health[direction] === state, 240_000);
    const endsHealthy = async (direction: "producer" | "consumer") => {
      if (!(await waitFor(target, () => target.health[direction] !== "recovering", 240_000))) {
        return describeEnd(`${direction} healthy or blocked`);
      }
      if (target.health[direction] === "healthy") return null;
      await target.retry();
      return (await reaches(direction, "healthy"))
        ? null
        : describeEnd(`${direction} healthy after Try again`);
    };
    const receiveEnd = target.mediaFlows
      ? await endsHealthy("consumer")
      : (await reaches("consumer", "blocked"))
        ? null
        : describeEnd("consumer blocked");
    return receiveEnd ?? (await endsHealthy("producer"));
  } finally {
    await stopRig(target);
    rig = null;
  }
};

const SEEDS_STUCK_RECOVERING_BEFORE = [118, 447, 688];
const seedsFrom = (first: number, last: number) =>
  Array.from({ length: last - first + 1 }, (_, index) => first + index);

describe("the hook's recovery under random interleavings", () => {
  it("ends every failure healthy or reported blocked, and recovers a blocked path on Try again", async () => {
    const seeds = process.env.RIG_EXTENDED
      ? seedsFrom(61, 1_060)
      : [...SEEDS_STUCK_RECOVERING_BEFORE, ...seedsFrom(1, 60)];
    const failed: string[] = [];
    for (const seed of seeds) {
      const failure = await playSeed(seed);
      if (failure) failed.push(failure);
      if (failed.length >= 5) break;
    }
    expect(failed).toEqual([]);
  }, 600_000);
});
