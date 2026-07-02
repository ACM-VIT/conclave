import { describe, expect, it } from "vitest";
import type { Server as SocketIOServer } from "socket.io";
import type { Room } from "../config/classes/Room.js";
import { clearAllRaisedHands } from "../server/admin/controlPlane.js";

type Emitted = { event: string; payload: unknown };

const fakeIo = () => {
  const emitted: Emitted[] = [];
  const io = {
    to: () => ({
      emit: (event: string, payload: unknown) => {
        emitted.push({ event, payload });
      },
    }),
  } as unknown as SocketIOServer;
  return { io, emitted };
};

const fakeRoom = (raised: string[]) =>
  ({
    id: "room-1",
    channelId: "conclave:room-1",
    handRaisedByUserId: new Set(raised),
  }) as unknown as Room;

describe("clearAllRaisedHands", () => {
  it("lowers every raised hand with explicit per-user updates", () => {
    const { io, emitted } = fakeIo();
    const room = fakeRoom(["host-1", "guest-2"]);

    const count = clearAllRaisedHands(io, room);

    expect(count).toBe(2);
    expect(room.handRaisedByUserId.size).toBe(0);

    const snapshot = emitted.find((entry) => entry.event === "handRaisedSnapshot");
    // Clients apply snapshot entries one by one, so the clear must name every
    // user it lowers; an empty list would visibly update nobody.
    expect(snapshot?.payload).toEqual({
      users: [
        { userId: "host-1", raised: false },
        { userId: "guest-2", raised: false },
      ],
      roomId: "room-1",
    });

    const cleared = emitted.find((entry) => entry.event === "admin:handsCleared");
    expect(cleared?.payload).toEqual({ roomId: "room-1", count: 2 });
  });

  it("is a no-op when nobody has a hand raised", () => {
    const { io, emitted } = fakeIo();
    const room = fakeRoom([]);

    expect(clearAllRaisedHands(io, room)).toBe(0);
    expect(emitted).toEqual([]);
  });
});
