/**
 * The design's reference checks, run against the real runtime: Polls, Q&A, a
 * Quiz and the Wheel, with every rule the design claims. Each tab keeps only
 * what the server sent it (a snapshot, then patches), so every check that
 * reads a tab also shows the patch stream alone reproduces the server's view.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTHORITY_EVENTS,
  type AuthorityResult,
  type Json,
} from "@conclave/apps-sdk/authority";
import { Harness, person, type Sent, type Tab } from "./harness.js";
import { pollsContract } from "@conclave/apps-sdk/polls/core";
import { pollsAuthority } from "@conclave/apps-sdk/polls/server";
import { qaContract } from "@conclave/apps-sdk/qa/core";
import { qaAuthority } from "@conclave/apps-sdk/qa/server";
import { quizAuthority, quizContract } from "./fixtures/quiz.js";
import { wheelAuthority, wheelContract } from "./fixtures/wheel.js";

const at = (value: Json | null, ...path: (string | number)[]): Json | null => {
  let node: Json | null = value;
  for (const key of path) {
    if (node === null || typeof node !== "object") return null;
    node =
      (Array.isArray(node)
        ? (node as readonly Json[])[key as number]
        : (node as { readonly [key: string]: Json })[key as string]) ?? null;
  }
  return node;
};

const rejectedWith = (result: AuthorityResult<Json>, reason: string): boolean =>
  !result.ok && result.code === "rejected" && result.reason === reason;
const refused = (result: AuthorityResult<Json>, code: string): boolean =>
  !result.ok && result.code === code;
const receivers = (sent: Sent[]): Tab[] => [...new Set(sent.map((entry) => entry.tab))];
const bucketsSent = (sent: Sent[], tab: Tab): string[] => [
  ...new Set(
    sent
      .filter((entry) => entry.tab === tab && entry.frame.kind === "patch")
      .flatMap((entry) =>
        entry.frame.kind === "patch"
          ? [...entry.frame.put, ...entry.frame.remove].map((row) => row.bucket)
          : [],
      ),
  ),
];

const host = person("asha@example.com", "Asha", "host");
const priya = person("priya@example.com", "Priya");
const ravi = person("ravi@example.com", "Ravi");
const viewer = person("vik@example.com", "Vik", "attendee");

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("polls", () => {
  it("keeps every poll rule", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const priyaSecondTab = await room.open(priya, pollsContract);
    const raviTab = await room.open(ravi, pollsContract);

    expect(
      refused(await priyaTab.act("create", { question: "Q", options: ["a", "b"] }), "forbidden"),
      "a participant cannot create a poll",
    ).toBe(true);
    expect(
      rejectedWith(
        await hostTab.act("create", { question: "Q", options: ["Tea", " tea "] }),
        "invalid-options",
      ),
      "duplicate options are refused",
    ).toBe(true);

    const created = await hostTab.act("create", {
      question: "  Lunch?  ",
      options: ["Tea", "Coffee", ""],
      choiceMode: "single",
    });
    const pollId = created.ok ? (at(created.value, "pollId") as string) : "";
    await room.deliver();
    expect(
      at(raviTab.row("polls", pollId), "question"),
      "the host creates a poll and everyone receives it",
    ).toBe("Lunch?");
    expect(
      (at(raviTab.row("polls", pollId), "options") as Json[]).length,
      "blank options are dropped",
    ).toBe(2);

    expect(
      rejectedWith(await priyaTab.act("vote", { pollId, optionIds: ["o1", "o2"] }), "invalid-choice"),
      "two options in a single-choice poll are refused",
    ).toBe(true);
    expect(
      rejectedWith(await priyaTab.act("vote", { pollId, optionIds: ["o9"] }), "invalid-choice"),
      "an unknown option is refused",
    ).toBe(true);

    const operation = { issuedAtMs: Date.now(), nonce: "vote-attempt-1" };
    const voteAck = await priyaTab.actWith(operation, "vote", { pollId, optionIds: ["o1"] });
    const afterVote = await room.deliver();
    expect(voteAck.ok, "a vote is accepted").toBe(true);
    expect(
      receivers(afterVote).includes(raviTab),
      "a private vote sends nothing to other participants",
    ).toBe(false);
    expect(
      {
        receivers: receivers(afterVote).length,
        host: bucketsSent(afterVote, hostTab),
        voter: bucketsSent(afterVote, priyaTab),
        voterOtherTab: bucketsSent(afterVote, priyaSecondTab),
      },
      "a private vote reaches hosts as a tally and the voter as their own ballot, and nobody else",
    ).toEqual({
      receivers: 3,
      host: ["results"],
      voter: ["myVotes"],
      voterOtherTab: ["myVotes"],
    });
    expect(
      at(hostTab.row("results", pollId), "votes", "o1"),
      "the host sees the tally",
    ).toBe(1);
    expect(
      raviTab.row("results", pollId),
      "participants see no results until they are shared",
    ).toBeNull();
    expect(
      at(priyaSecondTab.row("myVotes", pollId), "optionIds"),
      "the voter's other tab learns of the vote (review: other tabs miss votes)",
    ).toEqual(["o1"]);
    expect(
      rejectedWith(await priyaSecondTab.act("vote", { pollId, optionIds: ["o2"] }), "already-voted"),
      "a second vote from another tab is refused (one vote per person)",
    ).toBe(true);
    const retried = await priyaTab.actWith(operation, "vote", { pollId, optionIds: ["o1"] });
    await room.deliver();
    expect(
      [retried.ok, at(hostTab.row("results", pollId), "voterCount")],
      "a retry of the same attempt returns the first answer and counts once",
    ).toEqual([true, 1]);

    // Promotion: the same seat, a new audience, a fresh view.
    room.room.promoteClientToAdmin(raviTab.seat.id);
    await room.deliver();
    expect(
      at(raviTab.row("results", pollId), "voterCount"),
      "a participant promoted to host gets the tallies at once (review: new hosts see wrong totals)",
    ).toBe(1);

    await hostTab.act("share", { pollId, shared: true });
    await room.deliver();
    expect(
      at(priyaSecondTab.row("results", pollId), "votes", "o1"),
      "shared results reach people who have not voted (review: shared results stay hidden)",
    ).toBe(1);

    await hostTab.act("end", { pollId });
    await room.deliver();
    const lateVoter = await room.open(person("omar@example.com", "Omar"), pollsContract);
    expect(
      rejectedWith(await lateVoter.act("vote", { pollId, optionIds: ["o2"] }), "ended"),
      "a vote after the poll ends is refused",
    ).toBe(true);

    expect(
      refused(await priyaTab.query("exportBallots", { pollId }), "forbidden"),
      "a participant cannot export",
    ).toBe(true);
    await room.deliver();
    const exported = await hostTab.query("exportBallots", { pollId });
    const ballots = exported.ok ? (at(exported.value, "ballots") as Json[]) : [];
    expect(
      [ballots.length, at(ballots[0] ?? null, "name")],
      "the host's export carries named ballots",
    ).toEqual([1, "Priya"]);
    expect((await room.deliver()).length, "an export sends nothing to anyone else").toBe(0);

    const late = await room.open(person("lata@example.com", "Lata"), pollsContract);
    expect(
      [
        at(late.row("polls", pollId), "status"),
        at(late.row("results", pollId), "voterCount"),
      ],
      "a late joiner gets the ended poll with its shared results",
    ).toEqual(["ended", 1]);

    const attendeeTab = await room.open(viewer, pollsContract);
    const attendeeSubscribe = await attendeeTab.raw<AuthorityResult<null>>(
      AUTHORITY_EVENTS.subscribe,
      {
        roomEpoch: room.authority.roomEpoch,
        instance: hostTab.client.entryFor(pollsContract)!.instance,
        app: "polls",
        major: 1,
        subscription: "attendee-attempt",
      },
    );
    expect(
      [
        attendeeTab.state.kind,
        attendeeTab.frames.length,
        refused(attendeeSubscribe, "forbidden"),
        refused(await attendeeTab.act("vote", { pollId, optionIds: ["o1"] }), "unsupported"),
      ],
      "a webinar attendee is sent no polls and cannot vote",
    ).toEqual(["unsupported", 0, true, true]);

    expect(await room.converged(), "every tab's patched copy matches the server").toBe(true);
  });
});

describe("Q&A", () => {
  it("keeps every meeting rule", async () => {
    const room = new Harness([qaAuthority]);
    const hostTab = await room.open(host, qaContract);
    const priyaTab = await room.open(priya, qaContract);
    const raviTab = await room.open(ravi, qaContract);

    const asked = await priyaTab.act("ask", { text: "  When do   we ship? " });
    const id = asked.ok ? (at(asked.value, "id") as string) : "";
    await room.deliver();
    expect(
      at(raviTab.row("questions", id), "text"),
      "a question is public to the meeting as soon as it is asked",
    ).toBe("When do we ship?");

    await raviTab.act("upvote", { id, value: true });
    await raviTab.act("upvote", { id, value: true });
    await raviTab.act("upvote", { id, value: true });
    await room.deliver();
    expect(
      [at(hostTab.row("votes", id), "upvotes"), raviTab.row("myUpvotes", id)],
      "an upvote counts once per person however often it is sent",
    ).toEqual([1, {}]);

    expect(
      refused(await raviTab.act("moderate", { id, action: "dismissed" }), "forbidden"),
      "a participant cannot moderate",
    ).toBe(true);
    await hostTab.act("moderate", { id, action: "dismissed" });
    await room.deliver();
    expect(
      raviTab.row("questions", id),
      "a dismissed question leaves everyone else's list",
    ).toBeNull();
    expect(
      [
        at(priyaTab.row("myQuestions", id), "hidden", "question", "status"),
        at(hostTab.row("questions", id), "status"),
      ],
      "the asker and the host still see it",
    ).toEqual(["dismissed", "dismissed"]);
    expect(
      rejectedWith(await raviTab.act("upvote", { id, value: true }), "not-found"),
      "a hidden question cannot be upvoted",
    ).toBe(true);

    for (const text of ["one more", "and another", "a third open one"]) {
      await vi.advanceTimersByTimeAsync(60_000);
      await priyaTab.act("ask", { text });
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      rejectedWith(await priyaTab.act("ask", { text: "too many" }), "too-many-open"),
      "a fourth open question from one person is refused",
    ).toBe(true);
    expect(await room.converged(), "every tab's patched copy matches the server").toBe(true);
  });

  it("keeps every webinar rule", async () => {
    const webinar = new Harness([qaAuthority]);
    const stageHost = await webinar.open(host, qaContract);
    webinar.setWebinar(true, true);
    const panelist = await webinar.open(priya, qaContract);
    const asker = await webinar.open(viewer, qaContract);
    const otherViewer = await webinar.open(person("wen@example.com", "Wen", "attendee"), qaContract);
    await webinar.deliver();

    expect(
      refused(await panelist.act("ask", { text: "from the panel" }), "forbidden"),
      "a panelist cannot ask in a webinar",
    ).toBe(true);
    const fromViewer = await asker.act("ask", { text: "Is this recorded?" });
    const qid = fromViewer.ok ? (at(fromViewer.value, "id") as string) : "";
    await webinar.deliver();
    expect(
      [
        at(stageHost.row("questions", qid), "status"),
        at(asker.row("myQuestions", qid), "hidden", "question", "status"),
        otherViewer.row("questions", qid),
        panelist.row("questions", qid),
      ],
      "a pending question reaches hosts and its asker only",
    ).toEqual(["pending", "pending", null, null]);

    await stageHost.act("moderate", { id: qid, action: "answered", answerText: "Yes." });
    await webinar.deliver();
    expect(
      [
        at(otherViewer.row("questions", qid), "answerText"),
        at(otherViewer.row("questions", qid), "answeredByName"),
      ],
      "answering a question publishes it with the answer",
    ).toEqual(["Yes.", "Asha"]);

    webinar.setWebinar(true, false);
    await webinar.deliver();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      refused(await asker.act("ask", { text: "still there?" }), "forbidden"),
      "asking is refused once the host turns Q&A off",
    ).toBe(true);

    await stageHost.act("moderate", { id: qid, action: "reopen" });
    await webinar.deliver();
    expect(
      otherViewer.row("questions", qid),
      "a reopened question is private again in a webinar",
    ).toBeNull();

    webinar.setWebinar(false);
    await webinar.deliver();
    expect(
      at(panelist.row("questions", qid), "status"),
      "turning webinar mode off republishes pending questions to everyone",
    ).toBe("pending");
    expect(await webinar.converged(), "every tab's patched copy matches the server").toBe(true);
  });
});

describe("quiz", () => {
  it("runs timed rounds with hidden answers", async () => {
    const room = new Harness([quizAuthority]);
    const hostTab = await room.open(host, quizContract);
    const priyaTab = await room.open(priya, quizContract);
    const raviTab = await room.open(ravi, quizContract);

    await hostTab.act("load", {
      secondsPerQuestion: 20,
      questions: [
        { prompt: "2 + 2", choices: ["3", "4"], answer: 1 },
        { prompt: "Capital of France", choices: ["Paris", "Rome"], answer: 0 },
      ],
    });
    await hostTab.act("begin");
    await room.deliver();
    const startedAt = Date.now();
    expect(
      [
        at(priyaTab.row("quiz", "state"), "question", "prompt"),
        at(priyaTab.row("quiz", "state"), "question", "correct"),
      ],
      "the question is shown without its answer",
    ).toEqual(["2 + 2", null]);
    expect(
      [
        hostTab.held().includes('"answer"'),
        at(hostTab.row("quiz", "state"), "question", "correct"),
      ],
      "the host's view carries no answer either",
    ).toEqual([false, null]);

    await room.advance(2_000);
    await priyaTab.act("answer", { choice: 1 });
    expect(
      rejectedWith(await priyaTab.act("answer", { choice: 0 }), "already-answered"),
      "a second answer is refused",
    ).toBe(true);
    await room.deliver();
    expect(
      [
        at(priyaTab.row("myAnswer", "0"), "choice"),
        hostTab.row("myAnswer", "0"),
        at(hostTab.row("quiz", "state"), "answered"),
      ],
      "an answer is private to the person who gave it",
    ).toEqual([1, null, 1]);

    await room.advance(startedAt + 20_000 - Date.now() - 1);
    const justBefore = at(priyaTab.row("quiz", "state"), "phase");
    await room.advance(1);
    expect(
      [justBefore, at(priyaTab.row("quiz", "state"), "phase")],
      "the server wakes itself exactly at the deadline",
    ).toEqual(["question", "reveal"]);
    expect(
      [
        at(priyaTab.row("quiz", "state"), "question", "correct"),
        (at(priyaTab.row("myScore", "score"), "score") as number) > 500,
      ],
      "at the deadline the server reveals the answer and scores it",
    ).toEqual([1, true]);
    expect(
      rejectedWith(await raviTab.act("answer", { choice: 1 }), "not-open"),
      "an answer after time is refused",
    ).toBe(true);

    await room.advance(5_000);
    expect(
      [
        at(priyaTab.row("quiz", "state"), "phase"),
        at(priyaTab.row("quiz", "state"), "index"),
        priyaTab.row("myAnswer", "1"),
      ],
      "the next round starts on its own",
    ).toEqual(["question", 1, null]);

    await hostTab.act("answer", { choice: 0 });
    await priyaTab.act("answer", { choice: 0 });
    await raviTab.act("answer", { choice: 1 });
    await hostTab.act("endRound");
    await room.advance(0);
    expect(
      at(priyaTab.row("quiz", "state"), "phase"),
      "the host can end a round early by bringing its timer forward",
    ).toBe("reveal");

    await room.advance(5_000);
    expect(
      [
        at(priyaTab.row("quiz", "state"), "phase"),
        at(priyaTab.row("quiz", "state"), "leaderboard", 0, "name"),
      ],
      "the quiz ends on results with a leaderboard",
    ).toEqual(["results", "Priya"]);
    expect(await room.converged(), "every tab's patched copy matches the server").toBe(true);
  });
});

describe("wheel", () => {
  it("lets the server pick and record the winner", async () => {
    const room = new Harness([wheelAuthority]);
    const hostTab = await room.open(host, wheelContract);
    const priyaTab = await room.open(priya, wheelContract);

    await priyaTab.act("addEntries", { labels: ["Asha", "Priya", "Ravi"] });
    expect(
      (await priyaTab.act("spin", { winnerIndex: 1 })).ok,
      "a spin is accepted and any winner the client sends is ignored",
    ).toBe(true);
    await room.deliver();
    const winnerIndex = at(priyaTab.row("wheel", "wheel"), "spin", "winnerIndex") as number;
    expect(
      Number.isInteger(winnerIndex) && winnerIndex >= 0 && winnerIndex < 3,
      "the server picks the winner",
    ).toBe(true);
    expect(
      rejectedWith(await hostTab.act("spin", {}), "spinning"),
      "a second spin while spinning is refused",
    ).toBe(true);

    // The spinner leaves mid-spin. Nothing depends on their client.
    room.room.removeClient(priyaTab.seat.id);
    await room.advance(10_000);
    expect(
      [hostTab.rows("history").length, at(hostTab.row("wheel", "wheel"), "spin", "settled")],
      "the server records the result once, without the spinner",
    ).toEqual([1, true]);
    expect(await room.converged(), "every tab's patched copy matches the server").toBe(true);
  });
});
