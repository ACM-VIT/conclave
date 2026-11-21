/**
 * A small app for exercising the runtime's bounds, faults and timers. It has
 * no product meaning.
 */
import { defineContract, s } from "@conclave/apps-sdk/authority";
import {
  defineAuthority,
  key,
  reject,
  table,
} from "@conclave/apps-sdk/authority/server";

const note = s.object({ id: s.string({ max: 64 }), text: s.string({ max: 4_000 }) });

export const probeContract = defineContract({
  id: "probe",
  major: 1,
  surface: "panel",
  actions: {
    put: {
      input: s.object({ id: s.string({ min: 1, max: 64 }), text: s.string({ max: 20_000 }) }),
      receipt: s.null(),
    },
    remove: { input: s.object({ id: s.string({ min: 1, max: 64 }) }), receipt: s.null() },
    throwAfterWrite: { input: s.null(), receipt: s.null() },
    rejectAfterWrite: { input: s.null(), receipt: s.null() },
    mutateCommitted: { input: s.object({ id: s.string({ max: 64 }) }), receipt: s.null() },
    leak: { input: s.null(), receipt: s.null() },
    schedule: {
      input: s.object({
        id: s.string({ min: 1, max: 64 }),
        afterMs: s.int({ min: 0 }),
        label: s.string({ max: 64 }),
      }),
      receipt: s.null(),
    },
    cancel: { input: s.object({ id: s.string({ min: 1, max: 64 }) }), receipt: s.object({ cancelled: s.boolean() }) },
  },
  queries: {
    dump: {
      input: s.null(),
      output: s.object({ notes: s.array(note, { max: 10_000 }) }),
    },
  },
  views: {
    notes: note,
    fired: s.object({ label: s.string({ max: 64 }), at: s.number(), order: s.int() }),
  },
});

type Note = { id: string; text: string; secret?: string };
type Fired = { label: string; at: number; order: number };

const RATE = { burst: 1_000, perSecond: 1_000 };
const everyone = ["moderator", "member"] as const;

export const probeAuthority = defineAuthority({
  contract: probeContract,
  tables: {
    notes: table<Note>({ maxRows: 5, maxRowBytes: 8 * 1024 }),
    fired: table<Fired>({ maxRows: 100 }),
  },
  timers: { ring: s.object({ label: s.string({ max: 64 }) }) },
  canView: ({ role }) => role === "moderator" || role === "member",
  actions: {
    put: {
      roles: everyone,
      identity: "any",
      rate: RATE,
      run(_ctx, tx, input) {
        tx.put("notes", key(input.id), { id: input.id, text: input.text });
        return null;
      },
    },
    remove: {
      roles: everyone,
      identity: "any",
      rate: RATE,
      run(_ctx, tx, input) {
        tx.delete("notes", key(input.id));
        return null;
      },
    },
    throwAfterWrite: {
      roles: everyone,
      identity: "any",
      rate: RATE,
      run(_ctx, tx) {
        tx.put("notes", key("thrown"), { id: "thrown", text: "must not persist" });
        throw new Error("handler bug");
      },
    },
    rejectAfterWrite: {
      roles: everyone,
      identity: "any",
      rate: RATE,
      run(_ctx, tx) {
        tx.put("notes", key("rejected"), { id: "rejected", text: "must not persist" });
        return reject("changed-my-mind");
      },
    },
    mutateCommitted: {
      roles: everyone,
      identity: "any",
      rate: RATE,
      run(_ctx, tx, input) {
        const row = tx.get("notes", key(input.id));
        if (!row) return reject("not-found");
        (row as { text: string }).text = "mutated in place";
        return null;
      },
    },
    leak: {
      roles: everyone,
      identity: "any",
      rate: RATE,
      run(_ctx, tx) {
        tx.put("notes", key("leaky"), { id: "leaky", text: "public", secret: "CANARY" });
        return null;
      },
    },
    schedule: {
      roles: everyone,
      identity: "any",
      rate: RATE,
      run(ctx, tx, input) {
        tx.schedule("ring", key("timer", input.id), ctx.now + input.afterMs, {
          label: input.label,
        });
        return null;
      },
    },
    cancel: {
      roles: everyone,
      identity: "any",
      rate: RATE,
      run(_ctx, tx, input) {
        return { cancelled: tx.cancelTimer(key("timer", input.id)) };
      },
    },
  },
  queries: {
    dump: {
      roles: ["moderator"],
      rate: RATE,
      read(_ctx, db) {
        return {
          notes: db.scan("notes").map(([, row]) => ({ id: row.id, text: row.text })),
        };
      },
    },
  },
  onTimer: {
    ring(ctx, tx, payload) {
      const order = tx.count("fired");
      tx.put("fired", key(String(order)), { label: payload.label, at: ctx.now, order });
      if (payload.label === "faulty") throw new Error("timer bug");
    },
  },
  views: {
    notes: {
      kind: "shared",
      source: "notes",
      // Passes a stray field through when a row has one: the leak canary.
      project: (row) => ({
        key: row.id,
        value: row.secret
          ? { id: row.id, text: row.text, secret: row.secret }
          : { id: row.id, text: row.text },
      }),
    },
    fired: {
      kind: "shared",
      source: "fired",
      project: (row) => ({ key: String(row.order), value: { ...row } }),
    },
  },
});
