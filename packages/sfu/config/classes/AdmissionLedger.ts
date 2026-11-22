/**
 * What hosts decided about who may come into a room, kept as the latest
 * decision per principal and per scope, on the room's lobby clock.
 *
 * A principal is a guest pass (`pass:<proof>`) or a single user key
 * (`key:<userKey>`). Whether a join may pass the waiting room or the lock
 * is never stored as a flag: it is the latest decision across the
 * principals the join speaks for (see `admits`). Requests to be let in are
 * on the same clock, so a decision can be told apart from a request that
 * came after it (see `latestAnswer`).
 */
export type AdmissionScope = "waitingRoom" | "lock";

const SCOPES: readonly AdmissionScope[] = ["waitingRoom", "lock"];

type Mark = { admitted: boolean; at: number; userKeys: string[] };

type PrincipalRecord = {
  marks: Partial<Record<AdmissionScope, Mark>>;
  // The hosts' latest answer to a request: an admission or a denial. A
  // revocation is not an answer.
  answer?: { admitted: boolean; at: number };
};

const MAX_PRINCIPALS = 5000;

export class AdmissionLedger {
  private records = new Map<string, PrincipalRecord>();
  // When the room was last locked. A lock admission given before it no
  // longer lets anyone past the lock.
  private lockedAt = 0;

  admit(
    principal: string,
    userKey: string,
    scopes: readonly AdmissionScope[],
    at: number,
  ): void {
    const record = this.touch(principal);
    for (const scope of scopes) {
      const current = record.marks[scope];
      const stillAdmitted = current?.admitted && this.counts(scope, current);
      record.marks[scope] = {
        admitted: true,
        at,
        userKeys: stillAdmitted
          ? [...new Set([...current.userKeys, userKey])]
          : [userKey],
      };
    }
    record.answer = { admitted: true, at };
  }

  /** A host turned a request away. It also ends any admission. */
  deny(principal: string, at: number): void {
    const record = this.touch(principal);
    for (const scope of SCOPES) {
      record.marks[scope] = { admitted: false, at, userKeys: [] };
    }
    record.answer = { admitted: false, at };
  }

  /** An admission was taken back, as by a revocation, a removal or a block. */
  revoke(principal: string, scopes: readonly AdmissionScope[], at: number): void {
    const record = this.records.get(principal);
    if (!record) return;
    for (const scope of scopes) {
      record.marks[scope] = { admitted: false, at, userKeys: [] };
    }
  }

  /** Returns the keys whose lock admission this ends. */
  lockStarted(at: number): string[] {
    const ended = new Set<string>();
    for (const record of this.records.values()) {
      const mark = record.marks.lock;
      if (mark?.admitted && this.counts("lock", mark)) {
        for (const userKey of mark.userKeys) ended.add(userKey);
      }
    }
    this.lockedAt = at;
    return [...ended];
  }

  /** Whether the latest decision for `scope` across `principals` admits. */
  admits(principals: Iterable<string>, scope: AdmissionScope): boolean {
    let latest: Mark | undefined;
    for (const principal of principals) {
      const mark = this.records.get(principal)?.marks[scope];
      if (mark && this.counts(scope, mark) && (!latest || mark.at > latest.at)) {
        latest = mark;
      }
    }
    return latest?.admitted === true;
  }

  /** The hosts' latest answer across `principals`. */
  latestAnswer(
    principals: Iterable<string>,
  ): { admitted: boolean; at: number } | undefined {
    let latest: { admitted: boolean; at: number } | undefined;
    for (const principal of principals) {
      const answer = this.records.get(principal)?.answer;
      if (answer && (!latest || answer.at > latest.at)) latest = answer;
    }
    return latest;
  }

  has(principal: string): boolean {
    return this.records.has(principal);
  }

  /** Whether `principal` holds an admission that names `userKey`. */
  names(principal: string, userKey: string): boolean {
    const record = this.records.get(principal);
    if (!record) return false;
    return SCOPES.some((scope) => {
      const mark = record.marks[scope];
      return (
        mark?.admitted === true &&
        this.counts(scope, mark) &&
        mark.userKeys.includes(userKey)
      );
    });
  }

  /**
   * The user keys named by admissions that still let someone in for
   * `scope`, as `stillAdmits` judges each principal's guest.
   */
  admittedKeys(
    scope: AdmissionScope,
    stillAdmits: (principal: string) => boolean,
  ): string[] {
    const userKeys = new Set<string>();
    for (const [principal, record] of this.records) {
      const mark = record.marks[scope];
      if (!mark?.admitted || !this.counts(scope, mark)) continue;
      if (!stillAdmits(principal)) continue;
      for (const userKey of mark.userKeys) userKeys.add(userKey);
    }
    return [...userKeys];
  }

  clear(): void {
    this.records.clear();
    this.lockedAt = 0;
  }

  private counts(scope: AdmissionScope, mark: Mark): boolean {
    return scope !== "lock" || mark.at > this.lockedAt;
  }

  // Keeps the ledger bounded in a long-lived room. The record touched least
  // recently goes first, unless it still admits someone and another does not.
  private touch(principal: string): PrincipalRecord {
    const existing = this.records.get(principal);
    if (existing) {
      this.records.delete(principal);
      this.records.set(principal, existing);
      return existing;
    }
    if (this.records.size >= MAX_PRINCIPALS) this.evictOne();
    const record: PrincipalRecord = { marks: {} };
    this.records.set(principal, record);
    return record;
  }

  private evictOne(): void {
    for (const [principal, record] of this.records) {
      const admitsAnyone = SCOPES.some((scope) => record.marks[scope]?.admitted);
      if (!admitsAnyone) {
        this.records.delete(principal);
        return;
      }
    }
    const oldest = this.records.keys().next().value;
    if (oldest !== undefined) this.records.delete(oldest);
  }
}
