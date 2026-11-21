import type { Socket } from "socket.io";
import type {
  AuthorityModule,
  RoomPolicy,
} from "@conclave/apps-sdk/authority/server";
import type { Room } from "../../../config/classes/Room.js";
import type { SfuState } from "../../state.js";
import {
  guestPassProofOf,
  IdentityAdapter,
  type GuestPassProofSource,
} from "./identity.js";
import { DEFAULT_AUTHORITY_LIMITS, type AuthorityLimits } from "./limits.js";
import { assertUniqueModules, AUTHORITY_MODULES } from "./registry.js";
import { RoomAuthority, type SocketPressure } from "./roomAuthority.js";

/** How this SFU process runs authority apps. Null on the state when off. */
export type AppsAuthorityRuntime = {
  modules: readonly AuthorityModule[];
  limits: AuthorityLimits;
  verifyViews: boolean;
  pressure: (socket: Socket) => SocketPressure;
  guestProofOf: GuestPassProofSource;
};

/**
 * What a socket has accepted but not yet put on the wire. engine.io holds
 * packets in `writeBuffer` until the transport can take them, and a
 * WebSocket reports the bytes still buffered below that.
 */
export const socketPressure = (socket: Socket): SocketPressure => {
  const connection = socket.conn as unknown as {
    writeBuffer?: unknown[];
    transport?: { socket?: { bufferedAmount?: unknown } };
  };
  const buffered = connection.transport?.socket?.bufferedAmount;
  return {
    packets: connection.writeBuffer?.length ?? 0,
    bytes: typeof buffered === "number" ? buffered : 0,
  };
};

export const createAppsAuthorityRuntime = (
  overrides: Partial<AppsAuthorityRuntime> = {},
): AppsAuthorityRuntime => ({
  limits: DEFAULT_AUTHORITY_LIMITS,
  verifyViews: false,
  pressure: socketPressure,
  guestProofOf: guestPassProofOf,
  ...overrides,
  modules: assertUniqueModules(overrides.modules ?? AUTHORITY_MODULES),
});

const authorities = new WeakMap<Room, RoomAuthority>();

const policyOf = (state: SfuState, room: Room): RoomPolicy => {
  const webinar = state.webinarConfigs.get(room.channelId);
  return {
    mode: webinar?.enabled ? "webinar" : "meeting",
    qaEnabled: webinar?.qaEnabled ?? true,
  };
};

/** The room's authority runtime if it has one. Never creates it. */
export const peekRoomAuthority = (room: Room): RoomAuthority | null => {
  const authority = authorities.get(room);
  return authority && !authority.isClosed ? authority : null;
};

/**
 * The room's authority runtime, created on first use. Null when this SFU
 * does not run authority apps or the room is no longer registered.
 */
export const getRoomAuthority = (
  state: SfuState,
  room: Room,
): RoomAuthority | null => {
  const runtime = state.appsAuthority;
  if (!runtime) return null;
  const existing = authorities.get(room);
  if (existing) return existing.isClosed ? null : existing;
  if (state.rooms.get(room.channelId) !== room) return null;

  const authority = new RoomAuthority({
    room,
    modules: runtime.modules,
    policy: () => policyOf(state, room),
    isLive: () => state.rooms.get(room.channelId) === room,
    identity: new IdentityAdapter(runtime.guestProofOf),
    limits: runtime.limits,
    pressure: runtime.pressure,
    verifyViews: runtime.verifyViews,
  });
  authorities.set(room, authority);
  room.onLifecycle((event) => {
    if (event === "closed") authority.close();
    else authority.membershipChanged();
  });
  return authority;
};
