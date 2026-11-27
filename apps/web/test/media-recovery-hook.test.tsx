// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { RIG_START, TURN_A, TURN_B, startRig, stopRig, type CallRig, type FakeTransport } from "./call-rig";
import { readJoinTokenUserKey } from "../src/app/lib/join-token-identity";
import { telemetry } from "../src/app/lib/telemetry";

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

  it("restarts ICE when the camera stops reaching the SFU while the microphone still gets through", async () => {
    rig = await startRig({ publish: true, camera: true });
    await rig.join();
    await rig.advance(5_000);
    const send = rig.send!;
    expect(send.sending.map(({ producer }) => producer.kind).sort()).toEqual(["audio", "video"]);
    rig.droppedSendKinds.add("video");
    const microphone = send.sending.find(({ producer }) => producer.kind === "audio")!;
    const reachedBefore = microphone.sfuPackets;

    expect(await waitFor(rig, () => send.restartIceCalls > 0, 25_000)).toBe(true);
    expect(microphone.sfuPackets).toBeGreaterThan(reachedBefore);
    expect(rig.log.some((line) => line.includes("producer transport has carried no media"))).toBe(true);

    expect(await waitFor(rig, () => rig!.send !== send, 20_000)).toBe(true);
    expect(rig.log.some((line) => line.includes("Rebuilding the producer transport"))).toBe(true);
  });

  it.each<[string, { dropEveryOther?: boolean; bursty?: boolean }]>([
    ["every other SFU reply goes missing", { dropEveryOther: true }],
    ["the camera sends in bursts", { bursty: true }],
    ["the camera sends in bursts and every other reply goes missing", { bursty: true, dropEveryOther: true }],
  ])("notices a camera that never reaches the SFU when %s", async (_name, { dropEveryOther, bursty }) => {
    rig = await startRig({ publish: true, camera: true });
    await rig.join();
    await rig.advance(5_000);
    const send = rig.send!;
    rig.dropEveryOtherOwnCountAnswer = Boolean(dropEveryOther);
    rig.burstyVideo = Boolean(bursty);
    rig.droppedSendKinds.add("video");

    expect(await waitFor(rig, () => send.restartIceCalls > 0, 40_000)).toBe(true);
  });

  it("rebuilds a send path whose ICE restart never proves the camera reaches the SFU, with every other reply missing", async () => {
    rig = await startRig({ publish: true, camera: true });
    await rig.join();
    await rig.advance(5_000);
    const send = rig.send!;
    rig.dropEveryOtherOwnCountAnswer = true;
    rig.droppedSendKinds.add("video");

    expect(await waitFor(rig, () => rig!.send !== send, 100_000)).toBe(true);
    expect(rig.log.some((line) => line.includes("Rebuilding the producer transport"))).toBe(true);
  });

  it.each([0, 6_000])("still rebuilds when the failed camera goes quiet %d ms before credentials arrive", async (waitMs) => {
    rig = await startRig({ publish: true, camera: true });
    await rig.join();
    await rig.advance(5_000);
    const send = rig.send!;
    rig.route = "hold";
    rig.droppedSendKinds.add("video");
    expect(await waitFor(rig, () => rig!.heldRoutes.length > 0, 60_000)).toBe(true);
    expect(rig.send).toBe(send);
    rig.videoQuiet = true;
    await rig.advance(waitMs);
    rig.route = "up";
    rig.releaseHeldRoutes("answer");

    expect(await waitFor(rig, () => rig!.send !== send, 10_000)).toBe(true);
    expect(rig.log.some((line) => line.includes("not rebuilding it"))).toBe(false);
  });

  it.each<[string, { dropEveryOther?: boolean; bursty?: boolean }]>([
    ["every other SFU reply goes missing", { dropEveryOther: true }],
    ["the camera sends in bursts", { bursty: true }],
  ])("leaves a camera that reaches the SFU alone when %s", async (_name, { dropEveryOther, bursty }) => {
    rig = await startRig({ publish: true, camera: true });
    await rig.join();
    rig.dropEveryOtherOwnCountAnswer = Boolean(dropEveryOther);
    rig.burstyVideo = Boolean(bursty);
    await rig.advance(90_000);

    expect(rig.send!.restartIceCalls).toBe(0);
    expect(rig.log.some((line) => line.includes("carried no media"))).toBe(false);
  });

  it("leaves a microphone and camera alone while both reach the SFU", async () => {
    rig = await startRig({ publish: true, camera: true });
    await rig.join();
    await rig.advance(60_000);

    expect(rig.ownCountQueries).toBeGreaterThan(15);
    expect(rig.send!.restartIceCalls).toBe(0);
    expect(rig.log.some((line) => line.includes("carried no media"))).toBe(false);
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

  it("keeps checking a screen share on an SFU whose first answers are all slow", async () => {
    rig = await startRig({ remoteMedia: "screen" });
    rig.slowSenderCountAnswers = 4;
    await rig.join();
    await rig.advance(20_000);
    expect(rig.slowSenderCountAnswers).toBe(0);
    const transport = rig.recv!;
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

  it("retries credentials within 5 s for the first half minute, then every 10 s, over about a minute", async () => {
    rig = await startRig({ ttlSeconds: 30 });
    await rig.join();
    await recoverThroughTurn(rig);
    rig.provider = "down";
    const downAt = Date.now();
    await rig.advance(120_000);

    const tries = rig.joinRequests.filter((request) => request.at > downAt).map((request) => request.at);
    const gaps = tries.slice(1).map((at, index) => Math.round((at - tries[index]) / 1000));
    expect(gaps).toEqual([3, 5, 5, 5, 5, 5, 10, 10, 10]);
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
    const unreachable = rig.joinRequests.length;
    expect(await waitFor(rig, () => rig!.joinRequests.length > unreachable, 15_000)).toBe(true);
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

describe("leaving a call and pressing Try again", () => {
  const blockedEverywhere = async () => {
    const target = await startRig({ directWorks: false });
    target.relayWorks = false;
    await target.join();
    expect(await waitFor(target, () => target.health.consumer === "blocked", 90_000)).toBe(true);
    return target;
  };

  it("clears a blocked direction on leave, and the next call starts healthy with a fresh ladder", async () => {
    rig = await blockedEverywhere();
    await rig.leave();
    expect(rig.health).toEqual({ producer: "healthy", consumer: "healthy" });

    await rig.join();
    expect(rig.health).toEqual({ producer: "healthy", consumer: "healthy" });
    const firstRecv = rig.recv!;
    expect(await waitFor(rig, () => rig!.recv !== firstRecv, 60_000)).toBe(true);
  });

  it("cancels the background credential retries on leave, leaving nothing scheduled to run", async () => {
    rig = await startRig({ ttlSeconds: 30, directWorks: false });
    await rig.join();
    await recoverThroughTurn(rig);
    rig.provider = "down";
    await rig.advance(32_000);
    const requestsBeforeLeave = rig.joinRequests.length;
    expect(rig.joinRequests.slice(-2).map(({ outcome }) => outcome)).toEqual(["stun-only", "stun-only"]);
    await rig.leave();
    const pendingAfterLeave = vi.getTimerCount();
    await rig.advance(120_000);

    expect(vi.getTimerCount()).toBe(pendingAfterLeave);
    expect(rig.joinRequests.length).toBe(requestsBeforeLeave);
  });

  it("an idle Try again drops the need for TURN alone, so a path that works directly is used", async () => {
    rig = await startRig({ directWorks: false });
    await rig.join();
    await recoverThroughTurn(rig);
    rig.directWorks = true;
    const before = rig.recvTransports.length;
    await rig.retry();
    expect(await waitFor(rig, () => rig!.recvTransports.length > before && rig!.recv!.carriedBytes > 0, 30_000)).toBe(true);

    expect(rig.recv!.policy).toBe("all");
  });
});

describe("acting only on the path that was sampled", () => {
  it("never restarts the next call's transport from a stats read held over a leave and rejoin", async () => {
    rig = await startRig({ publish: true });
    await rig.join();
    await rig.advance(5_000);
    const oldSend = rig.send!;
    rig.outgoingDropped = true;
    await rig.advance(11_000);
    const release = oldSend.holdNextStats();
    await rig.advance(3_000);
    await rig.leave();
    rig.outgoingDropped = false;
    await rig.join();
    const newSend = rig.send!;
    expect(newSend).not.toBe(oldSend);
    await rig.advance(5_000);
    release();
    await rig.advance(12_000);

    expect(newSend.restartIceCalls).toBe(0);
    expect(rig.health.producer).toBe("healthy");
  });

  it("does not rebuild a receive path whose media came back while its credentials were fetched", async () => {
    const capture = vi.spyOn(telemetry, "capture").mockImplementation(() => {});
    rig = await startRig({ trackCallQuality: true });
    await rig.join();
    await rig.advance(5_000);
    const recv = rig.recv!;
    rig.refuseIceRestart = true;
    rig.route = "hold";
    rig.mediaFlows = false;
    expect(await waitFor(rig, () => rig!.heldRoutes.length > 0, 40_000)).toBe(true);
    rig.mediaFlows = true;
    await rig.advance(5_000);
    const flowedBefore = recv.carriedBytes;
    rig.route = "up";
    rig.releaseHeldRoutes("answer");
    await rig.advance(8_000);

    expect(rig.recvTransports).toEqual([recv]);
    expect(recv.carriedBytes).toBeGreaterThan(flowedBefore);
    expect(rig.health.consumer).toBe("healthy");
    await rig.leave();
    expect(capture.mock.calls.find(([name]) => name === "call_summary")?.[1]).toMatchObject({
      end_reason: "left",
      reconnect_count: 0,
      reconnect_total_ms: 0,
    });
  });

  it("still reconnects a socket that drops after the stale rebuild's media came back", async () => {
    const capture = vi.spyOn(telemetry, "capture").mockImplementation(() => {});
    rig = await startRig({ trackCallQuality: true });
    await rig.join();
    await rig.advance(5_000);
    const socket = rig.socket!;
    rig.refuseIceRestart = true;
    rig.route = "hold";
    rig.mediaFlows = false;
    expect(await waitFor(rig, () => rig!.heldRoutes.length > 0, 40_000)).toBe(true);
    rig.mediaFlows = true;
    await rig.advance(5_000);
    await rig.dropSocket();
    rig.route = "up";
    rig.releaseHeldRoutes("answer");

    expect(await waitFor(rig, () => rig!.socket !== socket && rig!.socket!.connected, 30_000)).toBe(true);
    const recv = rig.recv!;
    const flowedBefore = recv.carriedBytes;
    await rig.advance(6_000);
    expect(recv.carriedBytes).toBeGreaterThan(flowedBefore);
    await rig.leave();
    expect(capture.mock.calls.find(([name]) => name === "call_summary")?.[1]).toMatchObject({
      end_reason: "left",
      reconnect_count: 1,
      reconnect_total_ms: expect.toSatisfy((ms: number) => ms > 0),
    });
  });

  it("keeps a receive path that carries media again just before its credentials arrive", async () => {
    rig = await startRig();
    await rig.join();
    await rig.advance(5_000);
    const recv = rig.recv!;
    rig.refuseIceRestart = true;
    rig.route = "hold";
    rig.mediaFlows = false;
    expect(await waitFor(rig, () => rig!.heldRoutes.length > 0, 40_000)).toBe(true);
    rig.relayWorks = false;
    rig.mediaFlows = true;
    rig.route = "up";
    rig.releaseHeldRoutes("answer");
    await rig.advance(8_000);

    expect(rig.recvTransports).toEqual([recv]);
    const flowedBefore = recv.carriedBytes;
    await rig.advance(5_000);
    expect(recv.carriedBytes).toBeGreaterThan(flowedBefore);
  });

  it("still rebuilds a receive path that stays dead while its credentials are fetched", async () => {
    const capture = vi.spyOn(telemetry, "capture").mockImplementation(() => {});
    rig = await startRig({ trackCallQuality: true });
    await rig.join();
    await rig.advance(5_000);
    const recv = rig.recv!;
    rig.refuseIceRestart = true;
    rig.route = "hold";
    rig.mediaFlows = false;
    expect(await waitFor(rig, () => rig!.heldRoutes.length > 0, 40_000)).toBe(true);
    await rig.advance(5_000);
    rig.holdProducersMs = 1_000;
    rig.route = "up";
    rig.releaseHeldRoutes("answer");

    expect(await waitFor(rig, () => rig!.recv !== recv, 10_000)).toBe(true);
    await rig.advance(2_000);
    await rig.leave();
    expect(capture.mock.calls.find(([name]) => name === "call_summary")?.[1]).toMatchObject({
      end_reason: "left",
      reconnect_count: 1,
      reconnect_total_ms: expect.toSatisfy((ms: number) => ms > 0 && ms < 5_000),
    });
  });
});

describe("what proves a path works, with bounded waits", () => {
  const stalledRecv = async () => {
    const target = await startRig();
    await target.join();
    await target.advance(5_000);
    target.refuseIceRestart = true;
    target.route = "hold";
    target.mediaFlows = false;
    expect(await waitFor(target, () => target.heldRoutes.length > 0, 40_000)).toBe(true);
    return target;
  };

  it("rebuilds a stalled path when the browser's ICE restart does not settle", async () => {
    rig = await startRig();
    await rig.join();
    await rig.advance(5_000);
    const target = rig;
    const recv = target.recv!;
    let restartStarted = false;
    recv.restartIce = () => {
      restartStarted = true;
      return new Promise<void>(() => {});
    };
    target.mediaFlows = false;

    expect(await waitFor(target, () => restartStarted, 30_000)).toBe(true);
    expect(await waitFor(target, () => target.recv !== recv, 16_000)).toBe(true);
  });

  it("reconnects a dropped socket while the rebuild's check is stuck on a stats read", async () => {
    rig = await stalledRecv();
    const socket = rig.socket!;
    const old = rig.recv!;
    const release = old.holdNextStats();
    rig.route = "up";
    rig.releaseHeldRoutes("answer");
    await rig.flush();
    expect(old.statsHold).toBeNull();
    await rig.dropSocket();
    rig.mediaFlows = true;

    expect(await waitFor(rig, () => rig!.socket !== socket && Boolean(rig!.socket?.connected), 15_000)).toBe(true);
    release();
  });

  it("runs Try again while the rebuild's check is stuck on a stats read", async () => {
    rig = await stalledRecv();
    const socket = rig.socket!;
    const old = rig.recv!;
    const release = old.holdNextStats();
    rig.route = "up";
    rig.releaseHeldRoutes("answer");
    await rig.flush();
    rig.mediaFlows = true;
    const joinsBefore = rig.joinRequests.length;
    await rig.retry();

    expect(await waitFor(rig, () => rig!.joinRequests.length > joinsBefore, 5_000)).toBe(true);
    release();
    expect(await waitFor(rig, () => Boolean(rig!.socket?.connected) && rig!.recv !== old, 30_000)).toBe(true);
    void socket;
  });

  it("rebuilds when a failed camera sends no packets during the check before the rebuild", async () => {
    rig = await startRig({ publish: true, camera: true });
    await rig.join();
    await rig.advance(5_000);
    const target = rig;
    const send = target.send!;
    const camera = send.sending.find(({ producer }) => producer.kind === "video")!;
    target.droppedSendKinds.add("video");
    target.route = "hold";
    expect(await waitFor(target, () => target.heldRoutes.length > 0, 40_000)).toBe(true);
    const accrue = target.accrue.bind(target);
    target.accrue = (transport) => {
      const packets = camera.packetsSent;
      const bytes = camera.bytesSent;
      accrue(transport);
      if (transport === send) {
        camera.packetsSent = packets;
        camera.bytesSent = bytes;
      }
    };
    target.route = "up";
    target.releaseHeldRoutes("answer");

    expect(await waitFor(target, () => target.send !== send, 10_000)).toBe(true);
    target.accrue = accrue;
  });

  it("starts the rebuild within a bounded wait when the count replies time out", async () => {
    rig = await startRig({ publish: true, camera: true });
    await rig.join();
    await rig.advance(5_000);
    const target = rig;
    const send = target.send!;
    target.droppedSendKinds.add("video");
    target.route = "hold";
    expect(await waitFor(target, () => target.heldRoutes.length > 0, 40_000)).toBe(true);
    const asked = target.ownCountQueries;
    target.answersSenderCounts = false;
    target.route = "up";
    target.releaseHeldRoutes("answer");
    await target.flush();
    const released = Date.now();

    expect(await waitFor(target, () => target.send !== send, 10_000)).toBe(true);
    expect(Date.now() - released).toBeLessThanOrEqual(3_500);
    expect(target.ownCountQueries - asked).toBeLessThanOrEqual(1);
  });

  it.each([800, 1_990])("keeps a recovered camera when both SFU count replies take %d ms", async (delayMs) => {
    rig = await startRig({ publish: true, camera: true });
    await rig.join();
    await rig.advance(5_000);
    const target = rig;
    const send = target.send!;
    const camera = send.sending.find(({ producer }) => producer.kind === "video")!;
    target.droppedSendKinds.add("video");
    target.route = "hold";
    expect(await waitFor(target, () => target.heldRoutes.length > 0, 40_000)).toBe(true);

    target.ownCountAckDelayMs = delayMs;
    target.droppedSendKinds.delete("video");
    const packets = camera.sfuPackets;
    target.route = "up";
    target.releaseHeldRoutes("answer");
    await target.advance(12_000);

    expect(send.closed).toBe(false);
    expect(target.send).toBe(send);
    expect(camera.sfuPackets).toBeGreaterThan(packets);
    expect(target.health.producer).toBe("healthy");
  });

  it("escalates when a known-failed camera's stats row is missing from an ICE restart sample", async () => {
    rig = await startRig({ publish: true, camera: true });
    await rig.join();
    await rig.advance(5_000);
    const target = rig;
    const send = target.send!;
    const camera = send.sending.find(({ producer }) => producer.kind === "video")!;
    const read = send.getStats.bind(send);
    let afterRestart = 0;
    send.getStats = async () => {
      const stats = await read();
      if (send.restartIceCalls === 1 && ++afterRestart === 1) {
        stats.delete(`OUT-${camera.mid}`);
        stats.delete(`RI-${camera.mid}`);
      }
      return stats;
    };
    target.droppedSendKinds.add("video");

    expect(await waitFor(target, () => send.restartIceCalls === 1, 40_000)).toBe(true);
    expect(await waitFor(target, () => target.send !== send, 20_000)).toBe(true);
  });
});
