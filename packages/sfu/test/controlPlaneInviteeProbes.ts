import { vi } from "vitest";
import * as invitations from "../server/controlPlane/inviteeCommands.js";
import type { ControlPlaneStore } from "../server/controlPlane/store.js";

const commands = new WeakMap<object, Parameters<typeof invitations.updateRoomInvitation>[1]["kind"]>();
const bookings = new WeakSet<object>();

export const installInviteeStoreProbes = (): void => {
  const update = invitations.updateRoomInvitation;
  const read = invitations.roomBooking;
  vi.spyOn(invitations, "updateRoomInvitation").mockImplementation((ref, change) => {
    const command = update(ref, change);
    commands.set(command, change.kind);
    return command;
  });
  vi.spyOn(invitations, "roomBooking").mockImplementation((clientId, roomId) => {
    const query = read(clientId, roomId);
    bookings.add(query);
    return query;
  });
};

export const observeInviteeStore = (
  store: ControlPlaneStore,
  hooks: {
    beforeCommit?: (kind: "fence" | "decide" | "end") => void | Promise<void>;
    afterCommit?: (kind: "fence" | "decide" | "end") => void | Promise<void>;
    beforeRead?: () => void | Promise<void>;
  },
): ControlPlaneStore => ({
  ...store,
  commit: async (command) => {
    const kind = commands.get(command);
    if (kind && hooks.beforeCommit) await hooks.beforeCommit(kind);
    const result = await store.commit(command);
    if (kind && hooks.afterCommit) await hooks.afterCommit(kind);
    return result;
  },
  read: async (query) => {
    if (bookings.has(query) && hooks.beforeRead) await hooks.beforeRead();
    return store.read(query);
  },
});
