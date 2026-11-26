import { describe, expect, it } from "vitest";
import {
  issueRoomRecoveryPass,
  provesEarlierRoomMembership,
} from "../server/roomRecoveryPass.js";
import {
  createMemoryRoomRecoveryStore,
  createRoomRecoveryLedger,
} from "../server/roomRecoveryLedger.js";

const SECRET = "pass-secret";
const CHANNEL = "conclave:abc-mnop-xyz";
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
const recovering = (recoveryPassGeneration: number | null) => ({
  channelId: CHANNEL,
  incarnationId: "room-3",
  recoveryPassesVoidUntil: null,
  recoveryPassGeneration,
});

describe("a recovery pass at a room recreated for a lost call", () => {
  it("proves membership when the lost call's room signed it under the call's generation", () => {
    expect(provesEarlierRoomMembership(passFrom("room-2", 6), recovering(6), "guest-ben", SECRET)).toBe(true);
  });

  it("proves nothing when an SFU that no longer owned the code signed it under an older generation", () => {
    expect(provesEarlierRoomMembership(passFrom("room-1", 5), recovering(6), "guest-ben", SECRET)).toBe(false);
  });

  it("proves membership by the other rules where no record says which generation the call ran under", () => {
    expect(provesEarlierRoomMembership(passFrom("room-1", 5), recovering(null), "guest-ben", SECRET)).toBe(true);
  });
});

describe("the generation a lost call's passes were signed under", () => {
  const ledgerRoom = (incarnationId: string, ownershipGeneration: number) => ({
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
  });

  it("is the generation of the room that last ran the call, and stays so when a new room fences the record", async () => {
    const store = createMemoryRoomRecoveryStore();
    const ledger = createRoomRecoveryLedger(store);
    await ledger.saveRecord(ledgerRoom("room-2", 6), ledger.runningRecord(ledgerRoom("room-2", 6)), 6);
    expect(await ledger.fence({ channelId: CHANNEL, incarnationId: "room-3", takesOverRecordOf: null }, 7, null)).toBe(true);

    expect((await ledger.recall(CHANNEL)).lost?.passGeneration).toBe(6);
  });
});
