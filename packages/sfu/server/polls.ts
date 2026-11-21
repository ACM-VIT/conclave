import type {
  PollBallotExport,
  PollChoiceMode,
  PollStatus,
  PollView,
} from "../types.js";

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const POLL_MAX_QUESTION_LENGTH = 300;
export const POLL_MAX_OPTION_LENGTH = 120;
export const MAX_POLLS_PER_ROOM = 50;

export type PollDraft = {
  question: string;
  options: string[];
  choiceMode: PollChoiceMode;
};

export type PollDraftRejection = "invalid-question" | "invalid-options";

export type PollVoteRejection =
  | "not-found"
  | "ended"
  | "already-voted"
  | "invalid-choice";

/**
 * Who is looking at a poll. Moderators always see tallies. A `voterKey`
 * (the voter's identity, stable across tabs and reconnects) adds their own
 * ballot to the view.
 */
export type PollAudience = {
  isModerator: boolean;
  voterKey?: string;
};

type Ballot = {
  optionIds: readonly string[];
  voterName: string;
  votedAt: number;
};

type PollRecord = {
  id: string;
  question: string;
  choiceMode: PollChoiceMode;
  options: { id: string; text: string }[];
  status: PollStatus;
  resultsShared: boolean;
  createdAt: number;
  endedAt: number | null;
  createdByName: string;
  ballots: Map<string, Ballot>;
};

const collapseWhitespace = (value: unknown, maxLength: number): string =>
  typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, maxLength)
    : "";

export const parsePollDraft = (
  input: unknown,
): { ok: true; draft: PollDraft } | { ok: false; reason: PollDraftRejection } => {
  const record =
    input && typeof input === "object"
      ? (input as { question?: unknown; options?: unknown; choiceMode?: unknown })
      : {};
  const question = collapseWhitespace(record.question, POLL_MAX_QUESTION_LENGTH);
  if (!question) return { ok: false, reason: "invalid-question" };

  if (!Array.isArray(record.options)) {
    return { ok: false, reason: "invalid-options" };
  }
  const options = record.options
    .map((option) => collapseWhitespace(option, POLL_MAX_OPTION_LENGTH))
    .filter((option) => option.length > 0);
  const distinct = new Set(options.map((option) => option.toLocaleLowerCase()));
  if (
    options.length < POLL_MIN_OPTIONS ||
    options.length > POLL_MAX_OPTIONS ||
    distinct.size !== options.length
  ) {
    return { ok: false, reason: "invalid-options" };
  }

  const choiceMode: PollChoiceMode =
    record.choiceMode === "multiple" ? "multiple" : "single";
  return { ok: true, draft: { question, options, choiceMode } };
};

/**
 * Every poll in one room. The SFU is the only writer, so the voting rules
 * (one ballot per identity, no ballots after the end, only listed options)
 * hold no matter what a client sends.
 */
export class PollBook {
  private polls = new Map<string, PollRecord>();
  private sequence = 0;

  create(
    draft: PollDraft,
    createdByName: string,
    now = Date.now(),
  ): { ok: true; pollId: string } | { ok: false; reason: "too-many-polls" } {
    if (this.polls.size >= MAX_POLLS_PER_ROOM) {
      return { ok: false, reason: "too-many-polls" };
    }
    this.sequence += 1;
    const id = `p${this.sequence}-${now.toString(36)}`;
    this.polls.set(id, {
      id,
      question: draft.question,
      choiceMode: draft.choiceMode,
      options: draft.options.map((text, index) => ({ id: `o${index + 1}`, text })),
      status: "open",
      resultsShared: false,
      createdAt: now,
      endedAt: null,
      createdByName,
      ballots: new Map(),
    });
    return { ok: true, pollId: id };
  }

  vote(
    pollId: string,
    voterKey: string,
    voterName: string,
    optionIds: unknown,
    now = Date.now(),
  ): { ok: true } | { ok: false; reason: PollVoteRejection } {
    const poll = this.polls.get(pollId);
    if (!poll) return { ok: false, reason: "not-found" };
    if (poll.status === "ended") return { ok: false, reason: "ended" };
    if (poll.ballots.has(voterKey)) return { ok: false, reason: "already-voted" };

    const choice = parseChoice(poll, optionIds);
    if (!choice) return { ok: false, reason: "invalid-choice" };

    poll.ballots.set(voterKey, { optionIds: choice, voterName, votedAt: now });
    return { ok: true };
  }

  end(pollId: string, now = Date.now()): "ended" | "unchanged" | "not-found" {
    const poll = this.polls.get(pollId);
    if (!poll) return "not-found";
    if (poll.status === "ended") return "unchanged";
    poll.status = "ended";
    poll.endedAt = now;
    return "ended";
  }

  setResultsShared(
    pollId: string,
    shared: boolean,
  ): "changed" | "unchanged" | "not-found" {
    const poll = this.polls.get(pollId);
    if (!poll) return "not-found";
    if (poll.resultsShared === shared) return "unchanged";
    poll.resultsShared = shared;
    return "changed";
  }

  isResultsShared(pollId: string): boolean {
    return this.polls.get(pollId)?.resultsShared ?? false;
  }

  view(pollId: string, audience: PollAudience): PollView | null {
    const poll = this.polls.get(pollId);
    return poll ? projectPoll(poll, audience) : null;
  }

  snapshot(audience: PollAudience): PollView[] {
    return Array.from(this.polls.values(), (poll) => projectPoll(poll, audience));
  }

  exportBallots(pollId: string): PollBallotExport[] | null {
    const poll = this.polls.get(pollId);
    if (!poll) return null;
    return Array.from(poll.ballots.values(), (ballot) => ({
      name: ballot.voterName,
      optionIds: [...ballot.optionIds],
      votedAt: ballot.votedAt,
    })).sort((a, b) => a.votedAt - b.votedAt);
  }

  clear(): void {
    this.polls.clear();
  }
}

const parseChoice = (poll: PollRecord, optionIds: unknown): string[] | null => {
  if (!Array.isArray(optionIds)) return null;
  if (!optionIds.every((id): id is string => typeof id === "string")) return null;
  const chosen = new Set(optionIds);
  if (chosen.size !== optionIds.length || chosen.size === 0) return null;
  if (poll.choiceMode === "single" && chosen.size !== 1) return null;
  const known = new Set(poll.options.map((option) => option.id));
  for (const id of chosen) {
    if (!known.has(id)) return null;
  }
  // Keep ballots in the poll's option order so exports read naturally.
  return poll.options.map((option) => option.id).filter((id) => chosen.has(id));
};

const projectPoll = (poll: PollRecord, audience: PollAudience): PollView => {
  const showResults = audience.isModerator || poll.resultsShared;
  const counts = new Map<string, number>();
  if (showResults) {
    for (const ballot of poll.ballots.values()) {
      for (const id of ballot.optionIds) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
  }
  const myBallot = audience.voterKey
    ? poll.ballots.get(audience.voterKey)
    : undefined;

  return {
    id: poll.id,
    question: poll.question,
    choiceMode: poll.choiceMode,
    status: poll.status,
    resultsShared: poll.resultsShared,
    options: poll.options.map((option) =>
      showResults
        ? { id: option.id, text: option.text, votes: counts.get(option.id) ?? 0 }
        : { id: option.id, text: option.text },
    ),
    ...(showResults ? { voterCount: poll.ballots.size } : {}),
    createdAt: poll.createdAt,
    ...(poll.endedAt !== null ? { endedAt: poll.endedAt } : {}),
    createdByName: poll.createdByName,
    ...(audience.voterKey ? { myVote: myBallot ? [...myBallot.optionIds] : [] } : {}),
  };
};
