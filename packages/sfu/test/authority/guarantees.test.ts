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
import { defineAuthority, type Subject } from "@conclave/apps-sdk/authority/server";
import { Admin } from "../../config/classes/Admin.js";
import { Client } from "../../config/classes/Client.js";
import { Room } from "../../config/classes/Room.js";
import { getRoomAuthority, socketPressure } from "../../server/apps/authority/index.js";
import { AuthorityInstance, type Actor } from "../../server/apps/authority/instance.js";
import { DEFAULT_AUTHORITY_LIMITS } from "../../server/apps/authority/limits.js";
import { ensureWebinarRoomConfig } from "../../server/scheduledWebinarScheduler.js";
import { getOrCreateWebinarRoomConfig } from "../../server/webinar.js";
import type { ScheduledWebinar } from "../../types.js";
import type { Router } from "mediasoup/types";
import { Harness, person, type Tab } from "./harness.js";
import { pollsContract } from "@conclave/apps-sdk/polls/core";
import { pollsAuthority } from "@conclave/apps-sdk/polls/server";
import { probeAuthority, probeContract } from "./fixtures/probe.js";
import { qaContract } from "@conclave/apps-sdk/qa/core";
import { qaAuthority } from "@conclave/apps-sdk/qa/server";

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
    expect(field(hostTab.row("results", pollId), "voterCount")).toBe(1);
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
    expect(field(hostTab.row("results", pollId), "voterCount")).toBe(0);
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
    expect(field(hostTab.row("results", pollId), "voterCount")).toBe(1);
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

    expect(field(hostTab.row("results", pollId), "votes")).toEqual({ o1: 1, o2: 1 });
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
    expect(field(hostTab.row("results", pollId), "voterCount")).toBe(1);
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
    expect(field(hostTab.row("results", pollId), "voterCount")).toBe(2);
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
    expect(field(raviTab.row("results", pollId), "voterCount")).toBe(1);

    Object.setPrototypeOf(raviTab.seat, Client.prototype);
    room.authority.membershipChanged();
    await room.deliver();

    const state = raviTab.state;
    expect(raviTab.row("results", pollId)).toBeNull();
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
            (row) => row.bucket === "results",
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

describe("a change of room policy", () => {
  const canAsk = (tab: Tab): boolean => tab.state.kind === "ready" && tab.state.actions.has("ask");
  /** Each frame as its kind and how many rows it carries. */
  const shapes = (frames: AuthorityFrame[]) =>
    frames.map((frame) => [
      frame.kind,
      frame.kind === "patch"
        ? frame.put.length + frame.remove.length
        : frame.kind === "replace"
          ? frame.rows.length
          : 0,
    ]);

  it("tells a viewer what they may now do, and sends no view again, when that is all that changed", async () => {
    const room = new Harness([qaAuthority]);
    room.setWebinar(true, true);
    const hostTab = await room.open(host, qaContract);
    const viewer = await room.open(person("guest-viewer", "Viewer", "attendee"), qaContract);
    const asked = await viewer.act("ask", { text: "Asked while Q&A was on" });
    const id = field(asked.ok ? asked.value : null, "id") as string;
    await hostTab.act("moderate", { id, action: "answered" });
    await room.deliver();
    const couldAsk = canAsk(viewer);
    const viewBefore = viewer.held();
    const replacesBefore = room.authority.stats.replaces;
    const framesBefore = [viewer.frames.length, hostTab.frames.length];

    // The host turns Q&A off. Who may see which question is as it was.
    room.setWebinar(true, false);
    await vi.advanceTimersByTimeAsync(10);
    await room.deliver();
    const whileOff = {
      canAsk: canAsk(viewer),
      view: viewer.held(),
      replaces: room.authority.stats.replaces - replacesBefore,
    };
    const refused = await viewer.act("ask", { text: "Asked while it is off" });
    room.setWebinar(true, true);
    await vi.advanceTimersByTimeAsync(10);
    await room.deliver();

    expect(couldAsk).toBe(true);
    expect(whileOff).toEqual({ canAsk: false, view: viewBefore, replaces: 0 });
    expect(refused).toMatchObject({ ok: false, code: "forbidden" });
    expect(canAsk(viewer)).toBe(true);
    expect(room.authority.stats.replaces - replacesBefore).toBe(0);
    // Two small frames for the attendee, one for each switch, with no rows.
    expect(shapes(viewer.frames.slice(framesBefore[0]))).toEqual([
      ["patch", 0],
      ["patch", 0],
    ]);
    // Nothing changed for the host, who is sent nothing at all.
    expect(hostTab.frames.slice(framesBefore[1])).toEqual([]);
    expect(await room.converged()).toBe(true);
  });

  it("sends each viewer what changed for them, and no view again, when the room's mode changes", async () => {
    const room = new Harness([qaAuthority]);
    const hostTab = await room.open(host, qaContract);
    const asker = await room.open(priya, qaContract);
    const other = await room.open(ravi, qaContract);
    const asked = await asker.act("ask", { text: "Public in a meeting, private in a webinar" });
    const id = field(asked.ok ? asked.value : null, "id") as string;
    await room.deliver();
    const seenBefore = [other.row("questions", id) !== null, asker.row("myQuestions", id)];
    const replacesBefore = room.authority.stats.replaces;
    const framesBefore = other.frames.length;

    // In a webinar a waiting question is between its asker and the hosts.
    room.setWebinar(true, true);
    await vi.advanceTimersByTimeAsync(10);
    await room.deliver();

    expect(seenBefore).toEqual([true, { hidden: null }]);
    expect(room.authority.stats.replaces - replacesBefore).toBe(0);
    expect(other.row("questions", id)).toBeNull();
    // The asker now holds it as their own, out of the shared list.
    expect(asker.row("questions", id)).toBeNull();
    expect(field(asker.row("myQuestions", id), "hidden")).not.toBeNull();
    expect(JSON.stringify(asker.row("myQuestions", id))).toContain(
      "Public in a meeting, private in a webinar",
    );
    expect(field(hostTab.row("questions", id), "status")).toBe("pending");
    // The other member is told to drop that one question, in one frame that
    // also says what they may now do.
    const told = patches(other.frames.slice(framesBefore));
    expect(told.length).toBe(1);
    expect(new Set(told[0].remove.map((row) => row.key))).toEqual(new Set([id]));
    expect(told[0].put).toEqual([]);
    expect(told[0].grants?.actions).not.toContain("ask");
    expect(replaces(other.frames.slice(framesBefore))).toEqual([]);
    expect(await room.converged()).toBe(true);
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
    expect(field(watcher.row("results", pollId), "voterCount")).toBe(10);
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

describe("a view taken between a write and its flush", () => {
  /** The rows of one bucket a tab was handed whole when it opened the app. */
  const handed = (tab: Tab, bucket: string) =>
    replaces(tab.frames)
      .flatMap((frame) => frame.rows)
      .filter((row) => row.bucket === bucket);
  /** Every key a tab was told to drop. */
  const toldToDrop = (tab: Tab): string[] =>
    patches(tab.frames).flatMap((frame) => frame.remove.map((row) => row.key));

  it("leaves out a question the host hid a moment before", async () => {
    const room = new Harness([qaAuthority]);
    const hostTab = await room.open(host, qaContract);
    const priyaTab = await room.open(priya, qaContract);
    const asked = await priyaTab.act("ask", { text: "A question to hide" });
    const id = field(asked.ok ? asked.value : null, "id") as string;
    await room.deliver();
    const shownBefore = priyaTab.rows("questions").length;

    // The hide has committed. The flush that follows it is 50 ms away.
    const flushesBefore = room.authority.stats.flushes;
    const hidden = await hostTab.act("moderate", { id, action: "dismissed" });
    const late = await room.open(ravi, qaContract);
    const flushedMeanwhile = room.authority.stats.flushes - flushesBefore;
    const handedToLate = handed(late, "questions").map((row) => row.key);
    await room.deliver();

    expect(shownBefore).toBe(1);
    expect(hidden.ok).toBe(true);
    expect(flushedMeanwhile).toBe(0);
    expect(handedToLate).toEqual([]);
    expect(JSON.stringify(late.frames)).not.toContain("A question to hide");
    // Whoever held it loses it at the flush. Ravi never held it, so he is
    // told nothing, not even the id of a question that was gone before he came.
    expect(priyaTab.rows("questions")).toEqual([]);
    expect(patches(late.frames)).toEqual([]);
    expect(await room.converged()).toBe(true);
  });

  it("leaves out a poll's results the host stopped sharing a moment before", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const pollId = await createPoll(room, hostTab);
    await priyaTab.act("vote", { pollId, optionIds: ["o1"] });
    await hostTab.act("share", { pollId, shared: true });
    await room.deliver();
    const sharedBefore = field(priyaTab.row("results", pollId), "voterCount");

    const flushesBefore = room.authority.stats.flushes;
    await hostTab.act("share", { pollId, shared: false });
    const late = await room.open(ravi, pollsContract);
    const flushedMeanwhile = room.authority.stats.flushes - flushesBefore;
    const handedToLate = handed(late, "polls").map((row) => [
      row.key,
      field(row.value, "resultsShared"),
    ]);
    const resultsHandedToLate = handed(late, "results").map((row) => row.key);
    await room.deliver();

    expect(sharedBefore).toBe(1);
    expect(flushedMeanwhile).toBe(0);
    expect(handedToLate).toEqual([[pollId, false]]);
    expect(resultsHandedToLate).toEqual([]);
    expect(priyaTab.row("results", pollId)).toBeNull();
    expect(patches(late.frames)).toEqual([]);
    expect(await room.converged()).toBe(true);
  });

  it("shows a poll the host closed a moment before as closed", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const pollId = await createPoll(room, hostTab);
    const statusBefore = field(priyaTab.row("polls", pollId), "status");

    const flushesBefore = room.authority.stats.flushes;
    const ended = await hostTab.act("end", { pollId });
    const late = await room.open(ravi, pollsContract);
    const flushedMeanwhile = room.authority.stats.flushes - flushesBefore;
    const handedToLate = handed(late, "polls").map((row) => field(row.value, "status"));
    // Someone who was already watching still shows it open, until the flush.
    const earlyStillShows = field(priyaTab.row("polls", pollId), "status");
    const vote = await late.act("vote", { pollId, optionIds: ["o1"] });
    await room.deliver();

    expect(statusBefore).toBe("open");
    expect(ended.ok).toBe(true);
    expect(flushedMeanwhile).toBe(0);
    expect(handedToLate).toEqual(["ended"]);
    expect(earlyStillShows).toBe("open");
    expect(vote.ok).toBe(false);
    expect(field(priyaTab.row("polls", pollId), "status")).toBe("ended");
    expect(patches(late.frames)).toEqual([]);
    expect(await room.converged()).toBe(true);
  });

  it("holds a person's own row they gave up a moment before", async () => {
    const room = new Harness([qaAuthority]);
    const hostTab = await room.open(host, qaContract);
    const priyaTab = await room.open(priya, qaContract);
    const asked = await hostTab.act("ask", { text: "Upvote me" });
    const id = field(asked.ok ? asked.value : null, "id") as string;
    await priyaTab.act("upvote", { id, value: true });
    await room.deliver();
    const heldBefore = priyaTab.rows("myUpvotes").length;

    await priyaTab.act("upvote", { id, value: false });
    const secondTab = await room.open(priya, qaContract);

    expect(heldBefore).toBe(1);
    expect(handed(secondTab, "myUpvotes")).toEqual([]);
    expect(field(handed(secondTab, "votes")[0]?.value ?? null, "upvotes")).toBe(0);
    expect(await room.converged()).toBe(true);
  });

  it("tells each viewer what changed since their own view, and nothing older", async () => {
    const room = new Harness([probeAuthority]);
    const hostTab = await room.open(host, probeContract);
    const early = await room.open(priya, probeContract);
    await hostTab.act("put", { id: "kept", text: "stays" });
    await room.deliver();
    const earlyFrames = early.frames.length;

    // A note is written, Ravi opens the app and is handed it, and it is
    // removed again, all before the flush.
    await hostTab.act("put", { id: "brief", text: "here and gone" });
    const late = await room.open(ravi, probeContract);
    const handedToLate = handed(late, "notes").map((row) => row.key);
    await hostTab.act("remove", { id: "brief" });
    await room.deliver();

    expect(handedToLate).toEqual(["kept", "brief"]);
    // Ravi holds the note, so he is told to drop it. Priya never held it and
    // gets no frame at all.
    expect(toldToDrop(late)).toEqual(expect.arrayContaining(["brief"]));
    expect(late.rows("notes")).toEqual([{ id: "kept", text: "stays" }]);
    expect(early.frames.slice(earlyFrames)).toEqual([]);
    expect(await room.converged()).toBe(true);
  });

  it("names no question to a viewer who was never handed it, however it came and went since", async () => {
    const room = new Harness([qaAuthority]);
    const hostTab = await room.open(host, qaContract);
    const early = await room.open(priya, qaContract);
    const asked = await early.act("ask", { text: "Now you see me" });
    const id = field(asked.ok ? asked.value : null, "id") as string;
    await room.deliver();
    const earlyHeld = early.row("questions", id) !== null;

    // Shown. Hidden when Ravi opens the app. Shown again when Tara opens
    // it. Hidden again. All of it before the flush.
    const flushesBefore = room.authority.stats.flushes;
    await hostTab.act("moderate", { id, action: "dismissed" });
    const late = await room.open(ravi, qaContract);
    const handedToLate = handed(late, "questions").map((row) => row.key);
    await hostTab.act("moderate", { id, action: "reopen" });
    const later = await room.open(person("tara@example.com", "Tara"), qaContract);
    const handedToLater = handed(later, "questions").map((row) => row.key);
    await hostTab.act("moderate", { id, action: "dismissed" });
    const flushedMeanwhile = room.authority.stats.flushes - flushesBefore;
    await room.deliver();

    expect(earlyHeld).toBe(true);
    expect(flushedMeanwhile).toBe(0);
    expect(handedToLate).toEqual([]);
    expect(handedToLater).toEqual([id]);
    // Ravi never held it, so he is told nothing: not even its id, to drop.
    expect(patches(late.frames)).toEqual([]);
    expect(JSON.stringify(late.frames)).not.toContain(id);
    // Priya and Tara did hold it, and are told to drop it.
    expect(toldToDrop(early)).toContain(id);
    expect(toldToDrop(later)).toContain(id);
    expect([early.row("questions", id), later.row("questions", id)]).toEqual([null, null]);
    expect(await room.converged()).toBe(true);
  });

  it("sends a viewer a question that was hidden when they looked and is shown since", async () => {
    const room = new Harness([qaAuthority]);
    const hostTab = await room.open(host, qaContract);
    const early = await room.open(priya, qaContract);
    const asked = await early.act("ask", { text: "Back again" });
    const id = field(asked.ok ? asked.value : null, "id") as string;
    await room.deliver();
    const earlyFrames = early.frames.length;

    await hostTab.act("moderate", { id, action: "dismissed" });
    const late = await room.open(ravi, qaContract);
    const handedToLate = handed(late, "questions").map((row) => row.key);
    await hostTab.act("moderate", { id, action: "reopen" });
    await room.deliver();

    expect(handedToLate).toEqual([]);
    expect(field(late.row("questions", id), "text")).toBe("Back again");
    // Priya holds it exactly as it is again, so she is sent nothing of it.
    expect(
      patches(early.frames.slice(earlyFrames)).flatMap((frame) => [
        ...frame.put.filter((row) => row.bucket === "questions"),
        ...frame.remove.filter((row) => row.bucket === "questions"),
      ]),
    ).toEqual([]);
    expect(await room.converged()).toBe(true);
  });

  it("sends a change made after a view was taken to that viewer too", async () => {
    const room = new Harness([probeAuthority]);
    const hostTab = await room.open(host, probeContract);
    const early = await room.open(priya, probeContract);
    await room.deliver();

    await hostTab.act("put", { id: "note", text: "first" });
    const late = await room.open(ravi, probeContract);
    const handedToLate = handed(late, "notes").map((row) => field(row.value, "text"));
    await hostTab.act("put", { id: "note", text: "second" });
    await room.deliver();

    expect(handedToLate).toEqual(["first"]);
    expect(late.rows("notes")).toEqual([{ id: "note", text: "second" }]);
    expect(early.rows("notes")).toEqual([{ id: "note", text: "second" }]);
    expect(await room.converged()).toBe(true);
  });
});

describe("views nobody holds", () => {
  it("are forgotten when their last viewer leaves, in a room where nothing is written", async () => {
    const room = new Harness([qaAuthority]);
    const hostTab = await room.open(host, qaContract);
    const priyaTab = await room.open(priya, qaContract);
    const raviTab = await room.open(ravi, qaContract);
    await priyaTab.act("ask", { text: "Mine" });
    await room.deliver();
    const held = () => room.authority.viewsHeld;
    const atFirst = held();
    const flushesBefore = room.authority.stats.flushes;

    // Priya's socket drops. Nothing is written afterwards, so no flush runs.
    priyaTab.seat.socket.disconnect(true);
    await vi.advanceTimersByTimeAsync(100);
    const afterPriyaLeft = held();
    // Ravi closes the app and stays in the room.
    raviTab.session.close();
    await vi.advanceTimersByTimeAsync(100);
    const afterRaviClosed = held();
    // The only host closes it too.
    hostTab.session.close();
    await vi.advanceTimersByTimeAsync(100);

    expect(atFirst).toEqual({ roles: 2, subjects: 3 });
    expect(afterPriyaLeft).toEqual({ roles: 2, subjects: 2 });
    expect(afterRaviClosed).toEqual({ roles: 1, subjects: 1 });
    expect(held()).toEqual({ roles: 0, subjects: 0 });
    expect(room.authority.stats.flushes).toBe(flushesBefore);
  });

  it("are kept while another tab of the same person still holds them", async () => {
    const room = new Harness([qaAuthority]);
    const one = await room.open(priya, qaContract);
    const two = await room.open(priya, qaContract);
    await one.act("ask", { text: "Mine" });
    await room.deliver();

    one.session.close();
    await vi.advanceTimersByTimeAsync(100);
    const afterOneClosed = room.authority.viewsHeld;
    await two.act("ask", { text: "Also mine" });
    await room.deliver();

    // The tab that stayed goes on being told of its own rows.
    expect(afterOneClosed).toEqual({ roles: 1, subjects: 1 });
    expect(two.rows("myQuestions").length).toBe(2);
    expect(two.rows("questions").length).toBe(2);
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

  it("reads a table a page at a time, for the price of the rows it returns", async () => {
    const room = new Harness([probeAuthority], {
      runtime: { limits: { ...DEFAULT_AUTHORITY_LIMITS, transactionOps: 4 } },
    });
    const hostTab = await room.open(host, probeContract);
    for (let index = 0; index < 5; index += 1) {
      await hostTab.act("put", { id: `n${index}`, text: `${index}` });
    }

    // Five rows are more than one transaction may read here.
    const whole = await hostTab.query("dump");
    const first = await hostTab.query("page", { offset: 0, limit: 3 });
    const rest = await hostTab.query("page", { offset: 3, limit: 3 });

    expect(whole).toEqual({ ok: false, code: "app-fault" });
    expect(first).toEqual({ ok: true, value: { ids: ["n0", "n1", "n2"] } });
    expect(rest).toEqual({ ok: true, value: { ids: ["n3", "n4"] } });
  });

  it("drops a parent's rows in one step where one at a time would not fit", async () => {
    // A fiftieth of the real budget, so the test needs a fiftieth of the rows.
    const room = new Harness([probeAuthority], {
      runtime: { limits: { ...DEFAULT_AUTHORITY_LIMITS, transactionOps: 1_000 } },
    });
    const hostTab = await room.open(host, probeContract);
    const marks = async () => {
      const counted = await hostTab.query("countMarks", { id: "a" });
      return counted.ok ? field(counted.value, "count") : null;
    };
    for (const from of [0, 200, 400]) {
      await hostTab.act("mark", { id: "a", from, count: 200, shown: false });
    }
    await hostTab.act("mark", { id: "b", from: 0, count: 3, shown: false });

    // Reading and deleting 600 rows one by one is 1,200 operations, more
    // than the 1,000 a transaction may make here.
    const oneAtATime = await hostTab.act("unmark", { id: "a", how: "one at a time" });
    const stillThere = await marks();
    const cleared = await hostTab.act("unmark", { id: "a", how: "clear" });

    expect(oneAtATime).toEqual({ ok: false, code: "app-fault" });
    expect(stillThere).toBe(600);
    expect(cleared).toEqual({ ok: true, value: { removed: 600 } });
    expect(await marks()).toBe(0);
    // Another parent's rows are not touched.
    expect(await hostTab.query("countMarks", { id: "b" })).toEqual({ ok: true, value: { count: 3 } });
  });

  it("keeps nothing from a handler that ran out of budget, even one that carries on", async () => {
    const room = new Harness([probeAuthority], {
      runtime: { limits: { ...DEFAULT_AUTHORITY_LIMITS, transactionOps: 1_000 } },
    });
    const hostTab = await room.open(host, probeContract);
    for (const from of [0, 200, 400]) {
      await hostTab.act("mark", { id: "a", from, count: 200, shown: false });
    }
    const marks = async () => {
      const counted = await hostTab.query("countMarks", { id: "a" });
      return counted.ok ? field(counted.value, "count") : null;
    };

    // It deletes a few rows, runs out on the scan of all 600, catches the
    // error and returns as if all were well.
    const carriedOn = await hostTab.act("unmark", {
      id: "a",
      how: "one at a time, whatever goes wrong",
    });
    const afterLoop = await marks();

    expect(carriedOn).toEqual({ ok: false, code: "app-fault" });
    expect(afterLoop).toBe(600);
  });

  it("shows a handler its own clear at once, and keeps what it writes afterwards", async () => {
    const room = new Harness([probeAuthority]);
    const hostTab = await room.open(host, probeContract);
    await hostTab.act("mark", { id: "a", from: 0, count: 5, shown: true });
    await room.deliver();

    const remarked = await hostTab.act("remark", { id: "a" });
    await room.deliver();

    expect(remarked).toEqual({
      ok: true,
      value: { removed: 5, leftAfterClear: 0, oldRowStillThere: false, leftAfterWrite: 1 },
    });
    expect(await hostTab.query("countMarks", { id: "a" })).toEqual({ ok: true, value: { count: 1 } });
    expect(hostTab.rows("marks")).toEqual([{ n: 0 }]);
  });

  it("keeps the rows when the handler that cleared them is refused", async () => {
    const room = new Harness([probeAuthority]);
    const hostTab = await room.open(host, probeContract);
    await hostTab.act("mark", { id: "a", from: 0, count: 5, shown: true });
    await room.deliver();

    const refused = await hostTab.act("unmark", { id: "a", how: "clear then refuse" });
    await room.deliver();

    expect(refused).toEqual({ ok: false, code: "rejected", reason: "changed-my-mind" });
    expect(hostTab.rows("marks").length).toBe(5);
  });

  it("tells viewers of a large clear a batch at a time, until none of its rows is left", async () => {
    const room = new Harness([probeAuthority], {
      runtime: { limits: { ...DEFAULT_AUTHORITY_LIMITS, clearedRowsPerFlush: 100 } },
    });
    const hostTab = await room.open(host, probeContract);
    const raviTab = await room.open(ravi, probeContract);
    await hostTab.act("mark", { id: "a", from: 0, count: 250, shown: true });
    await hostTab.act("mark", { id: "b", from: 0, count: 2, shown: true });
    await room.deliver();
    const before = raviTab.rows("marks").length;

    await hostTab.act("unmark", { id: "a", how: "clear" });
    // The rows are gone for every handler at once.
    const leftForHandlers = await hostTab.query("countMarks", { id: "a" });
    await room.deliver();
    const afterOneFlush = raviTab.rows("marks").length;
    // Someone who opens the app now is not handed rows that are already gone.
    const late = await room.open(priya, probeContract);
    const lateSees = late.rows("marks").length;
    // The host goes on by itself, a batch every flush interval.
    await vi.advanceTimersByTimeAsync(50);
    const afterTwo = raviTab.rows("marks").length;
    await vi.advanceTimersByTimeAsync(50);

    expect(before).toBe(252);
    expect(leftForHandlers).toEqual({ ok: true, value: { count: 0 } });
    expect(afterOneFlush).toBe(152);
    expect(lateSees).toBe(2);
    expect(afterTwo).toBe(52);
    expect(raviTab.rows("marks").length).toBe(2);
    expect(hostTab.rows("marks").length).toBe(2);
    // The batches still to come are for those who held the rows. Priya never
    // did, and is sent none of their keys: no frame at all.
    expect(patches(late.frames)).toEqual([]);
    expect(await room.converged()).toBe(true);
  });

  it("lets a new row take a view key from a cleared row that viewers have yet to lose", async () => {
    const room = new Harness([probeAuthority], {
      runtime: { limits: { ...DEFAULT_AUTHORITY_LIMITS, clearedRowsPerFlush: 100 } },
    });
    const hostTab = await room.open(host, probeContract);
    const raviTab = await room.open(ravi, probeContract);
    await hostTab.act("mark", { id: "a", from: 0, count: 250, shown: false, slot: true });
    await room.deliver();
    const slot = (tab: Tab, n: number) => field(tab.row("slots", String(n)), "of");

    // The clear is told over three flushes. After the first, the viewers
    // still hold slots 100 to 249 of the cleared note.
    await hostTab.act("unmark", { id: "a", how: "clear" });
    await room.deliver();
    const heldAfterOneFlush = raviTab.rows("slots").length;
    // Another note's marks now claim ten of those slots, ones whose batch
    // is not the next to run.
    const replaced = await hostTab.act("mark", { id: "b", from: 220, count: 10, shown: false, slot: true });
    await room.deliver();
    const takenAtOnce = [slot(raviTab, 220), slot(raviTab, 229)];
    await vi.advanceTimersByTimeAsync(200);
    await room.deliver();

    expect(heldAfterOneFlush).toBe(150);
    expect(replaced).toEqual({ ok: true, value: null });
    expect(takenAtOnce).toEqual(["b", "b"]);
    // The late batches take the cleared note's slots, not the ones that replaced them.
    expect(raviTab.rows("slots").map((row) => field(row, "of"))).toEqual(Array(10).fill("b"));
    expect(hostTab.rows("slots").length).toBe(10);
    expect(await room.converged()).toBe(true);
  });

  it("sends a restored row to someone who subscribed while its clear was being told", async () => {
    const room = new Harness([probeAuthority], {
      runtime: { limits: { ...DEFAULT_AUTHORITY_LIMITS, clearedRowsPerFlush: 100 } },
    });
    const hostTab = await room.open(host, probeContract);
    const raviTab = await room.open(ravi, probeContract);
    await hostTab.act("mark", { id: "a", from: 0, count: 250, shown: true });
    await room.deliver();

    await hostTab.act("unmark", { id: "a", how: "clear" });
    await room.deliver();
    // Priya opens the app while 150 of the rows are still being told.
    const late = await room.open(priya, probeContract);
    const lateAtFirst = late.rows("marks").length;
    // Mark 200 comes back exactly as it was, before its batch has run.
    await hostTab.act("mark", { id: "a", from: 200, count: 1, shown: true });
    await room.deliver();
    await vi.advanceTimersByTimeAsync(200);
    await room.deliver();

    expect(lateAtFirst).toBe(0);
    // All Priya is ever told is the row that came back.
    expect(patches(late.frames).flatMap((frame) => frame.remove)).toEqual([]);
    expect(patches(late.frames).flatMap((frame) => frame.put.map((row) => row.key))).toEqual(["a/200"]);
    expect(late.rows("marks")).toEqual([{ n: 200 }]);
    expect(raviTab.rows("marks")).toEqual([{ n: 200 }]);
    expect(hostTab.rows("marks")).toEqual([{ n: 200 }]);
    expect(await room.converged()).toBe(true);
  });

  it("sends no cleared row to someone who subscribes before the flush that follows the clear", async () => {
    const room = new Harness([probeAuthority], {
      runtime: { limits: { ...DEFAULT_AUTHORITY_LIMITS, clearedRowsPerFlush: 100 } },
    });
    const hostTab = await room.open(host, probeContract);
    const raviTab = await room.open(ravi, probeContract);
    await hostTab.act("mark", { id: "a", from: 0, count: 250, shown: true });
    await hostTab.act("mark", { id: "b", from: 0, count: 2, shown: true });
    await room.deliver();

    // The clear has committed. The flush that follows it is 50 ms away.
    const flushesBefore = room.authority.stats.flushes;
    await hostTab.act("unmark", { id: "a", how: "clear" });
    const late = await room.open(priya, probeContract);
    const flushedMeanwhile = room.authority.stats.flushes - flushesBefore;
    const sentToLate = late.frames
      .flatMap((frame) => (frame.kind === "replace" ? frame.rows : []))
      .filter((row) => row.bucket === "marks")
      .map((row) => row.key);
    const raviStillHolds = raviTab.rows("marks").length;
    // One of the rows comes back unchanged, still before that flush.
    await hostTab.act("mark", { id: "a", from: 200, count: 1, shown: true });
    await vi.advanceTimersByTimeAsync(300);
    await room.deliver();

    expect(flushedMeanwhile).toBe(0);
    expect(sentToLate).toEqual(["b/0", "b/1"]);
    // Of the 250 keys the others are told to drop, Priya is sent none.
    expect(patches(late.frames).flatMap((frame) => frame.remove)).toEqual([]);
    expect(patches(raviTab.frames).flatMap((frame) => frame.remove).length).toBeGreaterThanOrEqual(249);
    expect(raviStillHolds).toBe(252);
    expect(late.rows("marks")).toEqual([{ n: 0 }, { n: 1 }, { n: 200 }]);
    expect(raviTab.rows("marks").length).toBe(3);
    expect(await room.converged()).toBe(true);
  });

  it("tells people of their own cleared rows out of one allowance a flush", () => {
    // The Q&A fixture without sockets: 300 people upvote one question, and
    // each of them holds their upvote as a row of their own.
    const qa = new AuthorityInstance(
      "qa.test",
      qaAuthority,
      { mode: "meeting", qaEnabled: true },
      {
        limits: { ...DEFAULT_AUTHORITY_LIMITS, clearedRowsPerFlush: 100 },
        random: { next: Math.random, int: (max) => Math.floor(Math.random() * max), shuffle: (list) => [...list] },
        verifyViews: true,
      },
    );
    const actor = (id: string, role: Actor["role"]): Actor => ({
      subject: id as Subject,
      role,
      verified: true,
      displayName: id,
    });
    let now = 1_000_000;
    const act = (who: Actor, action: string, input: unknown): AuthorityResult<Json> => {
      now += 10;
      return qa.act(who, action, input, null, now);
    };
    const voters = Array.from({ length: 300 }, (_, index) => actor(`voter-${index}`, "member"));
    const live = {
      roles: new Set<Actor["role"]>(["member"]),
      subjects: new Set(voters.map((voter) => voter.subject)),
    };
    const ownUpvotes = (who: Actor): number =>
      qa.snapshot(who).rows.filter((sized) => sized.row.bucket === "myUpvotes").length;

    const first = act(actor("asker-0", "member"), "ask", { text: "The popular one" });
    const popular = first.ok ? (field(first.value, "id") as string) : "";
    act(actor("host", "moderator"), "moderate", { id: popular, action: "answered" });
    for (const voter of voters) {
      qa.snapshot(voter);
      act(voter, "upvote", { id: popular, value: true });
    }
    qa.flushViews(live);
    const heldBefore = ownUpvotes(voters[299]);
    // The book fills. The answered question is the first it gives up, and
    // its 300 upvotes go with it.
    for (let index = 1; index <= 300; index += 1) {
      act(actor(`asker-${Math.ceil(index / 3)}`, "member"), "ask", { text: `Question ${index}` });
    }

    const toldPerFlush: number[] = [];
    const heldAfterFirstFlush: number[] = [];
    while (qa.hasPendingChanges) {
      const flushed = qa.flushViews(live);
      toldPerFlush.push(
        [...flushed.personal.values()]
          // As told to someone who has held their view all along.
          .flatMap((changes) => changes.for(0)?.remove ?? [])
          .filter((row) => row.bucket === "myUpvotes").length,
      );
      if (toldPerFlush.length === 1) heldAfterFirstFlush.push(...voters.map(ownUpvotes));
    }

    expect(heldBefore).toBe(1);
    expect(qa.store.rows("upvotes").size).toBe(0);
    // A snapshot is without the rows from the first flush on.
    expect(heldAfterFirstFlush.filter((held) => held > 0)).toEqual([]);
    expect(toldPerFlush).toEqual([100, 100, 100]);
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

  it("keeps a budget for hosts that a crowd cannot spend", async () => {
    const room = new Harness([probeAuthority], {
      runtime: { limits: { ...DEFAULT_AUTHORITY_LIMITS, mutationBurst: 3, mutationsPerSecond: 1 } },
    });
    const hostTab = await room.open(host, probeContract);
    const crowd = [await room.open(priya, probeContract), await room.open(ravi, probeContract)];

    // Everyone acts in the same instant. The crowd asks for twice what the
    // room takes from it.
    const fromCrowd: AuthorityResult<Json>[] = [];
    for (let index = 0; index < 6; index += 1) {
      fromCrowd.push(await crowd[index % 2].act("put", { id: `n${index % 3}`, text: "crowd" }));
    }
    const fromHost: AuthorityResult<Json>[] = [];
    for (let index = 0; index < 5; index += 1) {
      fromHost.push(await hostTab.act("put", { id: "host", text: `host ${index}` }));
    }
    const busy = (results: AuthorityResult<Json>[]): number =>
      results.filter((result) => !result.ok && result.code === "busy").length;

    expect(busy(fromCrowd)).toBe(3);
    // The host's actions were never in that queue. Theirs is bounded too.
    expect(fromHost.slice(0, 3).map((result) => result.ok)).toEqual([true, true, true]);
    expect(busy(fromHost)).toBe(2);
  });

  it("holds a person to their cooldown when the table of limits is cleaned up", async () => {
    // A table small enough that every new person's first action cleans it.
    const room = new Harness([qaAuthority], {
      runtime: { limits: { ...DEFAULT_AUTHORITY_LIMITS, rateBuckets: 2 } },
    });
    const priyaTab = await room.open(priya, qaContract);
    const others = [await room.open(ravi, qaContract), await room.open(host, qaContract)];

    // Three questions in a burst, then one every ten seconds.
    const burst: AuthorityResult<Json>[] = [];
    for (let index = 0; index < 4; index += 1) {
      burst.push(await priyaTab.session.act("ask", { text: `Question ${index}` }));
    }
    await vi.advanceTimersByTimeAsync(1_000);
    for (const other of others) await other.session.act("ask", { text: "Mine" });
    const afterOneSecond = await priyaTab.session.act("ask", { text: "Again, a second later" });
    await vi.advanceTimersByTimeAsync(9_000);
    const afterTen = await priyaTab.session.act("ask", { text: "Again, ten seconds on" });

    expect(burst.map((result) => (result.ok ? "ok" : result.code))).toEqual([
      "ok",
      "ok",
      "ok",
      "rate-limited",
    ]);
    expect(afterOneSecond).toMatchObject({ ok: false, code: "rate-limited" });
    // Her fourth question is refused for being her fourth open one, not for its pace.
    expect(afterTen).toMatchObject({ ok: false, code: "rejected" });
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

  /**
   * A room with a view that goes in parts, and Ravi's socket with one subscription to
   * it whose first part has just gone out. `changeDuringTransfer` has the host
   * change a note and flushes it, so one more patch waits behind the snapshot.
   */
  const snapshotInFlight = async (
    limits: Partial<typeof DEFAULT_AUTHORITY_LIMITS>,
    pressure: (tab: Tab, name: string) => { packets: number; bytes: number },
  ) => {
    const name = "behind-a-snapshot";
    let slow: Tab | null = null;
    const room = new Harness([probeAuthority], {
      runtime: {
        limits: { ...small, ...limits },
        pressure: (socket) =>
          slow && socket.id === slow.seat.socket.id
            ? pressure(slow, name)
            : { packets: 0, bytes: 0 },
      },
    });
    const hostTab = await room.open(host, probeContract);
    for (let index = 0; index < 4; index += 1) {
      await hostTab.act("put", { id: `n${index}`, text: `${index}`.repeat(200) });
    }
    await room.deliver();
    const raviTab = await room.open(ravi, probeContract);
    // The tab's own view is closed, so the socket carries one view only.
    raviTab.socket.emit(AUTHORITY_EVENTS.unsubscribe, {
      subscription: raviTab.frames[0].subscription,
    });
    const entry = hostTab.client.entryFor(probeContract)!;
    const from = raviTab.frames.length;
    slow = raviTab;
    void raviTab.raw(AUTHORITY_EVENTS.subscribe, {
      roomEpoch: room.authority.roomEpoch,
      instance: entry.instance,
      app: entry.app,
      major: entry.major,
      subscription: name,
    });
    let changes = 0;
    const changeDuringTransfer = async (): Promise<string> => {
      changes += 1;
      const text = `change ${changes} `.repeat(20);
      await hostTab.raw(AUTHORITY_EVENTS.act, {
        roomEpoch: room.authority.roomEpoch,
        subscription: hostTab.frames[0].subscription,
        generation: 1,
        operation: { issuedAtMs: Date.now(), nonce: `during-transfer-${changes}` },
        action: "put",
        input: { id: `n${changes % 4}`, text },
      });
      room.authority.flushNow();
      return text;
    };
    return {
      room,
      hostTab,
      raviTab,
      changeDuringTransfer,
      sent: () => raviTab.frames.slice(from).filter((frame) => frame.subscription === name),
    };
  };

  const bytesOf = (frames: AuthorityFrame[]): number =>
    frames.reduce((total, frame) => total + JSON.stringify(frame).length, 0);

  it("stops the changes queued behind a snapshot once the socket is behind, and catches an idle view up when it drains", async () => {
    const softBytes = 2_200;
    // A socket that takes nothing off its queue: all it was sent is unsent.
    let stuck = true;
    const { room, hostTab, changeDuringTransfer, sent } = await snapshotInFlight(
      { socketSoftBytes: softBytes },
      (tab, name) => {
        const queued = stuck ? tab.frames.filter((frame) => frame.subscription === name) : [];
        return { packets: queued.length, bytes: bytesOf(queued) };
      },
    );
    const texts: string[] = [];
    for (let index = 0; index < 8; index += 1) texts.push(await changeDuringTransfer());
    await room.drain();

    const whileStuck = sent();
    const queuedBefore = whileStuck.map((_, index) => bytesOf(whileStuck.slice(0, index)));
    // The app does nothing more, and the socket stays stuck a while longer.
    await vi.advanceTimersByTimeAsync(1_000);
    await room.drain();
    const afterWaiting = sent().length;

    stuck = false;
    await vi.advanceTimersByTimeAsync(300);
    await room.drain();
    const caughtUp = sent().slice(whileStuck.length);
    const held = new Map<string, Json>();
    for (const frame of caughtUp) {
      if (frame.kind === "replace") for (const row of frame.rows) held.set(row.key, row.value);
    }

    expect(replaces(whileStuck).length).toBeGreaterThan(2);
    expect(replaces(whileStuck).at(-1)?.last).toBe(true);
    // Some of the eight queued changes went, until the queue was over its
    // limit. Nothing was added to a queue already over it.
    expect(patches(whileStuck).length).toBeGreaterThan(0);
    expect(patches(whileStuck).length).toBeLessThan(8);
    expect(Math.max(...queuedBefore)).toBeLessThanOrEqual(softBytes);
    expect(afterWaiting).toBe(whileStuck.length);
    // With no further change in the app, the drained socket gets a whole
    // fresh view carrying every change.
    expect(replaces(caughtUp).length).toBe(caughtUp.length);
    expect(replaces(caughtUp).at(-1)?.last).toBe(true);
    expect(new Set(caughtUp.map((frame) => frame.generation)).size).toBe(1);
    expect(caughtUp[0]?.generation).toBeGreaterThan(1);
    expect([0, 1, 2, 3].map((index) => field(held.get(`n${index}`) ?? null, "text"))).toEqual([
      texts[7],
      texts[4],
      texts[5],
      texts[6],
    ]);
    expect(hostTab.rows("notes").length).toBe(4);
    expect(room.authority.stats.resnapshots).toBe(1);
    expect(room.authority.stats.disconnects).toBe(0);
  });

  it("disconnects a socket whose queue is full when the changes queued behind its snapshot come due", async () => {
    // The snapshot's last part fills the queue.
    const { room, raviTab, changeDuringTransfer, sent } = await snapshotInFlight({}, (tab, name) => {
      const lastPartOut = tab.frames.some(
        (frame) => frame.subscription === name && frame.kind === "replace" && frame.last,
      );
      return { packets: 0, bytes: lastPartOut ? DEFAULT_AUTHORITY_LIMITS.socketHardBytes + 1 : 0 };
    });
    for (let index = 0; index < 8; index += 1) await changeDuringTransfer();
    await room.drain();

    expect(replaces(sent()).at(-1)?.last).toBe(true);
    expect(patches(sent())).toEqual([]);
    expect(raviTab.seat.socket.connected).toBe(false);
    expect(room.authority.stats.disconnects).toBe(1);
  });

  it("sends no part of a snapshot a question the host hid after the snapshot began", async () => {
    const room = new Harness([qaAuthority], { runtime: { limits: small } });
    const hostTab = await room.open(host, qaContract);
    const priyaTab = await room.open(priya, qaContract);
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const asked = await priyaTab.act("ask", { text: `Question ${index}? `.repeat(20) });
      ids.push(field(asked.ok ? asked.value : null, "id") as string);
    }
    await room.deliver();
    const raviTab = await room.open(ravi, qaContract);
    const entry = hostTab.client.entryFor(qaContract)!;
    const before = raviTab.frames.length;

    // A view that comes in parts. Its first part has gone out.
    void raviTab.raw(AUTHORITY_EVENTS.subscribe, {
      roomEpoch: room.authority.roomEpoch,
      instance: entry.instance,
      app: entry.app,
      major: entry.major,
      subscription: "hidden-mid-transfer",
    });
    const sentAtOnce = raviTab.frames.slice(before).length;
    // Before the next part, the host hides the last question, and changes
    // the one before it.
    const hidden = await hostTab.raw<AuthorityResult<Json>>(AUTHORITY_EVENTS.act, {
      roomEpoch: room.authority.roomEpoch,
      subscription: hostTab.frames[0].subscription,
      generation: 1,
      operation: { issuedAtMs: Date.now(), nonce: "hide-mid-transfer" },
      action: "moderate",
      input: { id: ids[2], action: "dismissed" },
    });
    const answered = await hostTab.raw<AuthorityResult<Json>>(AUTHORITY_EVENTS.act, {
      roomEpoch: room.authority.roomEpoch,
      subscription: hostTab.frames[0].subscription,
      generation: 1,
      operation: { issuedAtMs: Date.now(), nonce: "answer-mid-transfer" },
      action: "moderate",
      input: { id: ids[1], action: "answered" },
    });
    await room.drain();
    await room.deliver();
    await room.drain();

    const mine = raviTab.frames.slice(before).filter((frame) => frame.subscription === "hidden-mid-transfer");
    const parts = replaces(mine);
    const later = parts
      .slice(1)
      .flatMap((part) => part.rows)
      .filter((row) => row.bucket === "questions");
    // What Ravi ends up holding, from the parts and the patches after them.
    const held = new Map<string, Json>();
    for (const frame of mine) {
      if (frame.kind === "replace") for (const row of frame.rows) held.set(`${row.bucket}/${row.key}`, row.value);
      if (frame.kind === "patch") {
        for (const row of frame.remove) held.delete(`${row.bucket}/${row.key}`);
        for (const row of frame.put) held.set(`${row.bucket}/${row.key}`, row.value);
      }
    }

    expect(sentAtOnce).toBe(1);
    expect([hidden.ok, answered.ok]).toEqual([true, true]);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts[parts.length - 1].last).toBe(true);
    // No part sent after the hide carries the hidden question.
    expect(later.filter((row) => row.key === ids[2])).toEqual([]);
    expect(JSON.stringify(parts.slice(1))).not.toContain("Question 2?");
    // A row that changed is sent as it is when its part goes, not as it was.
    expect(later.filter((row) => row.key === ids[1]).map((row) => field(row.value, "status"))).toEqual([
      "answered",
    ]);
    expect([...held.keys()].filter((held) => held.startsWith("questions/")).sort()).toEqual(
      [`questions/${ids[0]}`, `questions/${ids[1]}`].sort(),
    );
    expect([...held.keys()].filter((held) => held.endsWith(`/${ids[2]}`))).toEqual([]);
    expect(field(held.get(`questions/${ids[1]}`) ?? null, "status")).toBe("answered");
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

  it("counts what is queued for a socket in bytes as well as packets, on any transport", () => {
    type Queued = { type: string; data?: unknown };
    const socketWith = (writeBuffer: Queued[], bufferedAmount?: number) =>
      ({
        conn: {
          writeBuffer,
          transport: bufferedAmount === undefined ? {} : { socket: { bufferedAmount } },
        },
      }) as unknown as Parameters<typeof socketPressure>[0];
    const part = "x".repeat(64 * 1024);

    // Long polling has no socket to ask: all there is to count is the queue.
    const polling = socketPressure(
      socketWith(Array.from({ length: 20 }, () => ({ type: "message", data: part }))),
    );
    // A WebSocket holds bytes below the queue as well, and both count.
    const webSocket = socketPressure(
      socketWith(
        [
          { type: "message", data: "\u00e9".repeat(10) },
          { type: "message", data: Buffer.alloc(100) },
          { type: "ping" },
        ],
        5_000,
      ),
    );

    expect(polling).toEqual({ packets: 20, bytes: 20 * 64 * 1024 });
    expect(polling.bytes).toBeGreaterThan(DEFAULT_AUTHORITY_LIMITS.socketSoftBytes);
    expect(webSocket).toEqual({ packets: 3, bytes: 20 + 100 + 5_000 });
    expect(socketPressure({} as Parameters<typeof socketPressure>[0])).toEqual({ packets: 0, bytes: 0 });
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
