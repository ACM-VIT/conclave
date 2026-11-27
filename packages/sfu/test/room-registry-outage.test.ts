import { describe, expect, it, vi } from "vitest";
import type { Router } from "mediasoup/types";
import { Room } from "../config/classes/Room.js";
import {
  LocalRoomRegistry,
  RoomLeaseExpiredError,
  RoomOwnershipError,
  RoomRegistryUnavailableError,
  type RoomAssignmentRecord,
} from "../server/roomRegistry.js";
import {
  cleanupStaleRoom,
  confirmRoomLease,
  getOrCreateRoomWithOrigin,
  hasUnconfirmedRoomLeases,
  renewRoomOwnerships,
} from "../server/rooms.js";
import { createSfuState, type SfuState } from "../server/state.js";

const makeState = (): SfuState =>
  createSfuState({
    roomRegistry: new LocalRoomRegistry({
      instanceId: "registry-outage-test",
      instanceUrl: "http://localhost",
      ttlMs: 45_000,
    }),
  });

const hostRoom = (state: SfuState, id = "room") => {
  const router = { closed: false, close: vi.fn() };
  router.close.mockImplementation(() => {
    router.closed = true;
  });
  const room = new Room({
    id,
    clientId: "conclave",
    workerPid: null,
    router: router as unknown as Router,
  });
  state.rooms.set(room.channelId, room);
  return { room, router, closeRouter: router.close };
};

const takeRegistryDown = (state: SfuState) => {
  const working = {
    renewRoom: state.roomRegistry.renewRoom.bind(state.roomRegistry),
    claimRoom: state.roomRegistry.claimRoom.bind(state.roomRegistry),
  };
  state.roomRegistry.renewRoom = async (input) => {
    throw new RoomLeaseExpiredError(input.channelId);
  };
  state.roomRegistry.claimRoom = async () => {
    throw new RoomRegistryUnavailableError("room claim");
  };
  return () => {
    state.roomRegistry.renewRoom = working.renewRoom;
    state.roomRegistry.claimRoom = working.claimRoom;
  };
};

describe("rooms during a shared registry outage", () => {
  it("keeps a room this instance hosts open through the renewal", async () => {
    const state = makeState();
    const { room, closeRouter } = hostRoom(state);
    takeRegistryDown(state);

    await renewRoomOwnerships(state);

    expect(state.rooms.get(room.channelId)).toBe(room);
    expect(closeRouter).not.toHaveBeenCalled();
    expect(hasUnconfirmedRoomLeases(state)).toBe(true);
  });

  it("lets someone join a room this instance hosts", async () => {
    const state = makeState();
    const { room, closeRouter } = hostRoom(state);
    takeRegistryDown(state);

    await expect(
      getOrCreateRoomWithOrigin(state, "conclave", "room"),
    ).resolves.toEqual({ room, created: false, recalled: null });
    expect(closeRouter).not.toHaveBeenCalled();
  });

  it("keeps the existing call without confirming host writes while its lease is lost", async () => {
    const state = makeState();
    const { room, closeRouter } = hostRoom(state);
    const holdsLease = state.roomRegistry.holdsLease.bind(state.roomRegistry);
    const bringRegistryBack = takeRegistryDown(state);
    state.roomRegistry.holdsLease = () => false;

    await expect(confirmRoomLease(state, room)).resolves.toBe(false);
    expect(state.rooms.get(room.channelId)).toBe(room);
    expect(closeRouter).not.toHaveBeenCalled();
    expect(hasUnconfirmedRoomLeases(state)).toBe(true);

    bringRegistryBack();
    state.roomRegistry.holdsLease = holdsLease;
    await renewRoomOwnerships(state);
    await expect(confirmRoomLease(state, room)).resolves.toBe(true);
    expect(hasUnconfirmedRoomLeases(state)).toBe(false);
  });

  it("waits for a new generation's fences even if the registry goes down during the reclaim", async () => {
    const state = makeState();
    const { room } = hostRoom(state);
    room.ownershipGeneration = 0;
    let finishFence!: (ok: boolean) => void;
    const fence = new Promise<boolean>((resolve) => { finishFence = resolve; });
    let startFence!: () => void;
    const started = new Promise<void>((resolve) => { startFence = resolve; });
    vi.spyOn(state.roomRecovery, "reclaim").mockImplementation(() => {
      startFence();
      return fence;
    });

    const renewal = renewRoomOwnerships(state);
    await started;
    takeRegistryDown(state);
    const join = getOrCreateRoomWithOrigin(state, "conclave", "room");
    const answered = vi.fn();
    void join.then(answered, answered);
    await new Promise((resolve) => setImmediate(resolve));
    expect(answered).not.toHaveBeenCalled();

    finishFence(true);
    await renewal;
    await expect(join).resolves.toMatchObject({ room, created: false });
    expect(room.ownershipGeneration).not.toBe(0);
  });

  it("refuses to start a new room", async () => {
    const state = makeState();
    takeRegistryDown(state);

    await expect(
      getOrCreateRoomWithOrigin(state, "conclave", "new-room"),
    ).rejects.toBeInstanceOf(RoomRegistryUnavailableError);
    expect(state.rooms.size).toBe(0);
  });

  it("registers the room again once the registry is back", async () => {
    const state = makeState();
    const { room } = hostRoom(state);
    const bringRegistryBack = takeRegistryDown(state);
    await renewRoomOwnerships(state);

    bringRegistryBack();
    await renewRoomOwnerships(state);

    expect(hasUnconfirmedRoomLeases(state)).toBe(false);
    expect(state.rooms.get(room.channelId)).toBe(room);
    await expect(
      state.roomRegistry.getOwner(room.channelId),
    ).resolves.toMatchObject({ instanceId: "registry-outage-test" });
  });

  it("still closes a room that another instance took over meanwhile", async () => {
    const state = makeState();
    const { room, closeRouter } = hostRoom(state);
    takeRegistryDown(state);
    await renewRoomOwnerships(state);

    const otherOwner: RoomAssignmentRecord = {
      kind: "owner",
      channelId: room.channelId,
      clientId: room.clientId,
      roomId: room.id,
      instanceId: "other-instance",
      updatedAt: Date.now(),
      expiresAt: Date.now() + 45_000,
    };
    state.roomRegistry.renewRoom = async () => ({ ok: false, owner: otherOwner });

    await renewRoomOwnerships(state);

    expect(state.rooms.has(room.channelId)).toBe(false);
    expect(closeRouter).toHaveBeenCalled();
    expect(hasUnconfirmedRoomLeases(state)).toBe(false);
  });

  it("leaves a successor room alone when the renewed room closed meanwhile", async () => {
    const state = makeState();
    const { room } = hostRoom(state);
    let answerRenewal!: () => void;
    const renewalAnswered = new Promise<void>((resolve) => {
      answerRenewal = resolve;
    });
    state.roomRegistry.renewRoom = async (input) => {
      await renewalAnswered;
      return {
        ok: false,
        owner: {
          kind: "owner",
          channelId: input.channelId,
          clientId: input.clientId,
          roomId: input.roomId,
          instanceId: "other-instance",
          updatedAt: Date.now(),
          expiresAt: Date.now() + 45_000,
        },
      };
    };

    const renewal = renewRoomOwnerships(state);
    state.rooms.delete(room.channelId);
    const successor = hostRoom(state);
    answerRenewal();
    await renewal;

    expect(state.rooms.get(room.channelId)).toBe(successor.room);
    expect(successor.closeRouter).not.toHaveBeenCalled();
  });

  it("leaves a reopened room alone when its old router closed while an earlier room renewed", async () => {
    const state = makeState();
    const first = hostRoom(state, "room-a");
    const reopened = hostRoom(state, "room-b");
    const renew = state.roomRegistry.renewRoom.bind(state.roomRegistry);
    let answerFirstRenewal!: () => void;
    const firstRenewalAnswered = new Promise<void>((resolve) => {
      answerFirstRenewal = resolve;
    });
    state.roomRegistry.renewRoom = async (input) => {
      if (input.channelId === first.room.channelId) await firstRenewalAnswered;
      return renew(input);
    };

    const renewal = renewRoomOwnerships(state);
    reopened.router.closed = true;
    expect(cleanupStaleRoom(state, reopened.room)).toBe(true);
    const successor = hostRoom(state, "room-b");
    answerFirstRenewal();
    await renewal;

    expect(state.rooms.get(successor.room.channelId)).toBe(successor.room);
    expect(successor.closeRouter).not.toHaveBeenCalled();
    expect(state.rooms.get(first.room.channelId)).toBe(first.room);
  });

  it("sends a joiner to the instance that took the room over", async () => {
    const state = makeState();
    const { room } = hostRoom(state);
    state.roomRegistry.renewRoom = async () => ({
      ok: false,
      owner: {
        kind: "owner",
        channelId: room.channelId,
        clientId: room.clientId,
        roomId: room.id,
        instanceId: "other-instance",
        updatedAt: Date.now(),
        expiresAt: Date.now() + 45_000,
      },
    });

    await expect(
      getOrCreateRoomWithOrigin(state, "conclave", "room"),
    ).rejects.toBeInstanceOf(RoomOwnershipError);
    expect(state.rooms.has(room.channelId)).toBe(false);
  });
});
