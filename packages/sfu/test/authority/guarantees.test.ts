/**
 * What the host guarantees whatever an app or a client does: retries,
 * identity, membership, delivery, bounds, timers and teardown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTHORITY_EVENTS,
  defineContract,
  s,
  type AuthorityFrame,
  type AuthorityResult,
  type Json,
  type PatchFrame,
  type ReplaceFrame,
} from "@conclave/apps-sdk/authority";
import { defineAuthority } from "@conclave/apps-sdk/authority/server";
import { Admin } from "../../config/classes/Admin.js";
import { Client } from "../../config/classes/Client.js";
import { Room } from "../../config/classes/Room.js";
import { getRoomAuthority } from "../../server/apps/authority/index.js";
import { DEFAULT_AUTHORITY_LIMITS } from "../../server/apps/authority/limits.js";
import { ensureWebinarRoomConfig } from "../../server/scheduledWebinarScheduler.js";
import { getOrCreateWebinarRoomConfig } from "../../server/webinar.js";
import type { ScheduledWebinar } from "../../types.js";
import type { Router } from "mediasoup/types";
import { Harness, person, type Tab } from "./harness.js";
import { pollsAuthority, pollsContract } from "./fixtures/polls.js";
import { probeAuthority, probeContract } from "./fixtures/probe.js";
import { qaAuthority, qaContract } from "./fixtures/qa.js";

const host = person("asha@example.com", "Asha", "host");
const priya = person("priya@example.com", "Priya");
const ravi = person("ravi@example.com", "Ravi");

const field = (value: Json | null, ...path: string[]): Json | null => {
  let node: Json | null = value;
  for (const key of path) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return null;
    node = (node as { readonly [key: string]: Json })[key] ?? null;
  }
  return node;
};

const patches = (frames: AuthorityFrame[]): PatchFrame[] =>
  frames.filter((frame): frame is PatchFrame => frame.kind === "patch");
const replaces = (frames: AuthorityFrame[]): ReplaceFrame[] =>
  frames.filter((frame): frame is ReplaceFrame => frame.kind === "replace");
const dataFrames = (frames: AuthorityFrame[]): AuthorityFrame[] =>
  frames.filter((frame) => frame.kind !== "revoke" && frame.kind !== "queryAbort");

const createPoll = async (room: Harness, tab: Tab): Promise<string> => {
  const created = await tab.act("create", {
    question: "Lunch?",
    options: ["Tea", "Coffee"],
  });
  if (!created.ok) throw new Error(`create failed: ${created.code}`);
  await room.deliver();
  return field(created.value, "pollId") as string;
};

/** A webinar schedule for the room `roomId`, as the scheduling routes hold it. */
const schedule = (
  roomId: string,
  status: ScheduledWebinar["status"],
): ScheduledWebinar => ({
  id: "webinar-1",
  clientId: "conclave",
  roomId,
  linkSlug: "launch",
  title: "Launch",
  description: "",
  hostEmail: host.userKey,
  hostName: host.name,
  hostUserId: null,
  coHosts: [],
  scheduledStartAt: 1_000_000,
  scheduledEndAt: 4_600_000,
  status,
  publicAccess: true,
  maxAttendees: 500,
  requiresInviteCode: false,
  waitingRoomEnabled: false,
  earlyEntryMinutes: 10,
  qaEnabled: true,
  notes: "",
  createdAt: 900_000,
  createdBy: host.userKey,
  updatedAt: 900_000,
  liveStartedAt: 1_000_000,
  endedAt: null,
  totalJoinCount: 0,
  peakAttendeeCount: 0,
  webinarLink: "http://localhost:3000/w/launch",
  coHostInviteTokenHash: null,
  coHostInviteTokenCreatedAt: null,
});

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("retries", () => {
  it("replays the first answer for a repeated operation id and runs it once", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const pollId = await createPoll(room, hostTab);

    const operation = { issuedAtMs: Date.now(), nonce: "op-priya-vote" };
    const first = await priyaTab.actWith(operation, "vote", { pollId, optionIds: ["o1"] });

    // 300 other operations in between: a small recency cache would have
    // forgotten the first by now and run it again.
    for (let index = 0; index < 300; index += 1) {
      await vi.advanceTimersByTimeAsync(250);
      await hostTab.actWith(
        { issuedAtMs: Date.now(), nonce: `op-share-${index}` },
        "share",
        { pollId, shared: index % 2 === 0 },
      );
    }
    const retried = await priyaTab.actWith(operation, "vote", { pollId, optionIds: ["o1"] });
    await room.deliver();

    expect([first, retried]).toEqual([
      { ok: true, value: null },
      { ok: true, value: null },
    ]);
    expect(field(hostTab.row("polls", pollId), "results", "voterCount")).toBe(1);
  });

  it("refuses an id reused for a different request", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const pollId = await createPoll(room, hostTab);

    const operation = { issuedAtMs: Date.now(), nonce: "op-reused-id" };
    await priyaTab.actWith(operation, "vote", { pollId, optionIds: ["o1"] });
    const other = await priyaTab.actWith(operation, "vote", { pollId, optionIds: ["o2"] });

    expect(other).toEqual({ ok: false, code: "operation-conflict" });
  });

  it("fails closed for an expired id, and for one from the future", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const pollId = await createPoll(room, hostTab);

    const old = await priyaTab.actWith(
      { issuedAtMs: Date.now() - 120_001, nonce: "op-too-old" },
      "vote",
      { pollId, optionIds: ["o1"] },
    );
    const early = await priyaTab.actWith(
      { issuedAtMs: Date.now() + 5_001, nonce: "op-too-early" },
      "vote",
      { pollId, optionIds: ["o1"] },
    );
    await room.deliver();

    expect([old, early]).toEqual([
      { ok: false, code: "operation-expired" },
      { ok: false, code: "invalid-operation" },
    ]);
    expect(field(hostTab.row("polls", pollId), "results", "voterCount")).toBe(0);
  });

  it("an id that ran is refused once it expires, even after its receipt is gone", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const pollId = await createPoll(room, hostTab);

    const operation = { issuedAtMs: Date.now(), nonce: "op-ran-once" };
    await priyaTab.actWith(operation, "vote", { pollId, optionIds: ["o1"] });
    await vi.advanceTimersByTimeAsync(121_000);
    // Any later operation sweeps the expired receipt out.
    await hostTab.act("share", { pollId, shared: true });
    const late = await priyaTab.actWith(operation, "vote", { pollId, optionIds: ["o1"] });
    await room.deliver();

    expect(late).toEqual({ ok: false, code: "operation-expired" });
    expect(field(hostTab.row("polls", pollId), "results", "voterCount")).toBe(1);
  });

  it("binds a receipt to its subject", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const raviTab = await room.open(ravi, pollsContract);
    const pollId = await createPoll(room, hostTab);

    const operation = { issuedAtMs: Date.now(), nonce: "op-shared-nonce" };
    await priyaTab.actWith(operation, "vote", { pollId, optionIds: ["o1"] });
    // Ravi presenting Priya's id gets his own vote, not her receipt.
    await raviTab.actWith(operation, "vote", { pollId, optionIds: ["o2"] });
    await room.deliver();

    expect(field(hostTab.row("polls", pollId), "results", "votes")).toEqual({ o1: 1, o2: 1 });
  });

  it("refuses new operations when receipts are full, and never drops a live one", async () => {
    const room = new Harness([pollsAuthority], {
      runtime: { limits: { ...DEFAULT_AUTHORITY_LIMITS, receiptsPerSubject: 2 } },
    });
    const hostTab = await room.open(host, pollsContract);
    const pollId = await createPoll(room, hostTab);
    // `create` used one of the host's two receipts.
    const first = { issuedAtMs: Date.now(), nonce: "op-first-share" };
    await hostTab.actWith(first, "share", { pollId, shared: true });

    const full = await hostTab.actWith(
      { issuedAtMs: Date.now(), nonce: "op-over-limit" },
      "share",
      { pollId, shared: false },
    );
    const replayed = await hostTab.actWith(first, "share", { pollId, shared: true });
    await vi.advanceTimersByTimeAsync(121_000);
    const afterExpiry = await hostTab.actWith(
      { issuedAtMs: Date.now(), nonce: "op-after-expiry" },
      "share",
      { pollId, shared: false },
    );

    expect([full, replayed, afterExpiry]).toEqual([
      { ok: false, code: "capacity" },
      { ok: true, value: null },
      { ok: true, value: null },
    ]);
  });

  it("a session resends a lost answer under the same id", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const pollId = await createPoll(room, hostTab);

    // Lose the first ack: the server runs the vote, the client never hears.
    const emit = priyaTab.socket.emit.bind(priyaTab.socket);
    let dropped = 0;
    priyaTab.socket.emit = (event: string, payload?: unknown, ack?: unknown) => {
      if (event === AUTHORITY_EVENTS.act && dropped === 0) {
        dropped += 1;
        emit(event, payload, () => {});
        return;
      }
      emit(event, payload, ack);
    };

    const pending = priyaTab.session.act("vote", { pollId, optionIds: ["o1"] });
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await pending;
    await room.deliver();

    expect(dropped).toBe(1);
    expect(result).toEqual({ ok: true, value: null });
    expect(field(hostTab.row("polls", pollId), "results", "voterCount")).toBe(1);
  });
});

describe("identity", () => {
  it("lets an unverified guest watch but not vote, and says why", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const guestTab = await room.open(person("guest-abc", "Guest"), pollsContract);
    const pollId = await createPoll(room, hostTab);

    const vote = await guestTab.act("vote", { pollId, optionIds: ["o1"] });
    const state = guestTab.state;

    expect(vote).toEqual({ ok: false, code: "identity-required" });
    expect(field(guestTab.row("polls", pollId), "question")).toBe("Lunch?");
    expect(state.kind === "ready" && [...state.needsIdentity]).toEqual(["vote"]);
    expect(state.kind === "ready" && state.actions.has("vote")).toBe(false);
  });

  it("lets an unverified host run a poll: only voting needs an identity", async () => {
    const room = new Harness([pollsAuthority]);
    const guestHost = await room.open(person("guest-host", "Guest host", "host"), pollsContract);

    const created = await guestHost.act("create", { question: "Q", options: ["a", "b"] });
    const pollId = created.ok ? (field(created.value, "pollId") as string) : "";
    const vote = await guestHost.act("vote", { pollId, optionIds: ["o1"] });

    expect(created.ok).toBe(true);
    expect(vote).toEqual({ ok: false, code: "identity-required" });
  });

  it("gives one subject to every tab of a guest once a pass vouches for them", async () => {
    // Two tabs of one guest have different user keys and the same pass.
    const passes = new Map([
      ["guest-pass1.tab-a", "proof-1"],
      ["guest-pass1.tab-b", "proof-1"],
      ["guest-pass2.tab-a", "proof-2"],
    ]);
    const room = new Harness([pollsAuthority], {
      runtime: { guestProofOf: (_room, userKey) => passes.get(userKey) },
    });
    const hostTab = await room.open(host, pollsContract);
    const tabA = await room.open(person("guest-pass1.tab-a", "Gita"), pollsContract);
    const tabB = await room.open(person("guest-pass1.tab-b", "Gita"), pollsContract);
    const other = await room.open(person("guest-pass2.tab-a", "Hari"), pollsContract);
    const pollId = await createPoll(room, hostTab);

    const first = await tabA.act("vote", { pollId, optionIds: ["o1"] });
    const second = await tabB.act("vote", { pollId, optionIds: ["o2"] });
    const otherGuest = await other.act("vote", { pollId, optionIds: ["o2"] });
    await room.deliver();

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, code: "rejected", reason: "already-voted" });
    expect(otherGuest.ok).toBe(true);
    expect(field(tabB.row("myVotes", pollId), "optionIds")).toEqual(["o1"]);
    expect(field(hostTab.row("polls", pollId), "results", "voterCount")).toBe(2);
  });

  it("keeps webinar Q&A open to guest attendees and meeting Q&A to verified people", async () => {
    const room = new Harness([qaAuthority]);
    await room.open(host, qaContract);
    const guestMember = await room.open(person("guest-m", "Mo"), qaContract);
    const inMeeting = await guestMember.act("ask", { text: "May I ask?" });

    room.setWebinar(true, true);
    const guestAttendee = await room.open(person("guest-v", "Vi", "attendee"), qaContract);
    await room.deliver();
    const inWebinar = await guestAttendee.act("ask", { text: "And me?" });

    expect(inMeeting).toEqual({ ok: false, code: "identity-required" });
    expect(inWebinar.ok).toBe(true);
  });
});

describe("membership", () => {
  it("sends a removed seat nothing more and refuses everything it asks", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const raviTab = await room.open(ravi, pollsContract);
    room.room.promoteClientToAdmin(raviTab.seat.id);
    const pollId = await createPoll(room, hostTab);
    const before = raviTab.frames.length;

    // A kick removes the seat. The socket itself stays open.
    room.room.removeClient(raviTab.seat.id);
    await room.deliver();
    await hostTab.act("share", { pollId, shared: true });
    await room.deliver();

    const after = raviTab.frames.slice(before);
    const entry = hostTab.client.entryFor(pollsContract)!;
    const subscribe = await raviTab.raw<AuthorityResult<null>>(AUTHORITY_EVENTS.subscribe, {
      roomEpoch: room.authority.roomEpoch,
      instance: entry.instance,
      app: entry.app,
      major: entry.major,
      subscription: "after-kick",
    });
    const vote = await raviTab.actWith(
      { issuedAtMs: Date.now(), nonce: "op-after-kick" },
      "vote",
      { pollId, optionIds: ["o1"] },
    );
    const exported = await raviTab.raw<AuthorityResult<Json>>(AUTHORITY_EVENTS.query, {
      roomEpoch: room.authority.roomEpoch,
      subscription: raviTab.frames[0].subscription,
      generation: 2,
      request: "export-after-kick",
      query: "exportBallots",
      input: { pollId },
    });

    expect(after.map((frame) => frame.kind)).toEqual(["revoke"]);
    expect(raviTab.state.kind).toBe("revoked");
    expect([subscribe.ok, vote.ok, exported.ok]).toEqual([false, false, false]);
    expect([subscribe, vote, exported].map((reply) => !reply.ok && reply.code)).toEqual([
      "not-in-room",
      "not-in-room",
      "not-in-room",
    ]);
  });

  it("ends the old socket's view when a second connection takes the seat", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const oldTab = await room.open(priya, pollsContract, { session: "same" });
    const pollId = await createPoll(room, hostTab);
    const before = oldTab.frames.length;

    const newTab = await room.open(priya, pollsContract, { session: "same" });
    await room.deliver();
    await hostTab.act("share", { pollId, shared: true });
    await room.deliver();

    const oldVote = await oldTab.actWith(
      { issuedAtMs: Date.now(), nonce: "op-old-socket" },
      "vote",
      { pollId, optionIds: ["o1"] },
    );
    expect(dataFrames(oldTab.frames.slice(before))).toEqual([]);
    expect(oldVote).toEqual({ ok: false, code: "not-in-room" });
    expect(field(newTab.row("polls", pollId), "resultsShared")).toBe(true);
  });

  it("drops a disconnected socket's subscriptions", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const before = priyaTab.frames.length;

    priyaTab.seat.socket.disconnect(true);
    await createPoll(room, hostTab);

    expect(priyaTab.frames.slice(before)).toEqual([]);
  });

  it("ends the view of a socket that moved to another room", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const elsewhere = new Room({
      id: "elsewhere",
      clientId: "conclave",
      workerPid: null,
      router: {} as Router,
    });
    room.state.rooms.set(elsewhere.channelId, elsewhere);
    const before = priyaTab.frames.length;

    // What the join handler does on a room switch.
    room.room.removeClient(priyaTab.seat.id);
    priyaTab.context.currentRoom = elsewhere;
    await room.deliver();
    await createPoll(room, hostTab);

    expect(priyaTab.frames.slice(before).map((frame) => frame.kind)).toEqual(["revoke"]);
  });

  it("clears a demoted host's privileged rows", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const raviTab = await room.open(ravi, pollsContract);
    room.room.promoteClientToAdmin(raviTab.seat.id);
    const pollId = await createPoll(room, hostTab);
    await priyaTab.act("vote", { pollId, optionIds: ["o1"] });
    await room.deliver();
    expect(field(raviTab.row("polls", pollId), "results", "voterCount")).toBe(1);

    Object.setPrototypeOf(raviTab.seat, Client.prototype);
    room.authority.membershipChanged();
    await room.deliver();

    const state = raviTab.state;
    expect(field(raviTab.row("polls", pollId), "results")).toBeNull();
    expect(state.kind === "ready" && state.actions.has("create")).toBe(false);
  });

  it("checks the role again before each frame, even when nothing announced the change", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const raviTab = await room.open(ravi, pollsContract);
    room.room.promoteClientToAdmin(raviTab.seat.id);
    const pollId = await createPoll(room, hostTab);
    const before = raviTab.frames.length;

    // Demoted with no notification to the runtime at all.
    Object.setPrototypeOf(raviTab.seat, Client.prototype);
    await priyaTab.act("vote", { pollId, optionIds: ["o1"] });
    await room.deliver();

    const after = raviTab.frames.slice(before);
    const tallies = after.flatMap((frame) =>
      frame.kind === "patch" || frame.kind === "replace"
        ? (frame.kind === "patch" ? frame.put : frame.rows).filter(
            (row) => row.bucket === "polls" && field(row.value, "results") !== null,
          )
        : [],
    );
    expect(tallies).toEqual([]);
    expect(replaces(after).length).toBe(1);
  });

  it("checks the role on a request, even when nothing announced the change", async () => {
    const room = new Harness([pollsAuthority]);
    await room.open(host, pollsContract);
    const raviTab = await room.open(ravi, pollsContract);

    Object.setPrototypeOf(raviTab.seat, Admin.prototype);
    const created = await raviTab.act("create", { question: "Q", options: ["a", "b"] });
    Object.setPrototypeOf(raviTab.seat, Client.prototype);
    const again = await raviTab.act("create", { question: "Q2", options: ["a", "b"] });

    expect(created.ok).toBe(true);
    expect(again).toEqual({ ok: false, code: "forbidden" });
  });

  it("tells a connection when the apps it may open change", async () => {
    const room = new Harness([qaAuthority]);
    await room.open(host, qaContract);
    const viewerTab = await room.open(person("vik@example.com", "Vik", "attendee"), qaContract);
    expect(viewerTab.state.kind).toBe("unsupported");

    room.setWebinar(true, true);
    await room.deliver();
    expect(viewerTab.state.kind).toBe("ready");

    room.setWebinar(false);
    await room.deliver();
    expect(viewerTab.state.kind).not.toBe("ready");
    expect(viewerTab.rows("questions")).toEqual([]);
  });
});

describe("room policy", () => {
  it("ends an idle attendee's view when the webinar's schedule is cancelled", async () => {
    const room = new Harness([qaAuthority], { roomId: "scheduled" });
    const live = schedule("scheduled", "live");
    ensureWebinarRoomConfig(room.state, live);
    const viewer = await room.open(person("guest-viewer", "Viewer", "attendee"), qaContract);
    const readyBefore = viewer.state.kind;

    // What the cancel route does: record the status, apply it to the room.
    // Nobody acts afterwards, so nothing else would bring the change in.
    ensureWebinarRoomConfig(room.state, { ...live, status: "cancelled" });
    await vi.advanceTimersByTimeAsync(10);

    expect(readyBefore).toBe("ready");
    expect(viewer.frames[viewer.frames.length - 1]).toMatchObject({
      kind: "revoke",
      reason: "forbidden",
    });
    // The room is a meeting again, which offers an attendee no Q&A.
    expect(viewer.state).toEqual({ kind: "unsupported" });
    expect(viewer.client.entryFor(qaContract)).toBeNull();
  });
});

describe("delivery", () => {
  it("coalesces a burst into one frame per recipient per interval", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const watcher = await room.open(ravi, pollsContract);
    const voters: Tab[] = [];
    for (let index = 0; index < 10; index += 1) {
      voters.push(await room.open(person(`voter${index}@example.com`, `V${index}`), pollsContract));
    }
    const pollId = await createPoll(room, hostTab);
    await hostTab.act("share", { pollId, shared: true });
    await room.deliver();
    await vi.advanceTimersByTimeAsync(1_000);
    const before = watcher.frames.length;

    // Ten votes inside one 50 ms window, with real flush scheduling.
    for (const voter of voters) {
      void voter.session.act("vote", { pollId, optionIds: ["o1"] });
      await vi.advanceTimersByTimeAsync(4);
    }
    await vi.advanceTimersByTimeAsync(60);

    const sent = patches(watcher.frames.slice(before));
    expect(sent.length).toBeLessThanOrEqual(2);
    expect(field(watcher.row("polls", pollId), "results", "voterCount")).toBe(10);
    expect(
      sent.every((frame, index) => index === 0 || frame.seq === sent[index - 1].seq + 1),
    ).toBe(true);
  });

  it("flushes a lone action at once", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const watcher = await room.open(ravi, pollsContract);
    await vi.advanceTimersByTimeAsync(1_000);

    const created = hostTab.session.act("create", { question: "Q", options: ["a", "b"] });
    await vi.advanceTimersByTimeAsync(1);
    await created;

    expect(watcher.rows("polls").length).toBe(1);
  });

  it("sends nothing when a write changes no row a recipient can see", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const raviTab = await room.open(ravi, pollsContract);
    const pollId = await createPoll(room, hostTab);
    await hostTab.act("share", { pollId, shared: true });
    await room.deliver();
    const before = [hostTab.frames.length, raviTab.frames.length];

    // Already shared: the handler writes nothing.
    await hostTab.act("share", { pollId, shared: true });
    await room.deliver();

    expect([hostTab.frames.length, raviTab.frames.length]).toEqual(before);
  });

  it("numbers frames per subscription, counting only frames sent", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const raviTab = await room.open(ravi, pollsContract);
    const pollId = await createPoll(room, hostTab);
    await priyaTab.act("vote", { pollId, optionIds: ["o1"] });
    await room.deliver();
    await hostTab.act("end", { pollId });
    await room.deliver();

    // Ravi saw the poll appear and end. The private vote was not his to see,
    // and left no gap in his numbering to count hidden activity by.
    expect(patches(raviTab.frames).map((frame) => frame.seq)).toEqual([1, 2]);
    expect(patches(hostTab.frames).map((frame) => frame.seq)).toEqual([1, 2, 3]);
  });

  it("withholds a projected row its contract does not describe", async () => {
    const room = new Harness([probeAuthority], { runtime: { verifyViews: false } });
    const hostTab = await room.open(host, probeContract);
    const raviTab = await room.open(ravi, probeContract);

    await hostTab.act("put", { id: "fine", text: "hello" });
    await hostTab.act("leak");
    await room.deliver();

    expect(raviTab.rows("notes")).toEqual([{ id: "fine", text: "hello" }]);
    expect(JSON.stringify(raviTab.frames)).not.toContain("CANARY");
    expect(JSON.stringify(hostTab.frames)).not.toContain("CANARY");
  });
});

describe("bounds", () => {
  it("refuses an oversized command before any app code runs", async () => {
    const room = new Harness([probeAuthority]);
    const hostTab = await room.open(host, probeContract);

    const result = await hostTab.act("put", { id: "big", text: "x".repeat(17 * 1024) });

    expect(result).toEqual({ ok: false, code: "too-large" });
  });

  it("refuses a write past a table's cap and keeps what was there", async () => {
    const room = new Harness([probeAuthority]);
    const hostTab = await room.open(host, probeContract);
    for (let index = 0; index < 5; index += 1) {
      await hostTab.act("put", { id: `n${index}`, text: `ok ${index}` });
    }

    const overflow = await hostTab.act("put", { id: "n5", text: "one too many" });
    const tooBig = await hostTab.act("put", { id: "n0", text: "y".repeat(9 * 1024) });
    await room.deliver();

    expect([overflow, tooBig]).toEqual([
      { ok: false, code: "capacity" },
      { ok: false, code: "capacity" },
    ]);
    expect(hostTab.rows("notes").length).toBe(5);
    expect(field(hostTab.row("notes", "n0"), "text")).toBe("ok 0");
  });

  it("keeps nothing from a handler that throws or rejects, and freezes committed rows", async () => {
    const room = new Harness([probeAuthority]);
    const hostTab = await room.open(host, probeContract);
    await hostTab.act("put", { id: "kept", text: "original" });

    const thrown = await hostTab.act("throwAfterWrite");
    const rejected = await hostTab.act("rejectAfterWrite");
    const mutated = await hostTab.act("mutateCommitted", { id: "kept" });
    await room.deliver();

    expect([thrown, rejected, mutated]).toEqual([
      { ok: false, code: "app-fault" },
      { ok: false, code: "rejected", reason: "changed-my-mind" },
      { ok: false, code: "app-fault" },
    ]);
    expect(hostTab.rows("notes")).toEqual([{ id: "kept", text: "original" }]);
  });

  it("limits a person across their tabs, and the room as a whole", async () => {
    const room = new Harness([pollsAuthority, probeAuthority], {
      runtime: { limits: { ...DEFAULT_AUTHORITY_LIMITS, mutationBurst: 3, mutationsPerSecond: 1 } },
    });
    const hostTab = await room.open(host, pollsContract);
    const priyaOne = await room.open(priya, pollsContract);
    const priyaTwo = await room.open(priya, pollsContract);
    const pollIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      pollIds.push(await createPoll(room, hostTab));
    }
    await vi.advanceTimersByTimeAsync(10_000);

    // Votes are 10 a burst per person. Invalid choices still spend it.
    const results: AuthorityResult<Json>[] = [];
    for (let index = 0; index < 12; index += 1) {
      const tab = index % 2 === 0 ? priyaOne : priyaTwo;
      results.push(await tab.act("vote", { pollId: pollIds[0], optionIds: ["nope"] }));
    }
    const limited = results.filter((result) => !result.ok && result.code === "rate-limited");

    await vi.advanceTimersByTimeAsync(60_000);
    const budget: AuthorityResult<Json>[] = [];
    for (let index = 0; index < 5; index += 1) {
      budget.push(await hostTab.act("share", { pollId: pollIds[index % 3], shared: index % 2 === 0 }));
    }

    expect(limited.length).toBe(2);
    expect(limited[0]).toMatchObject({ retryAfterMs: expect.any(Number) as number });
    expect(budget.filter((result) => !result.ok && result.code === "busy").length).toBe(2);
  });

  it("caps subscriptions per socket", async () => {
    const room = new Harness([probeAuthority], {
      runtime: { limits: { ...DEFAULT_AUTHORITY_LIMITS, subscriptionsPerSocket: 2 } },
    });
    const hostTab = await room.open(host, probeContract);
    const entry = hostTab.client.entryFor(probeContract)!;
    const subscribe = (subscription: string) =>
      hostTab.raw<AuthorityResult<null>>(AUTHORITY_EVENTS.subscribe, {
        roomEpoch: room.authority.roomEpoch,
        instance: entry.instance,
        app: entry.app,
        major: entry.major,
        subscription,
      });

    const second = await subscribe("second");
    const third = await subscribe("third");

    expect([second.ok, third]).toEqual([true, { ok: false, code: "capacity" }]);
  });
});

describe("large views and slow sockets", () => {
  const small = { ...DEFAULT_AUTHORITY_LIMITS, chunkBytes: 400 };

  it("sends a large snapshot in parts and installs it whole", async () => {
    const room = new Harness([probeAuthority], { runtime: { limits: small } });
    const hostTab = await room.open(host, probeContract);
    for (let index = 0; index < 5; index += 1) {
      await hostTab.act("put", { id: `n${index}`, text: `${index}`.repeat(200) });
    }
    await room.deliver();

    const seen: number[] = [];
    const late = room.open(ravi, probeContract);
    // Watch the tab while its parts arrive on later turns of the event loop.
    for (let turn = 0; turn < 12; turn += 1) {
      await Promise.resolve();
      const tab = room.tabs[room.tabs.length - 1];
      if (tab && tab !== (hostTab as unknown as Tab)) seen.push(tab.rows("notes").length);
      vi.advanceTimersToNextTimer();
    }
    const raviTab = await late;

    const parts = replaces(raviTab.frames);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((frame) => frame.part)).toEqual(parts.map((_, index) => index));
    expect(parts[parts.length - 1].last).toBe(true);
    // Never a partial view: nothing, then all five.
    expect([...new Set(seen)]).toEqual(expect.arrayContaining([0]));
    expect(new Set(seen).size).toBeLessThanOrEqual(2);
    expect(raviTab.rows("notes").length).toBe(5);
  });

  it("queues changes behind a snapshot in flight and applies them after it", async () => {
    const room = new Harness([probeAuthority], { runtime: { limits: small } });
    const hostTab = await room.open(host, probeContract);
    for (let index = 0; index < 4; index += 1) {
      await hostTab.act("put", { id: `n${index}`, text: `${index}`.repeat(200) });
    }
    await room.deliver();

    const entry = hostTab.client.entryFor(probeContract)!;
    const raviTab = await room.open(ravi, probeContract);
    // A second, raw subscription whose parts we can interleave with a write.
    void raviTab.raw(AUTHORITY_EVENTS.subscribe, {
      roomEpoch: room.authority.roomEpoch,
      instance: entry.instance,
      app: entry.app,
      major: entry.major,
      subscription: "interleaved",
    });
    await hostTab.raw(AUTHORITY_EVENTS.act, {
      roomEpoch: room.authority.roomEpoch,
      subscription: hostTab.frames[0].subscription,
      generation: 1,
      operation: { issuedAtMs: Date.now(), nonce: "op-during-transfer" },
      action: "put",
      input: { id: "n0", text: "changed mid-transfer" },
    });
    room.authority.flushNow();
    await room.drain();

    const mine = raviTab.frames.filter((frame) => frame.subscription === "interleaved");
    const kinds = mine.map((frame) => frame.kind);
    expect(kinds.indexOf("patch")).toBe(kinds.lastIndexOf("replace") + 1);
    expect(kinds.filter((kind) => kind === "patch").length).toBe(1);
  });

  it("stops a snapshot between parts when the seat is removed", async () => {
    const room = new Harness([probeAuthority], { runtime: { limits: small } });
    const hostTab = await room.open(host, probeContract);
    for (let index = 0; index < 5; index += 1) {
      await hostTab.act("put", { id: `n${index}`, text: `${index}`.repeat(200) });
    }
    await room.deliver();
    const raviTab = await room.open(ravi, probeContract);
    const entry = hostTab.client.entryFor(probeContract)!;
    const before = raviTab.frames.length;

    void raviTab.raw(AUTHORITY_EVENTS.subscribe, {
      roomEpoch: room.authority.roomEpoch,
      instance: entry.instance,
      app: entry.app,
      major: entry.major,
      subscription: "cut-short",
    });
    room.room.removeClient(raviTab.seat.id);
    await room.drain();

    const mine = raviTab.frames
      .slice(before)
      .filter((frame) => frame.subscription === "cut-short");
    expect(replaces(mine).length).toBe(1);
    expect(replaces(mine)[0].last).toBe(false);
  });

  it("streams a large query result, and cuts it off when access is lost", async () => {
    const room = new Harness([probeAuthority], { runtime: { limits: small } });
    const hostTab = await room.open(host, probeContract);
    const raviTab = await room.open(ravi, probeContract);
    room.room.promoteClientToAdmin(raviTab.seat.id);
    for (let index = 0; index < 5; index += 1) {
      await hostTab.act("put", { id: `n${index}`, text: `${index}`.repeat(300) });
    }
    await room.deliver();

    const whole = await hostTab.query("dump");

    const cut = raviTab.session.query("dump", null);
    await Promise.resolve();
    vi.advanceTimersToNextTimer();
    Object.setPrototypeOf(raviTab.seat, Client.prototype);
    const cutResult = await room.settle(cut);

    expect(whole.ok && (field(whole.value, "notes") as Json[]).length).toBe(5);
    expect(hostTab.frames.filter((frame) => frame.kind === "query").length).toBeGreaterThan(1);
    expect(cutResult.ok).toBe(false);
    expect(raviTab.frames.some((frame) => frame.kind === "query" && frame.last)).toBe(false);
  });

  it("stops a snapshot between parts when the room's mode changes unannounced", async () => {
    const room = new Harness([qaAuthority], { runtime: { limits: small } });
    const hostTab = await room.open(host, qaContract);
    const priyaTab = await room.open(priya, qaContract);
    for (let index = 0; index < 3; index += 1) {
      await priyaTab.act("ask", { text: `Question ${index}? `.repeat(20) });
    }
    await room.deliver();
    const raviTab = await room.open(ravi, qaContract);
    const entry = hostTab.client.entryFor(qaContract)!;
    const before = raviTab.frames.length;

    void raviTab.raw(AUTHORITY_EVENTS.subscribe, {
      roomEpoch: room.authority.roomEpoch,
      instance: entry.instance,
      app: entry.app,
      major: entry.major,
      subscription: "mode-change",
    });
    // The room becomes a webinar, where a waiting question is not public.
    // Nothing tells the runtime: it has to notice before the next part.
    getOrCreateWebinarRoomConfig(room.state.webinarConfigs, room.room.channelId).enabled = true;
    await room.drain();

    const [first, ...rest] = replaces(
      raviTab.frames.slice(before).filter((frame) => frame.subscription === "mode-change"),
    );
    expect(first).toMatchObject({ generation: 1, part: 0, last: false });
    expect(rest.map((frame) => frame.generation)).toEqual([2]);
    expect(rest.flatMap((frame) => frame.rows)).toEqual([]);
  });

  it("cuts a streamed result off when the room's policy withdraws the query unannounced", async () => {
    const room = new Harness([probeAuthority], { runtime: { limits: small } });
    const hostTab = await room.open(host, probeContract);
    for (let index = 0; index < 5; index += 1) {
      await hostTab.act("put", { id: `n${index}`, text: `${index}`.repeat(300) });
    }
    await room.deliver();
    const parts = () => hostTab.frames.filter((frame) => frame.kind === "query").length;

    const cut = hostTab.session.query("dump", null);
    await Promise.resolve();
    vi.advanceTimersToNextTimer();
    const sentBefore = parts();
    getOrCreateWebinarRoomConfig(room.state.webinarConfigs, room.room.channelId).qaEnabled = false;
    const cutResult = await room.settle(cut);

    expect(sentBefore).toBe(1);
    expect(parts()).toBe(sentBefore);
    expect(cutResult.ok).toBe(false);
  });

  it("holds a streamed result back while the socket is behind, then finishes it", async () => {
    const pressure = new Map<string, { packets: number; bytes: number }>();
    const room = new Harness([probeAuthority], {
      runtime: {
        limits: small,
        pressure: (socket) => pressure.get(socket.id) ?? { packets: 0, bytes: 0 },
      },
    });
    const hostTab = await room.open(host, probeContract);
    for (let index = 0; index < 5; index += 1) {
      await hostTab.act("put", { id: `n${index}`, text: `${index}`.repeat(300) });
    }
    await room.deliver();
    const parts = () => hostTab.frames.filter((frame) => frame.kind === "query").length;

    const slow = hostTab.session.query("dump", null);
    await Promise.resolve();
    vi.advanceTimersToNextTimer();
    const sentBefore = parts();
    pressure.set(hostTab.seat.socket.id, { packets: 300, bytes: 0 });
    await vi.advanceTimersByTimeAsync(1_000);
    const sentWhileBehind = parts();
    pressure.delete(hostTab.seat.socket.id);
    const result = await room.settle(slow);

    expect(sentBefore).toBe(1);
    expect(sentWhileBehind).toBe(sentBefore);
    expect(result.ok && (field(result.value, "notes") as Json[]).length).toBe(5);
  });

  it("gives up on a streamed result when the socket stays behind", async () => {
    const pressure = new Map<string, { packets: number; bytes: number }>();
    const room = new Harness([probeAuthority], {
      runtime: {
        limits: small,
        pressure: (socket) => pressure.get(socket.id) ?? { packets: 0, bytes: 0 },
      },
    });
    const hostTab = await room.open(host, probeContract);
    for (let index = 0; index < 5; index += 1) {
      await hostTab.act("put", { id: `n${index}`, text: `${index}`.repeat(300) });
    }
    await room.deliver();

    const stuck = hostTab.session.query("dump", null);
    await Promise.resolve();
    vi.advanceTimersToNextTimer();
    pressure.set(hostTab.seat.socket.id, { packets: 300, bytes: 0 });
    const result = await room.settle(stuck);

    expect(result.ok).toBe(false);
    expect(hostTab.frames.filter((frame) => frame.kind === "query").length).toBe(1);
    expect(hostTab.seat.socket.connected).toBe(true);
  });

  it("answers no query on a socket that is behind, and drops one whose queue is full", async () => {
    const pressure = new Map<string, { packets: number; bytes: number }>();
    const room = new Harness([probeAuthority], {
      runtime: { pressure: (socket) => pressure.get(socket.id) ?? { packets: 0, bytes: 0 } },
    });
    const hostTab = await room.open(host, probeContract);
    await hostTab.act("put", { id: "a", text: "one" });
    await room.deliver();
    const request = (name: string) =>
      hostTab.raw<AuthorityResult<Json>>(AUTHORITY_EVENTS.query, {
        roomEpoch: room.authority.roomEpoch,
        subscription: hostTab.frames[0].subscription,
        generation: 1,
        request: name,
        query: "dump",
        input: null,
      });

    pressure.set(hostTab.seat.socket.id, { packets: 300, bytes: 0 });
    const behind = await request("while-behind");
    pressure.set(hostTab.seat.socket.id, { packets: 5_000, bytes: 0 });
    void request("while-full");

    expect(behind).toMatchObject({ ok: false, code: "busy" });
    expect(hostTab.seat.socket.connected).toBe(false);
    expect(room.authority.stats.disconnects).toBe(1);
  });

  it("refuses a view too large to send", async () => {
    const room = new Harness([probeAuthority], {
      runtime: { limits: { ...DEFAULT_AUTHORITY_LIMITS, snapshotBytes: 500 } },
    });
    const hostTab = await room.open(host, probeContract);
    for (let index = 0; index < 3; index += 1) {
      await hostTab.act("put", { id: `n${index}`, text: `${index}`.repeat(300) });
    }
    await room.deliver();

    const raviTab = await room.open(ravi, probeContract);

    expect(raviTab.state).toEqual({ kind: "revoked", reason: "too-large" });
    expect(replaces(raviTab.frames)).toEqual([]);
  });

  it("skips patches for a socket that fell behind, then sends it a fresh view", async () => {
    const pressure = new Map<string, { packets: number; bytes: number }>();
    const room = new Harness([probeAuthority], {
      runtime: { pressure: (socket) => pressure.get(socket.id) ?? { packets: 0, bytes: 0 } },
    });
    const hostTab = await room.open(host, probeContract);
    const slowTab = await room.open(ravi, probeContract);
    const before = slowTab.frames.length;

    pressure.set(slowTab.seat.socket.id, { packets: 300, bytes: 0 });
    await hostTab.act("put", { id: "a", text: "one" });
    await room.deliver();
    await hostTab.act("put", { id: "b", text: "two" });
    await room.deliver();
    const whileBehind = slowTab.frames.slice(before);

    pressure.delete(slowTab.seat.socket.id);
    await vi.advanceTimersByTimeAsync(300);

    const caughtUp = slowTab.frames.slice(before);
    expect(whileBehind).toEqual([]);
    expect(caughtUp.map((frame) => frame.kind)).toEqual(["replace"]);
    expect(slowTab.rows("notes").length).toBe(2);
    expect(room.authority.stats.resnapshots).toBe(1);
  });

  it("disconnects a socket whose queue is full", async () => {
    const pressure = new Map<string, { packets: number; bytes: number }>();
    const room = new Harness([probeAuthority], {
      runtime: { pressure: (socket) => pressure.get(socket.id) ?? { packets: 0, bytes: 0 } },
    });
    const hostTab = await room.open(host, probeContract);
    const stuckTab = await room.open(ravi, probeContract);

    pressure.set(stuckTab.seat.socket.id, { packets: 5_000, bytes: 0 });
    await hostTab.act("put", { id: "a", text: "one" });
    await room.deliver();

    expect(stuckTab.seat.socket.connected).toBe(false);
    expect(room.authority.stats.disconnects).toBe(1);
  });
});

describe("timers", () => {
  it("runs timers in due order on the server clock", async () => {
    const room = new Harness([probeAuthority]);
    const hostTab = await room.open(host, probeContract);

    await hostTab.act("schedule", { id: "late", afterMs: 3_000, label: "late" });
    await hostTab.act("schedule", { id: "early", afterMs: 1_000, label: "early" });
    await hostTab.act("schedule", { id: "gone", afterMs: 2_000, label: "gone" });
    const cancelled = await hostTab.act("cancel", { id: "gone" });
    // Scheduling the same key again replaces the timer.
    await hostTab.act("schedule", { id: "late", afterMs: 4_000, label: "late, moved" });
    await room.advance(999);
    const none = hostTab.rows("fired").length;
    await room.advance(1);
    const afterFirst = hostTab.rows("fired");
    await room.advance(5_000);

    expect(cancelled).toEqual({ ok: true, value: { cancelled: true } });
    expect(none).toBe(0);
    expect(afterFirst).toEqual([{ label: "early", at: 1_001_000, order: 0 }]);
    expect(hostTab.rows("fired").map((row) => field(row, "label"))).toEqual([
      "early",
      "late, moved",
    ]);
  });

  it("consumes a timer whose handler fails, and keeps none of its writes", async () => {
    const room = new Harness([probeAuthority]);
    const hostTab = await room.open(host, probeContract);

    await hostTab.act("schedule", { id: "bad", afterMs: 1_000, label: "faulty" });
    await hostTab.act("schedule", { id: "good", afterMs: 2_000, label: "fine" });
    await room.advance(10_000);

    expect(hostTab.rows("fired").map((row) => field(row, "label"))).toEqual(["fine"]);
  });

  it("waits out a deadline further off than a Node timer can count", async () => {
    const room = new Harness([probeAuthority]);
    const hostTab = await room.open(host, probeContract);
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const armed = vi.spyOn(globalThis, "setTimeout");

    await hostTab.act("schedule", { id: "far", afterMs: thirtyDays, label: "far" });
    // Node turns a delay past 2^31 - 1 ms into 1 ms, which would wake the
    // room a thousand times a second until the deadline came into range.
    const longest = Math.max(...armed.mock.calls.map(([, delay]) => Number(delay ?? 0)));
    armed.mockRestore();
    await room.advance(thirtyDays - 1);
    const early = hostTab.rows("fired").length;
    await room.advance(1);

    expect(longest).toBeLessThanOrEqual(2 ** 31 - 1);
    expect(early).toBe(0);
    expect(hostTab.rows("fired").map((row) => field(row, "label"))).toEqual(["far"]);
  });
});

describe("handlers that return a promise", () => {
  const rejections: unknown[] = [];
  const note = (reason: unknown): void => {
    rejections.push(reason);
  };

  beforeEach(() => {
    rejections.length = 0;
    process.on("unhandledRejection", note);
  });

  afterEach(() => {
    process.off("unhandledRejection", note);
  });

  it("keeps nothing from a timer handler that is still working when it returns", async () => {
    const room = new Harness([probeAuthority]);
    const hostTab = await room.open(host, probeContract);

    await hostTab.act("schedule", { id: "unfinished", afterMs: 1_000, label: "async" });
    await hostTab.act("schedule", { id: "good", afterMs: 2_000, label: "fine" });
    await room.advance(10_000);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(hostTab.rows("fired").map((row) => field(row, "label"))).toEqual(["fine"]);
    expect(rejections).toEqual([]);
  });

  it("keeps nothing from an action that is still working when it returns", async () => {
    const room = new Harness([probeAuthority]);
    const hostTab = await room.open(host, probeContract);

    const result = await hostTab.act("putLater");
    await room.deliver();
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(result).toEqual({ ok: false, code: "app-fault" });
    expect(hostTab.rows("notes")).toEqual([]);
    expect(rejections).toEqual([]);
  });

  it("admits nobody through a rule that answers with a promise", async () => {
    // An `async` rule answers with a promise, which is truthy whatever it
    // resolves to. The types refuse one, so the casts stand in for an author
    // who got past them.
    const rate = { burst: 10, perSecond: 10 };
    const gated = defineContract({
      id: "gated",
      major: 1,
      surface: "panel",
      actions: {
        whenAsync: { input: s.null(), receipt: s.null() },
        identityAsync: { input: s.null(), receipt: s.null() },
      },
      queries: {},
      views: {},
    });
    const sealed = defineContract({
      id: "sealed",
      major: 1,
      surface: "panel",
      actions: {},
      queries: {},
      views: {},
    });
    const room = new Harness([
      defineAuthority({
        contract: gated,
        tables: {},
        timers: {},
        canView: () => true,
        actions: {
          whenAsync: {
            roles: ["moderator", "member"],
            when: (async () => false) as unknown as () => boolean,
            identity: "any",
            rate,
            run: () => null,
          },
          identityAsync: {
            roles: ["moderator", "member"],
            identity: (async () => "any") as unknown as () => "any",
            rate,
            run: () => null,
          },
        },
        queries: {},
        onTimer: {},
        views: {},
      }),
      defineAuthority({
        contract: sealed,
        tables: {},
        timers: { tick: s.null() },
        canView: (async () => false) as unknown as () => boolean,
        actions: {},
        queries: {},
        onTimer: {
          // @ts-expect-error A timer handler may not be `async`.
          async tick() {},
        },
        views: {},
      }),
    ]);
    const hostTab = await room.open(host, gated);
    const guestTab = await room.open(person("guest-7f3a", "Guest"), gated);

    const gatedOut = await hostTab.act("whenAsync");
    const unsigned = await guestTab.act("identityAsync");

    expect(gatedOut).toEqual({ ok: false, code: "forbidden" });
    expect(unsigned).toEqual({ ok: false, code: "identity-required" });
    expect(hostTab.client.entryFor(sealed)).toBeNull();
  });
});

describe("teardown", () => {
  it("stops timers and refuses requests once the room closes", async () => {
    const room = new Harness([probeAuthority]);
    const hostTab = await room.open(host, probeContract);
    await hostTab.act("schedule", { id: "pending", afterMs: 1_000, label: "never" });
    const authority = room.authority;
    const before = hostTab.frames.length;

    room.state.rooms.delete(room.room.channelId);
    room.room.close();
    await vi.advanceTimersByTimeAsync(10_000);
    const afterClose = await hostTab.raw<AuthorityResult<Json>>(AUTHORITY_EVENTS.capabilities, {
      protocols: [1],
    });

    expect(authority.isClosed).toBe(true);
    // The socket outlives the room, so it is told to forget what it held.
    expect(hostTab.frames.slice(before)).toMatchObject([
      { kind: "revoke", reason: "closed" },
    ]);
    expect(hostTab.state).toEqual({ kind: "revoked", reason: "closed" });
    expect(afterClose).toEqual({ ok: false, code: "not-in-room" });
    expect(getRoomAuthority(room.state, room.room)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives a recreated room a new epoch, so nothing carries over", async () => {
    const first = new Harness([pollsAuthority]);
    const hostTab = await first.open(host, pollsContract);
    const pollId = await createPoll(first, hostTab);
    const oldEpoch = first.authority.roomEpoch;

    const second = new Harness([pollsAuthority]);
    const newHost = await second.open(host, pollsContract);
    const stale = await newHost.raw<AuthorityResult<Json>>(AUTHORITY_EVENTS.act, {
      roomEpoch: oldEpoch,
      subscription: newHost.frames[0].subscription,
      generation: 1,
      operation: { issuedAtMs: Date.now(), nonce: "op-old-epoch" },
      action: "end",
      input: { pollId },
    });

    expect(second.authority.roomEpoch).not.toBe(oldEpoch);
    expect(stale).toEqual({ ok: false, code: "stale-epoch" });
    expect(newHost.rows("polls")).toEqual([]);
  });
});
