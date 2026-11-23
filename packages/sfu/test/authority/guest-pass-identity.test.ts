import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Json } from "@conclave/apps-sdk/authority";
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
  if (!link) throw new Error("the room did not plan a link");
  room.room.commitGuestLink(link);
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
});
