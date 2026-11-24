import { describe, expect, it, vi } from "vitest";
import { AdmissionLedger } from "../config/classes/AdmissionLedger.js";

const PRODUCTION_LIMIT = 5000;
const BOTH = ["waitingRoom", "lock"] as const;

describe("a full lobby decision record", () => {
  it("does not let in a guest admitted under one pass and later denied under another (Greptile, at the production limit)", () => {
    let clock = 0;
    const ledger = new AdmissionLedger(PRODUCTION_LIMIT);
    ledger.admit("pass:A", "guest-gp_tab-1-under-A", BOTH, (clock += 1));
    ledger.deny("pass:B", (clock += 1));
    expect(ledger.admits(["pass:A", "pass:B"], "lock")).toBe(false);

    // Enough other decisions to reach the limit, and one more.
    for (let other = 0; other < PRODUCTION_LIMIT - 1; other += 1) {
      ledger.admit(`pass:other-${other}`, `guest-gp_other-${other}`, BOTH, (clock += 1));
    }

    expect(ledger.admits(["pass:A", "pass:B"], "lock")).toBe(false);
    expect(ledger.admits(["pass:A", "pass:B"], "waitingRoom")).toBe(false);
    expect(ledger.latestAnswer(["pass:A", "pass:B"])?.admitted).toBe(false);
  });

  it("evicts the least recently active record that holds no refusal, whole, and names its keys", () => {
    let clock = 0;
    const evicted = vi.fn();
    const ledger = new AdmissionLedger(3, { onEvicted: evicted });
    ledger.admit("pass:old", "guest-gp_old", BOTH, (clock += 1));
    ledger.deny("pass:denied", (clock += 1));
    ledger.admit("pass:newer", "guest-gp_newer", BOTH, (clock += 1));
    // Activity on the oldest makes it the most recent.
    ledger.admit("pass:old", "guest-gp_old-2", BOTH, (clock += 1));

    ledger.admit("pass:fourth", "guest-gp_fourth", BOTH, (clock += 1));

    expect(evicted).toHaveBeenCalledWith(["guest-gp_newer"]);
    expect(ledger.has("pass:newer")).toBe(false);
    expect(ledger.has("pass:denied")).toBe(true);
    expect(ledger.admits(["pass:old"], "lock")).toBe(true);
  });

  it("keeps a revoked admission, which is a refusal", () => {
    let clock = 0;
    const ledger = new AdmissionLedger(2);
    ledger.admit("pass:A", "guest-gp_a", BOTH, (clock += 1));
    ledger.admit("pass:C", "guest-gp_c", BOTH, (clock += 1));
    ledger.revoke(["pass:C"], BOTH, (clock += 1));

    ledger.admit("pass:D", "guest-gp_d", BOTH, (clock += 1));

    expect(ledger.has("pass:C")).toBe(true);
    expect(ledger.has("pass:A")).toBe(false);
    expect(ledger.admits(["pass:A", "pass:C"], "lock")).toBe(false);
  });

  it("records a refusal for a principal it had no record of, which then beats an older admission (Greptile)", () => {
    let clock = 0;
    const ledger = new AdmissionLedger(PRODUCTION_LIMIT);
    ledger.admit("pass:A", "guest-gp_a", BOTH, (clock += 1));

    ledger.revoke(["pass:B"], BOTH, (clock += 1));

    expect(ledger.has("pass:B")).toBe(true);
    expect(ledger.admits(["pass:A", "pass:B"], "lock")).toBe(false);
    expect(ledger.admits(["pass:A", "pass:B"], "waitingRoom")).toBe(false);
  });

  it("refuses the stage to a guest demoted under one pass until a newer invite, under any pass", () => {
    let clock = 0;
    const ledger = new AdmissionLedger(PRODUCTION_LIMIT);
    ledger.admit("pass:A", "guest-gp_a", ["stage"], (clock += 1), { answersRequest: false, expiresAt: Date.now() + 60_000 });
    ledger.admit("pass:A", "guest-gp_a", ["stageDemotion"], clock, { answersRequest: false });

    ledger.revoke(["pass:B"], ["stage", "stageDemotion"], (clock += 1));

    expect(ledger.admits(["pass:A", "pass:B"], "stage")).toBe(false);
    expect(ledger.refuses(["pass:A", "pass:B"], "stageDemotion")).toBe(true);
    expect(ledger.latestAnswer(["pass:A", "pass:B"])).toBeUndefined();
    ledger.admit("pass:B", "guest-gp_b", ["stage"], (clock += 1), { answersRequest: false, expiresAt: Date.now() + 60_000 });
    ledger.admit("pass:B", "guest-gp_b", ["stageDemotion"], clock, { answersRequest: false });
    expect(ledger.admits(["pass:A", "pass:B"], "stage")).toBe(true);
    expect(ledger.refuses(["pass:A", "pass:B"], "stageDemotion")).toBe(false);
  });

  it("fails closed when only refusals remain: an admission is not kept, and a refusal still is", () => {
    let clock = 0;
    const full = vi.fn();
    const ledger = new AdmissionLedger(2, { onFull: full });
    ledger.deny("pass:X", (clock += 1));
    ledger.deny("pass:Y", (clock += 1));

    const kept = ledger.admit("pass:A", "guest-gp_a", BOTH, (clock += 1));
    ledger.deny("pass:B", (clock += 1));

    expect(kept).toBe(false);
    expect(full).toHaveBeenCalledTimes(1);
    expect(ledger.admits(["pass:A"], "lock")).toBe(false);
    expect(ledger.latestAnswer(["pass:B"])?.admitted).toBe(false);
    expect(ledger.has("pass:X") && ledger.has("pass:Y")).toBe(true);
  });

  it("keeps an admission for a principal it already has, even when full", () => {
    let clock = 0;
    const ledger = new AdmissionLedger(1);
    ledger.deny("pass:A", (clock += 1));

    expect(ledger.admit("pass:A", "guest-gp_a", BOTH, (clock += 1))).toBe(true);
    expect(ledger.admits(["pass:A"], "lock")).toBe(true);
  });
});

describe("what a participant's own action may change", () => {
  it("rewrites only the records that exist when a refusal is recorded only", () => {
    let clock = 0;
    const ledger = new AdmissionLedger(PRODUCTION_LIMIT);
    ledger.admit("pass:A", "guest-gp_a", BOTH, (clock += 1));

    ledger.revoke(["pass:A", "pass:fresh"], BOTH, (clock += 1), { recordedOnly: true });

    expect(ledger.admits(["pass:A"], "lock")).toBe(false);
    expect(ledger.has("pass:fresh")).toBe(false);
    expect(ledger.size).toBe(1);
  });

  it("uses up an invite without a refusal, and drops a record left with nothing", () => {
    let clock = 0;
    const ledger = new AdmissionLedger(PRODUCTION_LIMIT);
    ledger.admit("pass:A", "guest-gp_a", ["stage"], (clock += 1), { answersRequest: false });
    ledger.admit("pass:B", "guest-gp_b", ["stage"], (clock += 1), { answersRequest: false });

    expect(ledger.consume(["pass:A", "pass:B"], "stage")).toEqual(["guest-gp_a", "guest-gp_b"]);

    expect(ledger.admits(["pass:A", "pass:B"], "stage")).toBe(false);
    expect(ledger.holdsRefusalFor("pass:B")).toBe(false);
    expect(ledger.size).toBe(0);
  });
});

describe("one host action's admissions", () => {
  it("are all recorded or none, and never drop one another to make room", () => {
    let clock = 0;
    const ledger = new AdmissionLedger(3);
    ledger.deny("pass:refused-1", (clock += 1));
    ledger.deny("pass:refused-2", (clock += 1));
    ledger.admit("pass:older", "guest-gp_older", BOTH, (clock += 1));
    const both = [
      { principal: "pass:A", userKey: "guest-gp_a", scopes: BOTH },
      { principal: "pass:B", userKey: "guest-gp_b", scopes: BOTH },
    ];

    expect(ledger.admitAll(both, (clock += 1))).toBe(false);
    expect([ledger.has("pass:A"), ledger.has("pass:B"), ledger.has("pass:older")]).toEqual([false, false, true]);

    expect(ledger.admitAll(both.slice(0, 1), (clock += 1))).toBe(true);
    expect([ledger.has("pass:A"), ledger.has("pass:older")]).toEqual([true, false]);
    expect(ledger.admits(["pass:A"], "lock")).toBe(true);
  });
});

describe("a ledger that refusals took past its limit", () => {
  it("still changes the records it has: a denial taken back, a demoted guest invited again (Greptile)", () => {
    let clock = 0;
    const ledger = new AdmissionLedger(2);
    ledger.deny("pass:A", (clock += 1));
    ledger.deny("pass:B", (clock += 1));
    ledger.revoke(["pass:C"], ["stage", "stageDemotion"], (clock += 1));
    expect(ledger.size).toBe(3);

    expect(ledger.admit("pass:A", "guest-gp_a", BOTH, (clock += 1))).toBe(true);
    expect(ledger.admits(["pass:A"], "lock")).toBe(true);
    expect(
      ledger.admitAll(
        [
          { principal: "pass:C", userKey: "guest-gp_c", scopes: ["stage"], expiresAt: Date.now() + 60_000 },
          { principal: "pass:C", userKey: "guest-gp_c", scopes: ["stageDemotion"] },
        ],
        (clock += 1),
        { answersRequest: false },
      ),
    ).toBe(true);
    expect(ledger.admits(["pass:C"], "stage")).toBe(true);
    expect(ledger.refuses(["pass:C"], "stageDemotion")).toBe(false);

    // A new record still never drops the refusal that is left.
    expect(ledger.admit("pass:new", "guest-gp_new", BOTH, (clock += 1))).toBe(true);
    expect(ledger.has("pass:B")).toBe(true);
    expect(ledger.admits(["pass:B"], "lock")).toBe(false);
  });
});
