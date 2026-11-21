import type { PollExportResponse, PollView } from "./types";

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const POLL_MAX_QUESTION_LENGTH = 300;
export const POLL_MAX_OPTION_LENGTH = 120;

export type PollResultRow = {
  id: string;
  text: string;
  votes: number;
  percent: number;
};

/** Result bars for a poll, or null while the host keeps results private. */
export const pollResults = (poll: PollView): PollResultRow[] | null => {
  if (poll.voterCount === undefined) return null;
  const voters = poll.voterCount;
  return poll.options.map((option) => {
    const votes = option.votes ?? 0;
    return {
      id: option.id,
      text: option.text,
      votes,
      percent: voters > 0 ? Math.round((votes / voters) * 100) : 0,
    };
  });
};

export const hasVoted = (poll: PollView): boolean =>
  (poll.myVote?.length ?? 0) > 0;

/**
 * Broadcasts leave out the viewer's own ballot, so an update keeps the one
 * this client already knows unless the server sent a fresher one.
 */
export const mergePoll = (previous: PollView | undefined, next: PollView): PollView =>
  next.myVote === undefined && previous?.myVote !== undefined
    ? { ...next, myVote: previous.myVote }
    : next;

export const upsertPoll = (polls: PollView[], next: PollView): PollView[] => {
  const index = polls.findIndex((poll) => poll.id === next.id);
  if (index === -1) return [...polls, next];
  const updated = polls.slice();
  updated[index] = mergePoll(polls[index], next);
  return updated;
};

/** Spreadsheet apps run cells that start like a formula; keep them text. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

const csvCell = (value: string | number): string => {
  let text = String(value);
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const csvRow = (cells: (string | number)[]): string => cells.map(csvCell).join(",");

export const buildPollCsv = ({ poll, ballots }: PollExportResponse): string => {
  const optionText = new Map(poll.options.map((option) => [option.id, option.text]));
  const voterCount = ballots.length;
  const tally = new Map<string, number>();
  for (const ballot of ballots) {
    for (const id of ballot.optionIds) tally.set(id, (tally.get(id) ?? 0) + 1);
  }

  const lines = [
    csvRow(["Question", poll.question]),
    csvRow(["Type", poll.choiceMode === "multiple" ? "Multiple choice" : "Single choice"]),
    csvRow(["Status", poll.status === "ended" ? "Ended" : "Open"]),
    csvRow(["Voters", voterCount]),
    "",
    csvRow(["Option", "Votes", "Percent"]),
    ...poll.options.map((option) => {
      const votes = tally.get(option.id) ?? 0;
      const percent = voterCount > 0 ? Math.round((votes / voterCount) * 100) : 0;
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

export const pollCsvFilename = (poll: PollView): string => {
  const slug = poll.question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `poll-${slug || poll.id}.csv`;
};
