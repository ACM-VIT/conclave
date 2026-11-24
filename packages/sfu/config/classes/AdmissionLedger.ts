/**
 * What hosts decided about who may come into a room, kept as the latest
 * decision per principal and per scope, on the room's lobby clock.
 *
 * A principal is a guest pass (`pass:<proof>`) or a single user key
 * (`key:<userKey>`). Whether a join may pass the waiting room or the lock,
 * or go on stage in a webinar, is never stored as a flag: it is the latest
 * decision for that scope across the principals the join speaks for (see
 * `admits`). Every refusal a host makes is recorded, whether or not the
 * principal had a record, so a refusal made after an admission always wins.
 * Nothing a participant does adds a record: a refusal that follows from
 * one only rewrites records that exist (`recordedOnly`), and a decline only
 * takes back an invite (`consume`). Requests to be let in are on the same
 * clock, so a decision can be told apart from a request that came after it
 * (see `latestAnswer`).
 *
 * Scopes: `waitingRoom` and `lock` are admissions; `stage` is a webinar
 * stage invite, which expires; `stageDemotion` is a move back to the
 * audience, refused until a newer invite.
 */
export type AdmissionScope = "waitingRoom" | "lock" | "stage" | "stageDemotion";

const SCOPES: readonly AdmissionScope[] = [
  "waitingRoom",
  "lock",
  "stage",
  "stageDemotion",
];
// The scopes in which an admitted mark lets someone in. In `stageDemotion`
// it only says that a newer invite ended a demotion.
const RIGHTS: readonly AdmissionScope[] = ["waitingRoom", "lock", "stage"];

type Mark = {
  admitted: boolean;
  at: number;
  userKeys: string[];
  expiresAt?: number;
};

type PrincipalRecord = {
  marks: Partial<Record<AdmissionScope, Mark>>;
  // The hosts' latest answer to a request: an admission or a denial. A
  // revocation is not an answer.
  answer?: { admitted: boolean; at: number };
};

export class AdmissionLedger {
  // Oldest activity first: a record moves to the end whenever it changes.
  private records = new Map<string, PrincipalRecord>();
  // When the room was last locked. A lock admission given before it no
  // longer lets anyone past the lock.
  private lockedAt = 0;

  /**
   * `maxPrincipals` bounds the records in a long-lived room. `onEvicted`
   * hears the keys an evicted record named; `onFull` hears when an
   * admission could not be kept.
   */
  constructor(
    private readonly maxPrincipals: number,
    private readonly hooks: {
      onEvicted?: (userKeys: string[]) => void;
      onFull?: () => void;
    } = {},
  ) {}

  /**
   * Records an admission. Returns false when it could not be kept: the
   * ledger is full of refusals, and nothing changed.
   */
  admit(
    principal: string,
    userKey: string,
    scopes: readonly AdmissionScope[],
    at: number,
    options: { answersRequest?: boolean; expiresAt?: number } = {},
  ): boolean {
    return this.admitAll(
      [{ principal, userKey, scopes, expiresAt: options.expiresAt }],
      at,
      { answersRequest: options.answersRequest },
    );
  }

  /**
   * Records the admissions of one host action, all of them or none. When
   * the ledger has no room for the records they need (it would have to
   * drop a refusal, or one of these records), nothing changes and this
   * returns false.
   */
  admitAll(
    grants: ReadonlyArray<{
      principal: string;
      userKey: string;
      scopes: readonly AdmissionScope[];
      expiresAt?: number;
    }>,
    at: number,
    options: { answersRequest?: boolean } = {},
  ): boolean {
    const principals = new Set(grants.map((grant) => grant.principal));
    if (!this.hasRoomFor(principals)) {
      this.hooks.onFull?.();
      return false;
    }
    for (const grant of grants) {
      const record = this.touch(grant.principal, { refusal: false, keep: principals })!;
      for (const scope of grant.scopes) {
        const current = record.marks[scope];
        const stillAdmitted = current?.admitted && this.counts(scope, current);
        record.marks[scope] = {
          admitted: true,
          at,
          userKeys: stillAdmitted
            ? [...new Set([...current.userKeys, grant.userKey])]
            : [grant.userKey],
          ...(grant.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {}),
        };
      }
      if (options.answersRequest !== false) record.answer = { admitted: true, at };
    }
    return true;
  }

  // Whether records for all of `principals` fit. Only a new record needs
  // room: changing a record that exists, such as taking back a denial or
  // inviting a demoted guest again, always fits, even when refusals have
  // taken the ledger past its limit. A new record takes a free slot or one
  // that can be dropped for it: never a refusal, and never one of theirs.
  private hasRoomFor(principals: ReadonlySet<string>): boolean {
    let missing = 0;
    for (const principal of principals) {
      if (!this.records.has(principal)) missing += 1;
    }
    if (missing === 0) return true;
    let free = Math.max(0, this.maxPrincipals - this.records.size);
    if (missing <= free) return true;
    for (const [principal, record] of this.records) {
      if (principals.has(principal) || holdsRefusal(record)) continue;
      free += 1;
      if (missing <= free) return true;
    }
    return false;
  }

  /** A host turned a request away. It also ends any admission. */
  deny(principal: string, at: number): void {
    const record = this.touch(principal, { refusal: true })!;
    for (const scope of ["waitingRoom", "lock"] as const) {
      record.marks[scope] = { admitted: false, at, userKeys: [] };
    }
    record.answer = { admitted: false, at };
  }

  /**
   * Takes back what `principals` hold for `scopes`, as a revocation, a
   * removal, a block or a demotion does. Each principal gets the refusal
   * whether or not it had a record. The ones that had a record take it
   * first, so making room for the new ones never drops a record this
   * refusal is about. With `recordedOnly`, only principals that have a
   * record take it: a refusal that a participant's action sets off ends
   * what is there and adds nothing.
   */
  revoke(
    principals: Iterable<string>,
    scopes: readonly AdmissionScope[],
    at: number,
    options: { recordedOnly?: boolean } = {},
  ): void {
    const unique = [...new Set(principals)];
    const refuse = (record: PrincipalRecord) => {
      for (const scope of scopes) {
        record.marks[scope] = { admitted: false, at, userKeys: [] };
      }
    };
    for (const principal of unique.filter((one) => this.records.has(one))) {
      refuse(this.touch(principal, { refusal: true })!);
    }
    if (options.recordedOnly) return;
    for (const principal of unique.filter((one) => !this.records.has(one))) {
      refuse(this.touch(principal, { refusal: true })!);
    }
  }

  /**
   * Takes back the admissions `principals` hold for `scope` without a
   * refusal, as a guest who declines an invite does. A record left with
   * nothing goes. Returns the keys those admissions named.
   */
  consume(principals: Iterable<string>, scope: AdmissionScope): string[] {
    const named = new Set<string>();
    for (const principal of new Set(principals)) {
      const record = this.records.get(principal);
      const mark = record?.marks[scope];
      if (!record || !mark?.admitted) continue;
      for (const userKey of mark.userKeys) named.add(userKey);
      delete record.marks[scope];
      if (record.answer === undefined && Object.keys(record.marks).length === 0) {
        this.records.delete(principal);
      }
    }
    return [...named];
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

  /** Whether the latest decision for `scope` across `principals` refuses. */
  refuses(principals: Iterable<string>, scope: AdmissionScope): boolean {
    let latest: Mark | undefined;
    for (const principal of principals) {
      const mark = this.records.get(principal)?.marks[scope];
      if (mark && this.counts(scope, mark) && (!latest || mark.at > latest.at)) {
        latest = mark;
      }
    }
    return latest !== undefined && !latest.admitted;
  }

  namedKeys(principals: Iterable<string>, scope: AdmissionScope): string[] {
    const userKeys = new Set<string>();
    for (const principal of principals) {
      const mark = this.records.get(principal)?.marks[scope];
      if (!mark?.admitted || !this.counts(scope, mark)) continue;
      for (const userKey of mark.userKeys) userKeys.add(userKey);
    }
    return [...userKeys];
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

  /** Whether `principal` holds a refusal, which the ledger never drops. */
  holdsRefusalFor(principal: string): boolean {
    const record = this.records.get(principal);
    return record !== undefined && holdsRefusal(record);
  }

  get size(): number {
    return this.records.size;
  }

  /**
   * Whether `principal` holds a right that names `userKey`: an admission or
   * a stage invite that still counts.
   */
  names(principal: string, userKey: string): boolean {
    const record = this.records.get(principal);
    if (!record) return false;
    return RIGHTS.some((scope) => {
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
    if (scope === "lock") return mark.at > this.lockedAt;
    if (mark.expiresAt !== undefined) return mark.expiresAt > Date.now();
    return true;
  }

  /**
   * Keeps the ledger bounded in a long-lived room without ever letting
   * anyone in who would be refused with the whole history.
   *
   * A record that holds a refusal (a denial, a revocation, a removal or a
   * block) is never evicted: dropping it could make an older admission of
   * the same guest the latest decision again. Only records that hold
   * admissions or nothing are evicted, whole, the least recently active
   * first. Dropping an admission only ever makes a guest knock again. When
   * nothing can be evicted, a refusal is still recorded past the limit and
   * an admission is not (`undefined`).
   */
  private touch(
    principal: string,
    options: { refusal: boolean; keep?: ReadonlySet<string> },
  ): PrincipalRecord | undefined {
    const existing = this.records.get(principal);
    if (existing) {
      this.records.delete(principal);
      this.records.set(principal, existing);
      return existing;
    }
    if (this.records.size >= this.maxPrincipals && !this.evictOne(options.keep)) {
      if (!options.refusal) return undefined;
    }
    const record: PrincipalRecord = { marks: {} };
    this.records.set(principal, record);
    return record;
  }

  private evictOne(keep?: ReadonlySet<string>): boolean {
    for (const [principal, record] of this.records) {
      if (holdsRefusal(record) || keep?.has(principal)) continue;
      this.records.delete(principal);
      const named = SCOPES.flatMap((scope) => record.marks[scope]?.userKeys ?? []);
      if (named.length > 0) this.hooks.onEvicted?.([...new Set(named)]);
      return true;
    }
    return false;
  }
}

const holdsRefusal = (record: PrincipalRecord): boolean =>
  record.answer?.admitted === false ||
  SCOPES.some((scope) => record.marks[scope]?.admitted === false);
