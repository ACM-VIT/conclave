import { createHash } from "node:crypto";
import type {
  AuthorityFailure,
  AuthorityResult,
  Json,
  OperationId,
} from "@conclave/apps-sdk/authority";
import type { Subject } from "@conclave/apps-sdk/authority/server";
import type { AuthorityLimits } from "./limits.js";

type Receipt = {
  digest: string;
  outcome: AuthorityResult<Json>;
  expiresAt: number;
};

const NONCE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const SWEEP_INTERVAL_MS = 1_000;

export const parseOperationId = (value: unknown): OperationId | null => {
  if (!value || typeof value !== "object") return null;
  const { issuedAtMs, nonce } = value as { issuedAtMs?: unknown; nonce?: unknown };
  if (typeof issuedAtMs !== "number" || !Number.isSafeInteger(issuedAtMs)) {
    return null;
  }
  if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) return null;
  return { issuedAtMs, nonce };
};

/** What a retry must repeat exactly: the action and its parsed input. */
export const requestDigest = (action: string, input: unknown): string =>
  createHash("sha256")
    .update(action)
    .update("\u0000")
    .update(JSON.stringify(input) ?? "")
    .digest("base64");

/**
 * Remembers the answer to each operation for as long as its id is valid, so
 * a retry gets the first answer and never runs twice.
 *
 * An id is valid from its issue time for `operationMaxAgeMs`. A receipt is
 * kept for exactly that long and is never dropped early to make room, so
 * there is no window in which a still-valid id could run again. When the
 * book is full, new operations are refused. Once an id has expired it is
 * refused outright, whether or not its receipt is still here.
 */
export class ReceiptBook {
  private readonly bySubject = new Map<Subject, Map<string, Receipt>>();
  private count = 0;
  private lastSweepAt = 0;

  constructor(private readonly limits: AuthorityLimits) {}

  /** Refuses an id whose issue time is outside the window around `now`. */
  window(operation: OperationId, now: number): AuthorityFailure | null {
    if (operation.issuedAtMs > now + this.limits.operationMaxSkewMs) {
      return { ok: false, code: "invalid-operation" };
    }
    if (operation.issuedAtMs < now - this.limits.operationMaxAgeMs) {
      return { ok: false, code: "operation-expired" };
    }
    return null;
  }

  holds(subject: Subject, operation: OperationId): boolean {
    return this.bySubject.get(subject)?.has(keyOf(operation)) === true;
  }

  /**
   * The stored answer for this id, or a conflict when the id was first used
   * for a different request. Null when the id is new.
   */
  replay(
    subject: Subject,
    operation: OperationId,
    digest: string,
  ): AuthorityResult<Json> | null {
    const receipt = this.bySubject.get(subject)?.get(keyOf(operation));
    if (!receipt) return null;
    return receipt.digest === digest
      ? receipt.outcome
      : { ok: false, code: "operation-conflict" };
  }

  hasRoom(subject: Subject, now: number): boolean {
    if (now - this.lastSweepAt >= SWEEP_INTERVAL_MS) this.sweep(now);
    else this.sweepSubject(subject, now);
    return (
      this.count < this.limits.receiptsPerInstance &&
      (this.bySubject.get(subject)?.size ?? 0) < this.limits.receiptsPerSubject
    );
  }

  record(
    subject: Subject,
    operation: OperationId,
    digest: string,
    outcome: AuthorityResult<Json>,
  ): void {
    let receipts = this.bySubject.get(subject);
    if (!receipts) {
      receipts = new Map();
      this.bySubject.set(subject, receipts);
    }
    const key = keyOf(operation);
    if (!receipts.has(key)) this.count += 1;
    receipts.set(key, {
      digest,
      outcome,
      expiresAt: operation.issuedAtMs + this.limits.operationMaxAgeMs,
    });
  }

  mergeFits(merges: readonly { from: Subject; into: Subject }[], now: number): boolean {
    const keys = new Map<Subject, Set<string>>();
    const keysOf = (subject: Subject): Set<string> => {
      let held = keys.get(subject);
      if (!held) {
        this.sweepSubject(subject, now);
        held = new Set(this.bySubject.get(subject)?.keys() ?? []);
        keys.set(subject, held);
      }
      return held;
    };
    for (const { from, into } of merges) {
      const kept = keysOf(into);
      for (const key of keysOf(from)) kept.add(key);
      keys.set(from, new Set());
      if (kept.size > this.limits.receiptsPerSubject) return false;
    }
    return true;
  }

  merge(from: Subject, into: Subject): void {
    const moving = this.bySubject.get(from);
    if (!moving) return;
    this.bySubject.delete(from);
    const kept = this.bySubject.get(into);
    if (!kept) {
      this.bySubject.set(into, moving);
      return;
    }
    for (const [key, receipt] of moving) {
      if (kept.has(key)) this.count -= 1;
      else kept.set(key, receipt);
    }
  }

  get size(): number {
    return this.count;
  }

  sweep(now: number): void {
    this.lastSweepAt = now;
    for (const subject of [...this.bySubject.keys()]) this.sweepSubject(subject, now);
  }

  private sweepSubject(subject: Subject, now: number): void {
    const receipts = this.bySubject.get(subject);
    if (!receipts) return;
    for (const [key, receipt] of receipts) {
      if (receipt.expiresAt >= now) continue;
      receipts.delete(key);
      this.count -= 1;
    }
    if (receipts.size === 0) this.bySubject.delete(subject);
  }
}

const keyOf = (operation: OperationId): string =>
  `${operation.issuedAtMs}\u0000${operation.nonce}`;
