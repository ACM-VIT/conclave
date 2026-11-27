// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { RIG_START, TURN_A, TURN_B, startRig, stopRig, type CallRig, type FakeTransport } from "./call-rig";

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

const advanceTo = async (target: CallRig, seconds: number) => {
  const left = RIG_START + seconds * 1000 - Date.now();
  if (left > 0) await target.advance(left);
};

const sendTransports = (target: CallRig) =>
  target.transports.filter((transport) => transport.direction === "send");

const liveKinds = (transport: FakeTransport) =>
  transport.sending
    .filter(({ producer }) => !producer.closed)
    .map(({ producer }) => producer.kind)
    .sort();

const reachedSfu = (transport: FakeTransport) =>
  transport.sending.reduce((total, stream) => total + stream.sfuPackets, 0);

const rebuiltWithoutTurn = async (fault: (target: CallRig) => void) => {
  const target = await startRig({ publish: true, camera: true, ttlSeconds: 30 });
  rig = target;
  await target.join();
  await advanceTo(target, 12);
  const first = target.send!;
  expect(reachedSfu(first)).toBeGreaterThan(0);
  target.provider = "down";
  fault(target);
  expect(await waitFor(target, () => target.send !== first, 45_000)).toBe(true);
  const second = target.send!;
  expect(second.policy).toBe("all");
  expect(second.turnUsernames).toEqual([]);
  expect(await waitFor(target, () => liveKinds(second).length === 2, 5_000)).toBe(true);
  return { target, first, second };
};

describe("a send path rebuilt while no TURN credentials were usable", () => {
  it("moves onto the relay when credentials return, with every packet dropped while ICE and receiver reports pass", async () => {
    const { target, second } = await rebuiltWithoutTurn((call) => {
      call.directPathDropsSentRtp = true;
    });
    await target.advance(8_000);
    expect(second.connectionState).toBe("connected");
    expect(second.carriedBytes).toBeGreaterThan(0);
    expect(second.reportAt).not.toBeNull();
    expect(reachedSfu(second)).toBe(0);

    target.provider = "up";

    expect(await waitFor(target, () => target.send !== second, 30_000)).toBe(true);
    const third = target.send!;
    expect(third.policy).toBe("relay");
    expect(third.turnUsernames).toEqual([target.generations.at(-1)!.username]);
    expect(await waitFor(target, () => target.health.producer === "healthy", 20_000)).toBe(true);
    expect(reachedSfu(third)).toBeGreaterThan(0);
    expect(target.send).toBe(third);
    expect(sendTransports(target)).toHaveLength(3);
  });

  it("moves onto the relay when credentials return after the path was reported blocked", async () => {
    const { target, second } = await rebuiltWithoutTurn((call) => {
      call.directPathDropsSentRtp = true;
    });
    expect(await waitFor(target, () => target.health.producer === "blocked", 40_000)).toBe(true);
    expect(target.send).toBe(second);
    expect(second.restartIceCalls).toBe(0);

    target.provider = "up";

    expect(await waitFor(target, () => target.send !== second, 30_000)).toBe(true);
    expect(target.send!.policy).toBe("relay");
    expect(await waitFor(target, () => target.health.producer === "healthy", 20_000)).toBe(true);
  });

  it("stays where it is when credentials return and it delivers", async () => {
    const { target, second } = await rebuiltWithoutTurn((call) => {
      call.outgoingDropped = true;
    });
    target.outgoingDropped = false;
    target.provider = "up";
    const since = Date.now();

    expect(
      await waitFor(target, () => target.lastRelayAnswerAt !== null && target.lastRelayAnswerAt >= since, 15_000),
    ).toBe(true);
    await target.advance(30_000);

    expect(reachedSfu(second)).toBeGreaterThan(0);
    expect(target.send).toBe(second);
    expect(target.health.producer).toBe("healthy");
    expect(target.moves).toEqual([]);
  });
});

describe("a send path that never delivered a packet", () => {
  it("is rebuilt without an ICE restart, however long count replies were missing while reports came back", async () => {
    const target = await startRig({ publish: true, camera: true });
    rig = target;
    target.directPathDropsSentRtp = true;
    target.answersSenderCounts = false;
    await target.join();
    const first = target.send!;
    await target.advance(12_000);
    expect(first.reportAt).not.toBeNull();
    expect(reachedSfu(first)).toBe(0);
    target.answersSenderCounts = true;

    expect(await waitFor(target, () => target.send !== first, 45_000)).toBe(true);
    expect(first.restartIceCalls).toBe(0);
    expect(target.send!.policy).toBe("relay");
    expect(await waitFor(target, () => target.health.producer === "healthy", 20_000)).toBe(true);
  });
});

describe("the relay kept on offer as the one that carried media", () => {
  it("stays the one that delivered while a newer relay passes only ICE and receiver reports", async () => {
    const target = await startRig({ publish: true, camera: true, directWorks: false });
    rig = target;
    target.answerUrls = [TURN_B];
    await target.join();
    await target.advance(10_000);
    const delivered = target.generations[0];
    expect(target.send!.allocatedUrl).toBe(TURN_B);
    expect(reachedSfu(target.send!)).toBeGreaterThan(0);

    target.answerUrls = [TURN_A];
    target.relayUrlsDroppingMedia.add(TURN_A);
    target.answersSenderCounts = false;
    await target.retry();
    await target.advance(12_000);
    const newer = target.generations.at(-1)!;
    const send = target.send!;
    expect(newer).not.toBe(delivered);
    expect(send.allocatedUrl).toBe(TURN_A);
    expect(send.turnUsernames).toEqual([newer.username, delivered.username]);
    expect(send.carriedBytes).toBeGreaterThan(0);
    expect(send.reportAt).not.toBeNull();
    expect(reachedSfu(send)).toBe(0);

    target.refuseIceRestart = true;
    target.failRecv();
    await target.advance(3_000);

    expect(target.recv!.createdAt).toBeGreaterThan(send.createdAt);
    expect(target.recv!.turnUsernames).toContain(delivered.username);
  });
});

describe("a still screen share on a send path that has carried media", () => {
  const stillShareAfterReportsStopped = async () => {
    const target = await startRig();
    rig = target;
    await target.join();
    await target.shareScreen({ video: true, audio: false });
    await target.advance(6_000);
    const send = target.send!;
    expect(reachedSfu(send)).toBeGreaterThan(0);
    target.sendStatic = true;
    await target.advance(10_000);
    target.outgoingDropped = true;
    expect(await waitFor(target, () => send.restartIceCalls === 1, 25_000)).toBe(true);
    return { target, send };
  };

  it("is left alone when receiver reports come back after the ICE restart, and proves nothing until a frame is counted", async () => {
    const { target, send } = await stillShareAfterReportsStopped();
    target.outgoingDropped = false;
    const countedBefore = reachedSfu(send);
    await target.advance(40_000);

    expect(target.send).toBe(send);
    expect(send.restartIceCalls).toBe(1);
    expect(reachedSfu(send)).toBe(countedBefore);
    expect(target.log.some((line) => line.includes("Rebuilding"))).toBe(false);
    expect(target.health.producer).toBe("recovering");

    target.sendStatic = false;
    expect(await waitFor(target, () => target.health.producer === "healthy", 10_000)).toBe(true);
    expect(target.send).toBe(send);
  });

  it("is rebuilt when no receiver report comes back after the ICE restart", async () => {
    const { target, send } = await stillShareAfterReportsStopped();

    expect(await waitFor(target, () => target.send !== send, 20_000)).toBe(true);
    expect(target.log.some((line) => line.includes("Rebuilding the producer transport"))).toBe(true);
  });
});
