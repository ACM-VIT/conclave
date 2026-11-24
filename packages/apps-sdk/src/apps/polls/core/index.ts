import {
  AUTHORITY_LIMITS,
  DISPLAY_NAME_MAX_LENGTH,
  defineContract,
  s,
  type Infer,
} from "@conclave/apps-sdk/authority";

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const POLL_MAX_QUESTION_LENGTH = 300;
export const POLL_MAX_OPTION_LENGTH = 120;
export const MAX_POLLS_PER_ROOM = 50;
/**
 * The most ballots one page of an export carries, as JSON. The runtime
 * answers a query with at most 1 MiB, and a poll can hold far more ballots
 * than that, so an export comes in pages of half that size.
 */
export const POLL_EXPORT_PAGE_BYTES = AUTHORITY_LIMITS.snapshotBytes / 2;

const pollId = s.string({ min: 1, max: 64 });
const optionId = s.string({ min: 1, max: 16 });
// As long as the runtime ever hands an app, so a stored name always fits.
const name = s.string({ max: DISPLAY_NAME_MAX_LENGTH });

const pollCard = s.object({
  id: pollId,
  question: s.string({ max: POLL_MAX_QUESTION_LENGTH }),
  choiceMode: s.oneOf(["single", "multiple"]),
  options: s.array(
    s.object({ id: optionId, text: s.string({ max: POLL_MAX_OPTION_LENGTH }) }),
    { max: POLL_MAX_OPTIONS },
  ),
  status: s.oneOf(["open", "ended"]),
  resultsShared: s.boolean(),
  createdAt: s.number(),
  endedAt: s.nullable(s.number()),
  createdByName: name,
});

const pollResults = s.object({
  voterCount: s.int({ min: 0 }),
  /** Option id to votes. An option nobody chose is absent. */
  votes: s.record(s.int({ min: 0 }), { maxKeys: POLL_MAX_OPTIONS }),
});

const pollBallot = s.object({
  name,
  optionIds: s.array(optionId, { max: POLL_MAX_OPTIONS }),
  votedAt: s.number(),
});

const pollExportPage = s.object({
  poll: pollCard,
  results: pollResults,
  /** One page of ballots, oldest first. */
  ballots: s.array(pollBallot, { max: 20_000 }),
  /** Where the next page starts, or null after the last one. */
  nextOffset: s.nullable(s.int({ min: 0 })),
  rewrites: s.int({ min: 0 }),
});

/**
 * Polls: a host asks, everyone in the meeting answers once, and the host
 * decides when the room sees the totals.
 */
export const pollsContract = defineContract({
  id: "polls",
  major: 1,
  surface: "panel",
  actions: {
    create: {
      input: s.object({
        question: s.string({
          max: POLL_MAX_QUESTION_LENGTH,
          collapse: true,
          truncate: true,
        }),
        options: s.array(
          s.string({ max: POLL_MAX_OPTION_LENGTH, collapse: true, truncate: true }),
          { max: 2 * POLL_MAX_OPTIONS },
        ),
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
    /** Named ballots, for the host's download. */
    exportBallots: {
      input: s.object({
        pollId,
        offset: s.optional(s.int({ min: 0 })),
        rewrites: s.optional(s.int({ min: 0 })),
      }),
      output: pollExportPage,
    },
  },
  views: {
    polls: pollCard,
    /**
     * A poll's totals, keyed by poll id. The row exists exactly when this
     * viewer may see results, so a renderer shows results when it is there
     * and applies no condition of its own.
     */
    results: pollResults,
    /** The viewer's own ballot, keyed by poll id. */
    myVotes: s.object({ optionIds: s.array(optionId, { max: POLL_MAX_OPTIONS }) }),
  },
});

export type PollCard = Infer<typeof pollCard>;
export type PollResults = Infer<typeof pollResults>;
export type PollChoiceMode = PollCard["choiceMode"];
export type PollExportPage = Infer<typeof pollExportPage>;
export type PollBallot = PollExportPage["ballots"][number];
/** A whole export: the poll, and every ballot from every page. */
export type PollExport = { poll: PollCard; ballots: readonly PollBallot[] };

export type PollResultRow = {
  id: string;
  text: string;
  votes: number;
  percent: number;
};

/** Result bars for a poll from its totals. */
export const pollResultRows = (
  poll: PollCard,
  results: PollResults,
): PollResultRow[] =>
  poll.options.map((option) => {
    const votes = results.votes[option.id] ?? 0;
    return {
      id: option.id,
      text: option.text,
      votes,
      percent:
        results.voterCount > 0
          ? Math.round((votes / results.voterCount) * 100)
          : 0,
    };
  });

/** Spreadsheet apps run cells that start like a formula; keep them text. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

const csvCell = (value: string | number): string => {
  let text = String(value);
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const csvRow = (cells: (string | number)[]): string =>
  cells.map(csvCell).join(",");

export const buildPollCsv = ({ poll, ballots }: PollExport): string => {
  const optionText = new Map(
    poll.options.map((option) => [option.id, option.text]),
  );
  const voterCount = ballots.length;
  const tally = new Map<string, number>();
  for (const ballot of ballots) {
    for (const id of ballot.optionIds) tally.set(id, (tally.get(id) ?? 0) + 1);
  }

  const lines = [
    csvRow(["Question", poll.question]),
    csvRow([
      "Type",
      poll.choiceMode === "multiple" ? "Multiple choice" : "Single choice",
    ]),
    csvRow(["Status", poll.status === "ended" ? "Ended" : "Open"]),
    csvRow(["Voters", voterCount]),
    "",
    csvRow(["Option", "Votes", "Percent"]),
    ...poll.options.map((option) => {
      const votes = tally.get(option.id) ?? 0;
      const percent =
        voterCount > 0 ? Math.round((votes / voterCount) * 100) : 0;
      return csvRow([option.text, votes, `${percent}%`]);
    }),
    "",
    csvRow(["Name", "Answer", "Voted at"]),
    ...ballots.map((ballot) =>
      csvRow([
        ballot.name,
        ballot.optionIds.map((id) => optionText.get(id) ?? id).join("; "),
        new Date(ballot.votedAt).toISOString(),
      ]),
    ),
  ];
  return `${lines.join("\r\n")}\r\n`;
};

export const pollCsvFilename = (poll: PollCard): string => {
  const slug = poll.question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `poll-${slug || poll.id}.csv`;
};
