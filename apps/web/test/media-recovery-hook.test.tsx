// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { RIG_START, startRig, stopRig, type CallRig, type FakeTransport } from "./call-rig";

let rig: CallRig | null = null;
afterEach(async (context) => {
  if (process.env.RIG_LOG && rig) process.stdout.write(`${context.task.name}\n${rig.log.join("\n")}\n`);
  await stopRig(rig);
  rig = null;
});

const at = (seconds: number) => RIG_START + seconds * 1000;

const advanceTo = async (target: CallRig, seconds: number) => {
  const left = at(seconds) - Date.now();
  if (left > 0) await target.advance(left);
};

const recoverThroughTurn = async (target: CallRig) => {
  target.refuseIceRestart = true;
  target.failRecv();
  await target.advance(3_000);
  const recovered = target.recv!;
  expect(recovered.policy).toBe("relay");
  expect(recovered.carriedBytes).toBeGreaterThan(0);
  return recovered;
};

const relayTransportsAfter = (target: CallRig, since: number) =>
  target.recvTransports.filter((transport) => transport.createdAt >= since && transport.policy === "relay");

const waitFor = async (target: CallRig, condition: () => boolean, limitMs: number) => {
  for (let waited = 0; waited < limitMs && !condition(); waited += 250) await target.advance(250);
  return condition();
};

describe("the media path recovery the hook runs", () => {
  it("builds a transport with every candidate when relay only is wanted and no relay is usable", async () => {
    rig = await startRig({ ttlSeconds: 30 });
    await rig.join();
    await recoverThroughTurn(rig);
    await rig.advance(30_000);
    rig.route = "down";
    rig.failRecv();
    await rig.advance(5_000);

    expect(rig.recv?.policy).toBe("all");
    expect(rig.recv?.turnUsernames).toEqual([]);
    expect(rig.recv?.carriedBytes).toBeGreaterThan(0);
  });

  it("does not rebuild when the last remote stream pauses while an ICE restart is checked", async () => {
    rig = await startRig();
    await rig.join();
    const transport = rig.recv!;
    rig.mediaFlows = false;
    expect(await waitFor(rig, () => transport.restartIceCalls > 0, 25_000)).toBe(true);
    rig.pauseRemoteProducers(true);
    await rig.advance(8_000);

    expect(rig.recvTransports).toEqual([transport]);
    expect(rig.log.some((line) => line.includes("Rebuilding"))).toBe(false);
  });
});

describe("moving onto the relay when credentials return", () => {
  const blockedWithoutRelay = async () => {
    const target = await startRig({ ttlSeconds: 30, directWorks: false });
    await target.join();
    await recoverThroughTurn(target);
    await advanceTo(target, 25);
    target.provider = "down";
    await advanceTo(target, 37);
    target.failRecv();
    await target.advance(18_000);
    expect(target.recv?.turnUsernames).toEqual([]);
    expect(target.health.consumer).toBe("blocked");
    return target;
  };

  it("moves at once when a background refresh brings credentials back", async () => {
    rig = await blockedWithoutRelay();
    rig.provider = "up";
    const since = Date.now();
    expect(await waitFor(rig, () => rig!.lastRelayAnswerAt !== null && rig!.lastRelayAnswerAt >= since, 12_000)).toBe(true);
    const answeredAt = rig.lastRelayAnswerAt!;
    await rig.flush();

    const moved = relayTransportsAfter(rig, answeredAt);
    expect(moved).toHaveLength(1);
    expect(moved[0].createdAt - answeredAt).toBeLessThan(500);
    await rig.advance(6_000);
    expect(rig.recv?.carriedBytes).toBeGreaterThan(0);
    expect(rig.health.consumer).toBe("healthy");
  });

  it("moves as soon as a rebuild that was waiting for the producer list finishes", async () => {
    rig = await startRig({ ttlSeconds: 30, directWorks: false });
    await rig.join();
    await recoverThroughTurn(rig);
    await advanceTo(rig, 25);
    rig.provider = "down";
    await advanceTo(rig, 41);
    rig.holdProducersMs = 12_000;
    const failedAt = Date.now();
    rig.failRecv();
    await rig.advance(500);
    rig.provider = "up";
    await advanceTo(rig, (failedAt - RIG_START) / 1000 + 11.9);
    expect(rig.lastRelayAnswerAt).toBeGreaterThan(failedAt);
    expect(relayTransportsAfter(rig, failedAt)).toEqual([]);
    await rig.advance(400);
    await rig.flush();

    const moved = relayTransportsAfter(rig, failedAt);
    expect(moved).toHaveLength(1);
    expect(moved[0].createdAt - (failedAt + 12_000)).toBeLessThan(500);
  });

  it("keeps fetching credentials once they expire while relay only is wanted", async () => {
    rig = await startRig({ ttlSeconds: 30 });
    await rig.join();
    const recovered = await recoverThroughTurn(rig);
    const recoveredAt = Date.now();
    await rig.advance(50_000);

    expect(rig.joinRequests.filter((request) => request.at > recoveredAt + 20_000).length).toBeGreaterThan(0);
    expect(rig.recv).toBe(recovered);
  });

  it("gives a new rebuild a fresh retry budget after the last one ran out", async () => {
    rig = await startRig({ ttlSeconds: 30 });
    await rig.join();
    await recoverThroughTurn(rig);
    rig.provider = "down";
    await rig.advance(100_000);
    const exhaustedAt = Date.now();
    const asked = rig.joinRequests.length;
    await rig.advance(20_000);
    expect(rig.joinRequests.length).toBe(asked);

    rig.failRecv();
    await rig.advance(25_000);
    expect(rig.joinRequests.filter((request) => request.at > exhaustedAt + 21_000).length).toBeGreaterThanOrEqual(2);
  });

  it("moves a failed transport whose offered credentials expired before it connected", async () => {
    rig = await startRig({ ttlSeconds: 30, directWorks: false });
    await rig.join();
    await advanceTo(rig, 5);
    const recovered = await recoverThroughTurn(rig);
    const expiresAt = rig.generations.find((generation) => recovered.turnUsernames.includes(generation.username))!.expiresAt;
    await advanceTo(rig, (expiresAt - RIG_START) / 1000 - 5.9);
    rig.route = "down";
    rig.relayConnectMs = 7_000;
    rig.failRecv();
    await rig.advance(1_000);
    const stranded = rig.recv!;
    expect(stranded.turnUsernames).toEqual(recovered.turnUsernames);
    expect(await waitFor(rig, () => rig!.health.consumer === "blocked", 25_000)).toBe(true);

    rig.route = "up";
    rig.relayConnectMs = 200;
    expect(await waitFor(rig, () => rig!.recv !== stranded && rig!.recv!.carriedBytes > 0, 30_000)).toBe(true);
    expect(rig.recv?.usableGeneration?.username).toBe(rig.generations.at(-1)?.username);
    expect(await waitFor(rig, () => rig!.health.consumer === "healthy", 8_000)).toBe(true);
  });

  it("never moves a transport that carries media while its rebuild waits for the producer list", async () => {
    rig = await startRig({ ttlSeconds: 30 });
    await rig.join();
    await recoverThroughTurn(rig);
    await advanceTo(rig, 25);
    rig.provider = "down";
    await advanceTo(rig, 41);
    rig.holdProducersMs = 12_000;
    const failedAt = Date.now();
    rig.failRecv();
    await rig.advance(1_000);
    const direct = rig.recv!;
    expect(direct.policy).toBe("all");
    rig.announceProducer();
    rig.provider = "up";
    await rig.advance(20_000);

    expect(direct.carriedBytes).toBeGreaterThan(0);
    expect(rig.moves).toEqual([]);
    expect(rig.recv).toBe(direct);
    expect(relayTransportsAfter(rig, failedAt)).toEqual([]);
  });
});

describe("one versioned set of TURN credentials", () => {
  it("never lets a saved answer with expired credentials replace fresher ones", async () => {
    rig = await startRig({ ttlSeconds: 30, directWorks: false });
    await rig.join();
    await advanceTo(rig, 5);
    await recoverThroughTurn(rig);
    rig.route = "down";
    await advanceTo(rig, 40);
    rig.route = "up";
    rig.routePlan = ["hold"];
    await rig.dropSocket();
    expect(await waitFor(rig, () => rig!.heldRoutes.length > 0, 10_000)).toBe(true);
    const generations = rig.generations.length;
    expect(await waitFor(rig, () => rig!.generations.length > generations, 15_000)).toBe(true);
    const fresh = rig.generations.at(-1)!;
    const released = Date.now();
    rig.releaseHeldRoutes("fail");
    await rig.advance(8_000);

    const rejoined: FakeTransport = rig.recvTransports.find((transport) => transport.createdAt >= released)!;
    expect(rejoined.turnUsernames).toEqual([fresh.username]);
    expect(rejoined.carriedBytes).toBeGreaterThan(0);
    expect(rig.recvTransports.filter((transport) => transport.createdAt >= released)).toEqual([rejoined]);
  });
});

const mulberry32 = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};

const RELAY_USABLE_MARGIN_MS = 5_000;

const playSeed = async (seed: number): Promise<string | null> => {
  const random = mulberry32(seed);
  const pick = <T,>(values: T[]) => values[Math.floor(random() * values.length)];
  const target = await startRig({ ttlSeconds: 40, directWorks: random() < 0.5 });
  rig = target;
  const trace: string[] = [];
  try {
    await target.join();
    target.refuseIceRestart = true;
    target.failRecv();
    await target.advance(3_000);
    for (let step = 0; step < 24; step++) {
      const event = pick(["advance", "advance", "provider", "route", "release", "fail", "holdProducers", "announce", "slowRelay"]);
      trace.push(event);
      if (event === "advance") await target.advance(500 + Math.floor(random() * 8_000));
      else if (event === "provider") target.provider = target.provider === "up" ? "down" : "up";
      else if (event === "route") target.route = pick(["up", "down", "hold"] as const);
      else if (event === "release") target.releaseHeldRoutes(pick(["answer", "fail"] as const));
      else if (event === "fail") target.failRecv();
      else if (event === "holdProducers") target.holdProducersMs = 2_000 + Math.floor(random() * 11_000);
      else if (event === "announce") target.announceProducer();
      else if (event === "slowRelay") target.relayConnectMs = target.relayConnectMs === 200 ? 7_000 : 200;
      await target.advance(250);
    }
    target.route = "up";
    target.provider = "up";
    target.relayConnectMs = 200;
    target.holdProducersMs = 0;
    target.releaseHeldRoutes("answer");
    await target.advance(30_000);

    const failures: string[] = [];
    for (const move of target.moves) {
      if (move.bytes > 0) failures.push(`moved a transport that carried ${move.bytes} bytes`);
    }
    const needsRelay = target.log.some((line) => line.includes("Rebuilding through TURN only"));
    const newest = target.generations.at(-1);
    const relayUsable = Boolean(newest && newest.expiresAt - Date.now() > RELAY_USABLE_MARGIN_MS);
    const recv = target.recv;
    if (needsRelay && relayUsable && recv && recv.carriedBytes === 0 && recv.usableGeneration === null) {
      failures.push(`receive transport ${recv.policy} [${recv.turnUsernames.join(",")}] never carried media and is off the relay`);
    }
    return failures.length > 0
      ? `seed ${seed}: ${failures.join("; ")} | ${trace.join(" ")} | ${target.log.slice(-12).join(" | ")}`
      : null;
  } finally {
    await stopRig(target);
    rig = null;
  }
};

describe("the hook under random interleavings", () => {
  it("never strands a transport that needs the relay and never moves one that carried media", async () => {
    const failed: string[] = [];
    for (let seed = 1; seed <= 60; seed++) {
      const failure = await playSeed(seed);
      if (failure) failed.push(failure);
    }
    expect(failed).toEqual([]);
  }, 300_000);
});
