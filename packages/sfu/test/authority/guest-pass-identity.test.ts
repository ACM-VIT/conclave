import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Json } from "@conclave/apps-sdk/authority";
import { defineAuthority } from "@conclave/apps-sdk/authority/server";
import { Harness, person, type Tab } from "./harness.js";
import { pollsAuthority, pollsContract } from "./fixtures/polls.js";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

const host = person("asha@example.com", "Asha", "host");

const field = (value: Json | null, ...path: string[]): Json | null => {
  let node: Json | null = value;
  for (const key of path) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return null;
    node = (node as { readonly [key: string]: Json })[key] ?? null;
  }
  return node;
};

const pollIn = async (room: Harness, hostTab: Tab): Promise<string> => {
  const created = await hostTab.act("create", { question: "Lunch?", options: ["Tea", "Coffee"] });
  if (!created.ok) throw new Error(`create failed: ${created.code}`);
  await room.deliver();
  return field(created.value, "pollId") as string;
};

const guestTab = (room: Harness, userKey: string, session: string, guestProof?: string) => {
  if (guestProof) {
    room.room.setUserIdentity(`${userKey}#${session}`, userKey, "Gita", { guestProof });
  }
  return room.open(person(userKey, "Gita"), pollsContract, { session });
};

const linkPasses = (room: Harness, joining: string, shown: string) => {
  const link = room.room.planGuestLink([{ guestProof: shown }], joining);
  if (link) room.room.commitGuestLink(link);
};

const alreadyVoted = { ok: false, code: "rejected", reason: "already-voted" };

describe("a guest's pass, as the room's apps see it (Daybreak)", () => {
  it("lets a guest whose pass the room has bound vote, which needs one person", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const pollId = await pollIn(room, hostTab);
    const tab = await guestTab(room, "guest-gp_gita-tab-1", "tab-1", "proof-of-gita");

    expect((await tab.act("vote", { pollId, optionIds: ["o1"] })).ok).toBe(true);
    await room.deliver();

    expect(field(hostTab.row("polls", pollId), "results", "voterCount")).toBe(1);
  });

  it("still asks a guest with no pass for an identity", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const pollId = await pollIn(room, hostTab);
    const tab = await guestTab(room, "guest-names-itself", "tab-1");

    expect(await tab.act("vote", { pollId, optionIds: ["o1"] })).toEqual({ ok: false, code: "identity-required" });
  });

  it("knows the guest's vote when its tab comes back under a pass the room links to the first", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const pollId = await pollIn(room, hostTab);
    const first = await guestTab(room, "guest-gp_gita-first-pass", "tab-1", "proof-of-the-first-pass");
    expect((await first.act("vote", { pollId, optionIds: ["o1"] })).ok).toBe(true);
    await room.deliver();

    linkPasses(room, "proof-of-the-second-pass", "proof-of-the-first-pass");
    const back = await guestTab(room, "guest-gp_gita-second-pass", "tab-1-again", "proof-of-the-second-pass");
    room.room.removeClient(first.seat.id);
    await room.deliver();

    expect(await back.act("vote", { pollId, optionIds: ["o2"] })).toEqual(alreadyVoted);
    expect(field(back.row("myVotes", pollId), "optionIds")).toEqual(["o1"]);
    expect(field(hostTab.row("polls", pollId), "results", "voterCount")).toBe(1);
  });

  it("keeps the guest's identity and its one vote when it leaves after a pass change and comes back under the new pass (Greptile)", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const pollId = await pollIn(room, hostTab);
    const onA = await guestTab(room, "guest-gp_gita-on-pass-a", "tab-1", "proof-of-pass-a");
    expect((await onA.act("vote", { pollId, optionIds: ["o1"] })).ok).toBe(true);
    await room.deliver();
    linkPasses(room, "proof-of-pass-b", "proof-of-pass-a");
    const onB = await guestTab(room, "guest-gp_gita-on-pass-b", "tab-1", "proof-of-pass-b");
    room.room.removeClient(onA.seat.id);
    await room.deliver();

    room.room.removeClient(onB.seat.id);
    await room.deliver();
    const back = await guestTab(room, "guest-gp_gita-on-pass-b", "tab-1-back", "proof-of-pass-b");
    await room.deliver();

    expect(field(back.row("myVotes", pollId), "optionIds")).toEqual(["o1"]);
    expect(await back.act("vote", { pollId, optionIds: ["o2"] })).toEqual(alreadyVoted);
    expect(field(hostTab.row("polls", pollId), "results", "voterCount")).toBe(1);
  });

  it("counts one vote for two tabs of a guest once the room links their passes", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const pollId = await pollIn(room, hostTab);
    const first = await guestTab(room, "guest-gp_gita-tab-on-pass-1", "tab-1", "proof-of-pass-1");
    const second = await guestTab(room, "guest-gp_gita-tab-on-pass-2", "tab-2", "proof-of-pass-2");
    expect((await first.act("vote", { pollId, optionIds: ["o1"] })).ok).toBe(true);
    await room.deliver();

    linkPasses(room, "proof-of-pass-2", "proof-of-pass-1");
    await room.deliver();

    expect(field(second.row("myVotes", pollId), "optionIds")).toEqual(["o1"]);
    expect(await second.act("vote", { pollId, optionIds: ["o2"] })).toEqual(alreadyVoted);
    expect(field(hostTab.row("polls", pollId), "results", "voterCount")).toBe(1);
  });

  it("keeps the identity of a guest who voted under one pass, left, and came back under another that shows the first (Greptile)", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const pollId = await pollIn(room, hostTab);
    const onA = await guestTab(room, "guest-gp_gita-votes-on-a", "tab-1", "proof-of-the-voting-pass");
    expect((await onA.act("vote", { pollId, optionIds: ["o1"] })).ok).toBe(true);
    await room.deliver();
    room.room.removeClient(onA.seat.id);
    await room.deliver();

    linkPasses(room, "proof-of-the-returning-pass", "proof-of-the-voting-pass");
    const onB = await guestTab(room, "guest-gp_gita-back-on-b", "tab-1", "proof-of-the-returning-pass");
    await room.deliver();

    expect(field(onB.row("myVotes", pollId), "optionIds")).toEqual(["o1"]);
    expect(await onB.act("vote", { pollId, optionIds: ["o2"] })).toEqual(alreadyVoted);
    expect(field(hostTab.row("polls", pollId), "results", "voterCount")).toBe(1);
  });

  describe.each([
    ["its first pass sorts first", "proof-1-first", "proof-2-second"],
    ["its first pass sorts last", "proof-9-first", "proof-2-second"],
  ])("a guest whose %s", (_order, first, second) => {
    it.each([
      ["without", "its first pass", false],
      ["without", "a new pass that shows the first", false],
      ["with", "its first pass", true],
      ["with", "a new pass that shows the first", true],
    ])("votes once when it leaves %s rights in the room and comes back under %s", async (_rights, comesBack, keepsRights) => {
      const room = new Harness([pollsAuthority]);
      const hostTab = await room.open(host, pollsContract);
      const pollId = await pollIn(room, hostTab);
      const firstKey = `guest-gp_gita-${first}`;
      const tab = await guestTab(room, firstKey, "tab-1", first);
      expect((await tab.act("vote", { pollId, optionIds: ["o1"] })).ok).toBe(true);
      await room.deliver();
      if (keepsRights) room.room.allowLockedUser(firstKey);
      room.room.removeClient(tab.seat.id);
      await room.deliver();

      const onFirst = comesBack === "its first pass";
      if (!onFirst) linkPasses(room, second, first);
      const back = onFirst
        ? await guestTab(room, firstKey, "tab-1-back", first)
        : await guestTab(room, `guest-gp_gita-${second}`, "tab-1", second);
      await room.deliver();

      expect(field(back.row("myVotes", pollId), "optionIds")).toEqual(["o1"]);
      expect(await back.act("vote", { pollId, optionIds: ["o2"] })).toEqual(alreadyVoted);
      expect(field(hostTab.row("polls", pollId), "results", "voterCount")).toBe(1);
    });
  });
});

describe.each([
  ["by a request that waits", false],
  ["by a tab that takes a seat", true],
])("two passes of one guest linked %s (Neon)", (_how, seated) => {
  it.each([
    ["A", "A"],
    ["A", "B"],
    ["B", "A"],
    ["B", "B"],
    ["A", "both"],
    ["B", "both"],
  ])("count one vote when the room saw pass %s first and pass %s voted (Greptile)", async (seenFirst, voter) => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const pollId = await pollIn(room, hostTab);
    const passes = { A: "proof-of-pass-a", B: "proof-of-pass-b" } as const;
    const order = seenFirst === "A" ? (["A", "B"] as const) : (["B", "A"] as const);
    const tabs: Partial<Record<"A" | "B", Tab>> = {};
    for (const [index, pass] of order.entries()) {
      tabs[pass] = await guestTab(room, `guest-gp_gita-on-${pass}`, `tab-${index + 1}`, passes[pass]);
    }
    const voting = tabs[voter === "B" ? "B" : "A"]!;
    const other = tabs[voter === "B" ? "A" : "B"]!;
    expect((await voting.act("vote", { pollId, optionIds: ["o1"] })).ok).toBe(true);
    if (voter === "both") expect((await other.act("vote", { pollId, optionIds: ["o2"] })).ok).toBe(true);
    await room.deliver();

    linkPasses(room, passes.B, passes.A);
    if (seated) await guestTab(room, "guest-gp_gita-linking-tab", "tab-3", passes.B);
    await room.deliver();

    expect(await other.act("vote", { pollId, optionIds: ["o2"] })).toEqual(alreadyVoted);
    expect(await voting.act("vote", { pollId, optionIds: ["o2"] })).toEqual(alreadyVoted);
    expect(field(hostTab.row("polls", pollId), "results", "voterCount")).toBe(1);
    expect(field(other.row("myVotes", pollId), "optionIds")).toEqual(field(voting.row("myVotes", pollId), "optionIds"));
  });

  it("keeps the votes both passes cast in different polls, and refuses a second vote in either (Greptile)", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const firstPoll = await pollIn(room, hostTab);
    const secondPoll = await pollIn(room, hostTab);
    const onA = await guestTab(room, "guest-gp_gita-votes-in-the-first-poll", "tab-1", "proof-of-pass-a");
    const onB = await guestTab(room, "guest-gp_gita-votes-in-the-second-poll", "tab-2", "proof-of-pass-b");
    expect((await onA.act("vote", { pollId: firstPoll, optionIds: ["o1"] })).ok).toBe(true);
    expect((await onB.act("vote", { pollId: secondPoll, optionIds: ["o2"] })).ok).toBe(true);
    await room.deliver();

    linkPasses(room, "proof-of-pass-b", "proof-of-pass-a");
    if (seated) await guestTab(room, "guest-gp_gita-linking-tab", "tab-3", "proof-of-pass-b");
    await room.deliver();

    for (const tab of [onA, onB]) {
      expect(field(tab.row("myVotes", firstPoll), "optionIds")).toEqual(["o1"]);
      expect(field(tab.row("myVotes", secondPoll), "optionIds")).toEqual(["o2"]);
    }
    expect(await onA.act("vote", { pollId: secondPoll, optionIds: ["o1"] })).toEqual(alreadyVoted);
    expect(await onB.act("vote", { pollId: firstPoll, optionIds: ["o2"] })).toEqual(alreadyVoted);
    expect(field(hostTab.row("polls", firstPoll), "results", "voterCount")).toBe(1);
    expect(field(hostTab.row("polls", secondPoll), "results", "voterCount")).toBe(1);
  });
});

describe("an app that keeps rows by person (Greptile)", () => {
  it("is refused when it has no way to merge two people the room learns are one", () => {
    const { mergeSubjects: _merge, ...withoutMerge } = pollsAuthority.runtime;
    expect(() => defineAuthority(withoutMerge as never)).toThrow(/needs mergeSubjects/);
  });
});
