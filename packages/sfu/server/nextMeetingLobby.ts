import type { WaitingRequest } from "../config/classes/Room.js";
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
export type LobbyGuest = WaitingRequest & { retryAt: number | null; guestProof?: string };

export type NextMeetingLobby = {
  roomId: string;
  guests: Map<string, LobbyGuest>;
  retryTimer: NodeJS.Timeout | null;
};

// Asks again for everyone whose moment has come, as a room standing in for a
// lost call does for its knockers once that call's time is up.
const armRetry = (lobby: NextMeetingLobby): void => {
  if (lobby.retryTimer) clearTimeout(lobby.retryTimer);
  lobby.retryTimer = null;
  const due = [...lobby.guests.values()].flatMap((guest) =>
    guest.retryAt === null ? [] : [guest.retryAt],
  );
  if (due.length === 0) return;
  lobby.retryTimer = setTimeout(() => {
    lobby.retryTimer = null;
    const now = Date.now();
    for (const guest of lobby.guests.values()) {
      if (guest.retryAt === null || guest.retryAt > now) continue;
      guest.retryAt = null;
      guest.socket.emit("joinApproved", { roomId: lobby.roomId });
    }
    armRetry(lobby);
  }, Math.max(0, Math.min(...due) - Date.now()) + 1);
  lobby.retryTimer.unref?.();
};

const close = (state: SfuState, channelId: string, lobby: NextMeetingLobby): void => {
  if (lobby.retryTimer) clearTimeout(lobby.retryTimer);
  lobby.retryTimer = null;
  if (state.nextMeetingLobbies.get(channelId) === lobby) {
    state.nextMeetingLobbies.delete(channelId);
  }
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
    retryTimer: null,
  };
  for (const guest of guests) lobby.guests.set(guest.userKey, guest);
  state.nextMeetingLobbies.set(channelId, lobby);
  armRetry(lobby);
  return lobby;
};

// The people knocking on a meeting that ended wait for the next one at the
// code, out of the room that has gone, each keeping the moment they may ask
// again.
export const waitForNextMeeting = (
  state: SfuState,
  room: { channelId: string; id: string },
  waiting: Array<WaitingRequest & { guestProof?: string }>,
  retryAt: number | null,
): void => {
  if (waiting.length === 0) return;
  place(
    state,
    room.channelId,
    room.id,
    waiting.map((guest) => ({ ...guest, retryAt })),
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
  return guest?.socket.id === socketId ? guest : null;
};

// Someone waiting for the next meeting stops: they left, or went elsewhere.
export const leaveNextMeetingLobby = (
  state: SfuState,
  channelId: string,
  userKey: string,
  socketId: string,
): void => {
  const lobby = state.nextMeetingLobbies.get(channelId);
  if (!lobby || !lobbyGuestOf(state, channelId, userKey, socketId)) return;
  lobby.guests.delete(userKey);
  if (lobby.guests.size === 0) close(state, channelId, lobby);
  else armRetry(lobby);
};

// The next meeting at the code opened here: those waiting for it are its
// first knocks.
export const takeNextMeetingLobby = (
  state: SfuState,
  channelId: string,
): LobbyGuest[] => {
  const lobby = state.nextMeetingLobbies.get(channelId);
  if (!lobby) return [];
  close(state, channelId, lobby);
  return [...lobby.guests.values()];
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
  close(state, channelId, lobby);
  for (const guest of lobby.guests.values()) {
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
