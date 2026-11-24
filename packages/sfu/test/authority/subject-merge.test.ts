import { describe, expect, it } from "vitest";
import type { Json } from "@conclave/apps-sdk/authority";
import type { AuthorityModule } from "@conclave/apps-sdk/authority/server";
import { ledgerAuthority } from "./fixtures/ledger.js";
import { pollsAuthority } from "./fixtures/polls.js";
import { qaAuthority } from "./fixtures/qa.js";
import { quizAuthority } from "./fixtures/quiz.js";
import { mergeAgainstOnePerson, type MergeStep } from "./merge-check.js";

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
  input: (receipts) => ({ pollId: kept(receipts, poll, "pollId"), optionIds: [option] }),
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
  input: (receipts) => ({ id: kept(receipts, question, "id"), value: true }),
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
