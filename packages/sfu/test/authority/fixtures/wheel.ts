/**
 * The Wheel on the authority runtime, as a test fixture. The server picks
 * the winner with its own randomness and records the result itself when the
 * spin's time is up, whether or not the spinner is still in the call.
 */
import { defineContract, s, type Infer } from "@conclave/apps-sdk/authority";
import {
  defineAuthority,
  key,
  reject,
  table,
} from "@conclave/apps-sdk/authority/server";

const MAX_WHEEL_ENTRIES = 64;
const MAX_HISTORY_LENGTH = 25;
const WHEEL = key("wheel");

const entry = s.object({ id: s.string({ max: 32 }), label: s.string({ max: 48 }) });
const spin = s.object({
  spinId: s.string({ max: 32 }),
  /** The entries as they were when the spin began. */
  entries: s.array(entry, { max: MAX_WHEEL_ENTRIES }),
  winnerIndex: s.int({ min: 0 }),
  startedAt: s.number(),
  durationMs: s.int({ min: 0 }),
  turns: s.int({ min: 0 }),
  jitter: s.number(),
  spunByName: s.string({ max: 200 }),
  /** True once the server has recorded the result. */
  settled: s.boolean(),
});
const wheelView = s.object({
  entries: s.array(entry, { max: MAX_WHEEL_ENTRIES }),
  spin: s.nullable(spin),
  removeWinnerOnDone: s.boolean(),
});
const result = s.object({
  spinId: s.string({ max: 32 }),
  label: s.string({ max: 48 }),
  at: s.number(),
  byName: s.string({ max: 200 }),
});

export const wheelContract = defineContract({
  id: "wheel-authority",
  major: 1,
  surface: "stage",
  actions: {
    addEntries: {
      input: s.object({
        labels: s.array(s.string({ min: 1, max: 48, collapse: true, truncate: true }), {
          min: 1,
          max: MAX_WHEEL_ENTRIES,
        }),
      }),
      receipt: s.object({ added: s.int({ min: 0 }) }),
    },
    setRemoveWinner: { input: s.object({ value: s.boolean() }), receipt: s.null() },
    // Any winner a client sends is not in this schema, so it is dropped.
    spin: { input: s.object({}), receipt: s.object({ spinId: s.string({ max: 32 }) }) },
  },
  queries: {},
  views: { wheel: wheelView, history: result },
});

type WheelState = Infer<typeof wheelView>;
type WheelResult = Infer<typeof result>;

const initial: WheelState = { entries: [], spin: null, removeWinnerOnDone: false };
const EDIT_RATE = { burst: 20, perSecond: 5 };
const isSpinning = (state: WheelState): boolean =>
  Boolean(state.spin && !state.spin.settled);

export const wheelAuthority = defineAuthority({
  contract: wheelContract,
  tables: {
    wheel: table<WheelState>({ maxRows: 1 }),
    history: table<WheelResult>({ maxRows: MAX_HISTORY_LENGTH + 1 }),
  },
  timers: { settle: s.object({ spinId: s.string({ max: 32 }) }) },
  canView: ({ role }) => role === "moderator" || role === "member",
  actions: {
    addEntries: {
      roles: ["moderator", "member"],
      identity: "any",
      rate: EDIT_RATE,
      run(ctx, tx, input) {
        const state = tx.get("wheel", WHEEL) ?? initial;
        if (isSpinning(state)) reject("spinning");
        const room = MAX_WHEEL_ENTRIES - state.entries.length;
        const added = input.labels.slice(0, Math.max(0, room));
        tx.put("wheel", WHEEL, {
          ...state,
          entries: [
            ...state.entries,
            ...added.map((label) => ({ id: ctx.nextId("e"), label })),
          ],
        });
        return { added: added.length };
      },
    },
    setRemoveWinner: {
      roles: ["moderator", "member"],
      identity: "any",
      rate: EDIT_RATE,
      run(_ctx, tx, input) {
        const state = tx.get("wheel", WHEEL) ?? initial;
        tx.put("wheel", WHEEL, { ...state, removeWinnerOnDone: input.value });
        return null;
      },
    },
    spin: {
      roles: ["moderator", "member"],
      identity: "any",
      rate: { burst: 3, perSecond: 0.5 },
      run(ctx, tx) {
        const state = tx.get("wheel", WHEEL) ?? initial;
        if (isSpinning(state)) reject("spinning");
        if (state.entries.length < 2) reject("too-few");
        const spinId = ctx.nextId("s");
        const durationMs = 4_500 + ctx.random.int(2_000);
        tx.put("wheel", WHEEL, {
          ...state,
          spin: {
            spinId,
            entries: state.entries,
            // The whole point: no client chooses this.
            winnerIndex: ctx.random.int(state.entries.length),
            startedAt: ctx.now,
            durationMs,
            turns: 5 + ctx.random.int(4),
            jitter: ctx.random.next(),
            spunByName: ctx.displayName,
            settled: false,
          },
        });
        tx.schedule("settle", key("spin", spinId), ctx.now + durationMs, { spinId });
        return { spinId };
      },
    },
  },
  queries: {},
  onTimer: {
    // Runs once, on the server, whether or not the spinner is still here.
    settle(ctx, tx, payload) {
      const state = tx.get("wheel", WHEEL);
      const current = state?.spin;
      if (!state || !current || current.settled || current.spinId !== payload.spinId) {
        return;
      }
      const winner = current.entries[current.winnerIndex];
      tx.insertIfAbsent("history", key(current.spinId), {
        spinId: current.spinId,
        label: winner.label,
        at: ctx.now,
        byName: current.spunByName,
      });
      const history = tx.scan("history");
      for (const [oldKey] of history.slice(0, Math.max(0, history.length - MAX_HISTORY_LENGTH))) {
        tx.delete("history", oldKey);
      }
      tx.put("wheel", WHEEL, {
        ...state,
        entries: state.removeWinnerOnDone
          ? state.entries.filter((candidate) => candidate.id !== winner.id)
          : state.entries,
        spin: { ...current, settled: true },
      });
    },
  },
  views: {
    wheel: {
      kind: "shared",
      source: "wheel",
      project: (state) => ({
        key: "wheel",
        value: {
          entries: [...state.entries],
          spin: state.spin ? { ...state.spin, entries: [...state.spin.entries] } : null,
          removeWinnerOnDone: state.removeWinnerOnDone,
        },
      }),
    },
    history: {
      kind: "shared",
      source: "history",
      project: (row) => ({ key: row.spinId, value: { ...row } }),
    },
  },
});
