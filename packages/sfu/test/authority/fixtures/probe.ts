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
    putThenGrow: {
      input: s.object({ id: s.string({ min: 1, max: 64 }) }),
      receipt: s.null(),
    },
    star: { input: s.object({ id: s.string({ max: 64 }) }), receipt: s.null() },
    throwAfterWrite: { input: s.null(), receipt: s.null() },
    putLater: { input: s.null(), receipt: s.null() },
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
    mark: {
      input: s.object({
        id: s.string({ min: 1, max: 64 }),
        from: s.int({ min: 0 }),
        count: s.int({ min: 1 }),
        shown: s.boolean(),
        slot: s.optional(s.boolean()),
      }),
      receipt: s.null(),
    },
    unmark: {
      input: s.object({
        id: s.string({ min: 1, max: 64 }),
        how: s.oneOf(["clear", "one at a time", "clear then refuse"]),
      }),
      receipt: s.object({ removed: s.int({ min: 0 }) }),
    },
    remark: {
      input: s.object({ id: s.string({ min: 1, max: 64 }) }),
      receipt: s.object({
        removed: s.int({ min: 0 }),
        leftAfterClear: s.int({ min: 0 }),
        oldRowStillThere: s.boolean(),
        leftAfterWrite: s.int({ min: 0 }),
      }),
    },
  },
  queries: {
    countMarks: {
      input: s.object({ id: s.string({ min: 1, max: 64 }) }),
      output: s.object({ count: s.int({ min: 0 }) }),
    },
    dump: {
      input: s.null(),
      output: s.object({
        notes: s.array(
          s.object({
            id: s.string({ max: 64 }),
            text: s.string({ max: 20_000 }),
            stars: s.int({ min: 0 }),
          }),
          { max: 10_000 },
        ),
      }),
    },
  },
  views: {
    notes: note,
    /** Keyed by a note's text, so two notes with one text collide. */
    byText: s.object({ id: s.string({ max: 64 }) }),
    fired: s.object({ label: s.string({ max: 64 }), at: s.number(), order: s.int() }),
    /** The marks that asked to be shown. */
    marks: s.object({ n: s.int({ min: 0 }) }),
    /**
     * One row per number, whichever note's mark holds it: marks of
     * different notes with one number claim the same key here.
     */
    slots: s.object({ n: s.int({ min: 0 }), of: s.string({ max: 64 }) }),
  },
});

type Note = { id: string; text: string; secret?: string; stars?: number[] };
type Fired = { label: string; at: number; order: number };
/** One of many rows under a note: keyed by the note, then by its number. */
type Mark = { noteId: string; n: number; shown: boolean; slot?: boolean };

const RATE = { burst: 1_000, perSecond: 1_000 };

/**
 * What an `async` handler does: it hands back a promise, writes again once
 * the caller has moved on, and then fails. The types refuse such a handler,
 * so the cast stands in for an author who got past them.
 */
const finishLater = <Result>(write: () => void): Result =>
  (async () => {
    await Promise.resolve();
    write();
    throw new Error("failed after the handler returned");
  })() as unknown as Result;
const everyone = ["moderator", "member"] as const;

export const probeAuthority = defineAuthority({
  contract: probeContract,
  tables: {
    notes: table<Note>({ maxRows: 5, maxRowBytes: 8 * 1024 }),
    fired: table<Fired>({ maxRows: 100 }),
    marks: table<Mark>({ maxRows: 50_000 }),
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
    putThenGrow: {
      roles: everyone,
      identity: "any",
      rate: RATE,
      run(_ctx, tx, input) {
        const row: Note = { id: input.id, text: "small", stars: [] };
        tx.put("notes", key(input.id), row);
        // Changing the object after it is staged must not reach the store.
        row.text = "x".repeat(9 * 1024);
        row.stars?.push(1, 2, 3);
        return null;
      },
    },
    star: {
      roles: everyone,
      identity: "any",
      rate: RATE,
      run(_ctx, tx, input) {
        const row = tx.get("notes", key(input.id));
        if (!row) return reject("not-found");
        // A committed row is frozen all the way down.
        (row.stars as number[]).push(1);
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
    putLater: {
      roles: everyone,
      identity: "any",
      rate: RATE,
      run(_ctx, tx) {
        tx.put("notes", key("early"), { id: "early", text: "must not persist" });
        return finishLater<null>(() =>
          tx.put("notes", key("late"), { id: "late", text: "must not persist" }),
        );
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
    mark: {
      roles: everyone,
      identity: "any",
      rate: RATE,
      run(_ctx, tx, input) {
        for (let n = input.from; n < input.from + input.count; n += 1) {
          tx.put("marks", key(input.id, String(n)), {
            noteId: input.id,
            n,
            shown: input.shown,
            ...(input.slot ? { slot: true } : {}),
          });
        }
        return null;
      },
    },
    unmark: {
      roles: everyone,
      identity: "any",
      rate: RATE,
      run(_ctx, tx, input) {
        if (input.how === "one at a time") {
          const rows = tx.scan("marks", key(input.id));
          for (const [markKey] of rows) tx.delete("marks", markKey);
          return { removed: rows.length };
        }
        const removed = tx.clear("marks", key(input.id));
        if (input.how === "clear then refuse") return reject("changed-my-mind");
        return { removed };
      },
    },
    // Clears a note's marks and writes one back, reporting what it saw on the way.
    remark: {
      roles: everyone,
      identity: "any",
      rate: RATE,
      run(_ctx, tx, input) {
        const removed = tx.clear("marks", key(input.id));
        const leftAfterClear = tx.count("marks", key(input.id));
        const oldRowStillThere = tx.get("marks", key(input.id, "0")) !== undefined;
        tx.put("marks", key(input.id, "kept"), { noteId: input.id, n: 0, shown: true });
        return {
          removed,
          leftAfterClear,
          oldRowStillThere,
          leftAfterWrite: tx.scan("marks", key(input.id)).length,
        };
      },
    },
  },
  queries: {
    countMarks: {
      roles: everyone,
      rate: RATE,
      read(_ctx, db, input) {
        return { count: db.count("marks", key(input.id)) };
      },
    },
    dump: {
      roles: ["moderator"],
      // Off while the room's Q&A switch is off, so a test can withdraw the
      // query without changing anyone's role.
      when: ({ room }) => room.qaEnabled,
      rate: RATE,
      read(_ctx, db) {
        return {
          notes: db.scan("notes").map(([, row]) => ({
            id: row.id,
            text: row.text,
            stars: row.stars?.length ?? 0,
          })),
        };
      },
    },
  },
  onTimer: {
    ring(ctx, tx, payload) {
      const order = tx.count("fired");
      tx.put("fired", key(String(order)), { label: payload.label, at: ctx.now, order });
      if (payload.label === "faulty") throw new Error("timer bug");
      if (payload.label === "async") {
        return finishLater<undefined>(() =>
          tx.put("fired", key("late"), { label: "late", at: ctx.now, order: -1 }),
        );
      }
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
    byText: {
      kind: "shared",
      source: "notes",
      project: (row) => ({ key: row.text.slice(0, 64) || "empty", value: { id: row.id } }),
    },
    fired: {
      kind: "shared",
      source: "fired",
      project: (row) => ({ key: String(row.order), value: { ...row } }),
    },
    marks: {
      kind: "shared",
      source: "marks",
      project: (row) =>
        row.shown ? { key: `${row.noteId}/${row.n}`, value: { n: row.n } } : null,
    },
    slots: {
      kind: "shared",
      source: "marks",
      project: (row) =>
        row.slot ? { key: String(row.n), value: { n: row.n, of: row.noteId } } : null,
    },
  },
});
