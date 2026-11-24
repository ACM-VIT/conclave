import { boundedJsonBytes } from "@conclave/apps-sdk/authority";
import {
  MAX_POLLS_PER_ROOM,
  POLL_EXPORT_PAGE_BYTES,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  pollsContract,
  type PollBallot,
  type PollCard,
  type PollResults,
} from "@conclave/apps-sdk/polls/core";
import {
  actionOrderTable,
  defineAuthority,
  key,
  nextActionOrder,
  reject,
  table,
  type Role,
  type Subject,
} from "@conclave/apps-sdk/authority/server";

/**
 * The poll rules. They run on the SFU, which is the only writer, so they hold
 * whatever a client sends: one ballot per person, none after the end, only
 * listed options, and totals for hosts alone until a host shares them.
 */
type PollRow = PollCard & {
  /** Kept in step with the ballots, so a view never recounts. */
  tally: PollResults;
  ballotRewrites: number;
};

type Ballot = {
  pollId: string;
  subject: Subject;
  /** The voter's name when they voted, for the host's export. */
  voterName: string;
  votedAt: number;
  order: number;
  optionIds: string[];
};

/** Ballots a room can hold across all its polls. */
const MAX_BALLOTS = 100_000;
/** Ballots read per scan while a page of an export is filled. */
const EXPORT_SCAN_ROWS = 2_000;
const HOST_RATE = { burst: 40, perSecond: 8 };

const card = (row: PollRow): PollCard => ({
  id: row.id,
  question: row.question,
  choiceMode: row.choiceMode,
  options: row.options.map((option) => ({ id: option.id, text: option.text })),
  status: row.status,
  resultsShared: row.resultsShared,
  createdAt: row.createdAt,
  endedAt: row.endedAt,
  createdByName: row.createdByName,
});

const totals = (row: PollRow): PollResults => ({
  voterCount: row.tally.voterCount,
  votes: { ...row.tally.votes },
});

const seesResults = (row: PollRow, role: Role): boolean =>
  role === "moderator" || row.resultsShared;

export const pollsAuthority = defineAuthority({
  contract: pollsContract,
  tables: {
    polls: table<PollRow>({ maxRows: MAX_POLLS_PER_ROOM }),
    ballots: table<Ballot>({ maxRows: MAX_BALLOTS }),
    order: actionOrderTable(),
  },
  timers: {},
  // Meeting polls are for the people in the meeting. Webinar attendees never
  // see them.
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
          ballotRewrites: 0,
        });
        return { pollId: id };
      },
    },
    vote: {
      roles: ["moderator", "member"],
      // Each person votes once per poll, so a small budget is plenty.
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
        // Kept in the poll's option order so exports read naturally.
        const optionIds = known.filter((id) => chosen.has(id));
        // One ballot per person: the row's key is the poll and the voter, so
        // a second tab, a reconnect or a retry cannot add another.
        const inserted = tx.insertIfAbsent("ballots", ballotKey, {
          pollId: input.pollId,
          subject: ctx.subject,
          voterName: ctx.displayName,
          votedAt: ctx.now,
          order: nextActionOrder(tx),
          optionIds,
        });
        if (inserted === "exists") reject("already-voted");

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
          tx.put("polls", key(poll.id), {
            ...poll,
            status: "ended",
            endedAt: ctx.now,
          });
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
    // One page of a poll's ballots, sized to fit one answer. Ballots are
    // only ever added and are kept in the order they were cast, so a page
    // stays where it was while later pages are read.
    exportBallots: {
      roles: ["moderator"],
      rate: HOST_RATE,
      read(_ctx, db, input) {
        const poll = db.get("polls", key(input.pollId));
        if (!poll) return reject("not-found");
        if ((input.offset ?? 0) > 0 && (input.rewrites ?? 0) !== poll.ballotRewrites) reject("export-changed");
        const ballots: PollBallot[] = [];
        let offset = input.offset ?? 0;
        let bytes = 0;
        let nextOffset: number | null = null;
        page: for (;;) {
          const rows = db.scan("ballots", key(input.pollId), {
            offset,
            limit: EXPORT_SCAN_ROWS,
          });
          for (const [, row] of rows) {
            const ballot: PollBallot = {
              name: row.voterName,
              optionIds: [...row.optionIds],
              votedAt: row.votedAt,
              order: row.order,
            };
            const size = boundedJsonBytes(ballot, POLL_EXPORT_PAGE_BYTES) + 1;
            if (ballots.length > 0 && bytes + size > POLL_EXPORT_PAGE_BYTES) {
              nextOffset = offset;
              break page;
            }
            ballots.push(ballot);
            bytes += size;
            offset += 1;
          }
          if (rows.length < EXPORT_SCAN_ROWS) break;
        }
        return { poll: card(poll), results: totals(poll), ballots, nextOffset, rewrites: poll.ballotRewrites };
      },
    },
  },
  onTimer: {},
  views: {
    polls: {
      kind: "shared",
      source: "polls",
      project: (row) => ({ key: row.id, value: card(row) }),
    },
    // The same row projected again, with only the totals. A vote changes
    // this small row and not the card, and it goes to nobody who may not see
    // results: for them the row is absent and stays absent.
    results: {
      kind: "shared",
      source: "polls",
      project: (row, role) =>
        seesResults(row, role) ? { key: row.id, value: totals(row) } : null,
    },
    // Owned by the voter, so every tab of theirs learns of the vote at once.
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
    for (const [, poll] of tx.scan("polls")) {
      const ballot = tx.get("ballots", key(poll.id, from));
      if (!ballot) continue;
      tx.delete("ballots", key(poll.id, from));
      const kept = tx.get("ballots", key(poll.id, into));
      const rewrites = poll.ballotRewrites + 1;
      if (!kept) {
        tx.put("ballots", key(poll.id, into), { ...ballot, subject: into });
        tx.put("polls", key(poll.id), { ...poll, ballotRewrites: rewrites });
        continue;
      }
      const dropped = kept.order < ballot.order ? ballot : kept;
      if (dropped === kept) tx.put("ballots", key(poll.id, into), { ...ballot, subject: into });
      const votes = { ...poll.tally.votes };
      for (const id of dropped.optionIds) {
        const left = (votes[id] ?? 0) - 1;
        if (left > 0) votes[id] = left;
        else delete votes[id];
      }
      tx.put("polls", key(poll.id), {
        ...poll,
        tally: { voterCount: Math.max(0, poll.tally.voterCount - 1), votes },
        ballotRewrites: rewrites,
      });
    }
    return undefined;
  },
});
