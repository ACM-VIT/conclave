import type { Socket } from "socket.io";
import type {
  AuthorityModule,
  AuthorityRandom,
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
  /** Where apps draw ids and chance from. Cryptographic unless a test seeds it. */
  random?: AuthorityRandom;
};

/** The size on the wire of what one queued packet carries. */
const queuedBytes = (data: unknown): number => {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  return 0;
};

/**
 * What a socket has accepted but not yet put on the wire: the packets
 * engine.io holds in `writeBuffer` until the transport can take them, and
 * their size, plus the bytes a WebSocket still holds below that.
 *
 * The queue is counted in bytes on every transport. A long-polling client
 * has no socket to ask, and its packets wait in the queue from one poll to
 * the next, so for a client that polls slowly, or has stopped, the queue's
 * size is the only sign that it is behind. Twenty parts of a large view are
 * few packets and more than a megabyte.
 */
export const socketPressure = (socket: Socket): SocketPressure => {
  const connection = socket.conn as unknown as
    | {
        writeBuffer?: readonly { data?: unknown }[];
        transport?: { socket?: { bufferedAmount?: unknown } };
      }
    | undefined;
  const queue = connection?.writeBuffer ?? [];
  let bytes = 0;
  for (const packet of queue) bytes += queuedBytes(packet.data);
  const buffered = connection?.transport?.socket?.bufferedAmount;
  return {
    packets: queue.length,
    bytes: bytes + (typeof buffered === "number" ? buffered : 0),
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
 * Says that a room's mode or one of its flags may have changed. Called from
 * wherever a room's webinar config is written, so a view that depends on it
 * is corrected at once and not at the next request. It costs nothing when
 * the room has no runtime or nothing changed.
 */
export const notifyAuthorityPolicy = (state: SfuState, channelId: string): void => {
  const room = state.rooms.get(channelId);
  if (room) peekRoomAuthority(room)?.policyChanged();
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
    random: runtime.random,
  });
  authorities.set(room, authority);
  room.onLifecycle((event) => {
    if (event === "closed") authority.close();
    else authority.membershipChanged();
  });
  room.setGuestIdentityMerger((merges) => authority.stageGuestMerges(merges));
  return authority;
};
