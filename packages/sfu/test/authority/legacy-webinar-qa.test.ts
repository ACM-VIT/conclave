/**
 * Old and new clients in one webinar. Released web and native builds speak
 * only `webinar:qa:*`; new builds speak the authority transport. In a room
 * that runs the Q&A app both read and write the same book.
 */
import { afterEach, describe, expect, it } from "vitest";
import { AUTHORITY_EVENTS, AuthorityClient } from "@conclave/apps-sdk/authority";
import { pollsAuthority } from "@conclave/apps-sdk/polls/server";
import { qaContract } from "@conclave/apps-sdk/qa/core";
import { qaAuthority } from "@conclave/apps-sdk/qa/server";
import {
  getOrCreateWebinarRoomConfig,
  setCustomWebinarLinkSlug,
} from "../../server/webinar.js";
import {
  WEBINAR_QA_LISTS_PER_TURN,
  emitWebinarConfigChanged,
} from "../../server/webinarNotifications.js";
import { Admin } from "../../config/classes/Admin.js";
import { Client } from "../../config/classes/Client.js";
import { LocalRoomRegistry } from "../../server/roomRegistry.js";
import { forceRemoveClientNow, toRoomSnapshot } from "../../server/admin/controlPlane.js";
import { REOPENED_TOO_OFTEN } from "../../server/apps/authority/legacyWebinarQa.js";
import { createSfuState } from "../../server/state.js";
import type {
  WebinarQaChangedNotification,
  WebinarQaEntry,
  WebinarQaSnapshot,
} from "../../types.js";
import {
  HOST,
  addRoom,
  ask,
  closeAll,
  connect,
  field,
  open,
  row,
  start,
  until,
  wait,
  type Stack,
} from "./wireKit.js";

afterEach(closeAll);

const SLUG = "launch";
const asha = { email: HOST, name: "Asha", session: "h1" };
const omar = { email: "omar@example.com", name: "Omar", session: "o1" };
const vik = { email: "vik@example.com", name: "Vik", session: "v1" };
const wen = { email: "wen@example.com", name: "Wen", session: "w1" };
const guest = { email: "guest-zed", name: "Zed", session: "z1" };

const asAttendee = { join: { roomId: SLUG, joinMode: "webinar_attendee" } };

const startWebinar = async (): Promise<Stack> => {
  const stack = await start([pollsAuthority, qaAuthority]);
  const webinar = getOrCreateWebinarRoomConfig(
    stack.state.webinarConfigs,
    stack.room.channelId,
  );
  webinar.enabled = true;
  webinar.publicAccess = true;
  setCustomWebinarLinkSlug({
    webinarConfig: webinar,
    webinarLinks: stack.state.webinarLinks,
    room: stack.room,
    slug: SLUG,
  });
  return stack;
};

/** A client that knows only the old Q&A events, and what it would show. */
const oldClient = async (
  stack: Stack,
  who: { email: string; name: string; session: string },
  options: Parameters<typeof connect>[2] = {},
) => {
  const entries = new Map<string, WebinarQaEntry>();
  const events: string[] = [];
  let snapshots = 0;
  // An old client listens before it joins: its first list arrives with the join.
  const connection = await connect(stack, who, {
    ...options,
    prepare: (socket) => {
      options.prepare?.(socket);
      socket.on("webinar:configChanged", (config: { enabled?: boolean }) => {
        if (config.enabled === false) entries.clear();
      });
      socket.on("webinar:qaSnapshot", (snapshot: WebinarQaSnapshot) => {
        snapshots += 1;
        entries.clear();
        for (const entry of snapshot.entries) entries.set(entry.id, entry);
      });
      socket.on("webinar:qaChanged", (notification: WebinarQaChangedNotification) => {
        events.push(
          notification.removedId ? `removed:${notification.removedId}` : "changed",
        );
        if (notification.removedId) entries.delete(notification.removedId);
        else if (notification.entry) entries.set(notification.entry.id, notification.entry);
      });
    },
  });
  return {
    ...connection,
    entries,
    events,
    snapshots: () => snapshots,
    submit: (question: string) =>
      ask<{ success?: boolean; id?: string; error?: string }>(
        connection.socket,
        "webinar:qa:submit",
        { question },
      ),
    upvote: (id: string) =>
      ask<{ success?: boolean; upvotes?: number; hasUpvoted?: boolean; error?: string }>(
        connection.socket,
        "webinar:qa:upvote",
        { id },
      ),
    moderate: (id: string, action: string, answerText?: string) =>
      ask<{ success?: boolean; error?: string }>(connection.socket, "webinar:qa:moderate", {
        id,
        action,
        answerText,
      }),
  };
};

/**
 * The native app at build 63, as its receiver is written in
 * `MeetingViewModel.swift`: `applyWebinarQaSnapshot`, `applyWebinarQaChanged`,
 * `upvoteWebinarQuestion` and `makeQaInputs`. It saves the questions it
 * upvoted apart from the list. A whole list replaces what it saved, its own
 * upvote's answer updates it, a change event leaves it alone, and what it
 * saved is shown over what an entry says.
 */
const build63 = async (
  stack: Stack,
  who: { email: string; name: string; session: string },
) => {
  const entries = new Map<string, WebinarQaEntry>();
  const savedVotes = new Map<string, true>();
  let snapshots = 0;
  const connection = await connect(stack, who, {
    ...asAttendee,
    prepare: (socket) => {
      socket.on("webinar:qaSnapshot", (snapshot: WebinarQaSnapshot) => {
        snapshots += 1;
        entries.clear();
        savedVotes.clear();
        for (const entry of snapshot.entries) {
          if (!entry.id) continue;
          entries.set(entry.id, entry);
          if (entry.hasUpvoted === true) savedVotes.set(entry.id, true);
        }
      });
      socket.on("webinar:qaChanged", (notification: WebinarQaChangedNotification) => {
        if (notification.removedId) {
          entries.delete(notification.removedId);
          return;
        }
        if (notification.entry?.id) entries.set(notification.entry.id, notification.entry);
      });
    },
  });
  return {
    ...connection,
    snapshots: () => snapshots,
    /** What the upvote button shows: the saved vote, else the entry's. */
    showsUpvoted: (id: string): boolean =>
      savedVotes.get(id) ?? entries.get(id)?.hasUpvoted ?? false,
    shownCount: (id: string): number | undefined => entries.get(id)?.upvotes,
    tapUpvote: async (id: string) => {
      const response = await ask<{ success?: boolean; upvotes?: number; hasUpvoted?: boolean; error?: string }>(
        connection.socket,
        "webinar:qa:upvote",
        { id },
      );
      if (response.error) return response;
      if (typeof response.hasUpvoted === "boolean") {
        if (response.hasUpvoted) savedVotes.set(id, true);
        else savedVotes.delete(id);
      }
      const entry = entries.get(id);
      if (typeof response.upvotes === "number" && entry) {
        entries.set(id, {
          ...entry,
          upvotes: response.upvotes,
          hasUpvoted: response.hasUpvoted ?? entry.hasUpvoted,
        });
      }
      return response;
    },
  };
};

describe("webinar Q&A with old and new clients in one room", () => {
  it("an old attendee asks into the book, and only the hosts and the asker see it", async () => {
    const stack = await startWebinar();
    const host = await open(stack, asha, qaContract);
    const oldHost = await oldClient(stack, { ...asha, session: "h2" });
    const oldAttendee = await oldClient(stack, vik, asAttendee);
    const otherOld = await oldClient(stack, wen, asAttendee);
    await until(() => oldAttendee.snapshots() > 0, "old attendee gets its first list");

    const asked = await oldAttendee.submit("  Is this   recorded? ");
    const id = asked.id ?? "";
    await until(() => row(host, "questions", id) !== null, "the host sees the question");
    await until(() => oldAttendee.entries.has(id), "the asker sees their own question");
    await until(() => oldHost.entries.has(id), "the old host sees it");
    await wait(120);

    expect(asked.success).toBe(true);
    expect(field(row(host, "questions", id), "text")).toBe("Is this recorded?");
    expect(oldAttendee.entries.get(id)).toMatchObject({
      question: "Is this recorded?",
      status: "pending",
      displayName: "Vik",
      userId: oldAttendee.seatId,
    });
    // A host is told who asked, by seat, so they can bring them on stage.
    expect(oldHost.entries.get(id)?.userId).toBe(oldAttendee.seatId);
    expect(otherOld.entries.has(id)).toBe(false);
    expect(otherOld.events).toEqual([]);
  });

  it("a new attendee's question reaches old clients once a host answers it, without the asker's seat", async () => {
    const stack = await startWebinar();
    const host = await open(stack, asha, qaContract);
    const oldHost = await oldClient(stack, { ...asha, session: "h2" });
    const newAttendee = await open(stack, omar, qaContract, asAttendee);
    const oldAttendee = await oldClient(stack, vik, asAttendee);
    await until(() => oldAttendee.snapshots() > 0, "old attendee gets its first list");

    const asked = await newAttendee.session.act("ask", { text: "Will slides be shared?" });
    const id = asked.ok ? asked.value.id : "";
    await until(() => oldHost.entries.has(id), "the old host sees the new attendee's question");
    const beforeAnswer = oldAttendee.entries.has(id);
    await host.session.act("moderate", { id, action: "answered", answerText: "Yes, after." });
    await until(() => oldAttendee.entries.has(id), "the old attendee sees the answer");

    expect(beforeAnswer).toBe(false);
    expect(oldHost.entries.get(id)?.userId).toBe(newAttendee.seatId);
    expect(oldAttendee.entries.get(id)).toMatchObject({
      status: "answered",
      answerText: "Yes, after.",
      answeredByName: "Asha",
      displayName: "Omar",
      userId: "",
    });
  });

  it("an old client's upvote toggle and a new client's upvote count in one tally", async () => {
    const stack = await startWebinar();
    const host = await open(stack, asha, qaContract);
    const newAttendee = await open(stack, omar, qaContract, asAttendee);
    const oldAttendee = await oldClient(stack, vik, asAttendee);
    const asked = await newAttendee.session.act("ask", { text: "Can we vote on this?" });
    const id = asked.ok ? asked.value.id : "";
    await host.session.act("moderate", { id, action: "answering" });
    await until(() => oldAttendee.entries.has(id), "the old attendee sees it");

    const on = await oldAttendee.upvote(id);
    await newAttendee.session.act("upvote", { id, value: true });
    await until(() => field(row(host, "votes", id), "upvotes") === 2, "both upvotes counted");
    await until(() => oldAttendee.entries.get(id)?.upvotes === 2, "the old attendee sees the tally");
    const off = await oldAttendee.upvote(id);
    await until(() => field(row(host, "votes", id), "upvotes") === 1, "the toggle took one back");
    // Its own socket is told on its own time, apart from the host's.
    await until(
      () => oldAttendee.entries.get(id)?.hasUpvoted === false,
      "the old attendee is told its upvote is off",
    );

    expect(on).toEqual({ success: true, upvotes: 1, hasUpvoted: true });
    expect(off).toEqual({ success: true, upvotes: 1, hasUpvoted: false });
    expect(oldAttendee.entries.get(id)?.upvotes).toBe(1);
  });

  it("answers an upvote with the count it made, even after a run of refused ones", async () => {
    const stack = await startWebinar();
    const host = await open(stack, asha, qaContract);
    const asker = await open(stack, omar, qaContract, asAttendee);
    const oldAttendee = await oldClient(stack, vik, asAttendee);
    const asked = await asker.session.act("ask", { text: "How many of us want this?" });
    const id = asked.ok ? asked.value.id : "";
    await host.session.act("moderate", { id, action: "answering" });
    // Fifteen other people upvote it.
    for (let index = 0; index < 15; index += 1) {
      const voter = await open(
        stack,
        { email: `voter${index}@example.com`, name: `Voter ${index}`, session: `voter${index}` },
        qaContract,
        asAttendee,
      );
      await voter.session.act("upvote", { id, value: true });
      voter.socket.disconnect();
    }
    await until(() => oldAttendee.entries.get(id)?.upvotes === 15, "the old attendee sees 15");

    // The same person has a second tab open, and taps upvote there on
    // questions that are gone. Then they tap this one, here, six times.
    const otherTab = await oldClient(stack, { ...vik, session: "v2" }, asAttendee);
    const refused: { error?: string }[] = [];
    for (let index = 0; index < 9; index += 1) {
      refused.push(await otherTab.upvote(`q-missing-${index}`));
    }
    const replies: Awaited<ReturnType<typeof oldAttendee.upvote>>[] = [];
    for (let index = 0; index < 6; index += 1) replies.push(await oldAttendee.upvote(id));
    const accepted = replies.filter((reply) => reply.success);
    const last = accepted[accepted.length - 1];
    await until(
      () => field(row(host, "votes", id), "upvotes") === last?.upvotes,
      "the host sees the count the last answer gave",
    );

    expect(refused.map((reply) => reply.error)).toEqual(Array(9).fill("Question not found"));
    // Every answer that says the upvote counted carries the count it made.
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    expect(accepted.map((reply) => [reply.upvotes, reply.hasUpvoted])).toEqual(
      accepted.map((_, index) => (index % 2 === 0 ? [16, true] : [15, false])),
    );
    // The rest are refused in so many words, never answered with a guess.
    expect(replies.filter((reply) => !reply.success).map((reply) => reply.error)).toEqual(
      Array(replies.length - accepted.length).fill("You are voting too quickly"),
    );
  });

  it("takes an upvote off a native build 63 screen when the same person removes it elsewhere", async () => {
    const stack = await startWebinar();
    const host = await open(stack, asha, qaContract);
    const asker = await open(stack, omar, qaContract, asAttendee);
    const native = await build63(stack, vik);
    // The same person, in a browser tab on the new transport.
    const browser = await open(stack, { ...vik, session: "v2" }, qaContract, asAttendee);
    const asked = await asker.session.act("ask", { text: "Upvoted on a phone, taken back in a tab" });
    const id = asked.ok ? asked.value.id : "";
    await host.session.act("moderate", { id, action: "answering" });
    await until(() => native.shownCount(id) === 0, "the phone lists the question");

    const tapped = await native.tapUpvote(id);
    const shownAfterTap = native.showsUpvoted(id);

    // The tab takes it back at once, without waiting to be told of it.
    await browser.session.act("upvote", { id, value: false });
    await until(() => !native.showsUpvoted(id), "the phone shows the upvote gone");
    const countAfterRemoval = native.shownCount(id);
    // The button is off, so the next tap puts the upvote back.
    const tappedAgain = await native.tapUpvote(id);
    await until(() => field(row(host, "votes", id), "upvotes") === 1, "the upvote counts again");

    expect(tapped).toEqual({ success: true, upvotes: 1, hasUpvoted: true });
    expect(shownAfterTap).toBe(true);
    expect(countAfterRemoval).toBe(0);
    expect(tappedAgain).toEqual({ success: true, upvotes: 1, hasUpvoted: true });
    expect(native.showsUpvoted(id)).toBe(true);
  });

  it("takes an upvote off a native build 63 screen when a second tap elsewhere lands in the same flush", async () => {
    const stack = await startWebinar();
    const host = await open(stack, asha, qaContract);
    const asker = await open(stack, omar, qaContract, asAttendee);
    const native = await build63(stack, vik);
    // The same person on a released web build in another tab.
    const otherTab = await oldClient(stack, { ...vik, session: "v2" }, asAttendee);
    const asked = await asker.session.act("ask", { text: "Tapped twice, on two screens" });
    const id = asked.ok ? asked.value.id : "";
    await host.session.act("moderate", { id, action: "answering" });
    await until(() => native.shownCount(id) === 0, "the phone lists the question");
    await until(() => otherTab.entries.has(id), "the other tab lists it");

    // Two taps, one on each, close enough to land in one flush. The vote
    // starts and ends absent, so no change to it is ever flushed.
    const [tapped, secondTap] = await Promise.all([native.tapUpvote(id), otherTab.upvote(id)]);
    await until(() => !native.showsUpvoted(id), "the phone shows the upvote gone");
    await until(() => field(row(host, "votes", id), "upvotes") === 0, "nobody upvotes it now");
    const tappedAgain = await native.tapUpvote(id);

    expect(tapped).toEqual({ success: true, upvotes: 1, hasUpvoted: true });
    expect(secondTap).toEqual({ success: true, upvotes: 0, hasUpvoted: false });
    expect(native.shownCount(id)).toBe(1);
    // The button was off, so the next tap put the upvote back.
    expect(tappedAgain).toEqual({ success: true, upvotes: 1, hasUpvoted: true });
    expect(native.showsUpvoted(id)).toBe(true);
  });

  it("takes an upvote off a native build 63 screen when the question was hidden as the vote was taken back, and is shown again", async () => {
    const stack = await startWebinar();
    const host = await open(stack, asha, qaContract);
    const asker = await open(stack, omar, qaContract, asAttendee);
    const native = await build63(stack, vik);
    // The same person on a released web build in another tab.
    const otherTab = await oldClient(stack, { ...vik, session: "v2" }, asAttendee);
    const asked = await asker.session.act("ask", { text: "Upvoted on a phone, taken back, hidden, shown" });
    const id = asked.ok ? asked.value.id : "";
    await host.session.act("moderate", { id, action: "answering" });
    await until(() => native.shownCount(id) === 0, "the phone lists the question");
    await until(() => otherTab.entries.has(id), "the other tab lists it");

    const tapped = await native.tapUpvote(id);
    // The tab takes the vote back as the host hides the question, so the
    // phone is told the question is gone before anything about the vote.
    const [takenBack, hidden] = await Promise.all([
      otherTab.upvote(id),
      host.session.act("moderate", { id, action: "dismissed" }),
    ]);
    await until(() => native.shownCount(id) === undefined, "the question leaves the phone");
    await wait(200);
    const restored = await host.session.act("moderate", { id, action: "answering" });
    await until(() => native.shownCount(id) === 0, "the question is back on the phone");
    await until(() => !native.showsUpvoted(id), "the phone shows the upvote gone");
    // The button is off, so the next tap puts the upvote back.
    const tappedAgain = await native.tapUpvote(id);
    await until(() => field(row(host, "votes", id), "upvotes") === 1, "the upvote counts again");

    expect(tapped).toEqual({ success: true, upvotes: 1, hasUpvoted: true });
    expect(takenBack).toEqual({ success: true, upvotes: 0, hasUpvoted: false });
    expect([hidden.ok, restored.ok]).toEqual([true, true]);
    expect(tappedAgain).toEqual({ success: true, upvotes: 1, hasUpvoted: true });
    expect(native.showsUpvoted(id)).toBe(true);
  });

  it("keeps an upvote on a native build 63 screen through a hide and a show, with no whole list", async () => {
    const stack = await startWebinar();
    const host = await open(stack, asha, qaContract);
    const asker = await open(stack, omar, qaContract, asAttendee);
    const native = await build63(stack, vik);
    const asked = await asker.session.act("ask", { text: "Upvoted, hidden, shown" });
    const id = asked.ok ? asked.value.id : "";
    await host.session.act("moderate", { id, action: "answering" });
    await until(() => native.shownCount(id) === 0, "the phone lists the question");
    await native.tapUpvote(id);
    await until(() => field(row(host, "votes", id), "upvotes") === 1, "the upvote counts");
    await wait(120);
    const snapshotsBefore = native.snapshots();

    await host.session.act("moderate", { id, action: "dismissed" });
    await until(() => native.shownCount(id) === undefined, "the question leaves the phone");
    await wait(120);
    await host.session.act("moderate", { id, action: "answering" });
    await until(() => native.shownCount(id) === 1, "the question is back with its upvote");
    await wait(120);
    // The button is on, so the next tap takes the upvote back.
    const tappedAgain = await native.tapUpvote(id);

    expect(native.snapshots()).toBe(snapshotsBefore);
    expect(tappedAgain).toEqual({ success: true, upvotes: 0, hasUpvoted: false });
    expect(native.showsUpvoted(id)).toBe(false);
  });

  it("takes a hidden question off its asker's native build 63 screen, and puts it back when the host unhides it", async () => {
    const stack = await startWebinar();
    const host = await open(stack, asha, qaContract);
    const native = await build63(stack, vik);
    await until(() => native.snapshots() > 0, "the phone gets its first list");
    const asked = await ask<{ success?: boolean; id?: string }>(native.socket, "webinar:qa:submit", {
      question: "Asked from a phone",
    });
    const id = asked.id ?? "";
    await until(() => native.shownCount(id) === 0, "the phone lists its own question");
    const snapshotsBefore = native.snapshots();

    await host.session.act("moderate", { id, action: "dismissed" });
    await until(() => native.shownCount(id) === undefined, "the question leaves the phone");
    const goneWithoutAList = native.snapshots() === snapshotsBefore;
    await host.session.act("moderate", { id, action: "reopen" });
    await until(() => native.shownCount(id) === 0, "the question is back on the phone");

    expect(asked.success).toBe(true);
    expect(goneWithoutAList).toBe(true);
    expect(field(row(host, "questions", id), "status")).toBe("pending");
  });

  it("leaves a native build 63 screen alone when its own tap takes the upvote back", async () => {
    const stack = await startWebinar();
    const host = await open(stack, asha, qaContract);
    const asker = await open(stack, omar, qaContract, asAttendee);
    const native = await build63(stack, vik);
    const asked = await asker.session.act("ask", { text: "On, then off, on the phone" });
    const id = asked.ok ? asked.value.id : "";
    await host.session.act("moderate", { id, action: "answering" });
    await until(() => native.shownCount(id) === 0, "the phone lists the question");
    const snapshotsBefore = native.snapshots();

    await native.tapUpvote(id);
    const off = await native.tapUpvote(id);
    await until(() => field(row(host, "votes", id), "upvotes") === 0, "the upvote is gone");
    await wait(120);

    expect(off).toEqual({ success: true, upvotes: 0, hasUpvoted: false });
    expect(native.showsUpvoted(id)).toBe(false);
    // Its own answer told it. No whole list was needed.
    expect(native.snapshots()).toBe(snapshotsBefore);
  });

  it("an old host moderates the same book, and a hidden question leaves old and new lists", async () => {
    const stack = await startWebinar();
    const host = await open(stack, asha, qaContract);
    const oldHost = await oldClient(stack, { ...asha, session: "h2" });
    const newAttendee = await open(stack, omar, qaContract, asAttendee);
    const oldAttendee = await oldClient(stack, vik, asAttendee);
    const asked = await oldAttendee.submit("Please take this one");
    const id = asked.id ?? "";
    await until(() => oldHost.entries.has(id), "the old host sees it");

    const answering = await oldHost.moderate(id, "answering");
    await until(() => row(newAttendee, "questions", id) !== null, "new attendee sees it live");
    const hidden = await oldHost.moderate(id, "dismissed");
    await until(() => row(newAttendee, "questions", id) === null, "it leaves the new list");
    const upvoteHidden = await oldClient(stack, wen, asAttendee).then((other) => other.upvote(id));
    const fromAttendee = await oldAttendee.moderate(id, "reopen");

    expect([answering, hidden]).toEqual([{ success: true }, { success: true }]);
    expect(field(row(host, "questions", id), "status")).toBe("dismissed");
    // The hosts keep it, to bring it back. Its asker loses it like everyone else.
    expect(oldHost.entries.get(id)?.status).toBe("dismissed");
    expect(oldAttendee.entries.has(id)).toBe(false);
    expect(oldAttendee.events.filter((event) => event === `removed:${id}`)).toEqual([`removed:${id}`]);
    expect(upvoteHidden).toEqual({ error: "Question not found" });
    expect(fromAttendee).toEqual({ error: "Only hosts can do this" });
  });

  it("keeps the old wire's limits and words", async () => {
    const stack = await startWebinar();
    await open(stack, asha, qaContract);
    const oldAttendee = await oldClient(stack, vik, asAttendee);
    const panelist = await oldClient(stack, omar);

    const short = await oldAttendee.submit("?");
    const first = await oldAttendee.submit("First question");
    const second = await oldAttendee.submit("Second question");
    const third = await oldAttendee.submit("Third question");
    const burst = await oldAttendee.submit("Fourth question");
    const fromPanel = await panelist.submit("From the panel");

    expect(short).toEqual({ error: "Ask a longer question" });
    expect([first.success, second.success]).toEqual([true, true]);
    // The socket's own budget is three in a burst, as before.
    expect([third, burst]).toContainEqual({ error: "You are sending questions too quickly" });
    expect(fromPanel).toEqual({ error: "Only webinar attendees can do this" });
  });

  it("lets a guest attendee ask over the old wire, as it always could", async () => {
    const stack = await startWebinar();
    const host = await open(stack, asha, qaContract);
    const guestAttendee = await oldClient(stack, guest, asAttendee);

    const asked = await guestAttendee.submit("Can guests ask?");
    await until(() => row(host, "questions", asked.id ?? "") !== null, "the host sees it");

    expect(asked.success).toBe(true);
    expect(field(row(host, "questions", asked.id ?? ""), "askerName")).toBe("Zed");
  });

  it("refuses questions while the host has Q&A off", async () => {
    const stack = await startWebinar();
    await open(stack, asha, qaContract);
    const oldAttendee = await oldClient(stack, vik, asAttendee);
    getOrCreateWebinarRoomConfig(stack.state.webinarConfigs, stack.room.channelId).qaEnabled = false;
    emitWebinarConfigChanged(stack.io, stack.state, stack.room);

    const asked = await oldAttendee.submit("Anyone there?");

    expect(asked).toEqual({ error: "Q&A is turned off for this webinar" });
  });

  it("sends a client that speaks the new transport nothing on the old events", async () => {
    const stack = await startWebinar();
    const host = await open(stack, asha, qaContract);
    const newAttendee = await open(stack, omar, qaContract, asAttendee);
    const legacyEvents: string[] = [];
    newAttendee.socket.onAny((event: string) => {
      if (event.startsWith("webinar:qa")) legacyEvents.push(event);
    });

    const asked = await newAttendee.session.act("ask", { text: "Only over the new wire?" });
    const id = asked.ok ? asked.value.id : "";
    await host.session.act("moderate", { id, action: "answered" });
    await until(() => row(newAttendee, "questions", id) !== null, "new attendee sees the answer");
    await wait(120);

    expect(legacyEvents).toEqual([]);
  });

  it("keeps the old feed for a client whose capability answer came too late to use", async () => {
    const stack = await startWebinar();
    const host = await open(stack, asha, qaContract);
    const attendee = await oldClient(stack, vik, asAttendee);
    await until(() => attendee.snapshots() > 0, "the attendee gets its first list");

    // A new client asks what the server offers, gives up waiting and falls
    // back to the old events. The answer still arrives, late, and is ignored.
    const late = await ask<{ ok: boolean }>(attendee.socket, AUTHORITY_EVENTS.capabilities, {
      protocols: [1],
    });
    const asked = await attendee.submit("Did the fallback survive?");
    const id = asked.id ?? "";
    await host.session.act("moderate", { id, action: "answered", answerText: "It did" });
    await until(
      () => attendee.entries.get(id)?.status === "answered",
      "the answer arrives on the old events",
    );

    expect(late.ok).toBe(true);
    expect(attendee.entries.get(id)?.answerText).toBe("It did");
  });

  it("keeps the old feed when a client's subscribe never takes", async () => {
    const stack = await startWebinar();
    const host = await open(stack, asha, qaContract);
    const attendee = await oldClient(stack, vik, asAttendee);
    await until(() => attendee.snapshots() > 0, "the attendee gets its first list");

    const capability = await ask<{
      ok: boolean;
      value?: { apps: { instance: string; app: string; major: number }[] };
    }>(attendee.socket, AUTHORITY_EVENTS.capabilities, { protocols: [1] });
    const qa = capability.value?.apps.find((entry) => entry.app === "qa");
    // The subscribe is refused: it names a room that has since been recreated.
    const refused = await ask<{ ok: boolean; code?: string }>(
      attendee.socket,
      AUTHORITY_EVENTS.subscribe,
      { roomEpoch: "an-older-epoch", instance: qa?.instance, app: "qa", major: qa?.major, subscription: "s1" },
    );
    const asked = await attendee.submit("Am I still being told?");
    const id = asked.id ?? "";
    await host.session.act("moderate", { id, action: "answered" });
    await until(
      () => attendee.entries.get(id)?.status === "answered",
      "the answer arrives on the old events",
    );

    expect(refused).toMatchObject({ ok: false, code: "stale-epoch" });
    expect(attendee.frames).toEqual([]);
  });

  it("rests the old feed while a client reads Q&A itself, and picks it up when that ends", async () => {
    const stack = await startWebinar();
    const host = await open(stack, asha, qaContract);
    const asker = await open(stack, omar, qaContract, asAttendee);
    const attendee = await oldClient(stack, vik, asAttendee);
    await until(() => attendee.snapshots() > 0, "the attendee gets its first list");
    const ask1 = await asker.session.act("ask", { text: "While it reads the new way" });
    const ask2 = await asker.session.act("ask", { text: "After it stopped" });
    const first = ask1.ok ? ask1.value.id : "";
    const second = ask2.ok ? ask2.value.id : "";

    // The same connection opens Q&A over the new transport.
    const client = new AuthorityClient({ socket: attendee.socket, ackTimeoutMs: 1_000 });
    const session = client.open(qaContract);
    client.joined();
    await until(() => session.getState().kind === "ready", "its own view is ready");
    const snapshotsBefore = attendee.snapshots();
    await host.session.act("moderate", { id: first, action: "answered" });
    await until(() => {
      const state = session.getState();
      return state.kind === "ready" && state.view.questions.has(first);
    }, "the answer arrives over the new transport");
    await wait(120);
    const oldEventsMeanwhile = [...attendee.events];
    const snapshotsMeanwhile = attendee.snapshots() - snapshotsBefore;

    // It closes that view. The old events are all it has again.
    client.dispose();
    await until(() => attendee.snapshots() > snapshotsBefore, "the old feed sends a fresh list");
    const caughtUp = attendee.entries.get(first)?.status;
    await host.session.act("moderate", { id: second, action: "answered" });
    await until(
      () => attendee.entries.get(second)?.status === "answered",
      "later answers arrive on the old events",
    );

    // Nothing was said twice while it read Q&A itself.
    expect(oldEventsMeanwhile).toEqual([]);
    expect(snapshotsMeanwhile).toBe(0);
    expect(caughtUp).toBe("answered");
  });

  it("says nothing on the old events in a regular meeting", async () => {
    const stack = await start([pollsAuthority, qaAuthority]);
    const host = await open(stack, asha, qaContract);
    const member = await open(stack, omar, qaContract);
    const oldMember = await oldClient(stack, vik);

    const asked = await member.session.act("ask", { text: "A meeting question" });
    const id = asked.ok ? asked.value.id : "";
    await until(() => row(host, "questions", id) !== null, "the host sees it");
    await wait(120);

    expect(oldMember.events).toEqual([]);
    expect(oldMember.snapshots()).toBe(0);
  });

  it("stops feeding a removed attendee", async () => {
    const stack = await startWebinar();
    const host = await open(stack, asha, qaContract);
    const oldAttendee = await oldClient(stack, vik, asAttendee);
    const asker = await open(stack, omar, qaContract, asAttendee);
    await until(() => oldAttendee.snapshots() > 0, "old attendee gets its first list");

    const gone = new Promise<void>((resolve) => oldAttendee.socket.once("disconnect", () => resolve()));
    await ask(host.socket, "kickUser", { userId: oldAttendee.seatId });
    await gone;
    const eventsAtRemoval = oldAttendee.events.length;
    const asked = await asker.session.act("ask", { text: "After the removal" });
    await host.session.act("moderate", { id: asked.ok ? asked.value.id : "", action: "answered" });
    await wait(150);

    expect(oldAttendee.events.length).toBe(eventsAtRemoval);
  });

  it("offers an old client nothing new: no authority frame ever reaches it", async () => {
    const stack = await startWebinar();
    const host = await open(stack, asha, qaContract);
    const oldAttendee = await oldClient(stack, vik, asAttendee);
    const authorityEvents: string[] = [];
    oldAttendee.socket.onAny((event: string) => {
      if (event.startsWith("apps:authority")) authorityEvents.push(event);
    });

    const asked = await oldAttendee.submit("Old wire only");
    await host.session.act("moderate", { id: asked.id ?? "", action: "answered" });
    await until(() => oldAttendee.entries.get(asked.id ?? "")?.status === "answered", "answer arrives");

    expect(authorityEvents).toEqual([]);
    expect(oldAttendee.frames).toEqual([]);
    expect(
      await ask<{ ok: boolean }>(oldAttendee.socket, AUTHORITY_EVENTS.capabilities, {
        protocols: [1],
      }).then((reply) => reply.ok),
    ).toBe(true);
  });
});


describe("a question at its reopen limit, on the old events", () => {
  const build63QaModerationCopy = (message: string): string => {
    const text = message.trim().toLowerCase();
    const any = (words: string[]) => words.some((word) => text.includes(word));
    if (text.includes("super admin")) return "cantRemove";
    if (any(["too many admin requests", "too many requests", "rate limit", "too quickly", "retry shortly"])) return "rateLimited";
    if (any(["not in a room", "room not found", "reconnect to use host controls", "reconnect before"])) return "reconnect";
    if (any(["not connected", "socket is not connected", "no internet", "network is unreachable", "offline"])) return "reconnect";
    return "Couldn\u2019t update the question.";
  };

  it("tells an old host the question cannot be reopened again, which build 63 shows as a question it could not update", async () => {
    const stack = await startWebinar();
    const host = await oldClient(stack, asha);
    const attendee = await oldClient(stack, vik, asAttendee);
    const asked = await attendee.submit("Reopen me as often as you like");
    const id = asked.id ?? "";
    await until(() => host.entries.has(id), "the host sees it");
    const reopened: (boolean | undefined)[] = [];
    for (let round = 0; round < 16; round += 1) {
      await host.moderate(id, "answered");
      reopened.push((await host.moderate(id, "reopen")).success);
    }
    await host.moderate(id, "answered");
    const refused = await host.moderate(id, "reopen");
    await wait(120);

    expect(reopened.every(Boolean)).toBe(true);
    expect(refused).toEqual({ error: REOPENED_TOO_OFTEN });
    expect(host.entries.get(id)?.status).toBe("answered");
    expect(build63QaModerationCopy(REOPENED_TOO_OFTEN)).toBe("Couldn\u2019t update the question.");
    expect(build63QaModerationCopy("Question not found")).toBe("Couldn\u2019t update the question.");
  });
});

describe("a webinar turned off and back on at once", () => {
  const roundTrip = async (stack: Stack) => {
    const host = await oldClient(stack, asha);
    const attendee = await oldClient(stack, vik, asAttendee);
    const asked = await attendee.submit("Pending through the round trip");
    await until(() => host.entries.has(asked.id ?? ""), "the host sees it");
    const listsBefore = host.snapshots();

    const [off, on] = await Promise.all([
      ask<{ success?: boolean }>(host.socket, "webinar:updateConfig", { enabled: false }),
      ask<{ success?: boolean }>(host.socket, "webinar:updateConfig", { enabled: true, publicAccess: true }),
    ]);
    await wait(300);

    expect([off.success, on.success]).toEqual([true, true]);
    expect(host.snapshots()).toBeGreaterThan(listsBefore);
    expect(host.entries.get(asked.id ?? "")?.status).toBe("pending");
  };

  it("sends an old-event host the list again when the room runs the Q&A app", async () => {
    await roundTrip(await startWebinar());
  });

  it("sends an old-event host the list again on a server without the runtime", async () => {
    const stack = await start(null);
    const webinar = getOrCreateWebinarRoomConfig(stack.state.webinarConfigs, stack.room.channelId);
    webinar.enabled = true;
    webinar.publicAccess = true;
    setCustomWebinarLinkSlug({
      webinarConfig: webinar,
      webinarLinks: stack.state.webinarLinks,
      room: stack.room,
      slug: SLUG,
    });
    await roundTrip(stack);
  });
});

describe("a webinar turned off with a question still waiting", () => {
  const TEXT = "Is the roadmap public yet?";
  const everyFrame = (socket: { onAny: (listener: (event: string, ...args: unknown[]) => void) => void }) => {
    const seen: string[] = [];
    socket.onAny((event, ...args) => seen.push(JSON.stringify([event, ...args])));
    return seen;
  };
  const turnOff = async (stack: Stack, withRuntime: boolean) => {
    const host = await oldClient(stack, asha);
    const panelist = await oldClient(stack, omar);
    const panelistFrames = everyFrame(panelist.socket);
    const newPanelist = withRuntime ? await open(stack, { ...omar, session: "o2" }, qaContract) : null;
    const newPanelistFrames = newPanelist ? everyFrame(newPanelist.socket) : [];
    const newHost = withRuntime ? await open(stack, { ...asha, session: "h2" }, qaContract) : null;
    const attendee = await oldClient(stack, vik, asAttendee);
    const asked = await attendee.submit(TEXT);
    const id = asked.id ?? "";
    await until(() => host.entries.has(id), "the host sees the question");
    await wait(150);
    const seenBeforeTheSwitch = [...panelistFrames, ...newPanelistFrames].filter((frame) => frame.includes(TEXT));

    const off = await ask<{ success?: boolean }>(host.socket, "webinar:updateConfig", { enabled: false });
    await wait(400);
    const seenAfterTheSwitch = [...panelistFrames, ...newPanelistFrames].filter((frame) => frame.includes(TEXT));
    return { host, newHost, newPanelist, id, off, seenBeforeTheSwitch, seenAfterTheSwitch };
  };

  it("keeps an attendee's waiting question from the panel when the room runs the Q&A app", async () => {
    const stack = await startWebinar();
    const { newHost, newPanelist, id, off, seenBeforeTheSwitch, seenAfterTheSwitch } = await turnOff(stack, true);
    const hostStillSees = field(row(newHost!, "questions", id), "text");
    await newHost!.session.act("moderate", { id, action: "answered", answerText: "Next week." });
    await until(() => row(newPanelist!, "questions", id) !== null, "the panel sees it once it is answered");

    expect(off.success).toBe(true);
    expect(seenBeforeTheSwitch).toEqual([]);
    expect(seenAfterTheSwitch).toEqual([]);
    expect(hostStillSees).toBe(TEXT);
    expect(field(row(newPanelist!, "questions", id), "status")).toBe("answered");
  });

  it("keeps an attendee's waiting question from the panel on a server without the runtime", async () => {
    const stack = await start(null);
    const webinar = getOrCreateWebinarRoomConfig(stack.state.webinarConfigs, stack.room.channelId);
    webinar.enabled = true;
    webinar.publicAccess = true;
    setCustomWebinarLinkSlug({
      webinarConfig: webinar,
      webinarLinks: stack.state.webinarLinks,
      room: stack.room,
      slug: SLUG,
    });
    const { off, seenBeforeTheSwitch, seenAfterTheSwitch } = await turnOff(stack, false);

    expect(off.success).toBe(true);
    expect(seenBeforeTheSwitch).toEqual([]);
    expect(seenAfterTheSwitch).toEqual([]);
  });
});

describe("webinar Q&A on a server without the runtime", () => {
  /** The room's webinar link, so attendees can come in by it. */
  const linkRoom = (stack: Stack) =>
    setCustomWebinarLinkSlug({
      webinarConfig: getOrCreateWebinarRoomConfig(stack.state.webinarConfigs, stack.room.channelId),
      webinarLinks: stack.state.webinarLinks,
      room: stack.room,
      slug: SLUG,
    });
  const startWebinarWithoutRuntime = async (): Promise<Stack> => {
    const stack = await start(null);
    const webinar = getOrCreateWebinarRoomConfig(stack.state.webinarConfigs, stack.room.channelId);
    webinar.enabled = true;
    webinar.publicAccess = true;
    linkRoom(stack);
    return stack;
  };

  it("sends a host the list when their meeting becomes a webinar, and every question after it", async () => {
    const stack = await start(null);
    const host = await oldClient(stack, asha);
    const listsInTheMeeting = host.snapshots();

    const turnedOn = await ask<{ success?: boolean; error?: string }>(host.socket, "webinar:updateConfig", {
      enabled: true,
      publicAccess: true,
    });
    await until(() => host.snapshots() > listsInTheMeeting, "the host is sent the list");
    linkRoom(stack);
    const attendee = await oldClient(stack, vik, asAttendee);
    const asked = await attendee.submit("Is this recorded?");
    await until(() => host.entries.has(asked.id ?? ""), "the host sees the question");

    expect(listsInTheMeeting).toBe(0);
    expect(turnedOn.success).toBe(true);
    expect(host.snapshots()).toBe(1);
    expect(host.entries.get(asked.id ?? "")?.question).toBe("Is this recorded?");
  });

  type Seen = { event: string; payload: Record<string, unknown> };
  const lastPayload = (seen: Seen[], event: string) => [...seen].reverse().find((entry) => entry.event === event)?.payload;
  const build63Promotion = (seen: Seen[], me: string) => {
    let isAdmin = false;
    let refreshes = 0;
    for (const { event, payload } of seen) {
      if (event === "hostAssigned") {
        if (!isAdmin) refreshes += 1;
        isAdmin = true;
      } else if (event === "adminUsersChanged") {
        const was = isAdmin;
        isAdmin = ((payload.hostUserIds as string[] | undefined) ?? []).includes(me);
        if (!was && isAdmin) refreshes += 1;
      } else if (event === "admin:roomStateChanged") {
        const snapshot = payload.snapshot as { hostUserId?: string | null; adminUserIds?: string[] };
        const hosts = snapshot.adminUserIds ?? [];
        isAdmin = hosts.length > 0 ? hosts.includes(me) : snapshot.hostUserId === me;
      }
    }
    return { isAdmin, refreshes };
  };
  const seedHostState = (stack: Stack, attendeeSeat: string) => {
    stack.room.recordChatMessage({ id: "m1", userId: "asha@example.com#h1", displayName: "Asha", content: "Welcome", timestamp: 1 });
    stack.room.addPendingClient("kit@example.com", "kit@example.com#k1", { id: "knocking", emit: () => true } as never, "Kit");
    stack.room.setLocked(true);
    stack.room.setWebinarHandRaised(attendeeSeat, true);
  };
  const roomStateFor = (socket: { emit: (event: string, reply: (answer: unknown) => void) => unknown }) =>
    Promise.race([
      new Promise<unknown>((resolve) => socket.emit("admin:getRoomState", resolve)),
      wait(1_000).then(() => null),
    ]);
  const HOST_EVENTS = [
    "hostAssigned",
    "pendingUsersSnapshot",
    "chatHistorySnapshot",
    "roomLockChanged",
    "admin:roomStateChanged",
    "webinar:handQueueChanged",
    "webinar:qaSnapshot",
  ];
  const hostPayloadsIn = (seen: Seen[]) =>
    Object.fromEntries(HOST_EVENTS.map((event) => [event, lastPayload(seen, event) ?? null]));
  const hostPayloadsFor = (
    stack: Stack,
    hostUserId: string,
    attendeeSeat: string,
    question: { id: string; text: string },
  ) => {
    const roomId = stack.room.id;
    return {
      hostAssigned: { roomId, hostUserId },
      pendingUsersSnapshot: {
        roomId,
        users: [
          {
            userId: "kit@example.com",
            participantUserId: "kit@example.com#k1",
            userKey: "kit@example.com",
            displayName: "Kit",
            socketId: "knocking",
          },
        ],
      },
      chatHistorySnapshot: {
        roomId,
        messages: [{ id: "m1", userId: "asha@example.com#h1", displayName: "Asha", content: "Welcome", timestamp: 1 }],
      },
      roomLockChanged: { roomId, locked: true },
      "admin:roomStateChanged": { roomId, snapshot: toRoomSnapshot(stack.room) },
      "webinar:handQueueChanged": {
        roomId,
        queue: [{ userId: attendeeSeat, displayName: "Vik", raisedAt: expect.any(Number) as number }],
      },
      "webinar:qaSnapshot": {
        roomId,
        entries: [
          {
            id: question.id,
            userId: attendeeSeat,
            displayName: "Vik",
            question: question.text,
            status: "pending",
            askedAt: expect.any(Number) as number,
            updatedAt: expect.any(Number) as number,
            upvotes: 0,
            hasUpvoted: false,
          },
        ],
      },
    };
  };
  const waysToBecomeHost: [string, (stack: Stack, host: { socket: { disconnect: () => void }; seatId: string }, panelistSeat: string) => Promise<string>][] = [
    ["promoted to co-host", async (_stack, host, panelistSeat) => {
      const promoted = await ask<{ success?: boolean; error?: string }>(host.socket as never, "promoteHost", { userId: panelistSeat });
      expect(promoted.success).toBe(true);
      return host.seatId;
    }],
    ["handed the host role", async (_stack, host, panelistSeat) => {
      const transferred = await ask<{ success?: boolean; error?: string }>(host.socket as never, "admin:transferHost", { userId: panelistSeat });
      expect(transferred.success).toBe(true);
      return panelistSeat;
    }],
    ["promoted when the last host disconnects", async (_stack, host, panelistSeat) => {
      host.socket.disconnect();
      return panelistSeat;
    }],
    ["promoted when the last host is removed from the room", async (stack, host, panelistSeat) => {
      expect(forceRemoveClientNow({ io: stack.io, state: stack.state, room: stack.room, userId: host.seatId })).toBe(true);
      return panelistSeat;
    }],
  ];

  it.each(waysToBecomeHost)(
    "sends a panelist %s everything a host needs, the questions only hosts see included",
    async (_way, becomeHost) => {
      const stack = await startWebinarWithoutRuntime();
      const host = await oldClient(stack, asha);
      const panelist = await oldClient(stack, omar);
      const attendee = await oldClient(stack, vik, asAttendee);
      const asked = await attendee.submit("Waiting for a host");
      await until(() => host.entries.has(asked.id ?? ""), "the host sees it");
      seedHostState(stack, attendee.seatId);
      const heldBefore = panelist.entries.has(asked.id ?? "");
      const seen: Seen[] = [];
      panelist.socket.onAny((event: string, payload: unknown) =>
        seen.push({ event, payload: (payload ?? {}) as Record<string, unknown> }),
      );

      const expectedHost = await becomeHost(stack, host, panelist.seatId);
      await until(() => seen.some((entry) => entry.event === "hostAssigned"), "the panelist is told they are a host");
      await wait(150);
      const roomState = lastPayload(seen, "admin:roomStateChanged")?.snapshot as { adminUserIds?: string[] } | undefined;

      expect(heldBefore).toBe(false);
      expect(panelist.entries.get(asked.id ?? "")?.status).toBe("pending");
      expect(hostPayloadsIn(seen)).toEqual(
        hostPayloadsFor(stack, expectedHost, attendee.seatId, { id: asked.id ?? "", text: "Waiting for a host" }),
      );
      expect(roomState?.adminUserIds).toContain(panelist.seatId);
      expect(build63Promotion(seen, panelist.seatId)).toEqual({ isAdmin: true, refreshes: 1 });
      expect(await roomStateFor(panelist.socket)).toEqual({ room: toRoomSnapshot(stack.room) });
    },
  );

  it("sends the owner arriving at a webinar everything a host needs, the questions only hosts see included", async () => {
    const stack = await startWebinarWithoutRuntime();
    const panelist = await oldClient(stack, omar);
    const attendee = await oldClient(stack, vik, asAttendee);
    const asked = await attendee.submit("Asked before the owner came");
    await wait(150);
    seedHostState(stack, attendee.seatId);
    const seen: Seen[] = [];

    const owner = await oldClient(stack, asha, {
      prepare: (socket) =>
        socket.onAny((event: string, payload: unknown) =>
          seen.push({ event, payload: (payload ?? {}) as Record<string, unknown> }),
        ),
    });
    await until(() => owner.entries.has(asked.id ?? ""), "the owner is sent the list");
    await wait(150);

    expect(panelist.entries.has(asked.id ?? "")).toBe(false);
    expect(owner.entries.get(asked.id ?? "")?.status).toBe("pending");
    expect(hostPayloadsIn(seen)).toEqual({
      ...hostPayloadsFor(stack, owner.seatId, attendee.seatId, { id: asked.id ?? "", text: "Asked before the owner came" }),
      "admin:roomStateChanged": null,
    });
    expect(await roomStateFor(owner.socket)).toEqual({ room: toRoomSnapshot(stack.room) });
  });

  it("sends a panelist the list as they join a webinar", async () => {
    const stack = await startWebinarWithoutRuntime();
    const host = await oldClient(stack, asha);
    const attendee = await oldClient(stack, vik, asAttendee);
    const shown = await attendee.submit("Shown to everyone");
    const waiting = await attendee.submit("Still waiting");
    await host.moderate(shown.id ?? "", "answering");
    await until(() => attendee.entries.get(shown.id ?? "")?.status === "answering", "it is shown");

    const panelist = await oldClient(stack, omar);
    await until(() => panelist.snapshots() > 0, "the panelist is sent the list");

    expect([...panelist.entries.keys()]).toEqual([shown.id]);
    expect(panelist.entries.has(waiting.id ?? "")).toBe(false);
  });
});

describe("webinar Q&A lists on a server without the runtime, in a large room", () => {
  it("sends a room that becomes a webinar again its lists a slice a turn", async () => {
    const state = createSfuState({
      roomRegistry: new LocalRoomRegistry({ instanceId: "lists", instanceUrl: "http://localhost", ttlMs: 45_000 }),
      appsAuthority: null,
    });
    const room = addRoom(state, "lists-room");
    const lists: string[] = [];
    const socketFor = (id: string) =>
      ({
        id,
        emit: (event: string) => {
          if (event === "webinar:qaSnapshot") lists.push(id);
        },
      }) as never;
    room.addClient(new Admin({ id: "host#1", socket: socketFor("host#1") }));
    for (let index = 0; index < 450; index += 1) {
      room.addClient(
        new Client({ id: `viewer-${index}#1`, socket: socketFor(`viewer-${index}`), mode: "webinar_attendee" }),
      );
    }
    const io = { to: () => ({ emit: () => {} }) } as never;
    const webinar = getOrCreateWebinarRoomConfig(state.webinarConfigs, room.channelId);

    webinar.enabled = true;
    emitWebinarConfigChanged(io, state, room);
    const inTheCall = lists.length;
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));

    expect(inTheCall).toBeLessThanOrEqual(WEBINAR_QA_LISTS_PER_TURN);
    expect(lists.length).toBe(451);
    expect(new Set(lists).size).toBe(451);
  });
});
