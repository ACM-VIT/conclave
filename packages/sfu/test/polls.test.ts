import { describe, expect, it } from "vitest";
import { PollBook, parsePollDraft, type PollDraft } from "../server/polls.js";

const HOST = { isModerator: true };
const GUEST = { isModerator: false };

const draft = (overrides: Partial<PollDraft> = {}): PollDraft => ({
  question: "Where should we eat?",
  options: ["Tacos", "Ramen", "Pizza"],
  choiceMode: "single",
  ...overrides,
});

const openPoll = (book: PollBook, overrides: Partial<PollDraft> = {}) => {
  const created = book.create(draft(overrides), "Hana", 1_000);
  if (!created.ok) throw new Error("poll was not created");
  return created.pollId;
};

const tallies = (book: PollBook, pollId: string) =>
  book.view(pollId, HOST)?.options.map((option) => option.votes);

describe("poll drafts", () => {
  it("accepts 2 to 10 distinct options and trims them", () => {
    const parsed = parsePollDraft({
      question: "  Lunch?  ",
      options: [" Yes ", "No", ""],
      choiceMode: "multiple",
    });
    expect(parsed).toEqual({
      ok: true,
      draft: { question: "Lunch?", options: ["Yes", "No"], choiceMode: "multiple" },
    });
  });

  it.each([
    { label: "one option", options: ["Only"] },
    { label: "eleven options", options: Array.from({ length: 11 }, (_, i) => `O${i}`) },
    { label: "duplicate options", options: ["Yes", "yes"] },
    { label: "options that are not a list", options: "Yes,No" },
  ])("rejects $label", ({ options }) => {
    expect(parsePollDraft({ question: "Q?", options })).toEqual({
      ok: false,
      reason: "invalid-options",
    });
  });

  it("rejects a blank question", () => {
    expect(parsePollDraft({ question: "   ", options: ["A", "B"] })).toEqual({
      ok: false,
      reason: "invalid-question",
    });
  });
});

describe("voting rules", () => {
  it("counts one ballot per voter and rejects a second one", () => {
    const book = new PollBook();
    const pollId = openPoll(book);

    expect(book.vote(pollId, "ana@x.com", "Ana", ["o1"])).toEqual({ ok: true });
    expect(book.vote(pollId, "ana@x.com", "Ana", ["o2"])).toEqual({
      ok: false,
      reason: "already-voted",
    });
    expect(tallies(book, pollId)).toEqual([1, 0, 0]);
    expect(book.view(pollId, HOST)?.voterCount).toBe(1);
  });

  it("rejects ballots after the poll ends", () => {
    const book = new PollBook();
    const pollId = openPoll(book);
    book.vote(pollId, "ana@x.com", "Ana", ["o1"]);

    expect(book.end(pollId, 2_000)).toBe("ended");
    expect(book.vote(pollId, "ben@x.com", "Ben", ["o2"])).toEqual({
      ok: false,
      reason: "ended",
    });
    expect(tallies(book, pollId)).toEqual([1, 0, 0]);
    expect(book.view(pollId, HOST)).toMatchObject({ status: "ended", endedAt: 2_000 });
  });

  it.each([
    { label: "two answers on a single choice poll", choice: ["o1", "o2"] },
    { label: "no answer", choice: [] },
    { label: "an option that is not on the poll", choice: ["o9"] },
    { label: "the same option twice", choice: ["o1", "o1"] },
    { label: "a non-list payload", choice: "o1" },
  ])("rejects $label", ({ choice }) => {
    const book = new PollBook();
    const pollId = openPoll(book);
    expect(book.vote(pollId, "ana@x.com", "Ana", choice)).toEqual({
      ok: false,
      reason: "invalid-choice",
    });
    expect(book.view(pollId, HOST)?.voterCount).toBe(0);
  });

  it("lets a multiple choice ballot pick several options", () => {
    const book = new PollBook();
    const pollId = openPoll(book, { choiceMode: "multiple" });
    book.vote(pollId, "ana@x.com", "Ana", ["o3", "o1"]);
    book.vote(pollId, "ben@x.com", "Ben", ["o1"]);

    expect(tallies(book, pollId)).toEqual([2, 0, 1]);
    expect(book.view(pollId, HOST)?.voterCount).toBe(2);
  });

  it("rejects ballots for a poll that does not exist", () => {
    expect(new PollBook().vote("p404", "ana@x.com", "Ana", ["o1"])).toEqual({
      ok: false,
      reason: "not-found",
    });
  });
});

describe("result visibility", () => {
  it("hides tallies from participants until the host shares them", () => {
    const book = new PollBook();
    const pollId = openPoll(book);
    book.vote(pollId, "ana@x.com", "Ana", ["o2"]);

    const hidden = book.view(pollId, GUEST);
    expect(hidden?.voterCount).toBeUndefined();
    expect(hidden?.options.every((option) => option.votes === undefined)).toBe(true);

    expect(book.setResultsShared(pollId, true)).toBe("changed");
    expect(book.view(pollId, GUEST)?.options.map((option) => option.votes)).toEqual([
      0, 1, 0,
    ]);

    expect(book.setResultsShared(pollId, false)).toBe("changed");
    expect(book.view(pollId, GUEST)?.voterCount).toBeUndefined();
  });

  it("gives a late joiner the current poll and their own earlier ballot", () => {
    const book = new PollBook();
    const pollId = openPoll(book);
    book.vote(pollId, "ana@x.com", "Ana", ["o3"]);
    book.end(pollId, 5_000);
    book.setResultsShared(pollId, true);

    const [returning] = book.snapshot({ isModerator: false, voterKey: "ana@x.com" });
    expect(returning).toMatchObject({
      id: pollId,
      status: "ended",
      resultsShared: true,
      myVote: ["o3"],
      voterCount: 1,
    });

    const [newcomer] = book.snapshot({ isModerator: false, voterKey: "cy@x.com" });
    expect(newcomer.myVote).toEqual([]);
  });

  it("exports every ballot with the voter's name", () => {
    const book = new PollBook();
    const pollId = openPoll(book, { choiceMode: "multiple" });
    book.vote(pollId, "ben@x.com", "Ben", ["o2", "o1"], 3_000);
    book.vote(pollId, "ana@x.com", "Ana", ["o3"], 2_000);

    expect(book.exportBallots(pollId)).toEqual([
      { name: "Ana", optionIds: ["o3"], votedAt: 2_000 },
      { name: "Ben", optionIds: ["o1", "o2"], votedAt: 3_000 },
    ]);
  });

  it("caps how many polls a room can hold", () => {
    const book = new PollBook();
    for (let index = 0; index < 50; index += 1) openPoll(book);
    expect(book.create(draft(), "Hana")).toEqual({ ok: false, reason: "too-many-polls" });
  });
});
