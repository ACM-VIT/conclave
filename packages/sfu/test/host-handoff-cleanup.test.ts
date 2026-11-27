import { afterEach, describe, expect, it, vi } from "vitest";
import type { Router } from "mediasoup/types";
import type { Server as SocketIOServer } from "socket.io";
import { config } from "../config/config.js";
import { Room } from "../config/classes/Room.js";
import { ensureHost } from "../server/admin/controlPlane.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { createSfuState, type SfuState } from "../server/state.js";

const makeState = (): SfuState =>
  createSfuState({
    roomRegistry: new LocalRoomRegistry({
      instanceId: "host-handoff-test",
      instanceUrl: "http://localhost",
      ttlMs: 45000,
    }),
  });

const makeRoom = (state: SfuState) => {
  const close = vi.fn();
  const room = new Room({
    id: "room",
    clientId: "conclave",
    workerPid: null,
    router: { closed: false, close } as unknown as Router,
  });
  state.rooms.set(room.channelId, room);
  return { room, close };
};

const io = { to: () => ({ emit: vi.fn() }) } as unknown as SocketIOServer;

afterEach(() => {
  vi.useRealTimers();
});

describe("the cleanup a host hand-off leaves when nobody can host", () => {
  it("closes the room it was started for once that room is still empty", () => {
    vi.useFakeTimers();
    const state = makeState();
    const { room, close } = makeRoom(state);

    ensureHost(io, state, room);
    vi.advanceTimersByTime(config.adminCleanupTimeout + 1);

    expect(state.rooms.has(room.channelId)).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  it("leaves a newer room that reopened the same channel alone", () => {
    vi.useFakeTimers();
    const state = makeState();
    const { room } = makeRoom(state);

    ensureHost(io, state, room);
    state.rooms.delete(room.channelId);
    const { room: reopened, close: closeReopened } = makeRoom(state);
    vi.advanceTimersByTime(config.adminCleanupTimeout + 1);

    expect(state.rooms.get(room.channelId)).toBe(reopened);
    expect(closeReopened).not.toHaveBeenCalled();
  });
});
