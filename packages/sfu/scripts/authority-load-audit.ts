/**
 * The oracle of the authority load measurement: what each person did, and
 * from that whether a row that reached one of their sockets was theirs to
 * see. It is apart from the script that drives the load so it can be tested.
 */
import type { AuthorityFrame, Json } from "@conclave/apps-sdk/authority";

export type AuditPerson = { key: string; name: string; host: boolean };

/** One socket, as the script knows it when a frame arrives. */
export type AuditRecipient = { person: AuditPerson; removed: boolean };

/**
 * What one person has done, across their tabs: the oracle for their rows.
 * `upvoteTakenBackAt` is when each upvote was last taken back. A person's
 * two tabs are two sockets with no order between them, so one tab's
 * "upvoted" frame can land just after the other tab took the upvote back.
 * That row is still theirs for a moment. A row for a question they do not
 * hold an upvote on, and did not just release, is someone else's.
 */
type Ledger = {
  votes: Set<string>;
  upvotes: Set<string>;
  upvoteTakenBackAt: Map<string, number>;
  asked: Set<string>;
};

/** How long after taking an upvote back its row may still arrive. */
const CROSS_TAB_GRACE_MS = 1_000;

const field = (value: Json, name: string): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? ((value as { readonly [key: string]: Json })[name] ?? null)
    : null;

export class LoadAudit {
  readonly violations: string[] = [];
  private readonly ledgers = new Map<string, Ledger>();
  private readonly sharedPolls = new Set<string>();
  /**
   * Question rows that reached a person before the ack that names their new
   * question. Only the ack says which id is theirs, so these are judged once
   * every ack is in.
   */
  private readonly unsettledQuestions: { person: AuditPerson; key: string }[] = [];
  questionRowsJudgedLate = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Records a vote being sent. Returns whether it is the person's first on the poll. */
  vote(person: AuditPerson, pollId: string): boolean {
    const ledger = this.ledgerOf(person);
    const first = !ledger.votes.has(pollId);
    ledger.votes.add(pollId);
    return first;
  }

  /** Whether the person holds an upvote on the question, as far as acks say. */
  holdsUpvote(person: AuditPerson, questionId: string): boolean {
    return this.ledgerOf(person).upvotes.has(questionId);
  }

  /**
   * Records an upvote (`value` true) or a take-back being sent. Call it
   * before sending, because the row may arrive before the ack, and call what
   * it returns with the answer.
   */
  upvote(
    person: AuditPerson,
    questionId: string,
    value: boolean,
  ): (ok: boolean) => void {
    const ledger = this.ledgerOf(person);
    if (value) ledger.upvotes.add(questionId);
    return (ok) => {
      if (!ok || value) return;
      ledger.upvotes.delete(questionId);
      ledger.upvoteTakenBackAt.set(questionId, this.now());
    };
  }

  /** Records the id an ask was answered with. */
  asked(person: AuditPerson, questionId: string): void {
    this.ledgerOf(person).asked.add(questionId);
  }

  /** Checks one received frame against what its connection may see. */
  frame(recipient: AuditRecipient, frame: AuthorityFrame): void {
    if (frame.kind === "revoke" || frame.kind === "queryAbort") return;
    const { person } = recipient;
    if (recipient.removed) {
      this.violations.push(`${person.name}: ${frame.kind} frame after removal`);
      return;
    }
    if (frame.kind === "query") return;
    const ledger = this.ledgerOf(person);
    for (const row of frame.kind === "replace" ? frame.rows : frame.put) {
      if (row.bucket === "polls") {
        const visible = person.host || this.sharedPolls.has(row.key);
        if (field(row.value, "results") !== null && !visible) {
          this.violations.push(`${person.name}: private tally for poll ${row.key}`);
        }
      } else if (row.bucket === "myVotes") {
        if (!ledger.votes.has(row.key)) {
          this.violations.push(`${person.name}: someone else's ballot ${row.key}`);
        }
      } else if (row.bucket === "myUpvotes") {
        const takenBackAt = ledger.upvoteTakenBackAt.get(row.key);
        const justTakenBack =
          takenBackAt !== undefined &&
          this.now() - takenBackAt < CROSS_TAB_GRACE_MS;
        if (!ledger.upvotes.has(row.key) && !justTakenBack) {
          this.violations.push(`${person.name}: someone else's upvote ${row.key}`);
        }
      } else if (row.bucket === "myQuestions") {
        if (!ledger.asked.has(row.key)) {
          this.unsettledQuestions.push({ person, key: row.key });
        }
      } else if (row.bucket === "questions") {
        if (field(row.value, "status") === "dismissed" && !person.host) {
          this.violations.push(`${person.name}: dismissed question ${row.key}`);
        }
      }
    }
  }

  /** Judges the question rows that were waiting for an ack. */
  settleQuestions(): void {
    this.questionRowsJudgedLate += this.unsettledQuestions.length;
    for (const { person, key } of this.unsettledQuestions.splice(0)) {
      if (!this.ledgerOf(person).asked.has(key)) {
        this.violations.push(`${person.name}: someone else's question ${key}`);
      }
    }
  }

  private ledgerOf(person: AuditPerson): Ledger {
    let ledger = this.ledgers.get(person.key);
    if (!ledger) {
      ledger = {
        votes: new Set(),
        upvotes: new Set(),
        upvoteTakenBackAt: new Map(),
        asked: new Set(),
      };
      this.ledgers.set(person.key, ledger);
    }
    return ledger;
  }
}
