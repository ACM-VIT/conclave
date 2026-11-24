import type { Json } from "@conclave/apps-sdk/authority";
import type { AuthorityModule, Subject, TimerContext } from "@conclave/apps-sdk/authority/server";
import { AuthorityInstance, type Actor } from "../../server/apps/authority/instance.js";
import { DEFAULT_AUTHORITY_LIMITS } from "../../server/apps/authority/limits.js";
import { ACTION_ORDER_TABLE } from "./fixtures/action-order.js";

export type MergeStep =
  | {
      by: "into" | "from" | "host";
      action: string;
      input?: (receipts: ReadonlyMap<string, Json>) => unknown;
      keep?: string;
      sameMoment?: boolean;
    }
  | { wait: number }
  | { crowd: number; action: string; input?: (receipts: ReadonlyMap<string, Json>, member: number) => unknown };

const STEP_MS = 10_000;

const SETUP_LIMITS = {
  ...DEFAULT_AUTHORITY_LIMITS,
  mutationBurst: Number.MAX_SAFE_INTEGER,
  mutationsPerSecond: Number.MAX_SAFE_INTEGER,
};

const actor = (subject: string, role: Actor["role"], displayName: string): Actor => ({
  subject: subject as Subject,
  role,
  verified: true,
  displayName,
});

const mixed = (...parts: number[]): number => {
  let hash = 2_166_136_261;
  for (const part of parts) {
    hash = Math.imul(hash ^ part, 16_777_619) >>> 0;
    hash ^= hash >>> 13;
  }
  return hash >>> 0;
};

const withoutFields = (row: object, fields: readonly string[]): object =>
  Object.fromEntries(Object.entries(row).filter(([name]) => !fields.includes(name)));

const collectOrders = (value: unknown, found: Set<number>): void => {
  if (Array.isArray(value)) {
    for (const inner of value) collectOrders(inner, found);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [name, inner] of Object.entries(value)) {
    if (name === "order" && typeof inner === "number") found.add(inner);
    else collectOrders(inner, found);
  }
};

const ranked = (value: unknown, rank: ReadonlyMap<number, number>): unknown => {
  if (Array.isArray(value)) return value.map((inner) => ranked(inner, rank));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, inner]) => [
      name,
      name === "order" && typeof inner === "number" ? rank.get(inner) : ranked(inner, rank),
    ]),
  );
};

const byRank = <T>(tables: T): T => {
  const orders = new Set<number>();
  collectOrders(tables, orders);
  const rank = new Map([...orders].sort((a, b) => a - b).map((order, index) => [order, index]));
  return ranked(tables, rank) as T;
};

const play = (
  module: AuthorityModule,
  steps: readonly MergeStep[],
  merge: boolean,
  activityFields: readonly string[],
) => {
  let step = 0;
  let member = 0;
  let draw = 0;
  const instance = new AuthorityInstance(
    `${module.contract.id}.merge-check`,
    module,
    { mode: "meeting", qaEnabled: true },
    {
      limits: SETUP_LIMITS,
      random: {
        next: () => 0.5,
        int: (max) => mixed(step, member, (draw += 1)) % max,
        shuffle: (list) => [...list],
      },
      verifyViews: false,
    },
  );
  const into = actor("person-into", "member", "Person");
  const crowdOf = (member: number) => actor(`crowd-${String(member).padStart(5, "0")}`, "member", `Crowd ${member}`);
  const from = merge ? actor("person-from", "member", "Person") : into;
  const host = actor("host", "moderator", "Host");
  const receipts = new Map<string, Json>();
  let now = 1_000_000;
  for (const [index, entry] of steps.entries()) {
    step = index + 1;
    member = 0;
    draw = 0;
    if (!("by" in entry && entry.sameMoment)) now += STEP_MS;
    if ("wait" in entry) {
      now += entry.wait;
      instance.runDueTimers(now);
      continue;
    }
    if ("crowd" in entry) {
      instance.runDueTimers(now);
      for (let position = 0; position < entry.crowd; position += 1) {
        member = position + 1;
        draw = 0;
        const result = instance.act(crowdOf(position), entry.action, entry.input?.(receipts, position) ?? null, null, now);
        if (!result.ok) throw new Error(`${module.contract.id}: ${entry.action} by crowd member ${position} failed: ${JSON.stringify(result)}`);
      }
      continue;
    }
    instance.runDueTimers(now);
    const who = entry.by === "host" ? host : entry.by === "into" ? into : from;
    const result = instance.act(who, entry.action, entry.input?.(receipts) ?? null, null, now);
    if (result.ok && entry.keep) receipts.set(entry.keep, result.value);
  }
  let mergeOps = 0;
  let subjectRows = 0;
  const crowd = new Set<string>();
  const rowsBefore = new Map<string, number>();
  for (const table of Object.keys(module.runtime.tables)) {
    rowsBefore.set(table, instance.store.rows(table).size);
    for (const [key, row] of instance.store.rows(table)) {
      for (const member of `${String(key)} ${JSON.stringify(row)}`.match(/crowd-\d{5}/g) ?? []) crowd.add(member);
    }
  }
  if (merge) {
    step = steps.length + 1;
    member = 0;
    draw = 0;
    for (const table of Object.keys(module.runtime.tables)) {
      for (const [key, row] of instance.store.rows(table)) {
        const text = `${String(key)} ${JSON.stringify(row)}`;
        if (text.includes(into.subject) || text.includes(from.subject)) subjectRows += 1;
      }
    }
    const ctx: TimerContext = {
      room: { mode: "meeting", qaEnabled: true },
      now,
      random: { next: () => 0.5, int: () => 0, shuffle: (list) => [...list] },
      nextId: (prefix = "") => `${prefix}merge`,
    };
    const outcome = instance.store.transact((tx) => {
      module.runtime.mergeSubjects?.(ctx, tx, { from: from.subject, into: into.subject });
      mergeOps = (tx as unknown as { ops: number }).ops;
    });
    if (!outcome.ok) throw new Error(`${module.contract.id}: the merge did not commit`);
  }
  const tables = Object.fromEntries(
    Object.keys(module.runtime.tables).filter((table) => table !== ACTION_ORDER_TABLE).map((table) => [
      table,
      [...instance.store.rows(table)]
        .map(([key, row]) => [String(key), withoutFields(row, activityFields)] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    ]),
  );
  return { tables: byRank(tables), mergeOps, subjectRows, crowd: crowd.size, rowsBefore };
};

export const mergeAgainstOnePerson = (
  module: AuthorityModule,
  steps: readonly MergeStep[],
  options: { activityFields?: readonly string[] } = {},
) => ({
  merged: play(module, steps, true, options.activityFields ?? []).tables,
  onePerson: play(module, steps, false, options.activityFields ?? []).tables,
});

export const mergeCost = (module: AuthorityModule, steps: readonly MergeStep[], walked: readonly string[] = []) => {
  const { mergeOps, subjectRows, crowd, rowsBefore } = play(module, steps, true, []);
  const walkedRows = walked.reduce((total, table) => total + (rowsBefore.get(table) ?? 0), 0);
  return { ops: mergeOps, subjectRows, crowd, walkedRows };
};
