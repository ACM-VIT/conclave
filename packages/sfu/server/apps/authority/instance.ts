import {
  boundedJsonBytes,
  SchemaError,
  type AuthorityFailure,
  type AuthorityGrants,
  type AuthorityResult,
  type Json,
  type OperationId,
} from "@conclave/apps-sdk/authority";
import type {
  ActionContext,
  AuthorityModule,
  AuthorityRandom,
  GateContext,
  IdentityRequirement,
  Role,
  RoomPolicy,
  RuntimeAction,
  RuntimeQuery,
  RuntimeTransaction,
  Subject,
  SubjectMerge,
  TimerContext,
} from "@conclave/apps-sdk/authority/server";
import { Logger } from "../../../utilities/loggers.js";
import type { AuthorityLimits } from "./limits.js";
import { RateBuckets } from "./rate.js";
import { ReceiptBook, requestDigest } from "./receipts.js";
import { AuthorityStore, type TransactionOutcome } from "./store.js";
import {
  ViewTracker,
  type CommittedView,
  type HeldRows,
  type LiveAudiences,
  type OwedCursor,
  type ViewFlush,
  type ViewOps,
  type ViewSnapshot,
} from "./views.js";

/** One person on one connection, as the host resolved them just now. */
export type Actor = {
  subject: Subject;
  role: Role;
  /** Whether the subject is a stable identity the server can vouch for. */
  verified: boolean;
  displayName: string;
};

export type InstanceOptions = {
  limits: AuthorityLimits;
  random: AuthorityRandom;
  /** Recompute every view after each flush and throw on drift. */
  verifyViews: boolean;
};

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 12;

const failure = (
  code: AuthorityFailure["code"],
  extra?: { reason?: string; retryAfterMs?: number },
): AuthorityFailure => ({ ok: false, code, ...extra });

/** Anything but a plain `any` asks for a verified identity. */
const identityOf = (
  action: RuntimeAction,
  ctx: GateContext,
): IdentityRequirement => {
  const wanted =
    typeof action.identity === "function"
      ? action.identity(ctx)
      : action.identity;
  return wanted === "any" ? "any" : "verified";
};

/**
 * What a handler returned, once it is known to have finished. A handler runs
 * inside one transaction and must be done when it returns. One that hands
 * back a promise is still working: its writes so far would commit without
 * the rest, and a later failure would reach nobody. That is a fault, so
 * nothing it staged is kept.
 */
const finished = <Value>(value: Value, handler: string): Value => {
  const pending = value as { then?: unknown } | null | undefined;
  if (typeof pending?.then !== "function") return value;
  // Nobody waits for the promise, so its rejection must not go unhandled.
  void Promise.resolve(value).catch(() => {});
  throw new Error(
    `${handler} returned a promise. A handler must finish before it returns.`,
  );
};

/**
 * One app running in one room: its rows, its views, its receipts and its
 * budgets. Every guard the app's author does not write lives here, in the
 * order a request meets them.
 */
export class AuthorityInstance {
  readonly store: AuthorityStore;
  private readonly views: ViewTracker;
  private readonly receipts: ReceiptBook;
  private readonly rates: RateBuckets;

  constructor(
    readonly id: string,
    readonly module: AuthorityModule,
    policy: RoomPolicy,
    private readonly options: InstanceOptions,
  ) {
    this.store = new AuthorityStore(module.runtime, options.limits);
    this.views = new ViewTracker(module.runtime, this.store, policy, {
      verify: options.verifyViews,
      clearedRowsPerFlush: options.limits.clearedRowsPerFlush,
    });
    this.receipts = new ReceiptBook(options.limits);
    this.rates = new RateBuckets(options.limits.rateBuckets);
  }

  get appId(): string {
    return this.module.contract.id;
  }

  get policy(): RoomPolicy {
    return this.views.currentPolicy;
  }

  setPolicy(policy: RoomPolicy): void {
    this.views.setPolicy(policy);
  }

  canView(actor: Actor): boolean {
    // Only a plain `true` admits. A rule that answers with anything else,
    // such as the promise an `async` rule returns, admits nobody.
    return (
      this.module.runtime.canView(
        { role: actor.role, verified: actor.verified },
        this.policy,
      ) === true
    );
  }

  /** What this actor may call right now, for the renderer's controls. */
  grants(actor: Actor, now: number): AuthorityGrants {
    const ctx = this.gateContext(actor, now);
    const grants: AuthorityGrants = { actions: [], needsIdentity: [], queries: [] };
    for (const [name, action] of Object.entries(this.module.runtime.actions)) {
      if (!this.passesGate(action, ctx)) continue;
      if (identityOf(action, ctx) === "verified" && !actor.verified) {
        grants.needsIdentity.push(name);
      } else {
        grants.actions.push(name);
      }
    }
    for (const [name, query] of Object.entries(this.module.runtime.queries)) {
      if (this.passesGate(query, ctx)) grants.queries.push(name);
    }
    return grants;
  }

  /**
   * Runs one action for an actor the host has already bound to a live
   * connection. `operation` is absent only for trusted in-process callers
   * that have no retry channel, such as an adapter for a legacy event.
   */
  act(
    actor: Actor,
    name: string,
    rawInput: unknown,
    operation: OperationId | null,
    now: number,
  ): AuthorityResult<Json> {
    const action = Object.hasOwn(this.module.runtime.actions, name)
      ? this.module.runtime.actions[name]
      : undefined;
    const spec = action ? this.module.contract.actions[name] : undefined;
    if (!action || !spec) return failure("forbidden");
    if (!this.canView(actor)) return failure("forbidden");

    const saved = operation && this.savedAnswer(actor, name, spec.input, rawInput, operation, now);
    if (saved) return saved;

    const ctx = this.gateContext(actor, now);
    if (!this.passesGate(action, ctx)) return failure("forbidden");
    if (identityOf(action, ctx) === "verified" && !actor.verified) {
      return failure("identity-required");
    }

    const parsed = this.parseInput(spec.input, rawInput);
    if (!parsed.ok) return parsed;

    let digest = "";
    if (operation) {
      const outside = this.receipts.window(operation, now);
      if (outside) return outside;
      digest = requestDigest(name, parsed.value);
    }

    const limited = this.rates.take(
      `${actor.subject}\u0000act\u0000${name}`,
      action.rate,
      now,
    );
    if (!limited.ok) {
      return failure("rate-limited", { retryAfterMs: limited.retryAfterMs });
    }
    if (operation && !this.receipts.hasRoom(actor.subject, now)) {
      return failure("capacity");
    }

    // The app's budget of accepted mutations is held twice: once for
    // moderators and once for everyone else. However much a crowd asks for,
    // it spends only its own, and a host can still run the session.
    const budget = this.rates.take(
      actor.role === "moderator"
        ? "\u0000mutations\u0000moderators"
        : "\u0000mutations",
      {
        burst: this.options.limits.mutationBurst,
        perSecond: this.options.limits.mutationsPerSecond,
      },
      now,
    );
    if (!budget.ok) {
      return failure("busy", { retryAfterMs: budget.retryAfterMs });
    }

    const writeContext: ActionContext = {
      ...ctx,
      random: this.options.random,
      nextId: (prefix) => this.nextId(prefix),
    };
    const outcome = this.transact((tx) =>
      spec.receipt.parse(
        finished(action.run(writeContext, tx, parsed.value), `Action ${name}`),
        "strict",
        `${name} receipt`,
      ),
    );

    let result: AuthorityResult<Json>;
    if (outcome.ok) {
      result = { ok: true, value: outcome.value as Json };
    } else if (outcome.kind === "rejected") {
      result = failure("rejected", { reason: outcome.reason });
    } else if (outcome.kind === "capacity") {
      result = failure("capacity");
    } else {
      Logger.error(
        `[Authority] ${this.appId}: action ${name} failed`,
        outcome.error,
      );
      // A fault is not a decision about the request, so it is not recorded
      // and a retry of the same id may run.
      return failure("app-fault");
    }
    if (operation) {
      this.receipts.record(actor.subject, operation, digest, result);
    }
    return result;
  }

  keepsAnswer(actor: Actor, operation: OperationId): boolean {
    return this.receipts.holds(actor.subject, operation);
  }

  private savedAnswer(
    actor: Actor,
    name: string,
    schema: { parse(input: unknown, mode?: "strip" | "strict"): unknown },
    rawInput: unknown,
    operation: OperationId,
    now: number,
  ): AuthorityResult<Json> | null {
    if (!this.receipts.holds(actor.subject, operation)) return null;
    const outside = this.receipts.window(operation, now);
    if (outside) return outside;
    const parsed = this.parseInput(schema, rawInput);
    if (!parsed.ok) return parsed;
    return this.receipts.replay(actor.subject, operation, requestDigest(name, parsed.value));
  }

  /** A one-shot read for the caller alone. Changes nothing. */
  query(
    actor: Actor,
    name: string,
    rawInput: unknown,
    now: number,
  ): AuthorityResult<Json> {
    const query = Object.hasOwn(this.module.runtime.queries, name)
      ? this.module.runtime.queries[name]
      : undefined;
    const spec = query ? this.module.contract.queries[name] : undefined;
    if (!query || !spec) return failure("forbidden");

    const ctx = this.gateContext(actor, now);
    if (!this.canView(actor) || !this.passesGate(query, ctx)) {
      return failure("forbidden");
    }
    const limited = this.rates.take(
      `${actor.subject}\u0000query\u0000${name}`,
      query.rate,
      now,
    );
    if (!limited.ok) {
      return failure("rate-limited", { retryAfterMs: limited.retryAfterMs });
    }
    const parsed = this.parseInput(spec.input, rawInput);
    if (!parsed.ok) return parsed;

    const outcome = this.store.read((db) =>
      spec.output.parse(
        finished(query.read(ctx, db, parsed.value), `Query ${name}`),
        "strict",
        `${name} output`,
      ),
    );
    if (!outcome.ok) {
      if (outcome.kind === "rejected") {
        return failure("rejected", { reason: outcome.reason });
      }
      if (outcome.kind === "capacity") return failure("capacity");
      Logger.error(
        `[Authority] ${this.appId}: query ${name} failed`,
        outcome.error,
      );
      return failure("app-fault");
    }
    const output = outcome.value;
    const limit = this.options.limits.snapshotBytes;
    if (boundedJsonBytes(output, limit) > limit) return failure("too-large");
    return { ok: true, value: output as Json };
  }

  nextTimerAt(): number | null {
    return this.store.nextTimerAt();
  }

  /**
   * Runs the timers that are due, each in its own transaction. A timer is
   * consumed when it runs, whatever its handler does, so a faulty handler
   * cannot fire forever. Returns whether any row changed.
   */
  runDueTimers(now: number): boolean {
    let changed = false;
    const due = this.store.dueTimers(now, this.options.limits.timersPerWake);
    for (const timer of due) {
      // An earlier timer in this batch may have cancelled or replaced it.
      if (this.store.committedTimer(timer.key) !== timer) continue;
      const handler = this.module.runtime.onTimer[timer.kind];
      const ctx: TimerContext = {
        room: this.policy,
        now,
        random: this.options.random,
        nextId: (prefix) => this.nextId(prefix),
      };
      const outcome = this.transact((tx) => {
        tx.cancelTimer(timer.key);
        finished(handler(ctx, tx, timer.payload), `Timer ${timer.kind}`);
      });
      if (outcome.ok) {
        changed = changed || outcome.changed;
        continue;
      }
      if (outcome.kind === "fault") {
        Logger.error(
          `[Authority] ${this.appId}: timer ${timer.kind} failed`,
          outcome.error,
        );
      }
      // The handler's writes were dropped; still consume the timer.
      this.transact((tx) => tx.cancelTimer(timer.key));
    }
    return changed;
  }

  mergeSubjects(merge: SubjectMerge, now: number): boolean {
    const handler = this.module.runtime.mergeSubjects;
    const ctx: TimerContext = {
      room: this.policy,
      now,
      random: this.options.random,
      nextId: (prefix) => this.nextId(prefix),
    };
    const outcome = this.transact((tx) => {
      if (handler) finished(handler(ctx, tx, merge), "Subject merge");
    });
    if (!outcome.ok) {
      Logger.error(
        `[Authority] ${this.appId}: merging two subjects failed (${outcome.kind})`,
        outcome.kind === "fault" ? outcome.error : outcome,
      );
      return false;
    }
    this.receipts.merge(merge.from, merge.into);
    return outcome.changed;
  }

  /**
   * Runs one transaction, and takes what it committed into the views at
   * once, so they are always the committed rows.
   */
  private transact<R>(run: (tx: RuntimeTransaction) => R): TransactionOutcome<R> {
    const outcome = this.store.transact(run);
    this.views.takeIn();
    return outcome;
  }

  /**
   * Whether a viewer whose snapshot was read at `version`, got to `owed` in
   * the rows clears took, holds anything other than what was committed.
   */
  pendingSince(actor: Actor, version: number, owed: OwedCursor): boolean {
    return this.views.pendingSince(actor.role, actor.subject, version, owed);
  }

  /** The rows clears took that such a viewer is told of now, and where it then is. */
  owedFor(
    actor: Actor,
    version: number,
    owed: OwedCursor,
  ): { ops: ViewOps | undefined; next: OwedCursor; more: boolean } {
    return this.views.owedFor(actor.role, actor.subject, version, owed);
  }

  /** Where a viewer whose view is the committed rows now starts in rows clears took. */
  owedEnd(actor: Actor): OwedCursor {
    return this.views.owedEnd(actor.role, actor.subject);
  }

  /** Lets go of rows clears took that every viewer of an audience has passed. */
  settleOwed(least: {
    roles: ReadonlyMap<Role, number>;
    subjects: ReadonlyMap<Subject, number>;
  }): void {
    this.views.settleOwed(least);
  }

  /** Whether some viewer may still be owed a row a clear took. */
  get hasOwedRows(): boolean {
    return this.views.hasOwed;
  }

  /** Changed or owed rows the views' checks have looked at, to bound their cost. */
  get viewWork(): number {
    return this.views.examined;
  }

  /** Rows the views have yet to take in, or viewers have yet to be told of. */
  get hasPendingChanges(): boolean {
    return this.store.hasDirty || this.views.hasUntold;
  }

  flushViews(live: LiveAudiences): ViewFlush {
    return this.views.flush(live);
  }

  /** Forgets the views of everyone but these audiences. */
  keepViews(live: LiveAudiences): void {
    this.views.keep(live);
  }

  /** How many audiences' views are kept. */
  get viewsHeld(): { roles: number; subjects: number } {
    return this.views.held;
  }

  /** One viewer's rows as committed right now, for reading at once. */
  committedView(actor: Actor): CommittedView {
    return this.views.committed(actor.role, actor.subject);
  }

  /** One viewer's rows worked out afresh from the tables, touching no cache. */
  projectedView(actor: Actor): CommittedView {
    return this.views.projectedFor(actor.role, actor.subject);
  }

  /** The bytes one viewer's view as committed now takes in a snapshot's rows. */
  viewBytes(actor: Actor): number {
    return this.views.viewBytes(actor.role, actor.subject);
  }

  /** A whole view for one audience: its role's rows and its own. */
  snapshot(actor: Actor): ViewSnapshot {
    return this.views.snapshot(actor.role, actor.subject);
  }

  /** What a viewer holding `held` must be told to be up to date, read now. */
  catchUp(actor: Actor, held: HeldRows): { ops: ViewOps; version: number } {
    return this.views.catchUp(actor.role, actor.subject, held);
  }

  /** Whether the actor could run this query right now. Spends no budget. */
  mayQuery(actor: Actor, name: string, now: number): boolean {
    const query = Object.hasOwn(this.module.runtime.queries, name)
      ? this.module.runtime.queries[name]
      : undefined;
    return Boolean(
      query &&
        this.canView(actor) &&
        this.passesGate(query, this.gateContext(actor, now)),
    );
  }

  private gateContext(actor: Actor, now: number): GateContext {
    return {
      subject: actor.subject,
      role: actor.role,
      verified: actor.verified,
      displayName: actor.displayName,
      room: this.policy,
      now,
    };
  }

  private passesGate(gate: RuntimeAction | RuntimeQuery, ctx: GateContext): boolean {
    if (!gate.roles.includes(ctx.role)) return false;
    try {
      return gate.when ? gate.when(ctx) === true : true;
    } catch (error) {
      Logger.error(`[Authority] ${this.appId}: a gate failed`, error);
      return false;
    }
  }

  private parseInput(
    schema: { parse(input: unknown, mode?: "strip" | "strict"): unknown },
    rawInput: unknown,
  ): { ok: true; value: unknown } | AuthorityFailure {
    const limit = this.options.limits.commandBytes;
    if (boundedJsonBytes(rawInput ?? null, limit) > limit) {
      return failure("too-large");
    }
    try {
      return { ok: true, value: schema.parse(rawInput, "strip") };
    } catch (error) {
      if (error instanceof SchemaError) return failure("invalid-input");
      throw error;
    }
  }

  private nextId(prefix = ""): string {
    let id = prefix;
    for (let index = 0; index < ID_LENGTH; index += 1) {
      id += ID_ALPHABET[this.options.random.int(ID_ALPHABET.length)];
    }
    return id;
  }
}
