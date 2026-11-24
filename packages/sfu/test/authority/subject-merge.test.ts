import { describe, expect, it } from "vitest";
import type { Json } from "@conclave/apps-sdk/authority";
import type { AuthorityModule } from "@conclave/apps-sdk/authority/server";
import { ledgerAuthority } from "./fixtures/ledger.js";
import { pollsAuthority } from "./fixtures/polls.js";
import { qaAuthority } from "./fixtures/qa.js";
import { quizAuthority } from "./fixtures/quiz.js";
import { mergeAgainstOnePerson, mergeCost, type MergeStep } from "./merge-check.js";

const kept = (receipts: ReadonlyMap<string, Json>, name: string, field: string) =>
  (receipts.get(name) as Record<string, Json> | undefined)?.[field] ?? null;

const pollOf = (name: string): MergeStep => ({
  by: "host",
  action: "create",
  input: () => ({ question: `Poll ${name}?`, options: ["Tea", "Coffee"] }),
  keep: name,
});
const voteIn = (by: "into" | "from", poll: string, option: string): MergeStep => ({
  by,
  action: "vote",
  input: (receipts: ReadonlyMap<string, Json>) => ({ pollId: kept(receipts, poll, "pollId"), optionIds: [option] }),
});
const ask = (by: "into" | "from", name: string): MergeStep => ({
  by,
  action: "ask",
  input: () => ({ text: `Question ${name}` }),
  keep: name,
});
const upvote = (by: "into" | "from", question: string): MergeStep => ({
  by,
  action: "upvote",
  input: (receipts: ReadonlyMap<string, Json>) => ({ id: kept(receipts, question, "id"), value: true }),
});
const answer = (by: "into" | "from", choice: number): MergeStep => ({
  by,
  action: "answer",
  input: () => ({ choice }),
});
const quizStart: MergeStep[] = [
  {
    by: "host",
    action: "load",
    input: () => ({
      secondsPerQuestion: 120,
      questions: [
        { prompt: "One?", choices: ["a", "b"], answer: 0 },
        { prompt: "Two?", choices: ["a", "b"], answer: 1 },
      ],
    }),
  },
  { by: "host", action: "begin" },
];
const endRound: MergeStep[] = [{ by: "host", action: "endRound" }, { wait: 1 }];
const nextRound: MergeStep = { wait: 6_000 };
const moderate = (question: string, action: "answered" | "reopen"): MergeStep => ({
  by: "host",
  action: "moderate",
  input: (receipts: ReadonlyMap<string, Json>) => ({ id: kept(receipts, question, "id"), action }),
});
const secret = (by: "into" | "from", id: string, text: string): MergeStep => ({
  by,
  action: "secret",
  input: () => ({ id, text }),
});

const activityFields = new Map<AuthorityModule, string[]>([[qaAuthority, ["updatedAt"]]]);

const scripts: Array<[string, AuthorityModule, MergeStep[]]> = [
  ["polls: a ballot each in different polls", pollsAuthority, [pollOf("p1"), pollOf("p2"), voteIn("into", "p1", "o1"), voteIn("from", "p2", "o2")]],
  ["polls: two ballots in one poll, the kept identity first", pollsAuthority, [pollOf("p"), voteIn("into", "p", "o1"), voteIn("from", "p", "o2")]],
  ["polls: two ballots in one poll, the merged identity first", pollsAuthority, [pollOf("p"), voteIn("from", "p", "o2"), voteIn("into", "p", "o1")]],
  ["qa: both upvote one question", qaAuthority, [ask("from", "q"), upvote("into", "q"), upvote("from", "q")]],
  ["qa: each upvotes another question", qaAuthority, [ask("into", "q1"), ask("from", "q2"), upvote("into", "q2"), upvote("from", "q1")]],
  ["qa: more open questions than one person may have", qaAuthority, [ask("into", "q1"), ask("from", "q2"), ask("into", "q3"), ask("from", "q4")]],
  ["qa: an answered question frees a slot for a fourth (Greptile)", qaAuthority, [ask("into", "q1"), ask("into", "q2"), ask("from", "q3"), moderate("q1", "answered"), ask("from", "q4")]],
  ["qa: a question reopened after the fourth was asked (Greptile)", qaAuthority, [ask("into", "q1"), ask("into", "q2"), ask("from", "q3"), moderate("q1", "answered"), ask("from", "q4"), moderate("q1", "reopen")]],
  ["quiz: both answer a round, the kept identity first, merged at the results", quizAuthority, [...quizStart, answer("into", 0), answer("from", 1), ...endRound, nextRound, answer("from", 1), answer("into", 0), ...endRound, nextRound]],
  ["quiz: both answer a round, the merged identity first, merged at the reveal", quizAuthority, [...quizStart, answer("from", 0), answer("into", 1), ...endRound]],
  ["quiz: both answer the round still open", quizAuthority, [...quizStart, answer("into", 1), answer("from", 0)]],
  ["ledger: the same secret, the kept identity later", ledgerAuthority, [secret("from", "s1", "first"), secret("into", "s1", "second"), secret("from", "s2", "other")]],
  ["ledger: the same secret, the merged identity later", ledgerAuthority, [secret("into", "s1", "first"), secret("from", "s1", "second"), secret("into", "s3", "third")]],
];

describe("an app's mergeSubjects leaves what one person would have (Greptile)", () => {
  it.each(scripts)("%s", (_name, module, steps) => {
    const { merged, onePerson } = mergeAgainstOnePerson(module, steps, {
      activityFields: activityFields.get(module),
    });

    expect(merged).toEqual(onePerson);
  });
});

describe("the cost of an app's mergeSubjects (Greptile)", () => {
  const crowdVote = (poll: string): MergeStep => ({
    crowd: 0,
    action: "vote",
    input: (receipts, member) => ({ pollId: kept(receipts, poll, "pollId"), optionIds: [member % 2 === 0 ? "o1" : "o2"] }),
  });
  const crowdUpvote = (question: string): MergeStep => ({
    crowd: 0,
    action: "upvote",
    input: (receipts: ReadonlyMap<string, Json>) => ({ id: kept(receipts, question, "id"), value: true }),
  });
  const crowdAnswer: MergeStep = { crowd: 0, action: "answer", input: (_receipts, member) => ({ choice: member % 2 }) };
  const crowdSecret: MergeStep = { crowd: 0, action: "secret", input: (_receipts, member) => ({ id: `c${member}`, text: "theirs" }) };
  const withCrowd = (steps: MergeStep[], size: number): MergeStep[] =>
    steps.map((step) => ("crowd" in step ? { ...step, crowd: size } : step));

  const costs: Array<[string, AuthorityModule, MergeStep[], number]> = [
    ["polls", pollsAuthority, [pollOf("p1"), pollOf("p2"), crowdVote("p1"), crowdVote("p2"), voteIn("into", "p1", "o1"), voteIn("from", "p1", "o2"), voteIn("from", "p2", "o1")], 4_000],
    ["qa", qaAuthority, [ask("into", "q1"), ask("from", "q2"), crowdUpvote("q1"), crowdUpvote("q2"), upvote("into", "q2"), upvote("from", "q1"), upvote("from", "q2")], 4_000],
    ["quiz", quizAuthority, [...quizStart, crowdAnswer, answer("into", 0), answer("from", 1), ...endRound, nextRound, crowdAnswer, answer("from", 1), ...endRound], 990],
    ["ledger", ledgerAuthority, [crowdSecret, secret("into", "s1", "mine"), secret("from", "s1", "later"), secret("from", "s2", "other")], 4_000],
  ];

  it.each(costs)("%s: the same for a crowd of ten as for thousands, and a small multiple of the two people's rows", (_name, module, steps, crowd) => {
    const small = mergeCost(module, withCrowd(steps, 10));
    const large = mergeCost(module, withCrowd(steps, crowd));

    expect(large.ops).toBe(small.ops);
    expect(large.ops).toBeLessThanOrEqual(8 + 8 * large.subjectRows);
  });
});

