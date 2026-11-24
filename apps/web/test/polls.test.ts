import { describe, expect, it } from "vitest";
import {
  buildPollCsv,
  pollCsvFilename,
  pollResultRows,
  type PollCard,
} from "@conclave/apps-sdk/polls/core";

const poll = (overrides: Partial<PollCard> = {}): PollCard => ({
  id: "p1",
  question: "Lunch?",
  choiceMode: "single",
  status: "open",
  resultsShared: false,
  options: [
    { id: "o1", text: "Tacos" },
    { id: "o2", text: "Ramen" },
  ],
  createdAt: 1,
  endedAt: null,
  createdByName: "Hana",
  ...overrides,
});

describe("poll results", () => {
  it("gives each option its share of voters", () => {
    expect(pollResultRows(poll(), { voterCount: 4, votes: { o1: 3, o2: 1 } })).toEqual([
      { id: "o1", text: "Tacos", votes: 3, percent: 75 },
      { id: "o2", text: "Ramen", votes: 1, percent: 25 },
    ]);
  });

  it("shows an option nobody chose as zero, and an empty poll as all zeros", () => {
    expect(pollResultRows(poll(), { voterCount: 2, votes: { o2: 2 } })).toEqual([
      { id: "o1", text: "Tacos", votes: 0, percent: 0 },
      { id: "o2", text: "Ramen", votes: 2, percent: 100 },
    ]);
    expect(
      pollResultRows(poll(), { voterCount: 0, votes: {} }).map((row) => row.percent),
    ).toEqual([0, 0]);
  });
});

describe("poll CSV export", () => {
  it("lists ballots in the order they were cast, even when a merge stored one after later ones", () => {
    const sameMoment = Date.UTC(2026, 10, 22, 10);
    const csv = buildPollCsv({
      poll: poll(),
      results: { voterCount: 3, votes: { o1: 2, o2: 1 } },
      ballots: [
        { name: "Ben", optionIds: ["o2"], votedAt: sameMoment, order: 7 },
        { name: "Cy", optionIds: ["o1"], votedAt: sameMoment, order: 5 },
        { name: "Gita", optionIds: ["o1"], votedAt: Date.UTC(2026, 10, 22, 9), order: 2 },
      ],
    });

    expect(csv.split("\r\n").slice(-4, -1).map((line) => line.split(",")[0])).toEqual(["Gita", "Cy", "Ben"]);
  });

  it("lists tallies and every ballot", () => {
    const csv = buildPollCsv({
      poll: poll({ status: "ended", choiceMode: "multiple" }),
      results: { voterCount: 2, votes: { o1: 1, o2: 2 } },
      ballots: [
        { name: "Ana", optionIds: ["o1", "o2"], votedAt: Date.UTC(2026, 10, 22, 9), order: 1 },
        { name: "Ben", optionIds: ["o2"], votedAt: Date.UTC(2026, 10, 22, 10), order: 2 },
      ],
    });
    expect(csv.split("\r\n")).toEqual([
      "Question,Lunch?",
      "Type,Multiple choice",
      "Status,Ended",
      "Voters,2",
      "",
      "Option,Votes,Percent",
      "Tacos,1,50%",
      "Ramen,2,100%",
      "",
      "Name,Answer,Voted at",
      "Ana,Tacos; Ramen,2026-11-22T09:00:00.000Z",
      "Ben,Ramen,2026-11-22T10:00:00.000Z",
      "",
    ]);
  });

  it("quotes commas and quotes and defuses formulas", () => {
    const csv = buildPollCsv({
      poll: poll({ question: 'Pick "one", please' }),
      results: { voterCount: 1, votes: { o1: 1 } },
      ballots: [{ name: "=HYPERLINK(1)", optionIds: ["o1"], votedAt: 0, order: 1 }],
    });
    expect(csv).toContain('Question,"Pick ""one"", please"');
    expect(csv).toContain("'=HYPERLINK(1),Tacos,");
  });

  it("names the file after the question", () => {
    expect(pollCsvFilename(poll({ question: "  Ship on Friday?! " }))).toBe(
      "poll-ship-on-friday.csv",
    );
    expect(pollCsvFilename(poll({ question: "???" }))).toBe("poll-p1.csv");
  });
});
