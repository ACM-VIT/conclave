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
  subject: Subject;
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
  private readonly receipts = new Map<string, Receipt>();
  private readonly perSubject = new Map<Subject, number>();
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

  /**
   * The stored answer for this id, or a conflict when the id was first used
   * for a different request. Null when the id is new.
   */
  replay(
    subject: Subject,
    operation: OperationId,
    digest: string,
  ): AuthorityResult<Json> | null {
    const receipt = this.receipts.get(this.keyOf(subject, operation));
    if (!receipt) return null;
    return receipt.digest === digest
      ? receipt.outcome
      : { ok: false, code: "operation-conflict" };
  }

  hasRoom(subject: Subject, now: number): boolean {
    if (now - this.lastSweepAt >= SWEEP_INTERVAL_MS) this.sweep(now);
    return (
      this.receipts.size < this.limits.receiptsPerInstance &&
      (this.perSubject.get(subject) ?? 0) < this.limits.receiptsPerSubject
    );
  }

  record(
    subject: Subject,
    operation: OperationId,
    digest: string,
    outcome: AuthorityResult<Json>,
  ): void {
    this.receipts.set(this.keyOf(subject, operation), {
      subject,
      digest,
      outcome,
      expiresAt: operation.issuedAtMs + this.limits.operationMaxAgeMs,
    });
    this.perSubject.set(subject, (this.perSubject.get(subject) ?? 0) + 1);
  }

  get size(): number {
    return this.receipts.size;
  }

  private sweep(now: number): void {
    this.lastSweepAt = now;
    for (const [key, receipt] of this.receipts) {
      if (receipt.expiresAt >= now) continue;
      this.receipts.delete(key);
      const held = (this.perSubject.get(receipt.subject) ?? 1) - 1;
      if (held <= 0) this.perSubject.delete(receipt.subject);
      else this.perSubject.set(receipt.subject, held);
    }
  }

  private keyOf(subject: Subject, operation: OperationId): string {
    return `${subject}\u0000${operation.issuedAtMs}\u0000${operation.nonce}`;
  }
}
