import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorityResult, Json } from "@conclave/apps-sdk/authority";
import { key, type Subject } from "@conclave/apps-sdk/authority/server";
import { DEFAULT_AUTHORITY_LIMITS } from "../../server/apps/authority/limits.js";
import { ReceiptBook } from "../../server/apps/authority/receipts.js";
import { AuthorityStore } from "../../server/apps/authority/store.js";
import {
  allViewsIn,
  field,
  guestTab,
  linkPasses,
  sameGuest,
  startWithLostAnswer,
} from "./guest-links.js";
import { Harness, person, type Tab } from "./harness.js";
import { ledgerAuthority, ledgerContract } from "./fixtures/ledger.js";
import { probeAuthority } from "./fixtures/probe.js";
import { qaAuthority, qaContract } from "./fixtures/qa.js";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

const host = person("asha@example.com", "Asha", "host");
const MORE_SECRETS_THAN_A_MERGE_CAN_MOVE = 13_000;

const questionsAsked = (hostTab: Tab, text: string) =>
  hostTab.rows("questions").filter((row) => field(row, "text") === text);

describe("an action whose answer was lost, sent again (Greptile)", () => {
  it("tells an attendee their question was posted when Q&A was turned off before the resend", async () => {
    const room = new Harness([qaAuthority]);
    room.setWebinar(true, true);
    const hostTab = await room.open(host, qaContract);
    const tab = await room.open(person("ana@example.com", "Ana", "attendee"), qaContract);

    const { answer } = await startWithLostAnswer(room, tab, "ask", { text: "Is lunch at one?" });
    room.setWebinar(true, false);
    const result = await room.settle(answer);
    await room.deliver();

    expect(result.ok).toBe(true);
    expect(questionsAsked(hostTab, "Is lunch at one?").map((row) => field(row, "id"))).toEqual([
      field(result.ok ? result.value : null, "id"),
    ]);
    expect(await tab.act("ask", { text: "And dinner?" })).toEqual({ ok: false, code: "forbidden" });
  });

  it("asks a guest's question once when another tab links the guest's passes before the resend", async () => {
    const room = new Harness([qaAuthority]);
    room.setWebinar(true, true);
    const hostTab = await room.open(host, qaContract);
    const onA = await guestTab(room, qaContract, "pass-a", "tab-1", "attendee");
    expect((await onA.act("ask", { text: "From the first pass?" })).ok).toBe(true);
    const onB = await guestTab(room, qaContract, "pass-b", "tab-2", "attendee");

    const { answer } = await startWithLostAnswer(room, onB, "ask", { text: "From the second pass?" });
    linkPasses(room, "pass-b", "pass-a");
    const result = await room.settle(answer);
    await room.deliver();

    expect(sameGuest(room, onA, onB)).toBe(true);
    expect(result.ok).toBe(true);
    expect(questionsAsked(hostTab, "From the second pass?").map((row) => field(row, "id"))).toEqual([
      field(result.ok ? result.value : null, "id"),
    ]);
  });

  it("keeps a guest's refused upvote refused when another tab links the guest's passes before the resend", async () => {
    const room = new Harness([qaAuthority]);
    room.setWebinar(true, true);
    const hostTab = await room.open(host, qaContract);
    const onA = await guestTab(room, qaContract, "pass-a", "tab-1", "attendee");
    const asked = await onA.act("ask", { text: "Seen only by hosts for now?" });
    const id = field(asked.ok ? asked.value : null, "id");
    const onB = await guestTab(room, qaContract, "pass-b", "tab-2", "attendee");

    const { answer } = await startWithLostAnswer(room, onB, "upvote", { id, value: true });
    expect((await hostTab.act("moderate", { id, action: "answering" })).ok).toBe(true);
    linkPasses(room, "pass-b", "pass-a");
    const result = await room.settle(answer);
    await room.deliver();

    expect(sameGuest(room, onA, onB)).toBe(true);
    expect(result).toEqual({ ok: false, code: "rejected", reason: "not-found" });
    expect(field(questionsAsked(hostTab, "Seen only by hosts for now?")[0], "upvotes")).toBe(0);
  });
});

describe("a link the room's apps cannot merge (Greptile)", () => {
  const stashed = async (room: Harness, count: number) => {
    const onA = await guestTab(room, ledgerContract, "pass-a", "tab-1");
    expect((await onA.act("secret", { id: "s1", text: "mine" })).ok).toBe(true);
    const onB = await guestTab(room, ledgerContract, "pass-b", "tab-2");
    expect((await onB.act("stash", { count })).ok).toBe(true);
    await room.deliver();
    return { onA, onB };
  };

  it("is not recorded, and each pass keeps its own identity and rows", async () => {
    const room = new Harness([ledgerAuthority]);
    const { onA, onB } = await stashed(room, MORE_SECRETS_THAN_A_MERGE_CAN_MOVE);

    const link = linkPasses(room, "pass-b", "pass-a");
    await allViewsIn(room);

    expect(sameGuest(room, onA, onB)).toBe(false);
    expect(onB.rows("mine")).toHaveLength(MORE_SECRETS_THAN_A_MERGE_CAN_MOVE);
    expect(onA.rows("mine")).toEqual([{ id: "s1", text: "mine" }]);
    expect(link?.recordable).toBe(false);
  });

  it("is refused at commit when the rows grew after the plan was made", async () => {
    const room = new Harness([ledgerAuthority]);
    const onA = await guestTab(room, ledgerContract, "pass-a", "tab-1");
    expect((await onA.act("secret", { id: "s1", text: "mine" })).ok).toBe(true);
    const onB = await guestTab(room, ledgerContract, "pass-b", "tab-2");
    expect((await onB.act("secret", { id: "s2", text: "theirs" })).ok).toBe(true);
    const link = room.room.planGuestLink([{ guestProof: "pass-a" }], "pass-b");
    expect(link?.recordable).toBe(true);
    expect((await onB.act("stash", { count: MORE_SECRETS_THAN_A_MERGE_CAN_MOVE })).ok).toBe(true);

    room.room.commitGuestLink(link!);
    await allViewsIn(room);

    expect(sameGuest(room, onA, onB)).toBe(false);
    expect(onB.rows("mine")).toHaveLength(MORE_SECRETS_THAN_A_MERGE_CAN_MOVE + 1);
    expect(onA.rows("mine")).toEqual([{ id: "s1", text: "mine" }]);
  });

  it("leaves every app as it was when one of them cannot merge", async () => {
    const room = new Harness([qaAuthority, ledgerAuthority]);
    const onA = await guestTab(room, qaContract, "pass-a", "tab-1");
    expect((await onA.act("ask", { text: "From the first pass?" })).ok).toBe(true);
    const onB = await guestTab(room, qaContract, "pass-b", "tab-2");
    expect((await onB.act("ask", { text: "From the second pass?" })).ok).toBe(true);
    const ledgerOfB = await guestTab(room, ledgerContract, "pass-b", "tab-2-ledger");
    expect((await ledgerOfB.act("stash", { count: MORE_SECRETS_THAN_A_MERGE_CAN_MOVE })).ok).toBe(true);
    await room.deliver();

    linkPasses(room, "pass-b", "pass-a");
    await allViewsIn(room);

    expect(sameGuest(room, onA, onB)).toBe(false);
    expect(onA.rows("myQuestions")).toHaveLength(1);
    expect(onB.rows("myQuestions")).toHaveLength(1);
    expect(ledgerOfB.rows("mine")).toHaveLength(MORE_SECRETS_THAN_A_MERGE_CAN_MOVE);
  });
});

describe("an ask whose answer may be lost, against gates, merges and failed merges", () => {
  const cases = [false, true].flatMap((lostAnswer) =>
    [false, true].flatMap((gateCloses) =>
      [false, true].flatMap((linked) =>
        [false, true].map((mergeFails) => ({ lostAnswer, gateCloses, linked, mergeFails })),
      ),
    ),
  );

  it.each(cases)(
    "lost answer $lostAnswer, gate closes $gateCloses, passes linked $linked, merge fails $mergeFails",
    async ({ lostAnswer, gateCloses, linked, mergeFails }) => {
      const room = new Harness([qaAuthority, ledgerAuthority]);
      const hostTab = await room.open(host, qaContract);
      const onA = await guestTab(room, qaContract, "pass-a", "tab-1");
      expect((await onA.act("ask", { text: "From the first pass?" })).ok).toBe(true);
      const ledgerOfA = await guestTab(room, ledgerContract, "pass-a", "tab-1-ledger");
      expect((await ledgerOfA.act("secret", { id: "s1", text: "mine" })).ok).toBe(true);
      const onB = await guestTab(room, qaContract, "pass-b", "tab-2");
      const ledgerOfB = await guestTab(room, ledgerContract, "pass-b", "tab-2-ledger");
      const secretsOfB = mergeFails ? MORE_SECRETS_THAN_A_MERGE_CAN_MOVE : 1;
      expect((await ledgerOfB.act("stash", { count: secretsOfB })).ok).toBe(true);
      await room.deliver();

      const changeTheRoom = () => {
        if (gateCloses) room.setWebinar(true, true);
        if (linked) linkPasses(room, "pass-b", "pass-a");
      };
      let result: AuthorityResult<Json>;
      if (lostAnswer) {
        const { answer } = await startWithLostAnswer(room, onB, "ask", { text: "From the second pass?" });
        changeTheRoom();
        result = await room.settle(answer);
      } else {
        result = await onB.act("ask", { text: "From the second pass?" });
        changeTheRoom();
      }
      await allViewsIn(room);

      const merged = linked && !mergeFails;
      const asked = questionsAsked(hostTab, "From the second pass?");
      expect(result.ok).toBe(true);
      expect(asked.map((row) => field(row, "id"))).toEqual([field(result.ok ? result.value : null, "id")]);
      expect(sameGuest(room, onA, onB)).toBe(merged);
      expect(onB.rows("myQuestions")).toHaveLength(merged ? 2 : 1);
      expect(onA.rows("myQuestions")).toHaveLength(merged ? 2 : 1);
      expect(ledgerOfB.rows("mine")).toHaveLength(merged ? secretsOfB + 1 : secretsOfB);
      expect(ledgerOfA.rows("mine")).toHaveLength(merged ? secretsOfB + 1 : 1);
      expect(await onB.act("ask", { text: "Another one?" })).toEqual(
        gateCloses ? { ok: false, code: "forbidden" } : expect.objectContaining({ ok: true }),
      );
    },
    30_000,
  );
});

describe("saved answers when two subjects merge", () => {
  const from = "subject-from" as Subject;
  const into = "subject-into" as Subject;
  const now = 1_000_000;
  const op = (nonce: string) => ({ issuedAtMs: now, nonce: `nonce-${nonce}` });
  const ok = (value: Json): AuthorityResult<Json> => ({ ok: true, value });

  it.each([
    ["into holds nothing", [], ["a", "b"], 2],
    ["into holds other ids", ["c"], ["a", "b", "c"], 3],
    ["both hold one id", ["a", "c"], ["a", "b", "c"], 3],
  ] as const)("are found under the kept subject when %s", (_case, intoNonces, found, size) => {
    const book = new ReceiptBook(DEFAULT_AUTHORITY_LIMITS);
    for (const nonce of ["a", "b"]) book.record(from, op(nonce), "digest", ok(`from-${nonce}`));
    for (const nonce of intoNonces) book.record(into, op(nonce), "digest", ok(`into-${nonce}`));

    book.merge(from, into);

    expect(book.size).toBe(size);
    expect(found.map((nonce) => book.replay(into, op(nonce), "digest"))).toEqual(
      found.map((nonce) => ok((intoNonces as readonly string[]).includes(nonce) ? `into-${nonce}` : `from-${nonce}`)),
    );
    expect(["a", "b"].map((nonce) => book.holds(from, op(nonce)))).toEqual([false, false]);
    expect(book.hasRoom(from, now)).toBe(true);
  });
});

describe("a staged transaction", () => {
  it("cannot commit after another transaction committed first", () => {
    const store = new AuthorityStore(probeAuthority.runtime, DEFAULT_AUTHORITY_LIMITS);
    const mark = (n: number) => ({ noteId: "a", n, shown: false });
    const staged = store.stage((tx) => tx.put("marks", key("a", "1"), mark(1)));
    store.transact((tx) => tx.put("marks", key("a", "2"), mark(2)));

    expect(staged.ok && (() => staged.commit())).toThrow(/must commit before any other/);
    expect([...store.rows("marks").keys()]).toEqual([key("a", "2")]);
  });
});
