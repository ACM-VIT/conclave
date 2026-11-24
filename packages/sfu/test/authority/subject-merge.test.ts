import { describe, expect, it } from "vitest";
import type { Json } from "@conclave/apps-sdk/authority";
import type { AuthorityModule, Subject } from "@conclave/apps-sdk/authority/server";
import { AuthorityInstance, type Actor } from "../../server/apps/authority/instance.js";
import { DEFAULT_AUTHORITY_LIMITS } from "../../server/apps/authority/limits.js";
import { BULK_ROWS_PER_OP } from "../../server/apps/authority/store.js";
import { ledgerAuthority } from "./fixtures/ledger.js";
import { pollsAuthority } from "@conclave/apps-sdk/polls/server";
import { qaAuthority } from "@conclave/apps-sdk/qa/server";
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
const upvote = (by: "into" | "from" | "host", question: string): MergeStep => ({
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
const moderate = (question: string, action: "answering" | "answered" | "dismissed" | "reopen"): MergeStep => ({
  by: "host",
  action: "moderate",
  input: (receipts: ReadonlyMap<string, Json>) => ({ id: kept(receipts, question, "id"), action }),
});
const secret = (by: "into" | "from", id: string, text: string): MergeStep => ({
  by,
  action: "secret",
  input: () => ({ id, text }),
});

const seeded = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const atOnce = (step: MergeStep): MergeStep => ("by" in step ? { ...step, sameMoment: true } : step);
const crowdUpvote = (question: string): MergeStep => ({
  crowd: 0,
  action: "upvote",
  input: (receipts: ReadonlyMap<string, Json>) => ({ id: kept(receipts, question, "id"), value: true }),
});
const crowdAsk: MergeStep = { crowd: 0, action: "ask", input: (_receipts, member) => ({ text: `Crowd question ${member}` }) };
const ofSize = (step: MergeStep, size: number): MergeStep => ("crowd" in step ? { ...step, crowd: size } : step);

const activityFields = new Map<AuthorityModule, string[]>([
  [qaAuthority, ["updatedAt"]],
  [pollsAuthority, ["ballotRewrites"]],
]);

const scripts: Array<[string, AuthorityModule, MergeStep[]]> = [
  ["polls: a ballot each in different polls", pollsAuthority, [pollOf("p1"), pollOf("p2"), voteIn("into", "p1", "o1"), voteIn("from", "p2", "o2")]],
  ["polls: two ballots in one poll, the kept identity first", pollsAuthority, [pollOf("p"), voteIn("into", "p", "o1"), voteIn("from", "p", "o2")]],
  ["polls: two ballots in one poll, the merged identity first", pollsAuthority, [pollOf("p"), voteIn("from", "p", "o2"), voteIn("into", "p", "o1")]],
  ["qa: both upvote one question", qaAuthority, [ask("from", "q"), upvote("into", "q"), upvote("from", "q")]],
  ["qa: each upvotes another question", qaAuthority, [ask("into", "q1"), ask("from", "q2"), upvote("into", "q2"), upvote("from", "q1")]],
  ["qa: more open questions than one person may have", qaAuthority, [ask("into", "q1"), ask("from", "q2"), ask("into", "q3"), ask("from", "q4")]],
  ["qa: an answered question frees a slot for a fourth (Greptile)", qaAuthority, [ask("into", "q1"), ask("into", "q2"), ask("from", "q3"), moderate("q1", "answered"), ask("from", "q4")]],
  ["qa: a question reopened after the fourth was asked (Greptile)", qaAuthority, [ask("into", "q1"), ask("into", "q2"), ask("from", "q3"), moderate("q1", "answered"), ask("from", "q4"), moderate("q1", "reopen")]],
  ["qa: a question closed before the fourth was asked, then reopened and closed until that close is far back in its history", qaAuthority, [ask("into", "q1"), ask("into", "q2"), ask("from", "q3"), moderate("q1", "answered"), ask("from", "q4"), ...Array.from({ length: 8 }, () => [moderate("q1", "reopen"), moderate("q1", "answered")]).flat(), moderate("q1", "reopen")]],
  ["qa: a question answered and reopened more often than its history keeps, after the fourth was asked", qaAuthority, [ask("into", "q1"), ask("into", "q2"), ask("from", "q3"), ask("from", "q4"), ...Array.from({ length: 9 }, () => [moderate("q1", "answered"), moderate("q1", "reopen")]).flat()]],
  ["quiz: both answer a round, the kept identity first, merged at the results", quizAuthority, [...quizStart, answer("into", 0), answer("from", 1), ...endRound, nextRound, answer("from", 1), answer("into", 0), ...endRound, nextRound]],
  ["quiz: both answer a round, the merged identity first, merged at the reveal", quizAuthority, [...quizStart, answer("from", 0), answer("into", 1), ...endRound]],
  ["quiz: both answer the round still open", quizAuthority, [...quizStart, answer("into", 1), answer("from", 0)]],
  ["ledger: the same secret, the kept identity later", ledgerAuthority, [secret("from", "s1", "first"), secret("into", "s1", "second"), secret("from", "s2", "other")]],
  ["ledger: the same secret, the merged identity later", ledgerAuthority, [secret("into", "s1", "first"), secret("from", "s1", "second"), secret("into", "s3", "third")]],
  ["polls: two ballots in one poll in the same millisecond, the merged identity first", pollsAuthority, [pollOf("p"), voteIn("from", "p", "o2"), atOnce(voteIn("into", "p", "o1"))]],
  ["qa: the third and fourth questions in the same millisecond under two passes (Greptile)", qaAuthority, [ask("into", "q1"), ask("into", "q2"), ask("from", "q3"), atOnce(ask("into", "q4"))]],
  ["qa: a question answered in the same millisecond as the fourth is asked", qaAuthority, [ask("into", "q1"), ask("into", "q2"), ask("from", "q3"), moderate("q1", "answered"), atOnce(ask("from", "q4"))]],
  ["quiz: both answer a round in the same millisecond, the merged identity first", quizAuthority, [...quizStart, answer("from", 1), atOnce(answer("into", 0)), ...endRound]],
  ["ledger: the same secret in the same millisecond, the merged identity later", ledgerAuthority, [secret("into", "s1", "first"), atOnce(secret("from", "s1", "second"))]],
];

describe("an app's mergeSubjects leaves what one person would have (Greptile)", () => {
  it.each(scripts)("%s", (_name, module, steps) => {
    const { merged, onePerson } = mergeAgainstOnePerson(module, steps, {
      activityFields: activityFields.get(module),
    });

    expect(merged).toEqual(onePerson);
  });
});

describe("qa merges after random histories of any length", () => {
  const randomHistory = (seed: number): MergeStep[] => {
    const random = seeded(seed);
    const steps: MergeStep[] = [];
    const asked: string[] = [];
    const length = 10 + Math.floor(random() * 110);
    const actions = ["answering", "answered", "dismissed", "reopen", "reopen"] as const;
    for (let index = 0; index < length; index += 1) {
      if (asked.length === 0 || random() < 0.3) {
        const name = `q${asked.length + 1}`;
        asked.push(name);
        steps.push(ask(random() < 0.5 ? "into" : "from", name));
      } else {
        const target = random() < 0.5 ? asked[0] : asked[Math.floor(random() * asked.length)];
        steps.push(moderate(target, actions[Math.floor(random() * actions.length)]));
      }
    }
    return steps;
  };

  it("leaves what one person would have, for every seed whose two passes asked everything one person could", () => {
    const mismatches: number[] = [];
    let compared = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const { merged, onePerson, keptMerged, keptOnePerson } = mergeAgainstOnePerson(qaAuthority, randomHistory(seed), {
        activityFields: ["updatedAt"],
      });
      if (!keptOnePerson.every((name) => keptMerged.includes(name))) continue;
      compared += 1;
      if (JSON.stringify(merged) !== JSON.stringify(onePerson)) mismatches.push(seed);
    }
    expect(mismatches).toEqual([]);
    expect(compared).toBeGreaterThan(40);
  });
});

describe("a poll export with a merge between its pages", () => {
  const meeting = { mode: "meeting" as const, qaEnabled: true };
  const voter = (subject: string, displayName: string, role: Actor["role"] = "member"): Actor => ({
    subject: subject as Subject,
    role,
    verified: true,
    displayName,
  });
  const host = voter("host", "Host", "moderator");
  const firstTab = voter("gita-tab-1", "Gita, first tab");
  const secondTab = voter("gita-tab-2", "Gita, second tab");
  const pollWithBallots = (secondTabVotes: boolean) => {
    const instance = new AuthorityInstance("polls.export-merge", pollsAuthority, meeting, {
      limits: DEFAULT_AUTHORITY_LIMITS,
      random: { next: () => 0.5, int: () => 0, shuffle: (list) => [...list] },
      verifyViews: false,
    });
    let now = 1_000_000;
    const created = instance.act(host, "create", { question: "Lunch?", options: ["Tea", "Coffee"] }, null, now);
    const pollId = created.ok ? ((created.value as { pollId: string }).pollId) : "";
    for (let index = 0; index < 3_000; index += 1) {
      now += 20;
      if (index === 2_600 && !secondTabVotes) continue;
      const who =
        index === 40 ? firstTab : index === 2_600 ? secondTab : voter(`voter-${index}`, `${"名".repeat(190)} ${index}`);
      const cast = instance.act(who, "vote", { pollId, optionIds: [index % 2 === 0 ? "o1" : "o2"] }, null, now);
      if (!cast.ok) throw new Error(`vote ${index} failed: ${cast.code}`);
    }
    return { instance, pollId, now };
  };
  const exportAll = (secondTabVotes: boolean, mergeBeforePage: number | null) => {
    const { instance, pollId, now } = pollWithBallots(secondTabVotes);
    let at = now;
    const names: string[] = [];
    let offset: number | null = 0;
    let rewrites: number | undefined;
    let pages = 0;
    let restarts = 0;
    let merged = false;
    while (offset !== null) {
      if (!merged && pages === mergeBeforePage) {
        instance.mergeSubjects({ from: firstTab.subject, into: secondTab.subject }, (at += 1));
        merged = true;
      }
      at += 1_000;
      const page = instance.query(host, "exportBallots", { pollId, offset, rewrites }, at);
      if (!page.ok) {
        if (page.code !== "rejected" || page.reason !== "export-changed" || restarts > 0) {
          throw new Error(`page at ${offset} failed: ${JSON.stringify(page)}`);
        }
        restarts += 1;
        names.length = 0;
        offset = 0;
        rewrites = undefined;
        continue;
      }
      pages += 1;
      const value = page.value as { ballots: { name: string }[]; nextOffset: number | null; rewrites: number };
      names.push(...value.ballots.map((ballot) => ballot.name));
      offset = value.nextOffset;
      rewrites = value.rewrites;
    }
    return { names, pages, restarts };
  };

  it.each([
    ["both tabs voted, and the first tab's ballot is kept under the second", true, 2_999],
    ["only the first tab voted, and its ballot moves to the second", false, 2_999],
  ])("exports every ballot once, whichever two pages the merge falls between: %s", (_case, secondTabVotes, ballots) => {
    const afterTheMerge = exportAll(secondTabVotes, 0);
    const outcomes = Array.from({ length: afterTheMerge.pages - 1 }, (_, index) => {
      const { names, restarts } = exportAll(secondTabVotes, index + 1);
      return { between: [index + 1, index + 2], sameAsAfterTheMerge: names.join("|") === afterTheMerge.names.join("|"), restarts };
    });

    expect(afterTheMerge.pages).toBeGreaterThan(2);
    expect(afterTheMerge.names).toHaveLength(ballots);
    expect(new Set(afterTheMerge.names).size).toBe(ballots);
    expect(afterTheMerge.names.filter((name) => name.startsWith("Gita"))).toEqual(["Gita, first tab"]);
    expect(outcomes).toEqual(
      outcomes.map(({ between }) => ({ between, sameAsAfterTheMerge: true, restarts: 1 })),
    );
  });
});

describe("a removed question leaves no row behind that names it (Greptile)", () => {
  const orphans = (tables: Record<string, (readonly [string, object])[]>): string[] => {
    const live = new Set(tables.questions.map(([, row]) => (row as { id: string }).id));
    return Object.entries(tables)
      .filter(([table]) => table !== "questions")
      .flatMap(([table, rows]) =>
        rows
          .filter(([, row]) => {
            const named = (row as { questionId?: string; id?: string }).questionId ?? (row as { id?: string }).id;
            return named !== undefined && !live.has(named);
          })
          .map(([rowKey]) => `${table} ${rowKey}`),
      );
  };
  const removals: Array<[string, MergeStep[]]> = [
    ["evicted when the book fills", [ask("into", "q"), ofSize(crowdUpvote("q"), 5), upvote("host", "q"), moderate("q", "dismissed"), ofSize(crowdAsk, 300)]],
    ["dropped by the merge", [ask("into", "q1"), ask("into", "q2"), ask("from", "q3"), ask("from", "q4"), upvote("into", "q4"), upvote("host", "q4")]],
  ];

  it.each(removals)("%s", (_name, steps) => {
    const { merged, onePerson } = mergeAgainstOnePerson(qaAuthority, steps, { activityFields: ["updatedAt"] });

    expect(orphans(merged)).toEqual([]);
    expect(orphans(onePerson)).toEqual([]);
    expect(merged).toEqual(onePerson);
  });
});

describe("quiz results after several merges (Greptile)", () => {
  const room = { mode: "meeting" as const, qaEnabled: true };
  const host: Actor = { subject: "host" as Subject, role: "moderator", verified: true, displayName: "Host" };
  const player = (index: number): Actor => ({
    subject: `player-${String(index).padStart(3, "0")}` as Subject,
    role: "member",
    verified: true,
    displayName: `Player ${index}`,
  });
  type Shown = { name: string; score: number };
  const shown = (instance: AuthorityInstance): Shown[] | null => {
    const quiz = instance.snapshot(host).rows.find(({ row }) => row.bucket === "quiz")?.row.value as
      | { leaderboard: Shown[] | null }
      | undefined;
    return quiz?.leaderboard ?? null;
  };
  const topTen = (instance: AuthorityInstance): Shown[] =>
    [...instance.store.rows("scores").values()]
      .map((row) => row as { subject: string; name: string; score: number })
      .sort((a, b) => b.score - a.score || (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0))
      .slice(0, 10)
      .map(({ name, score }) => ({ name, score }));
  const playedQuiz = (players: number, choiceOf: (index: number) => number) => {
    const instance = new AuthorityInstance("quiz.merges", quizAuthority, room, {
      limits: DEFAULT_AUTHORITY_LIMITS,
      random: { next: () => 0.5, int: () => 0, shuffle: (list) => [...list] },
      verifyViews: true,
    });
    let now = 1_000_000;
    const act = (who: Actor, action: string, input: unknown) => {
      const result = instance.act(who, action, input, null, now);
      if (!result.ok) throw new Error(`${action} by ${who.subject} failed: ${JSON.stringify(result)}`);
    };
    act(host, "load", { secondsPerQuestion: 120, questions: [{ prompt: "One?", choices: ["a", "b"], answer: 0 }] });
    now += 1_000;
    act(host, "begin", null);
    for (let index = 0; index < players; index += 1) {
      now += 1_000;
      act(player(index), "answer", { choice: choiceOf(index) });
    }
    now += 1_000;
    act(host, "endRound", null);
    instance.runDueTimers(now);
    return { instance, now };
  };

  it("shows the top ten after eleven passes of one person are linked to the first (Greptile)", () => {
    const { instance, now } = playedQuiz(22, () => 0);
    instance.runDueTimers(now + 6_000);
    for (let index = 1; index <= 11; index += 1) {
      instance.mergeSubjects({ from: player(index).subject, into: player(0).subject }, now + 6_000 + index);
      expect(shown(instance)).toEqual(topTen(instance));
    }
    expect(shown(instance)).toHaveLength(10);
  });

  it.each(Array.from({ length: 24 }, (_, seed) => seed + 1))("shows the top ten after every merge of a random room, seed %i", (seed) => {
    const random = seeded(seed);
    const players = 11 + Math.floor(random() * 30);
    const { instance, now } = playedQuiz(players, () => (random() < 0.7 ? 0 : 1));
    let at = now;
    const left = Array.from({ length: players }, (_, index) => index);
    const merges = 1 + Math.floor(random() * (players - 1));
    for (let merge = 0; merge < merges; merge += 1) {
      if (merge === Math.floor(merges / 2)) instance.runDueTimers((at += 6_000));
      const from = left.splice(Math.floor(random() * left.length), 1)[0];
      const into = left[Math.floor(random() * left.length)];
      instance.mergeSubjects({ from: player(from).subject, into: player(into).subject }, (at += 1));
      expect(shown(instance)).toEqual(topTen(instance));
    }
  });
});

describe("the cost of an app's mergeSubjects (Greptile)", () => {
  const crowdVote = (poll: string): MergeStep => ({
    crowd: 0,
    action: "vote",
    input: (receipts, member) => ({ pollId: kept(receipts, poll, "pollId"), optionIds: [member % 2 === 0 ? "o1" : "o2"] }),
  });
  const crowdAnswer: MergeStep = { crowd: 0, action: "answer", input: (_receipts, member) => ({ choice: member % 2 }) };
  const crowdSecret: MergeStep = { crowd: 0, action: "secret", input: (_receipts, member) => ({ id: `c${member}`, text: "theirs" }) };
  const withCrowd = (steps: MergeStep[], size: number): MergeStep[] => steps.map((step) => ofSize(step, size));

  const costs: Array<[string, AuthorityModule, MergeStep[], number, number, string[]]> = [
    ["polls", pollsAuthority, [pollOf("p1"), pollOf("p2"), crowdVote("p1"), crowdVote("p2"), voteIn("into", "p1", "o1"), voteIn("from", "p1", "o2"), voteIn("from", "p2", "o1")], 10, 4_000, []],
    ["qa", qaAuthority, [ask("into", "q1"), ask("from", "q2"), crowdUpvote("q1"), crowdUpvote("q2"), upvote("into", "q2"), upvote("from", "q1"), upvote("from", "q2")], 10, 4_000, ["questions"]],
    ["qa with a full book", qaAuthority, [crowdAsk, ask("into", "q1"), ask("from", "q2"), crowdUpvote("q1"), crowdUpvote("q2"), upvote("into", "q2"), upvote("from", "q1"), upvote("from", "q2")], 300, 1_500, ["questions"]],
    ["quiz", quizAuthority, [...quizStart, crowdAnswer, answer("into", 0), answer("from", 1), ...endRound, nextRound, crowdAnswer, answer("from", 1), ...endRound], 10, 990, []],
    ["ledger", ledgerAuthority, [crowdSecret, secret("into", "s1", "mine"), secret("from", "s1", "later"), secret("from", "s2", "other")], 10, 4_000, []],
  ];

  it.each(costs)("%s: the same for a small crowd as for a large one, and a small multiple of the two people's rows", (_name, module, steps, smallCrowd, largeCrowd, walked) => {
    const small = mergeCost(module, withCrowd(steps, smallCrowd), walked);
    const large = mergeCost(module, withCrowd(steps, largeCrowd), walked);

    expect(small.crowd).toBe(smallCrowd);
    expect(large.crowd).toBe(largeCrowd);
    expect(large.ops).toBe(small.ops);
    expect(large.ops).toBeLessThanOrEqual(8 + 8 * large.subjectRows + 2 * large.walkedRows);
  }, 30_000);

  it("qa with a discarded question the crowd upvoted: grows only by the store's price for the upvotes it removes, and fits the budget at the upvote cap", () => {
    const steps = [ask("into", "q1"), ask("into", "q2"), ask("into", "q3"), ask("from", "q4"), crowdUpvote("q4"), upvote("into", "q4")];
    const small = mergeCost(qaAuthority, withCrowd(steps, 10), ["questions"]);
    const large = mergeCost(qaAuthority, withCrowd(steps, 4_000), ["questions"]);
    const bound = (cost: typeof small, removedRows: number) =>
      8 + 8 * cost.subjectRows + 2 * cost.walkedRows + Math.floor(removedRows / BULK_ROWS_PER_OP);
    const upvoteCap = qaAuthority.runtime.tables.upvotes.maxRows;

    expect([small.removedRows, large.removedRows]).toEqual([12, 4_002]);
    expect(small.ops).toBeLessThanOrEqual(bound(small, small.removedRows));
    expect(large.ops).toBeLessThanOrEqual(bound(large, large.removedRows));
    expect(large.ops - small.ops).toBeLessThanOrEqual(Math.ceil((large.removedRows - small.removedRows) / BULK_ROWS_PER_OP));
    expect(bound(large, upvoteCap + large.subjectRows)).toBeLessThan(DEFAULT_AUTHORITY_LIMITS.transactionOps);
  }, 30_000);
});
