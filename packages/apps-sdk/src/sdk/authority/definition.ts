import type {
  ActionInput,
  ActionName,
  ActionReceipt,
  AuthorityContract,
  QueryInput,
  QueryName,
  QueryOutput,
  ViewName,
  ViewRow,
} from "#authority/contract";
import type { Infer, Schema } from "#authority/schema";

declare const subjectBrand: unique symbol;
/**
 * Who a person is to an app: opaque, scoped to one room, and derived by the
 * server. A client can neither choose it nor learn anyone else's.
 */
export type Subject = string & { readonly [subjectBrand]: true };

declare const tableKeyBrand: unique symbol;
export type TableKey = string & { readonly [tableKeyBrand]: true };

const KEY_SEPARATOR = "\u001f";
const MAX_KEY_LENGTH = 256;

/**
 * A row key from its parts. `key(pollId, subject)` is one ballot, and
 * `key(pollId)` is the prefix that scans every ballot of that poll.
 */
export const key = (...parts: readonly string[]): TableKey => {
  if (parts.length === 0) throw new Error("A key needs at least one part");
  for (const part of parts) {
    if (typeof part !== "string" || part.length === 0) {
      throw new Error("Key parts must be non-empty strings");
    }
    if (part.includes(KEY_SEPARATOR)) {
      throw new Error("Key parts may not contain the unit separator");
    }
  }
  const joined = parts.join(KEY_SEPARATOR);
  if (joined.length > MAX_KEY_LENGTH) throw new Error("Key is too long");
  return joined as TableKey;
};

/** The first part of a key: the group prefix scans are indexed by. */
export const keyGroup = (tableKey: TableKey): string => {
  const end = tableKey.indexOf(KEY_SEPARATOR);
  return end === -1 ? tableKey : tableKey.slice(0, end);
};

export const keyHasPrefix = (tableKey: TableKey, prefix: TableKey): boolean =>
  tableKey === prefix || tableKey.startsWith(prefix + KEY_SEPARATOR);

/**
 * The audience classes. A moderator is a host or co-host. An attendee is a
 * webinar viewer. An observer watches without a seat. Everyone else is a
 * member.
 */
export const AUTHORITY_ROLES = [
  "moderator",
  "member",
  "attendee",
  "observer",
] as const;
export type Role = (typeof AUTHORITY_ROLES)[number];

export type RoomPolicy = {
  readonly mode: "meeting" | "webinar";
  /** Whether the host has webinar Q&A turned on. */
  readonly qaEnabled: boolean;
};

export type Viewer = {
  readonly role: Role;
  /** Whether the server can vouch that this is one stable person. */
  readonly verified: boolean;
};

export type TableSpec<Row extends object> = {
  readonly maxRows: number;
  readonly maxRowBytes: number;
  /** Type carrier only. Never set. */
  readonly row?: Row;
};

const DEFAULT_MAX_ROW_BYTES = 16 * 1024;

export const table = <Row extends object>(options: {
  maxRows: number;
  maxRowBytes?: number;
}): TableSpec<Row> => ({
  maxRows: options.maxRows,
  maxRowBytes: options.maxRowBytes ?? DEFAULT_MAX_ROW_BYTES,
});

export type Tables = Record<string, TableSpec<object>>;
type TimerSchemas = Record<string, Schema<unknown>>;
type RowOf<T extends Tables, K extends keyof T> =
  T[K] extends TableSpec<infer Row> ? Row : never;
type TableName<T extends Tables> = keyof T & string;

export interface AuthorityRead<T extends Tables> {
  get<K extends TableName<T>>(
    table: K,
    key: TableKey,
  ): Readonly<RowOf<T, K>> | undefined;
  count<K extends TableName<T>>(table: K, prefix?: TableKey): number;
  /** Rows under `prefix`, oldest insert first. Bounded by the table's cap. */
  scan<K extends TableName<T>>(
    table: K,
    prefix?: TableKey,
  ): readonly (readonly [TableKey, Readonly<RowOf<T, K>>])[];
}

/**
 * Staged writes over committed rows. Everything commits together when the
 * handler returns, or nothing does when it rejects or throws.
 */
export interface AuthorityTransaction<
  T extends Tables,
  Timers extends TimerSchemas,
> extends AuthorityRead<T> {
  /**
   * Writes the row only when no row has this key. This is how "once per
   * person" is said: key the row by the subject and a second insert reports
   * `exists`.
   */
  insertIfAbsent<K extends TableName<T>>(
    table: K,
    key: TableKey,
    row: RowOf<T, K>,
  ): "inserted" | "exists";
  put<K extends TableName<T>>(table: K, key: TableKey, row: RowOf<T, K>): void;
  delete<K extends TableName<T>>(table: K, key: TableKey): boolean;
  /** One timer per key. Scheduling the key again replaces it. */
  schedule<K extends keyof Timers & string>(
    kind: K,
    key: TableKey,
    atMs: number,
    payload: Infer<Timers[K]>,
  ): void;
  cancelTimer(key: TableKey): boolean;
}

export type AuthorityRandom = {
  /** A float in [0, 1). */
  next(): number;
  /** An unbiased integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  shuffle<V>(list: readonly V[]): V[];
};

export type GateContext = {
  readonly subject: Subject;
  readonly role: Role;
  readonly verified: boolean;
  /** The name the server accepted for this person. */
  readonly displayName: string;
  readonly room: RoomPolicy;
  /** The server clock, in ms. */
  readonly now: number;
};

export type ActionContext = GateContext & {
  readonly random: AuthorityRandom;
  /** A fresh opaque id. It says nothing about how many came before. */
  nextId(prefix?: string): string;
};

export type TimerContext = {
  readonly room: RoomPolicy;
  readonly now: number;
  readonly random: AuthorityRandom;
  nextId(prefix?: string): string;
};

export type RateLimit = { burst: number; perSecond: number };

/**
 * `verified` needs a subject the server can vouch for as one stable person,
 * which is what a once-per-person rule rests on. `any` also admits a
 * connection that has only a per-session identity, such as a guest without a
 * verified pass.
 */
export type IdentityRequirement = "verified" | "any";

type Gate = {
  /** Checked by the host before any app code runs. */
  roles: readonly Role[];
  /** A further host-checked condition, such as "Q&A is on". */
  when?(ctx: GateContext): boolean;
  rate: RateLimit;
};

export type ActionDefinition<
  Input,
  Receipt,
  T extends Tables,
  Timers extends TimerSchemas,
> = Gate & {
  /** Defaults to `verified`. */
  identity?: IdentityRequirement | ((ctx: GateContext) => IdentityRequirement);
  run(
    ctx: ActionContext,
    tx: AuthorityTransaction<T, Timers>,
    input: Input,
  ): Receipt;
};

export type QueryDefinition<Input, Output, T extends Tables> = Gate & {
  read(ctx: GateContext, db: AuthorityRead<T>, input: Input): Output;
};

type Projected<Out> = { key: string; value: Out } | null;

/**
 * A shared view is projected once per audience class and cannot see who is
 * looking. A personal view belongs to the subject `owner` names and reaches
 * every connection of that subject, and no one else.
 */
export type ViewDefinition<T extends Tables, Out> = {
  [K in TableName<T>]:
    | {
        kind: "shared";
        source: K;
        project(
          row: Readonly<RowOf<T, K>>,
          role: Role,
          room: RoomPolicy,
        ): Projected<Out>;
      }
    | {
        kind: "personal";
        source: K;
        owner(row: Readonly<RowOf<T, K>>): Subject;
        project(row: Readonly<RowOf<T, K>>, room: RoomPolicy): Projected<Out>;
      };
}[TableName<T>];

export type AuthorityDefinition<
  C extends AuthorityContract,
  T extends Tables,
  Timers extends TimerSchemas,
> = {
  contract: C;
  tables: T;
  /** Payload schema per timer kind. */
  timers: Timers;
  /** Who may subscribe at all. Checked on every request and every emit. */
  canView(viewer: Viewer, room: RoomPolicy): boolean;
  actions: {
    [K in ActionName<C>]: ActionDefinition<
      ActionInput<C, K>,
      ActionReceipt<C, K>,
      T,
      Timers
    >;
  };
  queries: {
    [K in QueryName<C>]: QueryDefinition<
      QueryInput<C, K>,
      QueryOutput<C, K>,
      T
    >;
  };
  onTimer: {
    [K in keyof Timers & string]: (
      ctx: TimerContext,
      tx: AuthorityTransaction<T, Timers>,
      payload: Infer<Timers[K]>,
    ) => void;
  };
  views: { [K in ViewName<C>]: ViewDefinition<T, ViewRow<C, K>> };
};

/* ---- What the host runs: the same definition with its types erased. ---- */

export interface RuntimeRead {
  get(table: string, key: TableKey): object | undefined;
  count(table: string, prefix?: TableKey): number;
  scan(table: string, prefix?: TableKey): readonly (readonly [TableKey, object])[];
}

export interface RuntimeTransaction extends RuntimeRead {
  insertIfAbsent(table: string, key: TableKey, row: object): "inserted" | "exists";
  put(table: string, key: TableKey, row: object): void;
  delete(table: string, key: TableKey): boolean;
  schedule(kind: string, key: TableKey, atMs: number, payload: unknown): void;
  cancelTimer(key: TableKey): boolean;
}

export type RuntimeAction = Gate & {
  identity?: IdentityRequirement | ((ctx: GateContext) => IdentityRequirement);
  run(ctx: ActionContext, tx: RuntimeTransaction, input: unknown): unknown;
};

export type RuntimeQuery = Gate & {
  read(ctx: GateContext, db: RuntimeRead, input: unknown): unknown;
};

export type RuntimeView =
  | {
      kind: "shared";
      source: string;
      project(row: object, role: Role, room: RoomPolicy): Projected<unknown>;
    }
  | {
      kind: "personal";
      source: string;
      owner(row: object): Subject;
      project(row: object, room: RoomPolicy): Projected<unknown>;
    };

export type RuntimeDefinition = {
  contract: AuthorityContract;
  tables: Record<string, { maxRows: number; maxRowBytes: number }>;
  timers: TimerSchemas;
  canView(viewer: Viewer, room: RoomPolicy): boolean;
  actions: Record<string, RuntimeAction>;
  queries: Record<string, RuntimeQuery>;
  onTimer: Record<
    string,
    (ctx: TimerContext, tx: RuntimeTransaction, payload: unknown) => void
  >;
  views: Record<string, RuntimeView>;
};

/** A server module: typed for its author, erased for the host. */
export type AuthorityModule<C extends AuthorityContract = AuthorityContract> = {
  readonly contract: C;
  readonly runtime: RuntimeDefinition;
};

const sameKeys = (kind: string, expected: string[], actual: string[]): void => {
  const missing = expected.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !expected.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${kind} do not match the contract (missing: ${missing.join(", ") || "none"}; not in contract: ${extra.join(", ") || "none"})`,
    );
  }
};

const assertGate = (label: string, gate: Gate): void => {
  if (gate.roles.length === 0) {
    throw new Error(`${label}: name at least one role`);
  }
  for (const role of gate.roles) {
    if (!AUTHORITY_ROLES.includes(role)) {
      throw new Error(`${label}: unknown role "${String(role)}"`);
    }
  }
  if (!(gate.rate.burst >= 1) || !(gate.rate.perSecond > 0)) {
    throw new Error(`${label}: rate needs a burst of 1 or more and a refill`);
  }
};

export const defineAuthority = <
  C extends AuthorityContract,
  const T extends Tables,
  const Timers extends TimerSchemas,
>(
  definition: AuthorityDefinition<C, T, Timers>,
): AuthorityModule<C> => {
  // The one place the author's types are erased for the host.
  const runtime = definition as unknown as RuntimeDefinition;
  const appId = runtime.contract.id;

  sameKeys(
    `App ${appId}: actions`,
    Object.keys(runtime.contract.actions),
    Object.keys(runtime.actions),
  );
  sameKeys(
    `App ${appId}: queries`,
    Object.keys(runtime.contract.queries),
    Object.keys(runtime.queries),
  );
  sameKeys(
    `App ${appId}: views`,
    Object.keys(runtime.contract.views),
    Object.keys(runtime.views),
  );
  sameKeys(
    `App ${appId}: timer handlers`,
    Object.keys(runtime.timers),
    Object.keys(runtime.onTimer),
  );

  for (const [name, spec] of Object.entries(runtime.tables)) {
    if (!Number.isInteger(spec.maxRows) || spec.maxRows < 1) {
      throw new Error(`App ${appId}: table ${name} needs a positive maxRows`);
    }
  }
  for (const [name, action] of Object.entries(runtime.actions)) {
    assertGate(`App ${appId}: action ${name}`, action);
  }
  for (const [name, query] of Object.entries(runtime.queries)) {
    assertGate(`App ${appId}: query ${name}`, query);
  }
  for (const [name, view] of Object.entries(runtime.views)) {
    if (!(view.source in runtime.tables)) {
      throw new Error(
        `App ${appId}: view ${name} reads unknown table "${view.source}"`,
      );
    }
  }

  return { contract: definition.contract, runtime };
};

const REJECTION_REASON_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;

/** Thrown by `reject`. The host turns it into a `rejected` reply. */
export class AuthorityRejection extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Rejected: ${reason}`);
    this.name = "AuthorityRejection";
    this.reason = reason;
  }
}

/**
 * Refuses the current action or query. Nothing it staged is kept, and the
 * caller gets `reason` back.
 */
export const reject = (reason: string): never => {
  if (!REJECTION_REASON_PATTERN.test(reason)) {
    throw new Error(`Invalid rejection reason "${reason}"`);
  }
  throw new AuthorityRejection(reason);
};
