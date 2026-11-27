import type { Room } from "../config/classes/Room.js";
import type { SfuState } from "./state.js";

export type LeasedRoom = Pick<Room, "id" | "clientId" | "channelId" | "incarnationId"> & {
  ownershipGeneration?: number | null;
};

export const holdsRoomLease = (
  state: Pick<SfuState, "roomRegistry" | "deferredRoomWrites">,
  room: Pick<LeasedRoom, "channelId" | "ownershipGeneration">,
): boolean =>
  state.roomRegistry.holdsLease(room.channelId, room.ownershipGeneration ?? undefined) &&
  !state.deferredRoomWrites.has(room.channelId);
