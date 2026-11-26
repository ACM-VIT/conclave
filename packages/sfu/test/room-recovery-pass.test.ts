import { afterEach, describe, expect, it, vi } from "vitest";
import {
  issueRoomRecoveryPass,
  provesEarlierRoomMembership,
  ROOM_RECOVERY_PASS_TTL_MS,
  type PassGeneration,
} from "../server/roomRecoveryPass.js";
import {
  createMemoryRoomRecoveryStore,
  createRoomRecoveryLedger,
} from "../server/roomRecoveryLedger.js";

const SECRET = "pass-secret";
const CHANNEL = "conclave:abc-mnop-xyz";
const START = new Date("2026-11-27T09:00:00Z").getTime();
const MINUTE_MS = 60_000;
const signingRoom = (incarnationId: string, ownershipGeneration: number) => ({
  channelId: CHANNEL,
  incarnationId,
  recoveryPassesVoidUntil: null,
  ownershipGeneration,
  userKeysById: new Map([["seat", "guest-ben"]]),
  needsReadmission: () => false,
  recordsItsCall: true,
});
const passFrom = (incarnationId: string, generation: number) =>
  issueRoomRecoveryPass(signingRoom(incarnationId, generation), { id: "seat", isObserver: false }, SECRET);
const recovering = (recoveryPassGenerations: PassGeneration[] | null) => ({
  channelId: CHANNEL,
  incarnationId: "room-9",
  recoveryPassesVoidUntil: null,
  recoveryPassGenerations,
});
const useClock = () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
};

afterEach(() => {
  vi.useRealTimers();
});

describe("a recovery pass at a room recreated for a lost call", () => {
  it("proves membership when the lost call's room signed it under the call's generation", () => {
    useClock();
    const pass = passFrom("room-2", 6);
    expect(
      provesEarlierRoomMembership(pass, recovering([{ generation: 6, until: START }]), "guest-ben", SECRET),
    ).toBe(true);
  });

  it("proves membership when a room earlier in the same call signed it, however many rooms ran the call since", () => {
    useClock();
    const pass = passFrom("room-1", 5);
    vi.setSystemTime(START + 2 * MINUTE_MS);
    const chain = [
      { generation: 5, until: START + 10_000 },
      { generation: 6, until: START + MINUTE_MS },
      { generation: 7, until: START + 2 * MINUTE_MS },
    ];
    expect(provesEarlierRoomMembership(pass, recovering(chain), "guest-ben", SECRET)).toBe(true);
  });

  it("proves nothing when an SFU that never ran this call signed it", () => {
    useClock();
    expect(
      provesEarlierRoomMembership(
        passFrom("room-1", 5),
        recovering([{ generation: 6, until: START }]),
        "guest-ben",
        SECRET,
      ),
    ).toBe(false);
  });

  it("proves nothing when an SFU signed it well after the next room took the call over from it", () => {
    useClock();
    const chain = [
      { generation: 5, until: START },
      { generation: 6, until: START + 3 * MINUTE_MS },
    ];
    vi.setSystemTime(START + 2 * MINUTE_MS);
    const late = passFrom("room-1", 5);
    expect(provesEarlierRoomMembership(late, recovering(chain), "guest-ben", SECRET)).toBe(false);
    expect(provesEarlierRoomMembership(passFrom("room-2", 6), recovering(chain), "guest-ben", SECRET)).toBe(true);
  });

  it("proves membership by the other rules where no record says which generations the call ran under", () => {
    useClock();
    expect(provesEarlierRoomMembership(passFrom("room-1", 5), recovering(null), "guest-ben", SECRET)).toBe(true);
  });
});

describe("the generations a lost call's passes were signed under", () => {
  const ledgerRoom = (
    incarnationId: string,
    ownershipGeneration: number,
    earlierPassGenerations: PassGeneration[] = [],
  ) => ({
    channelId: CHANNEL,
    incarnationId,
    takesOverRecordOf: null,
    ownerEmail: null,
    hostReasons: new Map(),
    hostUserKey: "host@example.com",
    adminUserKeys: new Set(["host@example.com"]),
    usersNeedingReadmission: [],
    recoveryPassesVoidUntil: null,
    guestPassesFor: () => ({}),
    ownershipGeneration,
    earlierPassGenerations,
  });
  const runs = async (
    ledger: ReturnType<typeof createRoomRecoveryLedger>,
    room: ReturnType<typeof ledgerRoom>,
  ) => ledger.saveRecord(room, ledger.runningRecord(room), room.ownershipGeneration);

  it("are the generation of the room that last ran the call, which stays when a new room fences the record", async () => {
    useClock();
    const ledger = createRoomRecoveryLedger(createMemoryRoomRecoveryStore());
    await runs(ledger, ledgerRoom("room-2", 6));
    expect(await ledger.fence({ channelId: CHANNEL, incarnationId: "room-3", takesOverRecordOf: null }, 7, null)).toBe(true);

    expect((await ledger.recall(CHANNEL)).lost?.passGenerations).toEqual([{ generation: 6, until: START }]);
  });

  it("are every generation the call ran under, each closed when the next room took the call over", async () => {
    useClock();
    const ledger = createRoomRecoveryLedger(createMemoryRoomRecoveryStore());
    await runs(ledger, ledgerRoom("room-1", 5));
    vi.setSystemTime(START + 10_000);
    const first = (await ledger.recall(CHANNEL)).lost?.passGenerations ?? [];
    expect(await ledger.fence({ channelId: CHANNEL, incarnationId: "room-2", takesOverRecordOf: null }, 6, null)).toBe(true);
    await runs(ledger, { ...ledgerRoom("room-2", 6, first), takesOverRecordOf: "room-1" as never });
    vi.setSystemTime(START + MINUTE_MS);

    expect((await ledger.recall(CHANNEL)).lost?.passGenerations).toEqual([
      { generation: 5, until: START + 10_000 },
      { generation: 6, until: START + MINUTE_MS },
    ]);
  });

  it("forget a generation once every pass it signed has run out", async () => {
    useClock();
    const ledger = createRoomRecoveryLedger(createMemoryRoomRecoveryStore());
    const old = { generation: 5, until: START - ROOM_RECOVERY_PASS_TTL_MS - 1 };
    await runs(ledger, ledgerRoom("room-2", 6, [old]));

    expect((await ledger.recall(CHANNEL)).lost?.passGenerations).toEqual([{ generation: 6, until: START }]);
  });

  it("are gone once the meeting is over", async () => {
    useClock();
    const ledger = createRoomRecoveryLedger(createMemoryRoomRecoveryStore());
    const room = ledgerRoom("room-2", 6, [{ generation: 5, until: START }]);
    await runs(ledger, room);
    await ledger.saveRecord(room, ledger.overRecord(room), 6);

    const recalled = await ledger.recall(CHANNEL);
    expect(recalled.lost).toBeNull();
    expect(recalled.passesVoidUntil).toBe(START);
  });
});
