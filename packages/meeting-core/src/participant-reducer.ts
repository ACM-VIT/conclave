import type {
  Participant,
  ParticipantConnectionStatus,
  ProducerType,
} from "./types";

export type ParticipantAction =
  | {
      type: "ADD_PARTICIPANT";
      userId: string;
      isGhost?: boolean;
      addIfMissing?: boolean;
      reviveIfPresent?: boolean;
    }
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
  | {
      type: "UPDATE_MUTED";
      userId: string;
      muted: boolean;
      addIfMissing?: boolean;
    }
  | {
      type: "UPDATE_CAMERA_OFF";
      userId: string;
      cameraOff: boolean;
      addIfMissing?: boolean;
    }
  | {
      type: "UPDATE_VIDEO_ADAPTIVE_PAUSED";
      userId: string;
      producerId: string;
      adaptivelyPaused: boolean;
    }
  | { type: "UPDATE_HAND_RAISED"; userId: string; raised: boolean }
  | {
      type: "UPDATE_CONNECTION_STATUS";
      userId: string;
      status: ParticipantConnectionStatus | null;
    }
  | { type: "CLEAR_ALL" };

const createEmptyParticipant = (
  userId: string,
  isGhost = false
): Participant => ({
  userId,
  videoStream: null,
  audioStream: null,
  screenShareStream: null,
  screenShareAudioStream: null,
  audioProducerId: null,
  videoProducerId: null,
  screenShareProducerId: null,
  screenShareAudioProducerId: null,
  isMuted: false,
  isCameraOff: false,
  isVideoAdaptivelyPaused: false,
  isHandRaised: false,
  isGhost,
});

// Clone the Map and set the participant in one step. Only ever called once a
// real change is known, so the new Map identity always signals a real update —
// this is what lets memoized consumers (GridLayout) skip no-op re-renders.
const withParticipant = (
  state: Map<string, Participant>,
  userId: string,
  participant: Participant
): Map<string, Participant> => {
  const next = new Map(state);
  next.set(userId, participant);
  return next;
};

export function participantReducer(
  state: Map<string, Participant>,
  action: ParticipantAction
): Map<string, Participant> {
  switch (action.type) {
    case "ADD_PARTICIPANT": {
      const existing = state.get(action.userId);
      if (existing) {
        if (
          action.addIfMissing === false &&
          existing.isLeaving &&
          !action.reviveIfPresent
        ) {
          return state;
        }
        const nextGhost = action.isGhost ?? existing.isGhost;
        // Re-add of an already-present, non-leaving participant with the same
        // ghost flag is a no-op (server re-sync) — keep the same reference.
        if (!existing.isLeaving && existing.isGhost === nextGhost) {
          return state;
        }
        return withParticipant(state, action.userId, {
          ...existing,
          isLeaving: false,
          isGhost: nextGhost,
          connectionStatus: undefined,
        });
      }
      if (action.addIfMissing === false) return state;
      return withParticipant(
        state,
        action.userId,
        createEmptyParticipant(action.userId, action.isGhost ?? false)
      );
    }
    case "REMOVE_PARTICIPANT": {
      if (!state.has(action.userId)) return state;
      const next = new Map(state);
      next.delete(action.userId);
      return next;
    }
    case "MARK_LEAVING": {
      const participant = state.get(action.userId);
      if (!participant || participant.isLeaving) return state;
      return withParticipant(state, action.userId, {
        ...participant,
        isLeaving: true,
      });
    }
    case "UPDATE_STREAM": {
      const existingParticipant = state.get(action.userId);
      if (!action.stream) {
        if (!existingParticipant) return state;
        const currentProducerId =
          action.streamType === "screen"
            ? action.kind === "video"
              ? existingParticipant.screenShareProducerId
              : existingParticipant.screenShareAudioProducerId
            : action.kind === "video"
              ? existingParticipant.videoProducerId
              : existingParticipant.audioProducerId;
        if (currentProducerId && currentProducerId !== action.producerId) {
          return state;
        }
      }

      const participant =
        existingParticipant || createEmptyParticipant(action.userId);
      const updated = { ...participant };

      if (action.streamType === "screen") {
        if (action.kind === "video") {
          updated.screenShareStream = action.stream;
          updated.screenShareProducerId = action.stream
            ? action.producerId
            : null;
        } else if (action.kind === "audio") {
          updated.screenShareAudioStream = action.stream;
          updated.screenShareAudioProducerId = action.stream
            ? action.producerId
            : null;
        }
      } else if (action.kind === "video") {
        updated.videoStream = action.stream;
        updated.videoProducerId = action.stream ? action.producerId : null;
        updated.isVideoAdaptivelyPaused = false;
        if (action.stream) updated.isCameraOff = false;
      } else if (action.kind === "audio") {
        updated.audioStream = action.stream;
        updated.audioProducerId = action.stream ? action.producerId : null;
        if (action.stream) updated.isMuted = false;
      }

      // Bail if every field matches (re-emitted producer state).
      if (
        state.has(action.userId) &&
        updated.videoStream === participant.videoStream &&
        updated.videoProducerId === participant.videoProducerId &&
        updated.audioStream === participant.audioStream &&
        updated.audioProducerId === participant.audioProducerId &&
        updated.screenShareStream === participant.screenShareStream &&
        updated.screenShareProducerId === participant.screenShareProducerId &&
        updated.screenShareAudioStream === participant.screenShareAudioStream &&
        updated.screenShareAudioProducerId ===
          participant.screenShareAudioProducerId &&
        updated.isCameraOff === participant.isCameraOff &&
        updated.isVideoAdaptivelyPaused ===
          participant.isVideoAdaptivelyPaused &&
        updated.isMuted === participant.isMuted
      ) {
        return state;
      }
      return withParticipant(state, action.userId, updated);
    }
    case "UPDATE_MUTED": {
      const participant = state.get(action.userId);
      if (!participant && action.addIfMissing === false) return state;
      if (participant && participant.isMuted === action.muted) return state;
      return withParticipant(state, action.userId, {
        ...(participant || createEmptyParticipant(action.userId)),
        isMuted: action.muted,
      });
    }
    case "UPDATE_CAMERA_OFF": {
      const participant = state.get(action.userId);
      if (!participant && action.addIfMissing === false) return state;
      const nextVideoAdaptivelyPaused =
        action.cameraOff ? false : participant?.isVideoAdaptivelyPaused ?? false;
      if (
        participant &&
        participant.isCameraOff === action.cameraOff &&
        participant.isVideoAdaptivelyPaused === nextVideoAdaptivelyPaused
      ) {
        return state;
      }
      return withParticipant(state, action.userId, {
        ...(participant || createEmptyParticipant(action.userId)),
        isCameraOff: action.cameraOff,
        isVideoAdaptivelyPaused: nextVideoAdaptivelyPaused,
      });
    }
    case "UPDATE_VIDEO_ADAPTIVE_PAUSED": {
      const participant = state.get(action.userId);
      if (!participant || participant.videoProducerId !== action.producerId) {
        return state;
      }
      const nextVideoAdaptivelyPaused =
        action.adaptivelyPaused &&
        !participant.isCameraOff &&
        Boolean(participant.videoStream);
      if (participant.isVideoAdaptivelyPaused === nextVideoAdaptivelyPaused) {
        return state;
      }
      return withParticipant(state, action.userId, {
        ...participant,
        isVideoAdaptivelyPaused: nextVideoAdaptivelyPaused,
      });
    }
    case "UPDATE_HAND_RAISED": {
      const participant = state.get(action.userId);
      if (participant && participant.isHandRaised === action.raised) {
        return state;
      }
      return withParticipant(state, action.userId, {
        ...(participant || createEmptyParticipant(action.userId)),
        isHandRaised: action.raised,
      });
    }
    case "UPDATE_CONNECTION_STATUS": {
      const participant = state.get(action.userId);
      if (!participant && !action.status) return state;

      const previous = participant?.connectionStatus;
      const previousGraceMs =
        previous?.state === "reconnecting" ? previous.graceMs : undefined;
      const nextGraceMs =
        action.status?.state === "reconnecting" ? action.status.graceMs : undefined;
      const previousDowntimeMs =
        previous?.state === "reconnected" ? previous.downtimeMs : undefined;
      const nextDowntimeMs =
        action.status?.state === "reconnected"
          ? action.status.downtimeMs
          : undefined;
      if (
        previous?.state === action.status?.state &&
        previous?.reason === action.status?.reason &&
        previousGraceMs === nextGraceMs &&
        previousDowntimeMs === nextDowntimeMs
      ) {
        return state;
      }
      return withParticipant(state, action.userId, {
        ...(participant || createEmptyParticipant(action.userId)),
        connectionStatus: action.status ?? undefined,
        isLeaving:
          action.status?.state === "reconnecting" ? false : participant?.isLeaving,
      });
    }
    case "CLEAR_ALL": {
      return state.size === 0 ? state : new Map<string, Participant>();
    }
    default:
      return state;
  }
}
