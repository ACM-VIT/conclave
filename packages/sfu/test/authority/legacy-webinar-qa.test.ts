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
import { emitWebinarConfigChanged } from "../../server/webinarNotifications.js";
import type {
  WebinarQaChangedNotification,
  WebinarQaEntry,
  WebinarQaSnapshot,
} from "../../types.js";
import {
  HOST,
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

