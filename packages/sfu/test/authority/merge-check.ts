import type { Json } from "@conclave/apps-sdk/authority";
import type { AuthorityModule, Subject } from "@conclave/apps-sdk/authority/server";
import { AuthorityInstance, type Actor } from "../../server/apps/authority/instance.js";
import { DEFAULT_AUTHORITY_LIMITS } from "../../server/apps/authority/limits.js";

export type MergeStep =
  | {
      by: "into" | "from" | "host";
      action: string;
      input?: (receipts: ReadonlyMap<string, Json>) => unknown;
      keep?: string;
    }
  | { wait: number };

const STEP_MS = 10_000;

const actor = (subject: string, role: Actor["role"], displayName: string): Actor => ({
  subject: subject as Subject,
  role,
  verified: true,
  displayName,
});

const withoutFields = (row: object, fields: readonly string[]): object =>
  Object.fromEntries(Object.entries(row).filter(([name]) => !fields.includes(name)));

const play = (
  module: AuthorityModule,
  steps: readonly MergeStep[],
  merge: boolean,
  activityFields: readonly string[],
) => {
  let step = 0;
  let draw = 0;
  const instance = new AuthorityInstance(
    `${module.contract.id}.merge-check`,
    module,
    { mode: "meeting", qaEnabled: true },
    {
      limits: DEFAULT_AUTHORITY_LIMITS,
      random: {
        next: () => 0.5,
        int: (max) => (step * 35 + (draw += 1) * 31) % max,
        shuffle: (list) => [...list],
      },
      verifyViews: false,
    },
  );
  const into = actor("person-into", "member", "Person");
  const from = merge ? actor("person-from", "member", "Person") : into;
  const host = actor("host", "moderator", "Host");
  const receipts = new Map<string, Json>();
  let now = 1_000_000;
  for (const [index, entry] of steps.entries()) {
    step = index + 1;
    draw = 0;
    now += STEP_MS;
    if ("wait" in entry) {
      now += entry.wait;
      instance.runDueTimers(now);
      continue;
    }
    instance.runDueTimers(now);
    const who = entry.by === "host" ? host : entry.by === "into" ? into : from;
    const result = instance.act(who, entry.action, entry.input?.(receipts) ?? null, null, now);
    if (result.ok && entry.keep) receipts.set(entry.keep, result.value);
  }
  if (merge) {
    step = steps.length + 1;
    draw = 0;
    instance.mergeSubjects({ from: from.subject, into: into.subject }, now);
  }
  return Object.fromEntries(
    Object.keys(module.runtime.tables).map((table) => [
      table,
      [...instance.store.rows(table)]
        .map(([key, row]) => [String(key), withoutFields(row, activityFields)] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    ]),
  );
};

export const mergeAgainstOnePerson = (
  module: AuthorityModule,
  steps: readonly MergeStep[],
  options: { activityFields?: readonly string[] } = {},
) => ({
  merged: play(module, steps, true, options.activityFields ?? []),
  onePerson: play(module, steps, false, options.activityFields ?? []),
});
