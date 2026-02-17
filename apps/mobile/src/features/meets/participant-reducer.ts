import type { Participant, ProducerType } from "./types";

export type ParticipantAction =
  | { type: "ADD_PARTICIPANT"; userId: string; isGhost?: boolean }
  | { type: "REMOVE_PARTICIPANT"; userId: string }
  | { type: "MARK_LEAVING"; userId: string }
  | {
      type: "UPDATE_STREAM";
      userId: string;
      kind: "audio" | "video";
      streamType: ProducerType;
      stream: MediaStream | null;
      producerId: string;
    }
  | { type: "UPDATE_MUTED"; userId: string; muted: boolean }
  | { type: "UPDATE_CAMERA_OFF"; userId: string; cameraOff: boolean }
  | { type: "UPDATE_HAND_RAISED"; userId: string; raised: boolean }
  | { type: "CLEAR_ALL" };

const createEmptyParticipant = (
  userId: string,
  isGhost = false
): Participant => ({
  userId,
  videoStream: null,
  audioStream: null,
  screenShareStream: null,
  audioProducerId: null,
  videoProducerId: null,
  screenShareProducerId: null,
  isMuted: false,
  isCameraOff: false,
  isHandRaised: false,
  isGhost,
});

export function participantReducer(
  state: Map<string, Participant>,
  action: ParticipantAction
): Map<string, Participant> {
  const newState = new Map(state);

  switch (action.type) {
    case "ADD_PARTICIPANT": {
      const existing = newState.get(action.userId);
      if (existing) {
        newState.set(action.userId, {
          ...existing,
          isLeaving: false,
          isGhost: action.isGhost ?? existing.isGhost,
        });
        return newState;
      }
      newState.set(
        action.userId,
        createEmptyParticipant(action.userId, action.isGhost ?? false)
      );
      return newState;
    }
    case "REMOVE_PARTICIPANT": {
      newState.delete(action.userId);
      return newState;
    }
    case "MARK_LEAVING": {
      const participant = newState.get(action.userId);
      if (participant) {
        newState.set(action.userId, { ...participant, isLeaving: true });
      }
      return newState;
    }
    case "UPDATE_STREAM": {
      const participant =
        newState.get(action.userId) || createEmptyParticipant(action.userId);

      const updated = { ...participant };

      if (action.streamType === "screen") {
        updated.screenShareStream = action.stream;
        updated.screenShareProducerId = action.stream
          ? action.producerId
          : null;
      } else if (action.kind === "video") {
        updated.videoStream = action.stream;
        updated.videoProducerId = action.stream ? action.producerId : null;
        if (action.stream) updated.isCameraOff = false;
      } else if (action.kind === "audio") {
        updated.audioStream = action.stream;
        updated.audioProducerId = action.stream ? action.producerId : null;
        if (action.stream) updated.isMuted = false;
      }

      newState.set(action.userId, updated);
      return newState;
    }
    case "UPDATE_MUTED": {
      const participant =
        newState.get(action.userId) || createEmptyParticipant(action.userId);
      newState.set(action.userId, { ...participant, isMuted: action.muted });
      return newState;
    }
    case "UPDATE_CAMERA_OFF": {
      const participant =
        newState.get(action.userId) || createEmptyParticipant(action.userId);
      newState.set(action.userId, {
        ...participant,
        isCameraOff: action.cameraOff,
      });
      return newState;
    }
    case "UPDATE_HAND_RAISED": {
      const participant =
        newState.get(action.userId) || createEmptyParticipant(action.userId);
      newState.set(action.userId, {
        ...participant,
        isHandRaised: action.raised,
      });
      return newState;
    }
    case "CLEAR_ALL": {
      return new Map();
    }
    default:
      return state;
  }
}
