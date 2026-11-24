/**
 * The authority transport on real sockets: a real socket.io server with the
 * SFU's auth and every handler it registers, real client connections that
 * join through `joinRoom`, and the real client session on each.
 */
import type { Socket as ClientSocket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTHORITY_EVENTS,
  type AuthorityFrame,
  type AuthorityResult,
  type Json,
} from "@conclave/apps-sdk/authority";
import { pollsContract } from "@conclave/apps-sdk/polls/core";
import { pollsAuthority } from "@conclave/apps-sdk/polls/server";
import { qaAuthority } from "@conclave/apps-sdk/qa/server";
import { answer } from "./answer.js";
import {
  getRoomAuthority,
  socketPressure,
} from "../../server/apps/authority/index.js";
import { forceCloseRoom } from "../../server/rooms.js";
import {
  getOrCreateWebinarRoomConfig,
  setCustomWebinarLinkSlug,
} from "../../server/webinar.js";
import { emitWebinarConfigChanged } from "../../server/webinarNotifications.js";
import { probeAuthority, probeContract } from "./fixtures/probe.js";
import {
  HOST,
  ROOM_ID,
  addRoom,
  ask,
  closeAll,
  connect,
  field,
  open,
  row,
  rows,
  start,
  until,
  wait,
  type Peer,
} from "./wireKit.js";

afterEach(closeAll);

/** Rows in a frame that show poll results. */
const tallies = (frames: AuthorityFrame[]) =>
  frames.flatMap((frame) =>
    frame.kind === "replace" || frame.kind === "patch"
      ? (frame.kind === "replace" ? frame.rows : frame.put).filter(
          (entry) => entry.bucket === "results",
        )
      : [],
  );

const asha = { email: HOST, name: "Asha", session: "h1" };
const priya = { email: "priya@example.com", name: "Priya", session: "p1" };
const ravi = { email: "ravi@example.com", name: "Ravi", session: "r1" };

const createPoll = async (hostPeer: Peer<typeof pollsContract>): Promise<string> => {
  const created = await hostPeer.session.act("create", {
    question: "Lunch?",
    options: ["Tea", "Coffee"],
  });
  if (!created.ok) throw new Error(`create failed: ${created.code}`);
  return created.value.pollId;
};

describe("authority transport on real sockets", () => {
  it("delivers each connection its own view and nothing else", async () => {
    const stack = await start([pollsAuthority]);
    const host = await open(stack, asha, pollsContract);
    const voter = await open(stack, priya, pollsContract);
    const other = await open(stack, ravi, pollsContract);
    const pollId = await createPoll(host);
    await until(() => row(other, "polls", pollId) !== null, "poll reaches Ravi");

    const voted = await voter.session.act("vote", { pollId, optionIds: ["o1"] });
    await until(
      () => field(row(host, "results", pollId), "voterCount") === 1,
      "tally reaches the host",
    );
    await wait(120);

    expect(answer(voted)).toEqual({ ok: true, value: null });
    expect(field(row(voter, "myVotes", pollId), "optionIds")).toEqual(["o1"]);
    expect(tallies(voter.frames)).toEqual([]);
    expect(tallies(other.frames)).toEqual([]);
    expect(JSON.stringify(other.frames)).not.toContain("myVotes");
  });

  it("two tabs of one person share one vote and both learn of it", async () => {
    const stack = await start([pollsAuthority]);
    const host = await open(stack, asha, pollsContract);
    const tabA = await open(stack, priya, pollsContract);
    const tabB = await open(stack, { ...priya, session: "p2" }, pollsContract);
    const pollId = await createPoll(host);
    await until(() => row(tabB, "polls", pollId) !== null, "poll reaches tab B");

    const [first, second] = await Promise.all([
      tabA.session.act("vote", { pollId, optionIds: ["o1"] }),
      tabB.session.act("vote", { pollId, optionIds: ["o2"] }),
    ]);
    await until(() => row(tabA, "myVotes", pollId) !== null, "tab A learns");
    await until(() => row(tabB, "myVotes", pollId) !== null, "tab B learns");

    expect([first.ok, second.ok].filter(Boolean).length).toBe(1);
    expect(row(tabA, "myVotes", pollId)).toEqual(row(tabB, "myVotes", pollId));
    await until(
      () => field(row(host, "results", pollId), "voterCount") === 1,
      "one voter counted",
    );
  });

  it("a removed co-host gets nothing more and can do nothing more", async () => {
    const stack = await start([pollsAuthority]);
    const host = await open(stack, asha, pollsContract);
    const cohost = await open(stack, ravi, pollsContract);
    const pollId = await createPoll(host);
    await ask(host.socket, "promoteHost", { userId: cohost.seatId });
    await until(
      () => row(cohost, "results", pollId) !== null,
      "promotion shows the tally",
    );

    const kicked = new Promise<void>((resolve) => cohost.socket.once("disconnect", () => resolve()));
    await ask(host.socket, "kickUser", { userId: cohost.seatId });
    await kicked;
    const framesAtKick = cohost.frames.length;
    await host.session.act("share", { pollId, shared: true });
    await wait(150);

    // The same identity cannot walk back in as a host.
    const rejoined = await connect(stack, ravi);
    const exportAfter = await ask<AuthorityResult<Json>>(rejoined.socket, AUTHORITY_EVENTS.query, {
      roomEpoch: getRoomAuthority(stack.state, stack.room)!.roomEpoch,
      subscription: cohost.frames[0].subscription,
      generation: 2,
      request: "export-after-kick",
      query: "exportBallots",
      input: { pollId },
    });

    expect(cohost.frames.slice(framesAtKick).filter((frame) => frame.kind !== "revoke")).toEqual([]);
    expect(exportAfter).toEqual({ ok: false, code: "not-subscribed" });
    expect(stack.room.isAdminUserKey(ravi.email)).toBe(false);
  });

  it("disconnects the first socket when a second connection takes its seat (Neon)", async () => {
    const stack = await start([pollsAuthority]);
    const host = await open(stack, asha, pollsContract);
    const first = await open(stack, priya, pollsContract);
    const pollId = await createPoll(host);
    await until(() => row(first, "polls", pollId) !== null, "poll reaches the first socket");

    const second = await open(stack, priya, pollsContract);
    await until(() => !first.socket.connected, "old socket disconnected");
    const framesAtSwap = first.frames.length;
    await host.session.act("share", { pollId, shared: true });
    await until(() => field(row(second, "polls", pollId), "resultsShared") === true, "new socket updated");

    expect(first.socket.connected).toBe(false);
    expect(first.frames.slice(framesAtSwap)).toEqual([]);
  });

  it("a demoted panelist loses the meeting's apps and keeps only the audience's", async () => {
    const stack = await start([pollsAuthority, qaAuthority]);
    const host = await open(stack, asha, pollsContract);
    const panelist = await open(stack, priya, pollsContract);
    const pollId = await createPoll(host);
    await until(() => row(panelist, "polls", pollId) !== null, "poll reaches the panelist");

    const webinar = getOrCreateWebinarRoomConfig(stack.state.webinarConfigs, stack.room.channelId);
    webinar.enabled = true;
    webinar.publicAccess = true;
    setCustomWebinarLinkSlug({
      webinarConfig: webinar,
      webinarLinks: stack.state.webinarLinks,
      room: stack.room,
      slug: "launch",
    });
    emitWebinarConfigChanged(stack.io, stack.state, stack.room);

    const gone = new Promise<void>((resolve) => panelist.socket.once("disconnect", () => resolve()));
    await ask(host.socket, "webinar:demoteParticipant", { userId: panelist.seatId });
    await gone;
    const framesAtDemotion = panelist.frames.length;
    await host.session.act("share", { pollId, shared: true });
    await wait(150);

    const audience = await connect(stack, priya, {
      join: { roomId: "launch", joinMode: "webinar_attendee" },
    });
    const capability = await ask<AuthorityResult<{ apps: { app: string; instance: string }[] }>>(
      audience.socket,
      AUTHORITY_EVENTS.capabilities,
      { protocols: [1] },
    );
    const pollsInstance = host.client.entryFor(pollsContract)!.instance;
    const sneak = await ask<AuthorityResult<null>>(audience.socket, AUTHORITY_EVENTS.subscribe, {
      roomEpoch: getRoomAuthority(stack.state, stack.room)!.roomEpoch,
      instance: pollsInstance,
      app: "polls",
      major: 1,
      subscription: "sneak-back-in",
    });

    expect(panelist.frames.slice(framesAtDemotion)).toEqual([]);
    expect(capability.ok && capability.value.apps.map((entry) => entry.app)).toEqual(["qa"]);
    expect(sneak).toEqual({ ok: false, code: "forbidden" });
    expect(audience.frames).toEqual([]);
  });

  it("a reconnecting client gets its view back and its vote still stands", async () => {
    const stack = await start([pollsAuthority]);
    const host = await open(stack, asha, pollsContract);
    const voter = await open(stack, priya, pollsContract, { reconnection: true });
    const pollId = await createPoll(host);
    await until(() => row(voter, "polls", pollId) !== null, "poll reaches the voter");
    await voter.session.act("vote", { pollId, optionIds: ["o1"] });

    // The transport drops. socket.io reconnects, and the app rejoins the room.
    voter.socket.once("connect", () => {
      void ask(voter.socket, "joinRoom", { roomId: ROOM_ID, sessionId: priya.session });
    });
    voter.socket.io.engine.close();
    await until(() => voter.session.getState().kind !== "ready", "view dropped on disconnect");
    await until(() => voter.session.getState().kind === "ready", "view back after reconnect", 8_000);

    const again = await voter.session.act("vote", { pollId, optionIds: ["o2"] });

    expect(field(row(voter, "myVotes", pollId), "optionIds")).toEqual(["o1"]);
    expect(again).toEqual({ ok: false, code: "rejected", reason: "already-voted" });
    expect(field(row(host, "results", pollId), "voterCount")).toBe(1);
  });

  it("resends an action whose answer was lost, and it runs once", async () => {
    const stack = await start([pollsAuthority]);
    const host = await open(stack, asha, pollsContract);
    const voter = await open(stack, priya, pollsContract, { ackTimeoutMs: 150 });
    const pollId = await createPoll(host);
    await until(() => row(voter, "polls", pollId) !== null, "poll reaches the voter");

    const emit = voter.socket.emit.bind(voter.socket);
    let lost = 0;
    voter.socket.emit = ((event: string, ...args: unknown[]) => {
      if (event === AUTHORITY_EVENTS.act && lost === 0) {
        lost += 1;
        return emit(event, args[0], () => {});
      }
      return emit(event, ...args);
    }) as ClientSocket["emit"];

    const result = await voter.session.act("vote", { pollId, optionIds: ["o1"] });
    await until(
      () => field(row(host, "results", pollId), "voterCount") === 1,
      "the vote counted",
    );

    expect(lost).toBe(1);
    expect(answer(result)).toEqual({ ok: true, value: null });
  });

  it("does not carry an unanswered action into another room", async () => {
    const stack = await start([probeAuthority]);
    addRoom(stack.state, "elsewhere").allowUser(asha.email);
    const host = await open(stack, asha, probeContract, { ackTimeoutMs: 150 });

    // The first room runs the action. Its answer never arrives.
    const emit = host.socket.emit.bind(host.socket);
    let lost = 0;
    host.socket.emit = ((event: string, ...args: unknown[]) => {
      if (event === AUTHORITY_EVENTS.act && lost === 0) {
        lost += 1;
        return emit(event, args[0], () => {});
      }
      return emit(event, ...args);
    }) as ClientSocket["emit"];
    const pending = host.session.act("put", { id: "note", text: "for the first room" });
    await until(() => lost === 1, "the action left");

    // The same socket moves to another room before the retry goes out.
    await ask(host.socket, "joinRoom", { roomId: "elsewhere", sessionId: asha.session });
    host.client.joined();
    const result = await pending;
    await until(() => host.session.getState().kind === "ready", "the other room's view");
    await wait(150);

    expect(result).toEqual({ ok: false, code: "unknown-outcome" });
    expect(rows(host, "notes")).toEqual([]);
  });

  it("holds patches back from a polling client that has stopped asking for them", async () => {
    // Only the bytes can say this client is behind: the packet marks are out of reach.
    const stack = await start([probeAuthority], {
      socketSoftBytes: 24 * 1024,
      socketSoftPackets: 100_000,
      socketHardPackets: 1_000_000,
      lagRecheckMs: 50,
    });
    const hostPeer = await open(stack, asha, probeContract);
    const slow = await open(stack, priya, probeContract, { transports: ["polling"] });
    const serverSide = stack.io.sockets.sockets.get(slow.socket.id ?? "");
    if (!serverSide) throw new Error("no server socket for the polling client");
    const authority = getRoomAuthority(stack.state, stack.room);
    if (!authority) throw new Error("the room has no authority runtime");
    const transport = slow.socket.io.engine.transport as unknown as {
      pause(done: () => void): void;
      readyState: string;
      _poll(): void;
    };
    const before = socketPressure(serverSide);
    const framesBefore = slow.frames.length;
    // The client stops polling, as one on a stalled connection would. The
    // poll it already has open is answered, and it asks for nothing after.
    transport.pause(() => {});

    // Sixty notes of about 4 KB each, changed one after another.
    const text = (round: number) => `${round} `.padEnd(3_900, "x");
    const queued: number[] = [];
    for (let round = 0; round < 60; round += 1) {
      await hostPeer.session.act("put", { id: `n${round % 5}`, text: text(round) });
      await wait(12);
      queued.push(socketPressure(serverSide).packets);
    }
    await until(() => row(hostPeer, "notes", "n4") !== null, "the host has the last notes");
    const behind = socketPressure(serverSide);
    const patchesQueuedAtTheEnd = queued[queued.length - 1] - queued[queued.length - 10];

    // It polls again, and is caught up with one whole view.
    transport.readyState = "open";
    transport._poll();
    await until(
      () => field(row(slow, "notes", "n4"), "text") === text(59),
      "the slow client has the latest notes",
      6_000,
    );

    // While it polls, its queue holds next to nothing from one poll to the next.
    expect(before.bytes).toBeLessThan(1_024);
    // Its queue is counted in bytes, and passes the mark long before 60 patches.
    expect(behind.bytes).toBeGreaterThan(24 * 1024);
    expect(behind.bytes).toBeLessThan(60 * 3_900);
    expect(behind.packets).toBeLessThan(20);
    // Once it was behind, nothing more was queued for it.
    expect(patchesQueuedAtTheEnd).toBe(0);
    expect(authority.stats.resnapshots).toBeGreaterThanOrEqual(1);
    expect(slow.frames.slice(framesBefore).some((frame) => frame.kind === "replace")).toBe(true);
    expect(rows(slow, "notes").length).toBe(5);
  }, 20_000);

  it("fires a timer on the server with no client asking", async () => {
    const stack = await start([probeAuthority]);
    const host = await open(stack, asha, probeContract);
    const watcher = await open(stack, priya, probeContract);

    const scheduledAt = Date.now();
    await host.session.act("schedule", { id: "bell", afterMs: 200, label: "ring" });
    host.socket.disconnect();
    await until(() => rows(watcher, "fired").length === 1, "the timer fired");

    expect(Date.now() - scheduledAt).toBeGreaterThanOrEqual(195);
    expect(field(rows(watcher, "fired")[0], "label")).toBe("ring");
  });

  it("tears everything down with the room", async () => {
    const stack = await start([probeAuthority]);
    const host = await open(stack, asha, probeContract);
    await host.session.act("schedule", { id: "bell", afterMs: 200, label: "never" });
    const authority = getRoomAuthority(stack.state, stack.room)!;
    const framesAtClose = host.frames.length;

    forceCloseRoom(stack.state, stack.room.channelId);
    await wait(400);
    const afterClose = await ask<AuthorityResult<Json>>(host.socket, AUTHORITY_EVENTS.act, {
      roomEpoch: authority.roomEpoch,
      subscription: host.frames[0].subscription,
      generation: 1,
      operation: { issuedAtMs: Date.now(), nonce: "op-after-close" },
      action: "put",
      input: { id: "late", text: "too late" },
    });

    expect(authority.isClosed).toBe(true);
    expect(host.frames.slice(framesAtClose)).toMatchObject([
      { kind: "revoke", reason: "closed" },
    ]);
    expect(host.session.getState()).toEqual({ kind: "revoked", reason: "closed" });
    expect(afterClose).toEqual({ ok: false, code: "not-in-room" });
  });

  it("an SFU without the runtime answers the capability request as unsupported at once, so the client hides the app", async () => {
    const stack = await start(null);
    const startedAt = Date.now();
    const host = await open(stack, asha, pollsContract, { expectReady: false });
    await until(() => host.client.capabilities.kind === "unsupported", "client hears unsupported", 1_000);
    const heardAfterMs = Date.now() - startedAt;

    expect(heardAfterMs).toBeLessThan(1_000);
    expect(host.session.getState()).toEqual({ kind: "unsupported" });
    expect(await host.session.act("create", { question: "Q", options: ["a", "b"] })).toEqual({
      ok: false,
      code: "unsupported",
    });
    expect(host.frames).toEqual([]);
  });

  it("a client that never asks is sent no authority event", async () => {
    const stack = await start([pollsAuthority]);
    const host = await open(stack, asha, pollsContract);
    const legacy = await connect(stack, priya);
    const seen: string[] = [];
    legacy.socket.onAny((event: string) => {
      if (event.startsWith("apps:authority")) seen.push(event);
    });

    const pollId = await createPoll(host);
    await host.session.act("share", { pollId, shared: true });
    await wait(150);

    expect(seen).toEqual([]);
    expect(legacy.frames).toEqual([]);
  });
});
