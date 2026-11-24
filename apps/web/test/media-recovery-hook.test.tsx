// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { RIG_START, TURN_A, TURN_B, startRig, stopRig, type CallRig, type FakeTransport } from "./call-rig";
import { readJoinTokenUserKey } from "../src/app/lib/join-token-identity";

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
    rig.route = "down";
    await rig.advance(30_000);
    rig.failRecv();
    await rig.advance(5_000);

    expect(rig.recv?.policy).toBe("all");
    expect(rig.recv?.turnUsernames).toEqual([]);
    expect(rig.recv?.carriedBytes).toBeGreaterThan(0);
  });

  it("restarts ICE on a send path whose media stops reaching the SFU while bytes still leave", async () => {
    rig = await startRig({ publish: true });
    await rig.join();
    await rig.advance(5_000);
    const send = rig.send!;
    expect(send.reportAt).not.toBeNull();
    rig.outgoingDropped = true;
    const sentBefore = send.carriedBytes;

    expect(await waitFor(rig, () => send.restartIceCalls > 0, 25_000)).toBe(true);
    expect(send.carriedBytes).toBeGreaterThan(sentBefore);
    expect(rig.log.some((line) => line.includes("producer transport has carried no media"))).toBe(true);
  });

  it("restarts ICE when shared screen audio stops reaching the SFU with the mic and camera off", async () => {
    rig = await startRig();
    await rig.join();
    await rig.shareScreen({ video: false, audio: true });
    await rig.advance(5_000);
    const send = rig.send!;
    expect(send.reportAt).not.toBeNull();
    rig.outgoingDropped = true;

    expect(await waitFor(rig, () => send.restartIceCalls > 0, 25_000)).toBe(true);
    expect(rig.log.some((line) => line.includes("producer transport has carried no media"))).toBe(true);
  });

  it("leaves a static screen share alone while the SFU reports on it and restarts it once reports stop", async () => {
    rig = await startRig();
    await rig.join();
    await rig.shareScreen({ video: true, audio: false });
    await rig.advance(5_000);
    const send = rig.send!;
    rig.sendStatic = true;
    await rig.advance(25_000);
    expect(send.restartIceCalls).toBe(0);
    expect(rig.log.some((line) => line.includes("producer transport has carried no media"))).toBe(false);

    rig.outgoingDropped = true;
    expect(await waitFor(rig, () => send.restartIceCalls > 0, 25_000)).toBe(true);
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

describe("a viewer whose only incoming media is a screen share", () => {
  it("restarts ICE when a changing share stops arriving and gets it back", async () => {
    rig = await startRig({ remoteMedia: "screen" });
    await rig.join();
    await rig.advance(5_000);
    const transport = rig.recv!;
    expect(transport.carriedBytes).toBeGreaterThan(0);
    rig.mediaFlows = false;

    expect(await waitFor(rig, () => transport.restartIceCalls > 0, 30_000)).toBe(true);
    expect(rig.log.some((line) => line.includes("consumer transport has carried no media"))).toBe(true);
    rig.mediaFlows = true;
    const resumedFrom = transport.carriedBytes;
    await rig.advance(10_000);

    expect(transport.carriedBytes).toBeGreaterThan(resumedFrom);
    expect(rig.recvTransports).toEqual([transport]);
  });

  it("restarts once when the share goes still just as the path comes back", async () => {
    rig = await startRig({ remoteMedia: "screen" });
    await rig.join();
    await rig.advance(5_000);
    const transport = rig.recv!;
    rig.mediaFlows = false;
    expect(await waitFor(rig, () => transport.restartIceCalls > 0, 30_000)).toBe(true);
    rig.mediaFlows = true;
    rig.screenChanging = false;
    await rig.advance(90_000);

    expect(transport.restartIceCalls).toBe(1);
    expect(rig.recvTransports).toEqual([transport]);
  });

  it("leaves a share that stays still for five minutes alone", async () => {
    rig = await startRig({ remoteMedia: "screen" });
    await rig.join();
    await rig.advance(5_000);
    const transport = rig.recv!;
    rig.screenChanging = false;
    await rig.advance(300_000);

    expect(rig.senderCountQueries).toBeGreaterThan(100);
    expect(transport.restartIceCalls).toBe(0);
    expect(rig.recvTransports).toEqual([transport]);
    expect(rig.log.filter((line) => line.includes("carried no media"))).toEqual([]);
  });

  it("rebuilds when an ICE restart brings back nothing while the sharer keeps sending", async () => {
    rig = await startRig({ remoteMedia: "screen" });
    await rig.join();
    await rig.advance(5_000);
    const transport = rig.recv!;
    rig.mediaFlows = false;
    expect(await waitFor(rig, () => transport.restartIceCalls > 0, 30_000)).toBe(true);

    expect(await waitFor(rig, () => rig!.recvTransports.length > 1, 15_000)).toBe(true);
    rig.mediaFlows = true;
    await rig.advance(10_000);
    expect(rig.recv).not.toBe(transport);
    expect(rig.recv?.carriedBytes).toBeGreaterThan(0);
  });

  it("keeps checking a screen share on an SFU that answered, however many answers go missing", async () => {
    rig = await startRig({ remoteMedia: "screen" });
    await rig.join();
    await rig.advance(5_000);
    const transport = rig.recv!;
    rig.dropSenderCountAnswers = 4;
    await rig.advance(20_000);
    expect(rig.dropSenderCountAnswers).toBe(0);
    rig.mediaFlows = false;

    expect(await waitFor(rig, () => transport.restartIceCalls > 0, 30_000)).toBe(true);
  });

  it("still notices a cut share when every other answer goes missing", async () => {
    rig = await startRig({ remoteMedia: "screen" });
    await rig.join();
    await rig.advance(5_000);
    const transport = rig.recv!;
    rig.dropEveryOtherSenderCountAnswer = true;
    rig.mediaFlows = false;

    expect(await waitFor(rig, () => transport.restartIceCalls > 0, 45_000)).toBe(true);
  });

  it("keeps checking a screen share after a slow answer, then a normal one", async () => {
    rig = await startRig({ remoteMedia: "screen" });
    await rig.join();
    await rig.advance(5_000);
    const transport = rig.recv!;
    rig.slowSenderCountAnswers = 1;
    await rig.advance(5_000);
    expect(rig.slowSenderCountAnswers).toBe(0);
    const asked = rig.senderCountQueries;
    await rig.advance(5_000);
    expect(rig.senderCountQueries).toBeGreaterThan(asked);
    rig.mediaFlows = false;

    expect(await waitFor(rig, () => transport.restartIceCalls > 0, 30_000)).toBe(true);
  });

  it("never asks an SFU whose join does not offer sender counts, and stays exempt as before", async () => {
    rig = await startRig({ remoteMedia: "screen" });
    rig.advertisesSenderCounts = false;
    rig.answersSenderCounts = false;
    await rig.join();
    await rig.advance(5_000);
    const transport = rig.recv!;
    rig.screenChanging = false;
    await rig.advance(60_000);

    expect(rig.senderCountQueries).toBe(0);
    expect(transport.restartIceCalls).toBe(0);
    expect(rig.log.filter((line) => line.includes("carried no media"))).toEqual([]);
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

  it("backs the credential retries off from 2 s to every 10 s over about a minute", async () => {
    rig = await startRig({ ttlSeconds: 30 });
    await rig.join();
    await recoverThroughTurn(rig);
    rig.provider = "down";
    const downAt = Date.now();
    await rig.advance(120_000);

    const tries = rig.joinRequests.filter((request) => request.at > downAt).map((request) => request.at);
    const gaps = tries.slice(1).map((at, index) => Math.round((at - tries[index]) / 1000));
    expect(gaps).toEqual([4, 8, 10, 10, 10, 10, 10]);
    expect(tries.at(-1)! - tries[0]).toBeGreaterThanOrEqual(60_000);
  });

  it("gets credentials back within seconds when the provider returns just after a failed try", async () => {
    rig = await startRig({ ttlSeconds: 30 });
    await rig.join();
    await recoverThroughTurn(rig);
    rig.provider = "down";
    const downAt = Date.now();
    expect(
      await waitFor(rig, () => rig!.joinRequests.some((request) => request.at > downAt), 60_000),
    ).toBe(true);
    rig.provider = "up";
    const upAt = Date.now();
    await rig.advance(6_000);

    const relayAnswer = rig.joinRequests.find((request) => request.at > upAt && request.outcome === "relay");
    expect(relayAnswer).toBeDefined();
    expect(relayAnswer!.at - upAt).toBeLessThan(5_000);
  });

  it("starts the credential retries over at 2 s when a failed path is rebuilt", async () => {
    rig = await startRig({ ttlSeconds: 30 });
    await rig.join();
    await recoverThroughTurn(rig);
    rig.provider = "down";
    await rig.advance(60_000);
    const failedAt = Date.now();
    rig.failRecv();
    await rig.advance(3_000);
    rig.provider = "up";
    const upAt = Date.now();
    await rig.advance(8_000);

    const asked = rig.joinRequests.filter((request) => request.at > failedAt);
    expect(Math.round((asked[1].at - asked[0].at) / 1000)).toBe(2);
    const relayAnswer = asked.find((request) => request.at > upAt && request.outcome === "relay");
    expect(relayAnswer).toBeDefined();
    expect(relayAnswer!.at - upAt).toBeLessThan(5_000);
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

  it("keeps offering a proven relay URL that a newer answer leaves out", async () => {
    rig = await startRig({ directWorks: false });
    rig.answerUrls = [TURN_A, TURN_B];
    rig.workingRelayUrls = new Set([TURN_B]);
    await rig.join();
    await rig.advance(10_000);
    const proven = rig.generations[0];
    expect(rig.recv?.allocatedUrl).toBe(TURN_B);
    expect(rig.provenAt.has(proven)).toBe(true);

    rig.answerUrls = [TURN_A];
    rig.refuseIceRestart = true;
    rig.failRecv();
    await rig.advance(6_000);

    expect(rig.generations.length).toBeGreaterThan(1);
    expect(rig.recv?.turnUsernames).toContain(proven.username);
    expect(rig.recv?.allocatedUrl).toBe(TURN_B);
    expect(rig.recv?.carriedBytes).toBeGreaterThan(0);
    expect(rig.offerViolations).toEqual([]);
  });

  it("refreshes credentials an older route gave no lifetime before they can strand a rebuild", async () => {
    rig = await startRig({ ttlSeconds: 20 * 60, directWorks: false });
    rig.statesLifetime = false;
    await rig.join();
    await recoverThroughTurn(rig);
    const recoveredAt = Date.now();
    await rig.advance(21 * 60_000);
    expect(rig.joinRequests.filter((request) => request.at > recoveredAt).length).toBeGreaterThan(0);

    rig.provider = "down";
    rig.failRecv();
    await rig.advance(20_000);
    rig.provider = "up";
    await rig.advance(90_000);

    expect(rig.recv?.usableGeneration).not.toBeNull();
    expect(rig.recv?.carriedBytes).toBeGreaterThan(0);
    expect(rig.health.consumer).toBe("healthy");
  });

  it("never moves a transport whose stats cannot be read when the move is judged", async () => {
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
    await advanceTo(rig, (failedAt - RIG_START) / 1000 + 11.5);
    direct.failStats = 1;
    await rig.advance(8_500);

    expect(direct.failStats).toBe(0);
    expect(direct.carriedBytes).toBeGreaterThan(0);
    expect(rig.moves).toEqual([]);
    expect(rig.recv).toBe(direct);
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

describe("the guest identity across recovery", () => {
  it("keeps the seat's identity when a credential refresh answers for another one", async () => {
    rig = await startRig({ identity: "guest-a" });
    await rig.join();
    rig.identity = "guest-b";
    rig.refuseIceRestart = true;
    rig.failRecv();
    await rig.advance(3_000);
    expect(rig.joinRequests.length).toBe(2);
    expect(rig.recv?.carriedBytes).toBeGreaterThan(0);

    await rig.dropSocket();
    await rig.advance(6_000);

    expect(rig.identityChanges).toEqual([]);
    expect(rig.sockets).toHaveLength(2);
    expect(readJoinTokenUserKey(rig.socket!.authToken!)).toBe("guest-a");
    expect(rig.recv?.carriedBytes).toBeGreaterThan(0);
  });

  it("stops a reconnect without an error when its answer names another identity", async () => {
    rig = await startRig({ identity: "guest-a", ttlSeconds: 30 });
    await rig.join();
    await rig.advance(31_000);
    rig.identity = "guest-b";
    await rig.dropSocket();
    await rig.advance(10_000);
    const asked = rig.joinRequests.length;
    await rig.advance(30_000);

    expect(rig.identityChanges).toEqual(["guest-b"]);
    expect(rig.sockets).toHaveLength(1);
    expect(rig.joinRequests.length).toBe(asked);
    expect(rig.meetErrors.filter((error) => error?.code === "CONNECTION_FAILED")).toEqual([]);
    expect(rig.api.reconnectRecoveryStatus).toBeNull();
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
  const statesLifetime = random() < 0.7;
  const target = await startRig({ ttlSeconds: statesLifetime ? 40 : 900, directWorks: random() < 0.5 });
  rig = target;
  target.statesLifetime = statesLifetime;
  target.answerUrls = pick([[TURN_A], [TURN_A, TURN_B], [TURN_B, TURN_A]]);
  target.workingRelayUrls = new Set(pick([[TURN_A, TURN_B], [TURN_B], [TURN_A]]));
  const trace: string[] = [];
  try {
    await target.join();
    target.refuseIceRestart = true;
    target.failRecv();
    await target.advance(3_000);
    for (let step = 0; step < 24; step++) {
      const event = pick(["advance", "advance", "longAdvance", "provider", "route", "release", "fail", "holdProducers", "announce", "slowRelay", "relayUrls", "workingUrls"]);
      trace.push(event);
      if (event === "advance") await target.advance(500 + Math.floor(random() * 8_000));
      else if (event === "longAdvance") await target.advance(30_000 + Math.floor(random() * 90_000));
      else if (event === "provider") target.provider = target.provider === "up" ? "down" : "up";
      else if (event === "route") target.route = pick(["up", "down", "hold"] as const);
      else if (event === "release") target.releaseHeldRoutes(pick(["answer", "fail"] as const));
      else if (event === "fail") target.failRecv();
      else if (event === "holdProducers") target.holdProducersMs = 2_000 + Math.floor(random() * 11_000);
      else if (event === "announce") target.announceProducer();
      else if (event === "slowRelay") target.relayConnectMs = target.relayConnectMs === 200 ? 7_000 : 200;
      else if (event === "relayUrls") target.answerUrls = pick([[TURN_A], [TURN_A, TURN_B], [TURN_B], [TURN_B, TURN_A]]);
      else if (event === "workingUrls") target.workingRelayUrls = new Set(pick([[TURN_A, TURN_B], [TURN_B], [TURN_A]]));
      await target.advance(250);
    }
    target.route = "up";
    target.provider = "up";
    target.relayConnectMs = 200;
    target.holdProducersMs = 0;
    target.releaseHeldRoutes("answer");
    await target.advance(30_000);

    const failures: string[] = [...target.offerViolations];
    for (const move of target.moves) {
      if (move.bytes > 0) failures.push(`moved a transport that carried ${move.bytes} bytes`);
    }
    const needsRelay = target.log.some((line) => line.includes("Rebuilding through TURN only"));
    const newest = target.generations.at(-1);
    const relayUsable = Boolean(newest && newest.clientExpiresAt - Date.now() > RELAY_USABLE_MARGIN_MS);
    const recv = target.recv;
    const workingHeld = Boolean(newest && newest.urls.some((url) => target.workingRelayUrls.has(url)));
    if (needsRelay && relayUsable && workingHeld && recv && recv.carriedBytes === 0 && !recv.clientUsableWorkingEntry()) {
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
    const [first, last] = process.env.RIG_EXTENDED ? [61, 660] : [1, 60];
    for (let seed = first; seed <= last; seed++) {
      const failure = await playSeed(seed);
      if (failure) failed.push(failure);
    }
    expect(failed).toEqual([]);
  }, 300_000);
});
