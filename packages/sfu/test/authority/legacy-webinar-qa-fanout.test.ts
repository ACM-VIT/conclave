/**
 * What it costs to tell a large webinar of old clients about a change. The
 * old wire has one event per changed question, so the cost to bound is the
 * work per recipient: how many times a payload is encoded, and how much is
 * sent in one turn of the event loop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollsContract } from "@conclave/apps-sdk/polls/core";
import { pollsAuthority } from "@conclave/apps-sdk/polls/server";
import { qaContract } from "@conclave/apps-sdk/qa/core";
import { qaAuthority } from "@conclave/apps-sdk/qa/server";
import {
  LEGACY_QA_SENDS_PER_TURN,
  attachLegacyQaFeed,
  legacyQaSubmit,
  legacyQaUpvote,
} from "../../server/apps/authority/legacyWebinarQa.js";
import { DEFAULT_AUTHORITY_LIMITS } from "../../server/apps/authority/limits.js";
import type {
  WebinarQaChangedNotification,
  WebinarQaEntry,
  WebinarQaSnapshot,
} from "../../types.js";
import { Harness, person, type Tab } from "./harness.js";

const host = person("asha@example.com", "Asha", "host");

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

/** An old client: it keeps what the old events tell it. */
const listen = (tab: Tab) => {
  const entries = new Map<string, WebinarQaEntry>();
  const heard = { snapshots: 0, changes: 0, removed: [] as string[] };
  tab.socket.on("webinar:qaSnapshot", (payload: unknown) => {
    heard.snapshots += 1;
    entries.clear();
    for (const entry of (payload as WebinarQaSnapshot).entries) entries.set(entry.id, entry);
  });
  tab.socket.on("webinar:qaChanged", (payload: unknown) => {
    heard.changes += 1;
    const notification = payload as WebinarQaChangedNotification;
    if (notification.removedId) {
      heard.removed.push(notification.removedId);
      entries.delete(notification.removedId);
    } else if (notification.entry) entries.set(notification.entry.id, notification.entry);
  });
  attachLegacyQaFeed(tab.context);
  return { tab, entries, heard };
};

/**
 * A webinar with a host on the new transport and `count` attendees on the
 * old events, holding `questions` questions the host has started answering.
 */
const webinar = async (
  count: number,
  questions: number,
  limits: Partial<typeof DEFAULT_AUTHORITY_LIMITS> = {},
) => {
  const room = new Harness([pollsAuthority, qaAuthority], {
    runtime: { limits: { ...DEFAULT_AUTHORITY_LIMITS, ...limits } },
  });
  room.setWebinar(true);
  const hostTab = await room.open(host, qaContract);
  const listeners: ReturnType<typeof listen>[] = [];
  for (let index = 0; index < count; index += 1) {
    // Open on the polls app: an old client has no view of Q&A of its own.
    const tab = await room.open(
      person(`attendee${index}@example.com`, `Attendee ${index}`, "attendee"),
      pollsContract,
    );
    listeners.push(listen(tab));
  }
  const ids: string[] = [];
  for (let index = 0; index < questions; index += 1) {
    const asked = legacyQaSubmit(room.authority, listeners[index].tab.context, `Question ${index}?`);
    if (!("id" in asked)) throw new Error(`ask failed: ${JSON.stringify(asked)}`);
    ids.push(asked.id);
    await vi.advanceTimersByTimeAsync(200);
    await hostTab.act("moderate", { id: asked.id, action: "answering" });
  }
  await room.deliver();
  await room.drain();
  await vi.advanceTimersByTimeAsync(10_000);
  return { room, hostTab, listeners, ids };
};

const sent = (room: Harness, event: string) => ({
  encodings:
    (room.directEmits.get(event) ?? 0) +
    room.broadcasts.filter((broadcast) => broadcast.event === event).length,
  writes:
    (room.directEmits.get(event) ?? 0) +
    room.broadcasts
      .filter((broadcast) => broadcast.event === event)
      .reduce((total, broadcast) => total + broadcast.sockets, 0),
});

describe("telling a webinar of old clients about a change", () => {
  it("encodes a changed question once for everyone it reads the same for", async () => {
    // Few enough to be said in one turn: each turn encodes for itself.
    const { room, hostTab, listeners, ids } = await webinar(90, 20);
    const before = sent(room, "webinar:qaChanged");

    // The host answers all twenty inside one flush.
    for (const id of ids) await hostTab.act("moderate", { id, action: "answered" });
    await room.deliver();
    await room.drain();
    const after = sent(room, "webinar:qaChanged");

    expect(
      listeners.every((listener) => ids.every((id) => listener.entries.get(id)?.status === "answered")),
    ).toBe(true);
    // 90 listeners each hear of 20 questions.
    expect(after.writes - before.writes).toBe(90 * 20);
    // A question reads the same for everyone but its asker, who is named in
    // their own copy: two encodings a question, whatever the audience.
    expect(after.encodings - before.encodings).toBe(20 * 2);
  });

  it("gives an attendee who upvoted a question their own reading of it, encoded once for all of them", async () => {
    const { room, hostTab, listeners, ids } = await webinar(60, 1);
    const [id] = ids;
    // Half of them upvote it, through the old event's action.
    for (const listener of listeners.slice(1, 31)) {
      room.authority.actAs(listener.tab.context, "qa", "toggleUpvote", { id });
      await vi.advanceTimersByTimeAsync(20);
    }
    await room.deliver();
    await room.drain();
    const before = sent(room, "webinar:qaChanged");

    await hostTab.act("moderate", { id, action: "answered" });
    await room.deliver();
    await room.drain();
    const after = sent(room, "webinar:qaChanged");

    expect(listeners.slice(1, 31).every((listener) => listener.entries.get(id)?.hasUpvoted === true)).toBe(true);
    expect(listeners.slice(31).every((listener) => listener.entries.get(id)?.hasUpvoted === false)).toBe(true);
    expect(listeners.every((listener) => listener.entries.get(id)?.upvotes === 30)).toBe(true);
    expect(after.writes - before.writes).toBe(60);
    // The asker, those who upvoted, and everyone else.
    expect(after.encodings - before.encodings).toBe(3);
  });

  it("spreads a large fan-out over turns of the event loop", async () => {
    const perListener = 20;
    const count = Math.ceil((LEGACY_QA_SENDS_PER_TURN * 2.5) / perListener);
    const { room, hostTab, listeners, ids } = await webinar(count, perListener);
    // The first answer is flushed at once. The rest wait for the next flush.
    for (const id of ids) await hostTab.act("moderate", { id, action: "answered" });
    await vi.advanceTimersByTimeAsync(0);
    const waiting = ids.length - 1;
    const heardBefore = listeners.map((listener) => listener.heard.changes);
    const heardSince = (): number =>
      listeners.reduce((total, listener, index) => total + listener.heard.changes - heardBefore[index], 0);

    room.authority.flushNow();
    // The flush's own turn, with its microtasks.
    await Promise.resolve();
    await Promise.resolve();
    const inTheFirstTurn = heardSince();
    await vi.advanceTimersByTimeAsync(0);
    const afterOneMoreTurn = heardSince();
    await room.drain();

    expect(inTheFirstTurn).toBeGreaterThan(0);
    expect(inTheFirstTurn).toBeLessThanOrEqual(LEGACY_QA_SENDS_PER_TURN + perListener);
    expect(afterOneMoreTurn).toBeGreaterThan(inTheFirstTurn);
    expect(heardSince()).toBe(count * waiting);
    expect(
      listeners.every((listener) => ids.every((id) => listener.entries.get(id)?.status === "answered")),
    ).toBe(true);
  }, 60_000);

  it("tells a listener of a question once, as it stands, however often it changed while waiting", async () => {
    const perListener = 20;
    const count = Math.ceil((LEGACY_QA_SENDS_PER_TURN * 1.5) / perListener);
    const { room, hostTab, listeners, ids } = await webinar(count, perListener);
    const last = listeners[listeners.length - 1];

    // The first answer is flushed at once. The rest wait for the next flush.
    for (const id of ids) await hostTab.act("moderate", { id, action: "answered" });
    await vi.advanceTimersByTimeAsync(0);
    const waiting = ids.length - 1;
    const heardBefore = last.heard.changes;
    room.authority.flushNow();
    await Promise.resolve();
    await Promise.resolve();
    const heardInFirstTurn = last.heard.changes - heardBefore;
    // Before the last listener's turn comes, one of those questions changes
    // again.
    room.authority.actAs(hostTab.context, "qa", "moderate", { id: ids[1], action: "answering" });
    room.authority.flushNow();
    await room.drain();

    expect(heardInFirstTurn).toBe(0);
    expect(last.entries.get(ids[1])?.status).toBe("answering");
    expect(last.heard.changes - heardBefore).toBe(waiting);
  }, 60_000);

  it("sends a removed attendee nothing that was still waiting to be said", async () => {
    const perListener = 20;
    const count = Math.ceil((LEGACY_QA_SENDS_PER_TURN * 1.5) / perListener);
    const { room, hostTab, listeners, ids } = await webinar(count, perListener);
    const last = listeners[listeners.length - 1];

    for (const id of ids) await hostTab.act("moderate", { id, action: "answered" });
    await vi.advanceTimersByTimeAsync(0);
    const heardBefore = { ...last.heard };
    room.authority.flushNow();
    await Promise.resolve();
    await Promise.resolve();
    const heardInFirstTurn = last.heard.changes - heardBefore.changes;
    // The host removes them before their turn comes. Nothing announces it.
    room.room.removeClient(last.tab.seat.id);
    await room.drain();

    expect(heardInFirstTurn).toBe(0);
    expect(last.heard.changes).toBe(heardBefore.changes);
    // All a removed seat is sent is an empty list, which carries nothing and
    // takes the room's questions off its screen.
    expect(last.heard.snapshots).toBe(heardBefore.snapshots + 1);
    expect(last.entries.size).toBe(0);
    // Everyone still in the room heard all of it.
    expect(
      listeners.slice(0, -1).every((listener) => ids.every((id) => listener.entries.get(id)?.status === "answered")),
    ).toBe(true);
  }, 60_000);

  it("says a question dropped from the book once to each old client that upvoted it, with no list", async () => {
    // Their upvote rows are told a few people a flush, after the question's own row.
    const { room, hostTab, listeners, ids } = await webinar(100, 1, { clearedRowsPerFlush: 30 });
    const [popular] = ids;
    // Everyone upvotes it with the old event, so each client has saved its vote.
    for (const listener of listeners) {
      const voted = legacyQaUpvote(room.authority, listener.tab.context, popular);
      if (!("success" in voted)) throw new Error(`upvote failed: ${JSON.stringify(voted)}`);
    }
    await hostTab.act("moderate", { id: popular, action: "answered" });
    // The book fills to its cap of 300 with questions still waiting.
    const fill = async (round: number): Promise<void> => {
      await vi.advanceTimersByTimeAsync(40_000);
      for (const listener of listeners) {
        const asked = legacyQaSubmit(room.authority, listener.tab.context, `Waiting ${round}?`);
        if (!("id" in asked)) throw new Error(`ask failed: ${JSON.stringify(asked)}`);
      }
      await room.deliver();
      await room.drain();
    };
    await fill(1);
    await fill(2);
    await vi.advanceTimersByTimeAsync(40_000);
    for (const listener of listeners.slice(0, 99)) {
      legacyQaSubmit(room.authority, listener.tab.context, "Waiting 3?");
    }
    await room.deliver();
    await room.drain();
    const before = listeners.map((listener) => ({
      snapshots: listener.heard.snapshots,
      removals: listener.heard.removed.length,
      upvotes: listener.entries.get(popular)?.upvotes,
    }));

    // One more question takes the book over its cap. The answered one is the
    // first it gives up, and its 100 upvotes go with it.
    const last = legacyQaSubmit(room.authority, listeners[99].tab.context, "Waiting 3?");
    for (let flush = 0; flush < 8; flush += 1) {
      await room.advance(50);
      await room.drain();
    }

    expect("id" in last).toBe(true);
    expect(before.every((held) => held.upvotes === 100)).toBe(true);
    expect(listeners.every((listener) => !listener.entries.has(popular))).toBe(true);
    // Each client hears that the question is gone, once.
    expect(
      listeners.map((listener, index) =>
        listener.heard.removed.slice(before[index].removals).filter((id) => id === popular).length,
      ),
    ).toEqual(Array(100).fill(1));
    // Nobody is sent the whole list over it: the saved upvote went with the question.
    expect(
      listeners.map((listener, index) => listener.heard.snapshots - before[index].snapshots),
    ).toEqual(Array(100).fill(0));
  }, 60_000);

  it("sends a listener whose socket is behind nothing, then a whole list once it has caught up", async () => {
    const pressure = new Map<string, { packets: number; bytes: number }>();
    const room = new Harness([pollsAuthority, qaAuthority], {
      runtime: { pressure: (socket) => pressure.get(socket.id) ?? { packets: 0, bytes: 0 } },
    });
    room.setWebinar(true);
    const hostTab = await room.open(host, qaContract);
    const asker = listen(await room.open(person("a@example.com", "A", "attendee"), pollsContract));
    const slow = listen(await room.open(person("b@example.com", "B", "attendee"), pollsContract));
    const asked = legacyQaSubmit(room.authority, asker.tab.context, "Will the slow one hear?");
    const id = "id" in asked ? asked.id : "";
    await room.deliver();
    await room.drain();
    const heardBefore = { ...slow.heard };

    pressure.set(slow.tab.seat.socket.id, { packets: 300, bytes: 0 });
    await hostTab.act("moderate", { id, action: "answered" });
    await room.deliver();
    await room.drain();
    const whileBehind = { ...slow.heard };
    pressure.delete(slow.tab.seat.socket.id);
    await vi.advanceTimersByTimeAsync(300);
    await room.drain();

    expect(whileBehind).toEqual(heardBefore);
    expect(slow.heard.snapshots).toBe(heardBefore.snapshots + 1);
    expect(slow.entries.get(id)?.status).toBe("answered");
  });
});
