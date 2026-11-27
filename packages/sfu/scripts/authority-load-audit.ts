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
 * One upvote or take-back as the script saw it: when it left and when its
 * answer came. The server ran it at some moment between the two.
 */
type UpvoteRequest = {
  value: boolean;
  sentAt: number;
  ackedAt: number | null;
  ok: boolean | null;
};

/** What one person has done, across their tabs: the oracle for their rows. */
type Ledger = {
  votes: Set<string>;
  /** Questions the person holds an upvote on, as far as answers say. */
  upvoted: Set<string>;
  upvoteRequests: Map<string, UpvoteRequest[]>;
  asked: Set<string>;
};

/**
 * Whether the person could have held the upvote when the server sent a row
 * at `rowSentAt`. A row is judged by when it was sent, never by when it
 * arrived: a person's tabs are separate sockets with no order between them,
 * and a slow one can deliver a row long after another tab took the upvote
 * back.
 *
 * An upvote sent by then stood, unless a take-back that was sent after the
 * upvote's answer had itself been answered before the row left. Only then
 * is it certain the server ran the take-back second, and before the row.
 */
const couldHoldUpvote = (
  requests: readonly UpvoteRequest[],
  rowSentAt: number,
): boolean =>
  requests.some(
    (upvote) =>
      upvote.value &&
      upvote.ok !== false &&
      upvote.sentAt <= rowSentAt &&
      !requests.some(
        (back) =>
          !back.value &&
          back.ok === true &&
          upvote.ackedAt !== null &&
          back.sentAt >= upvote.ackedAt &&
          back.ackedAt !== null &&
          back.ackedAt < rowSentAt,
      ),
  );

const field = (value: Json, name: string): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? ((value as { readonly [key: string]: Json })[name] ?? null)
    : null;

export class LoadAudit {
  private readonly violations: string[] = [];
  private readonly ledgers = new Map<string, Ledger>();
  private readonly sharedPolls = new Set<string>();
  /**
   * Question rows that reached a person before the ack that names their new
   * question. Only the ack says which id is theirs, so these are judged once
   * every ack is in.
   */
  private readonly unsettledQuestions: { person: AuditPerson; key: string }[] = [];
  private questionRowsJudgedLate = 0;

  /**
   * `now` must be the clock the server stamps its frames with. The SFU under
   * measurement is a child process on this machine, so it is.
   */
  constructor(private readonly now: () => number = Date.now) {}

  /** Records a vote being sent. Returns whether it is the person's first on the poll. */
  vote(person: AuditPerson, pollId: string): boolean {
    const ledger = this.ledgerOf(person);
    const first = !ledger.votes.has(pollId);
    ledger.votes.add(pollId);
    return first;
  }

  /** Whether the person holds an upvote on the question, as far as answers say. */
  holdsUpvote(person: AuditPerson, questionId: string): boolean {
    return this.ledgerOf(person).upvoted.has(questionId);
  }

  /**
   * Records an upvote (`value` true) or a take-back being sent. Call it
   * before sending, because the row may arrive before the answer, and call
   * what it returns with the answer.
   */
  upvote(
    person: AuditPerson,
    questionId: string,
    value: boolean,
  ): (ok: boolean) => void {
    const ledger = this.ledgerOf(person);
    const request: UpvoteRequest = {
      value,
      sentAt: this.now(),
      ackedAt: null,
      ok: null,
    };
    const requests = ledger.upvoteRequests.get(questionId);
    if (requests) requests.push(request);
    else ledger.upvoteRequests.set(questionId, [request]);
    if (value) ledger.upvoted.add(questionId);
    return (ok) => {
      request.ackedAt = this.now();
      request.ok = ok;
      if (ok && !value) ledger.upvoted.delete(questionId);
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
      if (row.bucket === "results") {
        // Totals exist only for hosts until a host shares them.
        if (!person.host && !this.sharedPolls.has(row.key)) {
          this.violations.push(`${person.name}: private tally for poll ${row.key}`);
        }
      } else if (row.bucket === "myVotes") {
        if (!ledger.votes.has(row.key)) {
          this.violations.push(`${person.name}: someone else's ballot ${row.key}`);
        }
      } else if (row.bucket === "myUpvotes") {
        const requests = ledger.upvoteRequests.get(row.key) ?? [];
        if (!couldHoldUpvote(requests, frame.serverNowMs)) {
          this.violations.push(`${person.name}: someone else's upvote ${row.key}`);
        }
      } else if (row.bucket === "myQuestions") {
        // A question a host hid is nobody's to see but a host's, and a host
        // sees it in the shared list, never as a row of their own.
        const own = field(field(row.value, "hidden"), "question");
        if (field(own, "status") === "dismissed") {
          this.violations.push(`${person.name}: their own hidden question ${row.key}`);
        }
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

  /**
   * The verdict on every frame received so far. It first judges the question
   * rows that were waiting for an ack, so take it after the last wait: a row
   * that arrives later is not in it.
   */
  finish(): { violations: string[]; questionRowsJudgedLate: number } {
    this.questionRowsJudgedLate += this.unsettledQuestions.length;
    for (const { person, key } of this.unsettledQuestions.splice(0)) {
      if (!this.ledgerOf(person).asked.has(key)) {
        this.violations.push(`${person.name}: someone else's question ${key}`);
      }
    }
    return {
      violations: [...this.violations],
      questionRowsJudgedLate: this.questionRowsJudgedLate,
    };
  }

  private ledgerOf(person: AuditPerson): Ledger {
    let ledger = this.ledgers.get(person.key);
    if (!ledger) {
      ledger = {
        votes: new Set(),
        upvoted: new Set(),
        upvoteRequests: new Map(),
        asked: new Set(),
      };
      this.ledgers.set(person.key, ledger);
    }
    return ledger;
  }
}
