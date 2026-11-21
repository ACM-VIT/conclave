import { describe, expect, it } from "vitest";
import { buildPollCsv, pollResults, upsertPoll } from "../src/app/lib/polls";
import type { PollView } from "../src/app/lib/types";

const poll = (overrides: Partial<PollView> = {}): PollView => ({
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
  createdByName: "Hana",
  ...overrides,
});

describe("poll results", () => {
  it("stays hidden while the server sends no tallies", () => {
    expect(pollResults(poll())).toBeNull();
  });

  it("gives each option its share of voters", () => {
    const rows = pollResults(
      poll({
        voterCount: 3,
        options: [
          { id: "o1", text: "Tacos", votes: 2 },
          { id: "o2", text: "Ramen", votes: 1 },
        ],
      }),
    );
    expect(rows?.map((row) => [row.text, row.votes, row.percent])).toEqual([
      ["Tacos", 2, 67],
      ["Ramen", 1, 33],
    ]);
  });

  it("keeps the viewer's own ballot when a broadcast leaves it out", () => {
    const mine = poll({ myVote: ["o2"] });
    const [updated] = upsertPoll([mine], poll({ status: "ended" }));
    expect(updated).toMatchObject({ status: "ended", myVote: ["o2"] });
  });
});

describe("poll CSV export", () => {
  it("lists tallies and every ballot", () => {
    const csv = buildPollCsv({
      poll: poll({ status: "ended", choiceMode: "multiple" }),
      ballots: [
        { name: "Ana", optionIds: ["o1", "o2"], votedAt: Date.UTC(2026, 10, 22, 9) },
        { name: "Ben", optionIds: ["o2"], votedAt: Date.UTC(2026, 10, 22, 10) },
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
      ballots: [{ name: "=HYPERLINK(1)", optionIds: ["o1"], votedAt: 0 }],
    });
    expect(csv).toContain('Question,"Pick ""one"", please"');
    expect(csv).toContain("'=HYPERLINK(1),Tacos,");
  });
});
