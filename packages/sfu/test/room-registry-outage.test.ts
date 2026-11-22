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

const hostRoom = (state: SfuState) => {
  const closeRouter = vi.fn();
  const room = new Room({
    id: "room",
    clientId: "conclave",
    workerPid: null,
    router: { closed: false, close: closeRouter } as unknown as Router,
  });
  state.rooms.set(room.channelId, room);
  return { room, closeRouter };
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
    ).resolves.toEqual({ room, created: false });
    expect(closeRouter).not.toHaveBeenCalled();
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
