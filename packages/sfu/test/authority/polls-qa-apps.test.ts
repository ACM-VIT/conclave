/**
 * Every rule PR #260 enforced for polls and meeting Q&A, now enforced by the
 * two apps on the authority runtime, and one test for each of the five
 * findings its review raised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTHORITY_EVENTS,
  type AuthorityResult,
  type Json,
} from "@conclave/apps-sdk/authority";
import { pollsContract } from "@conclave/apps-sdk/polls/core";
import { pollsAuthority } from "@conclave/apps-sdk/polls/server";
import { qaContract } from "@conclave/apps-sdk/qa/core";
import { qaAuthority } from "@conclave/apps-sdk/qa/server";
import { Harness, person, type Tab } from "./harness.js";

const host = person("asha@example.com", "Asha", "host");
const priya = person("priya@example.com", "Priya");
const ravi = person("ravi@example.com", "Ravi");
const viewer = person("vik@example.com", "Vik", "attendee");

const field = (value: Json | null, ...path: string[]): Json | null => {
  let node: Json | null = value;
  for (const key of path) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return null;
    node = (node as { readonly [key: string]: Json })[key] ?? null;
  }
  return node;
};

const rejected = (reason: string) => ({ ok: false, code: "rejected", reason });

const createPoll = async (
  room: Harness,
  tab: Tab,
  draft: Record<string, unknown> = {},
): Promise<string> => {
  const created = await tab.act("create", {
    question: "Lunch?",
    options: ["Tea", "Coffee", "Water"],
    ...draft,
  });
  if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created)}`);
  await room.deliver();
  return field(created.value, "pollId") as string;
};

const ask = async (room: Harness, tab: Tab, text: string): Promise<string> => {
  // Asking is limited to one question every ten seconds after a short burst.
  await vi.advanceTimersByTimeAsync(31_000);
  const asked = await tab.act("ask", { text });
  if (!asked.ok) throw new Error(`ask failed: ${JSON.stringify(asked)}`);
  await room.deliver();
  return field(asked.value, "id") as string;
};

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("poll drafts", () => {
  it("accepts 2 to 10 distinct options and trims them", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);

    const pollId = await createPoll(room, hostTab, {
      question: `  Where   to?  ${"x".repeat(400)}`,
      options: ["  Tea  ", "Coffee", "", "   ", `${"y".repeat(200)}`],
      choiceMode: "multiple",
    });
    const poll = hostTab.row("polls", pollId);
    const tooFew = await hostTab.act("create", { question: "Q", options: ["Only one", ""] });
    const tooMany = await hostTab.act("create", {
      question: "Q",
      options: Array.from({ length: 11 }, (_, index) => `Option ${index}`),
    });
    const repeated = await hostTab.act("create", { question: "Q", options: ["Tea", "tea"] });

    expect((field(poll, "question") as string).length).toBe(300);
    expect((field(poll, "question") as string).startsWith("Where to? x")).toBe(true);
    expect(field(poll, "choiceMode")).toBe("multiple");
    expect(field(poll, "options")).toEqual([
      { id: "o1", text: "Tea" },
      { id: "o2", text: "Coffee" },
      { id: "o3", text: "y".repeat(120) },
    ]);
    expect([tooFew, tooMany, repeated]).toEqual([
      rejected("invalid-options"),
      rejected("invalid-options"),
      rejected("invalid-options"),
    ]);
  });

  it("rejects a blank question", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);

    const blank = await hostTab.act("create", { question: "   ", options: ["a", "b"] });

    expect(blank).toEqual(rejected("invalid-question"));
  });

  it("caps how many polls a room can hold", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    for (let index = 0; index < 50; index += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await createPoll(room, hostTab, { question: `Poll ${index}` });
    }
    await vi.advanceTimersByTimeAsync(1_000);

    const overflow = await hostTab.act("create", { question: "One more", options: ["a", "b"] });

    expect(overflow).toEqual(rejected("too-many-polls"));
    expect(hostTab.rows("polls").length).toBe(50);
  });

  it("only lets hosts create, end, share and export polls", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const pollId = await createPoll(room, hostTab);

    const results = [
      await priyaTab.act("create", { question: "Q", options: ["a", "b"] }),
      await priyaTab.act("end", { pollId }),
      await priyaTab.act("share", { pollId, shared: true }),
      await priyaTab.query("exportBallots", { pollId }),
    ];
    await room.deliver();

    expect(results).toEqual(Array.from({ length: 4 }, () => ({ ok: false, code: "forbidden" })));
    expect(field(hostTab.row("polls", pollId), "status")).toBe("open");
    expect(field(hostTab.row("polls", pollId), "resultsShared")).toBe(false);
  });
});

describe("voting rules", () => {
  it("counts one ballot per voter and rejects a second one", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const pollId = await createPoll(room, hostTab);

    const first = await priyaTab.act("vote", { pollId, optionIds: ["o1"] });
    const second = await priyaTab.act("vote", { pollId, optionIds: ["o2"] });
    await room.deliver();

    expect(first).toEqual({ ok: true, value: null });
    expect(second).toEqual(rejected("already-voted"));
    expect(hostTab.row("results", pollId)).toEqual({ voterCount: 1, votes: { o1: 1 } });
  });

  it("rejects ballots after the poll ends, and ending twice changes nothing", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const pollId = await createPoll(room, hostTab);

    await hostTab.act("end", { pollId });
    await room.deliver();
    const endedAt = field(hostTab.row("polls", pollId), "endedAt");
    await vi.advanceTimersByTimeAsync(5_000);
    const again = await hostTab.act("end", { pollId });
    const late = await priyaTab.act("vote", { pollId, optionIds: ["o1"] });
    await room.deliver();

    expect(again.ok).toBe(true);
    expect(late).toEqual(rejected("ended"));
    expect(field(hostTab.row("polls", pollId), "status")).toBe("ended");
    expect(field(hostTab.row("polls", pollId), "endedAt")).toBe(endedAt);
    expect(field(hostTab.row("results", pollId), "voterCount")).toBe(0);
  });

  it("lets a multiple choice ballot pick several options, in the poll's order", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const pollId = await createPoll(room, hostTab, { choiceMode: "multiple" });

    const vote = await priyaTab.act("vote", { pollId, optionIds: ["o3", "o1"] });
    await room.deliver();

    expect(vote.ok).toBe(true);
    expect(priyaTab.row("myVotes", pollId)).toEqual({ optionIds: ["o1", "o3"] });
    expect(hostTab.row("results", pollId)).toEqual({ voterCount: 1, votes: { o1: 1, o3: 1 } });
  });

  it("rejects a choice that is empty, repeated, unknown or too many", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const pollId = await createPoll(room, hostTab);

    const attempts = [
      await priyaTab.act("vote", { pollId, optionIds: [] }),
      await priyaTab.act("vote", { pollId, optionIds: ["o1", "o1"] }),
      await priyaTab.act("vote", { pollId, optionIds: ["o9"] }),
      await priyaTab.act("vote", { pollId, optionIds: ["o1", "o2"] }),
    ];
    const malformed = await priyaTab.act("vote", { pollId, optionIds: "o1" });
    await room.deliver();

    expect(attempts).toEqual(Array.from({ length: 4 }, () => rejected("invalid-choice")));
    expect(malformed).toEqual({ ok: false, code: "invalid-input" });
    expect(field(hostTab.row("results", pollId), "voterCount")).toBe(0);
  });

  it("rejects ballots for a poll that does not exist", async () => {
    const room = new Harness([pollsAuthority]);
    await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);

    const vote = await priyaTab.act("vote", { pollId: "missing", optionIds: ["o1"] });

    expect(vote).toEqual(rejected("not-found"));
  });
});

describe("result visibility", () => {
  it("hides tallies from participants until the host shares them, and again when unshared", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const raviTab = await room.open(ravi, pollsContract);
    const pollId = await createPoll(room, hostTab);
    await priyaTab.act("vote", { pollId, optionIds: ["o2"] });
    await room.deliver();
    const whilePrivate = [priyaTab.row("results", pollId), raviTab.row("results", pollId)];

    await hostTab.act("share", { pollId, shared: true });
    await room.deliver();
    const whileShared = raviTab.row("results", pollId);
    await hostTab.act("share", { pollId, shared: false });
    await room.deliver();

    expect(whilePrivate).toEqual([null, null]);
    expect(hostTab.row("results", pollId)).toEqual({ voterCount: 1, votes: { o2: 1 } });
    expect(whileShared).toEqual({ voterCount: 1, votes: { o2: 1 } });
    expect(raviTab.row("results", pollId)).toBeNull();
    expect(JSON.stringify(raviTab.frames.filter((frame) => frame.kind === "replace"))).not.toContain(
      "voterCount",
    );
  });

  it("gives a late joiner the current poll and their own earlier ballot", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const before = await room.open(priya, pollsContract, { session: "first" });
    const pollId = await createPoll(room, hostTab);
    await before.act("vote", { pollId, optionIds: ["o3"] });
    room.room.removeClient(before.seat.id);

    // The same person comes back under a new session.
    const after = await room.open(priya, pollsContract, { session: "second" });
    await room.deliver();
    const again = await after.act("vote", { pollId, optionIds: ["o1"] });

    expect(field(after.row("polls", pollId), "question")).toBe("Lunch?");
    expect(after.row("myVotes", pollId)).toEqual({ optionIds: ["o3"] });
    expect(again).toEqual(rejected("already-voted"));
  });

  it("exports every ballot with the voter's name, oldest first", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const raviTab = await room.open(ravi, pollsContract);
    const pollId = await createPoll(room, hostTab, { choiceMode: "multiple" });
    await raviTab.act("vote", { pollId, optionIds: ["o2"] });
    await vi.advanceTimersByTimeAsync(2_000);
    await priyaTab.act("vote", { pollId, optionIds: ["o1", "o2"] });

    const exported = await hostTab.query("exportBallots", { pollId });

    const ballots = exported.ok ? (field(exported.value, "ballots") as Json[]) : [];
    expect(ballots.map((ballot) => [field(ballot, "name"), field(ballot, "optionIds")])).toEqual([
      ["Ravi", ["o2"]],
      ["Priya", ["o1", "o2"]],
    ]);
    expect(exported.ok && field(exported.value, "results")).toEqual({
      voterCount: 2,
      votes: { o1: 1, o2: 2 },
    });
  });

  it("leaves webinar attendees out", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const pollId = await createPoll(room, hostTab);
    const attendee = await room.open(viewer, pollsContract);

    const subscribe = await attendee.raw<AuthorityResult<null>>(AUTHORITY_EVENTS.subscribe, {
      roomEpoch: room.authority.roomEpoch,
      instance: hostTab.client.entryFor(pollsContract)!.instance,
      app: "polls",
      major: 1,
      subscription: "attendee",
    });
    await hostTab.act("share", { pollId, shared: true });
    await room.deliver();

    expect(attendee.state.kind).toBe("unsupported");
    expect(subscribe).toEqual({ ok: false, code: "forbidden" });
    expect(attendee.frames).toEqual([]);
  });
});

describe("Q&A in a regular meeting", () => {
  it("shows a participant's question to everyone right away", async () => {
    const room = new Harness([qaAuthority]);
    const hostTab = await room.open(host, qaContract);
    const priyaTab = await room.open(priya, qaContract);
    const raviTab = await room.open(ravi, qaContract);

    const id = await ask(room, priyaTab, "  When do   we ship? ");

    for (const tab of [hostTab, priyaTab, raviTab]) {
      expect(field(tab.row("questions", id), "text")).toBe("When do we ship?");
      expect(field(tab.row("questions", id), "askerName")).toBe("Priya");
    }
    expect(priyaTab.row("myQuestions", id)).toEqual({ hidden: null });
    expect(raviTab.row("myQuestions", id)).toBeNull();
  });

  it("counts upvotes from other participants, one each, and takes them back", async () => {
    const room = new Harness([qaAuthority]);
    const hostTab = await room.open(host, qaContract);
    const priyaTab = await room.open(priya, qaContract);
    const raviTab = await room.open(ravi, qaContract);
    const raviSecondTab = await room.open(ravi, qaContract);
    const id = await ask(room, priyaTab, "Can we get the slides?");

    await raviTab.act("upvote", { id, value: true });
    await raviSecondTab.act("upvote", { id, value: true });
    await hostTab.act("upvote", { id, value: true });
    await room.deliver();
    const counted = field(priyaTab.row("votes", id), "upvotes");
    await raviSecondTab.act("upvote", { id, value: false });
    await room.deliver();

    expect(counted).toBe(2);
    expect(field(priyaTab.row("votes", id), "upvotes")).toBe(1);
    expect(raviTab.row("myUpvotes", id)).toBeNull();
    expect(hostTab.row("myUpvotes", id)).toEqual({});
  });

  it("lets only hosts mark questions answered or hide them", async () => {
    const room = new Harness([qaAuthority]);
    const hostTab = await room.open(host, qaContract);
    const priyaTab = await room.open(priya, qaContract);
    const raviTab = await room.open(ravi, qaContract);
    const id = await ask(room, priyaTab, "Is this recorded?");

    const denied = await raviTab.act("moderate", { id, action: "answered" });
    await hostTab.act("moderate", { id, action: "answered", answerText: "  Yes,   shared after. " });
    await room.deliver();
    const answered = raviTab.row("questions", id);
    await hostTab.act("moderate", { id, action: "dismissed" });
    await room.deliver();

    expect(denied).toEqual({ ok: false, code: "forbidden" });
    expect(field(answered, "status")).toBe("answered");
    expect(field(answered, "answerText")).toBe("Yes, shared after.");
    expect(field(answered, "answeredByName")).toBe("Asha");
    expect(raviTab.row("questions", id)).toBeNull();
    expect(raviTab.row("votes", id)).toBeNull();
    expect(field(hostTab.row("questions", id), "status")).toBe("dismissed");
    expect(field(priyaTab.row("myQuestions", id), "hidden", "question", "status")).toBe("dismissed");
    expect(await raviTab.act("upvote", { id, value: true })).toEqual(rejected("not-found"));
    expect(await raviTab.act("upvote", { id: "missing", value: true })).toEqual(rejected("not-found"));
  });

  it("asks for at least two characters and keeps at most 500", async () => {
    const room = new Harness([qaAuthority]);
    await room.open(host, qaContract);
    const priyaTab = await room.open(priya, qaContract);

    const short = await priyaTab.act("ask", { text: " ? " });
    const id = await ask(room, priyaTab, "z".repeat(600));

    expect(short).toEqual(rejected("too-short"));
    expect((field(priyaTab.row("questions", id), "text") as string).length).toBe(500);
  });

  it("allows three open questions per person, and a fourth once one is closed", async () => {
    const room = new Harness([qaAuthority]);
    const hostTab = await room.open(host, qaContract);
    const priyaTab = await room.open(priya, qaContract);
    const first = await ask(room, priyaTab, "First question");
    await ask(room, priyaTab, "Second question");
    await ask(room, priyaTab, "Third question");
    await vi.advanceTimersByTimeAsync(31_000);

    const fourth = await priyaTab.act("ask", { text: "Fourth question" });
    await hostTab.act("moderate", { id: first, action: "dismissed" });
    await vi.advanceTimersByTimeAsync(31_000);
    const afterDismiss = await priyaTab.act("ask", { text: "Fourth question" });

    expect(fourth).toEqual(rejected("too-many-open"));
    expect(afterDismiss.ok).toBe(true);
  });

  // Asks 300 real questions through the wire, so it is given more time.
  it("drops hidden questions first when the book passes 300, then answered ones", async () => {
    const room = new Harness([qaAuthority]);
    const hostTab = await room.open(host, qaContract);
    const watcher = await room.open(ravi, qaContract);
    const askers: Tab[] = [];
    for (let index = 0; index < 25; index += 1) {
      askers.push(await room.open(person(`asker${index}@example.com`, `Asker ${index}`), qaContract));
    }
    // Four rounds of 75: each asker asks three, then the host closes them.
    const ids: string[] = [];
    for (let round = 0; round < 4; round += 1) {
      const asked: string[] = [];
      for (const asker of askers) {
        for (let n = 0; n < 3; n += 1) {
          await vi.advanceTimersByTimeAsync(31_000);
          const result = await asker.act("ask", { text: `Question ${ids.length + asked.length}` });
          if (result.ok) asked.push(field(result.value, "id") as string);
        }
      }
      for (const id of asked) {
        await vi.advanceTimersByTimeAsync(500);
        await hostTab.act("moderate", { id, action: "answered" });
      }
      ids.push(...asked);
    }
    expect(ids.length).toBe(300);
    await hostTab.act("moderate", { id: ids[150], action: "dismissed" });
    await watcher.act("upvote", { id: ids[0], value: true });
    await room.deliver();

    // Over the cap: the hidden one goes first, then the oldest answered one.
    const overCap = await ask(room, askers[0], "Question 300");
    const afterFirst = [hostTab.row("questions", ids[150]), hostTab.row("questions", ids[0])];
    await ask(room, askers[0], "Question 301");

    expect(afterFirst[0]).toBeNull();
    expect(afterFirst[1]).not.toBeNull();
    expect(hostTab.row("questions", ids[0])).toBeNull();
    expect(watcher.row("questions", ids[0])).toBeNull();
    expect(watcher.row("myUpvotes", ids[0])).toBeNull();
    expect(hostTab.rows("questions").length).toBe(300);
    expect(field(hostTab.row("questions", overCap), "status")).toBe("pending");
  }, 60_000);
});

describe("a Q&A book of the longest questions", () => {
  // Three bytes a character on the wire, at the most the contract allows.
  const longQuestion = "問".repeat(500);
  const longAnswer = "答".repeat(1_000);

  // Asks 225 real questions through the wire, so it is given more time.
  it("stays small enough for a host who joins late to open", async () => {
    const room = new Harness([qaAuthority]);
    const hostTab = await room.open(host, qaContract);
    const askers: Tab[] = [];
    for (let index = 0; index < 25; index += 1) {
      askers.push(
        await room.open(
          person(`asker${index}@example.com`, `${"名".repeat(190)} ${index}`),
          qaContract,
        ),
      );
    }
    // Three rounds of 75: each asker asks three, then the host answers them.
    let newest = "";
    for (let round = 0; round < 3; round += 1) {
      const asked: string[] = [];
      for (const asker of askers) {
        for (let n = 0; n < 3; n += 1) {
          await vi.advanceTimersByTimeAsync(31_000);
          const result = await asker.act("ask", { text: longQuestion });
          if (result.ok) asked.push(field(result.value, "id") as string);
        }
      }
      for (const id of asked) {
        await vi.advanceTimersByTimeAsync(500);
        await hostTab.act("moderate", { id, action: "answered", answerText: longAnswer });
        newest = id;
      }
    }
    await room.deliver();

    const lateHost = await room.open(person("omar@example.com", "Omar", "host"), qaContract);
    // A view this size arrives in parts, on later turns of the event loop.
    await room.drain();
    const sent = lateHost.frames
      .filter((frame) => frame.kind === "replace")
      .reduce((bytes, frame) => bytes + Buffer.byteLength(JSON.stringify(frame)), 0);

    expect(lateHost.state.kind).toBe("ready");
    expect(sent).toBeLessThan(1024 * 1024);
    // The book gave up its oldest answered questions, not the latest ones.
    expect(field(lateHost.row("questions", newest), "answerText")).toBe(longAnswer);
    expect(lateHost.rows("questions").length).toBeLessThan(225);
  }, 60_000);

  it("keeps the question a host is answering when the answer is what fills the book", async () => {
    const room = new Harness([qaAuthority]);
    const hostTab = await room.open(host, qaContract);
    const askers: Tab[] = [];
    for (let index = 0; index < 25; index += 1) {
      askers.push(
        await room.open(person(`asker${index}@example.com`, `Asker ${index}`), qaContract),
      );
    }
    // Four rounds of 75 long questions fill the book to its size cap.
    for (let round = 0; round < 4; round += 1) {
      const asked: string[] = [];
      for (const asker of askers) {
        for (let n = 0; n < 3; n += 1) {
          await vi.advanceTimersByTimeAsync(31_000);
          const result = await asker.act("ask", { text: longQuestion });
          if (result.ok) asked.push(field(result.value, "id") as string);
        }
      }
      // Answered without text, so the askers may go on asking.
      for (const id of asked) {
        await vi.advanceTimersByTimeAsync(500);
        await hostTab.act("moderate", { id, action: "answered" });
      }
    }
    await room.deliver();
    const before = hostTab.rows("questions");
    const oldest = [...before].sort(
      (a, b) => (field(a, "askedAt") as number) - (field(b, "askedAt") as number),
    )[0];
    const oldestId = field(oldest, "id") as string;

    // The oldest answered question is the first the book would give up, and
    // its long answer is what takes the book over its cap.
    await vi.advanceTimersByTimeAsync(500);
    const answered = await hostTab.act("moderate", {
      id: oldestId,
      action: "answered",
      answerText: longAnswer,
    });
    await room.deliver();

    expect(before.length).toBeLessThan(300);
    expect(answered).toEqual({ ok: true, value: null });
    expect(field(hostTab.row("questions", oldestId), "answerText")).toBe(longAnswer);
    expect(hostTab.rows("questions").length).toBeLessThan(before.length);
  }, 60_000);
});

describe("switching webinar mode", () => {
  it("rebuilds every list under the new rule, and keeps the same book", async () => {
    const room = new Harness([qaAuthority]);
    const hostTab = await room.open(host, qaContract);
    const priyaTab = await room.open(priya, qaContract);
    const raviTab = await room.open(ravi, qaContract);
    const pending = await ask(room, priyaTab, "Still waiting on this one");
    const answered = await ask(room, priyaTab, "Already answered this one");
    await hostTab.act("moderate", { id: answered, action: "answered" });
    await room.deliver();
    const framesBefore = raviTab.frames.length;

    room.setWebinar(true, true);
    await room.deliver();
    const inWebinar = [raviTab.row("questions", pending), raviTab.row("questions", answered)];
    room.setWebinar(false);
    await room.deliver();

    expect(inWebinar[0]).toBeNull();
    expect(inWebinar[1]).not.toBeNull();
    expect(field(priyaTab.row("myQuestions", pending), "hidden")).toBeNull();
    expect(raviTab.row("questions", pending)).not.toBeNull();
    expect(field(hostTab.row("questions", pending), "status")).toBe("pending");
    // Two mode changes, two fresh views, and nothing in between.
    expect(raviTab.frames.slice(framesBefore).map((frame) => frame.kind)).toEqual([
      "replace",
      "replace",
    ]);
  });
});

describe("Q&A in a webinar", () => {
  it("keeps unanswered questions between the asker and the hosts", async () => {
    const room = new Harness([qaAuthority]);
    const hostTab = await room.open(host, qaContract);
    room.setWebinar(true, true);
    const panelist = await room.open(priya, qaContract);
    const asker = await room.open(viewer, qaContract);
    const other = await room.open(person("wen@example.com", "Wen", "attendee"), qaContract);
    await room.deliver();

    const id = await ask(room, asker, "Is this recorded?");
    const fromPanel = await panelist.act("ask", { text: "From the panel" });
    const hiddenUpvote = await other.act("upvote", { id, value: true });

    expect(field(hostTab.row("questions", id), "status")).toBe("pending");
    expect(field(asker.row("myQuestions", id), "hidden", "question", "text")).toBe("Is this recorded?");
    expect([other.row("questions", id), panelist.row("questions", id)]).toEqual([null, null]);
    expect(fromPanel).toEqual({ ok: false, code: "forbidden" });
    expect(hiddenUpvote).toEqual(rejected("not-found"));
    expect(JSON.stringify(other.frames)).not.toContain("Is this recorded?");
  });

  it("refuses questions while the host has Q&A off", async () => {
    const room = new Harness([qaAuthority]);
    await room.open(host, qaContract);
    room.setWebinar(true, false);
    const asker = await room.open(viewer, qaContract);
    await room.deliver();

    const asked = await asker.act("ask", { text: "Anyone there?" });
    const state = asker.state;

    expect(asked).toEqual({ ok: false, code: "forbidden" });
    expect(state.kind === "ready" && state.actions.has("ask")).toBe(false);
  });
});

describe("the five findings from PR #260's review", () => {
  it("removed users lose access: a removed host cannot see, export or moderate", async () => {
    const room = new Harness([pollsAuthority, qaAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const cohostPolls = await room.open(ravi, pollsContract, { session: "polls" });
    room.room.promoteClientToAdmin(cohostPolls.seat.id);
    const priyaTab = await room.open(priya, pollsContract);
    const pollId = await createPoll(room, hostTab);
    const framesAtRemoval = cohostPolls.frames.length;

    // The seat is removed. Its socket is still open and still asking.
    room.room.removeClient(cohostPolls.seat.id);
    await room.deliver();
    await priyaTab.act("vote", { pollId, optionIds: ["o1"] });
    await room.deliver();
    const exported = await cohostPolls.raw<AuthorityResult<Json>>(AUTHORITY_EVENTS.query, {
      roomEpoch: room.authority.roomEpoch,
      subscription: cohostPolls.frames[0].subscription,
      generation: 2,
      request: "export",
      query: "exportBallots",
      input: { pollId },
    });
    const ended = await cohostPolls.actWith(
      { issuedAtMs: Date.now(), nonce: "op-removed-host" },
      "end",
      { pollId },
    );

    expect(cohostPolls.frames.slice(framesAtRemoval).map((frame) => frame.kind)).toEqual(["revoke"]);
    expect(cohostPolls.rows("results")).toEqual([]);
    expect([exported, ended]).toEqual([
      { ok: false, code: "not-in-room" },
      { ok: false, code: "not-in-room" },
    ]);
    expect(field(hostTab.row("polls", pollId), "status")).toBe("open");
  });

  it("shared results reach a participant who has not voted in an open poll", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const raviTab = await room.open(ravi, pollsContract);
    const pollId = await createPoll(room, hostTab);
    await priyaTab.act("vote", { pollId, optionIds: ["o1"] });

    await hostTab.act("share", { pollId, shared: true });
    await room.deliver();

    expect(field(raviTab.row("polls", pollId), "status")).toBe("open");
    expect(raviTab.row("myVotes", pollId)).toBeNull();
    expect(raviTab.row("results", pollId)).toEqual({ voterCount: 1, votes: { o1: 1 } });
  });

  it("a participant promoted to host sees the right totals at once, even for an ended poll", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const raviTab = await room.open(ravi, pollsContract);
    const pollId = await createPoll(room, hostTab);
    await priyaTab.act("vote", { pollId, optionIds: ["o2"] });
    await hostTab.act("end", { pollId });
    await room.deliver();
    expect(raviTab.row("results", pollId)).toBeNull();

    // Nothing else happens in the room after the promotion.
    room.room.promoteClientToAdmin(raviTab.seat.id);
    await room.deliver();

    const state = raviTab.state;
    expect(raviTab.row("results", pollId)).toEqual({ voterCount: 1, votes: { o2: 1 } });
    expect(state.kind === "ready" && state.queries.has("exportBallots")).toBe(true);
  });

  it("a vote in one tab reaches the voter's other tabs", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const tabOne = await room.open(priya, pollsContract);
    const tabTwo = await room.open(priya, pollsContract);
    const pollId = await createPoll(room, hostTab);

    await tabOne.act("vote", { pollId, optionIds: ["o3"] });
    await room.deliver();

    expect(tabTwo.row("myVotes", pollId)).toEqual({ optionIds: ["o3"] });
    expect(await tabTwo.act("vote", { pollId, optionIds: ["o1"] })).toEqual(rejected("already-voted"));
  });

  it("an older server offers neither app, whatever legacy events it sends", async () => {
    // An SFU without the runtime registers no authority handler at all.
    const room = new Harness([pollsAuthority, qaAuthority], { runtime: null });
    const hostPolls = await room.open(host, pollsContract);
    const hostQa = hostPolls.client.open(qaContract);

    // A legacy webinar snapshot arrives. It says nothing about the apps.
    hostPolls.seat.socket.emit("webinar:qaSnapshot", { roomId: "room", entries: [] });
    await vi.advanceTimersByTimeAsync(6_000);

    expect(hostPolls.client.capabilities).toEqual({ kind: "unsupported" });
    expect(hostPolls.state).toEqual({ kind: "unsupported" });
    expect(hostQa.getState()).toEqual({ kind: "unsupported" });
    expect(hostPolls.client.entryFor(pollsContract)).toBeNull();
    expect(hostPolls.client.entryFor(qaContract)).toBeNull();
  });
});
