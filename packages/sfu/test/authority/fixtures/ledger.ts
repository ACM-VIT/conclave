/**
 * Shared cards everyone sees, and rows each person keeps to themselves, with
 * a clear of either. For checking that what one viewer is told of a clear
 * depends on nothing but what that viewer held.
 */
import { defineContract, s } from "@conclave/apps-sdk/authority";
import {
  defineAuthority,
  key,
  table,
  type Subject,
} from "@conclave/apps-sdk/authority/server";

const id = s.string({ min: 1, max: 32 });
const text = s.string({ max: 4_096 });

export const ledgerContract = defineContract({
  id: "ledger",
  major: 1,
  surface: "panel",
  actions: {
    card: { input: s.object({ id, text }), receipt: s.null() },
    secret: { input: s.object({ id, text }), receipt: s.null() },
    /** Clears every card, and every secret of everyone. */
    wipe: { input: s.null(), receipt: s.object({ removed: s.int({ min: 0 }) }) },
    /** Clears the caller's own secrets. */
    forget: { input: s.null(), receipt: s.object({ removed: s.int({ min: 0 }) }) },
    /** Clears one card. */
    clearCard: { input: s.object({ id }), receipt: s.object({ removed: s.int({ min: 0 }) }) },
    /** Many cards, or many of the caller's secrets, in one transaction. */
    deal: { input: s.object({ count: s.int({ min: 1, max: 20_000 }) }), receipt: s.null() },
    stash: { input: s.object({ count: s.int({ min: 1, max: 20_000 }) }), receipt: s.null() },
  },
  queries: {},
  views: {
    cards: s.object({ id, text }),
    mine: s.object({ id, text }),
  },
});

type Card = { id: string; text: string };
type Secret = { id: string; text: string; subject: Subject };

const everyone = ["moderator", "member"] as const;

/** How many times a view projected a row, for tests that bound the work. */
export const ledgerCounters = { projections: 0 };
const RATE = { burst: 100_000, perSecond: 100_000 };

export const ledgerAuthority = defineAuthority({
  contract: ledgerContract,
  tables: {
    cards: table<Card>({ maxRows: 50_000 }),
    secrets: table<Secret>({ maxRows: 50_000 }),
  },
  timers: {},
  canView: ({ role }) => role === "moderator" || role === "member",
  actions: {
    card: {
      roles: everyone,
      identity: "any",
      rate: RATE,
      run(_ctx, tx, input) {
        tx.put("cards", key("card", input.id), { id: input.id, text: input.text });
        return null;
      },
    },
    secret: {
      roles: everyone,
      identity: "any",
      rate: RATE,
      run(ctx, tx, input) {
        tx.put("secrets", key("secret", ctx.subject, input.id), {
          id: input.id,
          text: input.text,
          subject: ctx.subject,
        });
        return null;
      },
    },
    wipe: {
      roles: ["moderator"],
      identity: "any",
      rate: RATE,
      run(_ctx, tx) {
        return { removed: tx.clear("cards", key("card")) + tx.clear("secrets", key("secret")) };
      },
    },
    forget: {
      roles: everyone,
      identity: "any",
      rate: RATE,
      run(ctx, tx) {
        return { removed: tx.clear("secrets", key("secret", ctx.subject)) };
      },
    },
    clearCard: {
      roles: ["moderator"],
      identity: "any",
      rate: RATE,
      run(_ctx, tx, input) {
        return { removed: tx.clear("cards", key("card", input.id)) };
      },
    },
    deal: {
      roles: everyone,
      identity: "any",
      rate: RATE,
      run(_ctx, tx, input) {
        for (let index = 0; index < input.count; index += 1) {
          tx.put("cards", key("card", `d${index}`), { id: `d${index}`, text: "dealt" });
        }
        return null;
      },
    },
    stash: {
      roles: everyone,
      identity: "any",
      rate: RATE,
      run(ctx, tx, input) {
        for (let index = 0; index < input.count; index += 1) {
          tx.put("secrets", key("secret", ctx.subject, `k${index}`), {
            id: `k${index}`,
            text: "kept",
            subject: ctx.subject,
          });
        }
        return null;
      },
    },
  },
  queries: {},
  onTimer: {},
  views: {
    cards: {
      kind: "shared",
      source: "cards",
      project: (row) => {
        ledgerCounters.projections += 1;
        return { key: row.id, value: { id: row.id, text: row.text } };
      },
    },
    mine: {
      kind: "personal",
      source: "secrets",
      owner: (row) => row.subject,
      project: (row) => {
        ledgerCounters.projections += 1;
        return { key: row.id, value: { id: row.id, text: row.text } };
      },
    },
  },
});
