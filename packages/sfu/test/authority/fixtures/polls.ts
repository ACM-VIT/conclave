/**
 * Polls on the authority runtime, as a test fixture: the rules the design's
 * reference harness checks. The shipped app lives in the apps SDK.
 */
import { defineContract, s, type Infer } from "@conclave/apps-sdk/authority";
import {
  defineAuthority,
  key,
  reject,
  table,
  type Subject,
} from "@conclave/apps-sdk/authority/server";
import { actionOrderTable, nextActionOrder } from "./action-order.js";

const POLL_MIN_OPTIONS = 2;
const POLL_MAX_OPTIONS = 10;
const MAX_POLLS_PER_ROOM = 50;

const pollId = s.string({ min: 1, max: 64 });
const optionId = s.string({ min: 1, max: 16 });
const results = s.object({
  voterCount: s.int({ min: 0 }),
  votes: s.record(s.int({ min: 0 }), { maxKeys: POLL_MAX_OPTIONS }),
});
const pollCard = s.object({
  id: pollId,
  question: s.string({ max: 300 }),
  choiceMode: s.oneOf(["single", "multiple"]),
  options: s.array(s.object({ id: optionId, text: s.string({ max: 120 }) }), {
    max: POLL_MAX_OPTIONS,
  }),
  status: s.oneOf(["open", "ended"]),
  resultsShared: s.boolean(),
  createdAt: s.number(),
  endedAt: s.nullable(s.number()),
  createdByName: s.string({ max: 200 }),
  /** Present exactly when this audience may see results. */
  results: s.nullable(results),
});

export const pollsContract = defineContract({
  id: "polls",
  major: 1,
  surface: "panel",
  actions: {
    create: {
      input: s.object({
        question: s.string({ max: 300, collapse: true, truncate: true }),
        options: s.array(s.string({ max: 120, collapse: true, truncate: true }), {
          max: 2 * POLL_MAX_OPTIONS,
        }),
        choiceMode: s.optional(s.oneOf(["single", "multiple"])),
      }),
      receipt: s.object({ pollId }),
    },
    vote: {
      input: s.object({
        pollId,
        optionIds: s.array(optionId, { max: POLL_MAX_OPTIONS }),
      }),
      receipt: s.null(),
    },
    end: { input: s.object({ pollId }), receipt: s.null() },
    share: { input: s.object({ pollId, shared: s.boolean() }), receipt: s.null() },
  },
  queries: {
    exportBallots: {
      input: s.object({ pollId }),
      output: s.object({
        poll: pollCard,
        ballots: s.array(
          s.object({
            name: s.string({ max: 200 }),
            optionIds: s.array(optionId, { max: POLL_MAX_OPTIONS }),
            votedAt: s.number(),
          }),
          { max: 100_000 },
        ),
      }),
    },
  },
  views: {
    polls: pollCard,
    myVotes: s.object({ optionIds: s.array(optionId, { max: POLL_MAX_OPTIONS }) }),
  },
});

type PollCard = Infer<typeof pollCard>;
type PollRow = Omit<PollCard, "results"> & {
  /** Kept in step with the ballots, so a view never recounts. */
  tally: { voterCount: number; votes: Record<string, number> };
};
type Ballot = {
  pollId: string;
  subject: Subject;
  voterName: string;
  votedAt: number;
  order: number;
  optionIds: string[];
};

const card = (row: PollRow, showResults: boolean): PollCard => ({
  id: row.id,
  question: row.question,
  choiceMode: row.choiceMode,
  options: row.options,
  status: row.status,
  resultsShared: row.resultsShared,
  createdAt: row.createdAt,
  endedAt: row.endedAt,
  createdByName: row.createdByName,
  results: showResults ? row.tally : null,
});

const HOST_RATE = { burst: 40, perSecond: 8 };

export const pollsAuthority = defineAuthority({
  contract: pollsContract,
  tables: {
    polls: table<PollRow>({ maxRows: MAX_POLLS_PER_ROOM }),
    ballots: table<Ballot>({ maxRows: 100_000 }),
    ballotsBySubject: table<{ pollId: string }>({ maxRows: 100_000 }),
    order: actionOrderTable(),
  },
  timers: {},
  // Webinar attendees never see meeting polls.
  canView: ({ role }) => role === "moderator" || role === "member",
  actions: {
    create: {
      roles: ["moderator"],
      identity: "any",
      rate: HOST_RATE,
      run(ctx, tx, input) {
        if (!input.question) reject("invalid-question");
        const texts = input.options.filter((text) => text.length > 0);
        const distinct = new Set(texts.map((text) => text.toLocaleLowerCase()));
        if (
          texts.length < POLL_MIN_OPTIONS ||
          texts.length > POLL_MAX_OPTIONS ||
          distinct.size !== texts.length
        ) {
          reject("invalid-options");
        }
        if (tx.count("polls") >= MAX_POLLS_PER_ROOM) reject("too-many-polls");
        const id = ctx.nextId("p");
        tx.insertIfAbsent("polls", key(id), {
          id,
          question: input.question,
          choiceMode: input.choiceMode ?? "single",
          options: texts.map((text, index) => ({ id: `o${index + 1}`, text })),
          status: "open",
          resultsShared: false,
          createdAt: ctx.now,
          endedAt: null,
          createdByName: ctx.displayName,
          tally: { voterCount: 0, votes: {} },
        });
        return { pollId: id };
      },
    },
    vote: {
      roles: ["moderator", "member"],
      rate: { burst: 10, perSecond: 2 },
      run(ctx, tx, input) {
        const poll = tx.get("polls", key(input.pollId));
        if (!poll) return reject("not-found");
        if (poll.status === "ended") reject("ended");
        const ballotKey = key(input.pollId, ctx.subject);
        if (tx.get("ballots", ballotKey)) reject("already-voted");

        const chosen = new Set(input.optionIds);
        const known = poll.options.map((option) => option.id);
        if (
          chosen.size === 0 ||
          chosen.size !== input.optionIds.length ||
          (poll.choiceMode === "single" && chosen.size !== 1) ||
          input.optionIds.some((id) => !known.includes(id))
        ) {
          reject("invalid-choice");
        }
        // Stored in the poll's option order so exports read naturally.
        const optionIds = known.filter((id) => chosen.has(id));
        // One ballot per person: the key is the poll and the voter.
        const inserted = tx.insertIfAbsent("ballots", ballotKey, {
          pollId: input.pollId,
          subject: ctx.subject,
          voterName: ctx.displayName,
          votedAt: ctx.now,
          order: nextActionOrder(tx),
          optionIds,
        });
        if (inserted === "exists") reject("already-voted");
        tx.put("ballotsBySubject", key(ctx.subject, input.pollId), { pollId: input.pollId });
        const votes = { ...poll.tally.votes };
        for (const id of optionIds) votes[id] = (votes[id] ?? 0) + 1;
        tx.put("polls", key(poll.id), {
          ...poll,
          tally: { voterCount: poll.tally.voterCount + 1, votes },
        });
        return null;
      },
    },
    end: {
      roles: ["moderator"],
      identity: "any",
      rate: HOST_RATE,
      run(ctx, tx, input) {
        const poll = tx.get("polls", key(input.pollId));
        if (!poll) return reject("not-found");
        if (poll.status === "open") {
          tx.put("polls", key(poll.id), { ...poll, status: "ended", endedAt: ctx.now });
        }
        return null;
      },
    },
    share: {
      roles: ["moderator"],
      identity: "any",
      rate: HOST_RATE,
      run(_ctx, tx, input) {
        const poll = tx.get("polls", key(input.pollId));
        if (!poll) return reject("not-found");
        if (poll.resultsShared !== input.shared) {
          tx.put("polls", key(poll.id), { ...poll, resultsShared: input.shared });
        }
        return null;
      },
    },
  },
  queries: {
    exportBallots: {
      roles: ["moderator"],
      rate: HOST_RATE,
      read(_ctx, db, input) {
        const poll = db.get("polls", key(input.pollId));
        if (!poll) return reject("not-found");
        const ballots = db
          .scan("ballots", key(input.pollId))
          .map(([, ballot]) => ({
            name: ballot.voterName,
            optionIds: [...ballot.optionIds],
            votedAt: ballot.votedAt,
          }))
          .sort((a, b) => a.votedAt - b.votedAt);
        return { poll: card(poll, true), ballots };
      },
    },
  },
  onTimer: {},
  views: {
    polls: {
      kind: "shared",
      source: "polls",
      project: (row, role) => ({
        key: row.id,
        value: card(row, role === "moderator" || row.resultsShared),
      }),
    },
    // Keyed by person, so every tab of the voter learns of the vote at once.
    myVotes: {
      kind: "personal",
      source: "ballots",
      owner: (ballot) => ballot.subject,
      project: (ballot) => ({
        key: ballot.pollId,
        value: { optionIds: [...ballot.optionIds] },
      }),
    },
  },
  mergeSubjects(_ctx, tx, { from, into }) {
    for (const [, { pollId }] of tx.scan("ballotsBySubject", key(from))) {
      tx.delete("ballotsBySubject", key(from, pollId));
      const ballot = tx.get("ballots", key(pollId, from));
      if (!ballot) continue;
      tx.delete("ballots", key(pollId, from));
      tx.put("ballotsBySubject", key(into, pollId), { pollId });
      const kept = tx.get("ballots", key(pollId, into));
      if (!kept) {
        tx.put("ballots", key(pollId, into), { ...ballot, subject: into });
        continue;
      }
      const dropped = kept.order < ballot.order ? ballot : kept;
      if (dropped === kept) tx.put("ballots", key(pollId, into), { ...ballot, subject: into });
      const poll = tx.get("polls", key(pollId));
      if (!poll) continue;
      const votes = { ...poll.tally.votes };
      for (const id of dropped.optionIds) {
        const left = (votes[id] ?? 0) - 1;
        if (left > 0) votes[id] = left;
        else delete votes[id];
      }
      tx.put("polls", key(poll.id), {
        ...poll,
        tally: { voterCount: Math.max(0, poll.tally.voterCount - 1), votes },
      });
    }
    return undefined;
  },
});
