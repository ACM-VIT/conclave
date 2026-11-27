import type { Socket } from "socket.io";
import type { WaitingRequest } from "../config/classes/Room.js";
import { isGuestUserKey } from "./identity.js";
import type { SfuState } from "./state.js";

// What someone still knocking is told when the meeting they knock on ends.
// Older apps match "no one to let you in".
export const MEETING_ENDED_WHILE_WAITING =
  "The meeting ended when everyone left. No one to let you in until it starts again.";

const MEETING_OPENED_ELSEWHERE =
  "The meeting started again on another server. Taking you there.";

// Someone waiting for the next meeting at a code. `retryAt` is their own:
// when the meeting they knocked on stood in for a lost call, the moment that
// call stops holding the code, from which they may ask again and open it.
type NextMeetingRequest = WaitingRequest & { guestProof?: string; guestIdentity?: string };

export type LobbyGuest = NextMeetingRequest & { retryAt: number | null; reconnectUntil: number | null };

export type NextMeetingLobby = {
  roomId: string;
  guests: Map<string, LobbyGuest>;
  wakeTimer: NodeJS.Timeout | null;
};

const close = (state: SfuState, channelId: string, lobby: NextMeetingLobby): void => {
  if (lobby.wakeTimer) clearTimeout(lobby.wakeTimer);
  lobby.wakeTimer = null;
  if (state.nextMeetingLobbies.get(channelId) === lobby) {
    state.nextMeetingLobbies.delete(channelId);
  }
};

const armLobby = (state: SfuState, channelId: string, lobby: NextMeetingLobby): void => {
  if (lobby.guests.size === 0) {
    close(state, channelId, lobby);
    return;
  }
  if (lobby.wakeTimer) clearTimeout(lobby.wakeTimer);
  lobby.wakeTimer = null;
  let due = Infinity;
  for (const guest of lobby.guests.values()) {
    due = Math.min(due, guest.reconnectUntil ?? guest.retryAt ?? Infinity);
  }
  if (due === Infinity) return;
  lobby.wakeTimer = setTimeout(() => {
    lobby.wakeTimer = null;
    const now = Date.now();
    for (const [userKey, guest] of lobby.guests) {
      if (guest.reconnectUntil !== null) {
        if (guest.reconnectUntil <= now) lobby.guests.delete(userKey);
      } else if (guest.retryAt !== null && guest.retryAt <= now) {
        guest.retryAt = null;
        guest.socket.emit("joinApproved", { roomId: lobby.roomId });
      }
    }
    armLobby(state, channelId, lobby);
  }, Math.max(0, due - Date.now()) + 1);
  lobby.wakeTimer.unref?.();
};

const place = (
  state: SfuState,
  channelId: string,
  roomId: string,
  guests: LobbyGuest[],
): NextMeetingLobby => {
  const lobby = state.nextMeetingLobbies.get(channelId) ?? {
    roomId,
    guests: new Map<string, LobbyGuest>(),
    wakeTimer: null,
  };
  for (const guest of guests) lobby.guests.set(guest.userKey, guest);
  state.nextMeetingLobbies.set(channelId, lobby);
  armLobby(state, channelId, lobby);
  return lobby;
};

// The people knocking on a meeting that ended wait for the next one at the
// code, out of the room that has gone, each keeping the moment they may ask
// again.
export const waitForNextMeeting = (
  state: SfuState,
  room: { channelId: string; id: string },
  waiting: NextMeetingRequest[],
  retryAt: number | null,
): void => {
  if (waiting.length === 0) return;
  place(
    state,
    room.channelId,
    room.id,
    waiting.map((guest) => ({ ...guest, retryAt, reconnectUntil: null })),
  );
  for (const guest of waiting) {
    guest.socket.emit("waitingRoomStatus", {
      message: MEETING_ENDED_WHILE_WAITING,
      roomId: room.id,
    });
  }
};

// This socket's place in the lobby at a code, if it has one. Looking takes
// nothing: a guest stays in the lobby until they are placed somewhere.
export const lobbyGuestOf = (
  state: SfuState,
  channelId: string,
  userKey: string,
  socketId: string,
): LobbyGuest | null => {
  const guest = state.nextMeetingLobbies.get(channelId)?.guests.get(userKey);
  return guest?.socket.id === socketId && guest.reconnectUntil === null ? guest : null;
};

export const disconnectNextMeetingLobby = (
  state: SfuState,
  channelId: string,
  userKey: string,
  socketId: string,
  graceMs: number,
): void => {
  const lobby = state.nextMeetingLobbies.get(channelId);
  const guest = lobbyGuestOf(state, channelId, userKey, socketId);
  if (!lobby || !guest) return;
  if (graceMs > 0 && (!isGuestUserKey(userKey) || guest.guestProof !== undefined)) {
    guest.reconnectUntil = Date.now() + graceMs;
    armLobby(state, channelId, lobby);
  } else {
    leaveNextMeetingLobby(state, channelId, userKey, socketId);
  }
};

export const resumeNextMeetingLobby = (
  state: SfuState,
  channelId: string,
  identity: { userKey: string; userId: string; guestProof: string | undefined },
  socket: Socket,
): LobbyGuest | null => {
  const lobby = state.nextMeetingLobbies.get(channelId);
  const guest = lobby?.guests.get(identity.userKey);
  if (
    !lobby || !guest || guest.reconnectUntil === null || guest.reconnectUntil <= Date.now() ||
    guest.userId !== identity.userId || guest.guestProof !== identity.guestProof
  ) return null;
  guest.socket = socket;
  guest.reconnectUntil = null;
  armLobby(state, channelId, lobby);
  return guest;
};

export const leaveNextMeetingLobby = (
  state: SfuState,
  channelId: string,
  userKey: string,
  socketId: string,
): void => {
  const lobby = state.nextMeetingLobbies.get(channelId);
  if (!lobby || !lobbyGuestOf(state, channelId, userKey, socketId)) return;
  lobby.guests.delete(userKey);
  armLobby(state, channelId, lobby);
};

export const takeNextMeetingLobby = (
  state: SfuState,
  channelId: string,
  { dropDisconnected = false }: { dropDisconnected?: boolean } = {},
): LobbyGuest[] => {
  const lobby = state.nextMeetingLobbies.get(channelId);
  if (!lobby) return [];
  const connected: LobbyGuest[] = [];
  for (const [key, guest] of lobby.guests) {
    if (guest.reconnectUntil === null) {
      connected.push(guest);
      lobby.guests.delete(key);
    } else if (dropDisconnected) {
      lobby.guests.delete(key);
    }
  }
  armLobby(state, channelId, lobby);
  return connected;
};

// Everyone waiting here asks again through the usual route, which leads to
// the meeting wherever it is. Apps reconnect on this notice and disconnect.
export const sendNextMeetingLobbyOn = (
  state: SfuState,
  channelId: string,
  message: string,
): void => {
  const lobby = state.nextMeetingLobbies.get(channelId);
  if (!lobby) return;
  for (const guest of takeNextMeetingLobby(state, channelId)) {
    guest.socket.emit("serverRestarting", {
      roomId: lobby.roomId,
      message,
      reconnecting: true,
    });
    guest.socket.disconnect(true);
  }
};

// Where the next meeting at a code opened on another server, those waiting
// for it here go there. The shared room registry says where each code is.
export const followMeetingsOpenedElsewhere = async (state: SfuState): Promise<void> => {
  for (const channelId of [...state.nextMeetingLobbies.keys()]) {
    const assignment = await state.roomRegistry.getAssignment(channelId);
    // A room opened here while the registry answered took the lobby in.
    if (state.rooms.has(channelId)) continue;
    if (assignment && !state.roomRegistry.isLocalOwner(assignment)) {
      sendNextMeetingLobbyOn(state, channelId, MEETING_OPENED_ELSEWHERE);
    }
  }
};
